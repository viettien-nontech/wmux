#!/usr/bin/env node
/**
 * Build a runnable wmux out of this checkout, in one command.
 *
 *     node scripts/package-app.mjs [--out <dir>] [--skip-build] [--zip]
 *
 * ## Why this exists, and why it is not `electron-builder`
 *
 * The release path in CLAUDE.md is a dozen shell steps, and the cost of that is
 * not typing: every step is a place to forget something, and the things it
 * forgets are silent. Two of them bit within an hour of doing it by hand —
 * `--unpack` with a glob produces an asar and NO `.unpacked` dir with no error
 * at all, and `cd` drift makes a re-pack swallow its own output into a 188 MB
 * asar. Both are recorded in CLAUDE.md because both had already happened once.
 *
 * `electron-builder` is deliberately unused: its winCodeSign step fails on a
 * path with spaces (this repo's own README says so), and it wants to talk to
 * GitHub. What it does that matters here — stage, pack, unpack natives, lay out
 * an Electron runtime, stamp the exe — is all reachable from Node directly.
 *
 * ## The part worth keeping
 *
 * `RESOURCE_SOURCES` is checked against what `src/main/` ACTUALLY reads at
 * runtime, by scanning for `process.resourcesPath` string literals. Copying
 * from a hand-written checklist is how `claude-instructions`,
 * `claude-instructions.md` and `icon.ico` got left out of a hand-built package —
 * an app that starts fine and then fails at one feature, which is the worst
 * shape of bug to ship. A resource this script cannot place is a hard error,
 * not a warning: the whole point is that it refuses rather than produces
 * something subtly incomplete.
 *
 * NOT a release. It does not sign (wmux has no certificate — see BAN_GIAO), tag,
 * or write `latest.yml`. It produces a folder you can run, and with `--zip` an
 * archive you can copy to another machine.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 || i + 1 >= args.length ? fallback : args[i + 1];
};

const OUT = path.resolve(ROOT, value('--out', path.join('..', 'wmux-app')));
const STAGING = path.join(ROOT, '.asar-staging');
const BUILD_OUT = path.join(ROOT, 'build-out');

const say = (s) => console.log(s);
const step = (n, s) => console.log(`\n[${n}/8] ${s}`);
const die = (s) => { console.error(`\n✗ ${s}`); process.exit(1); };

/**
 * Where each runtime resource comes from. Anything `main` reads out of
 * `process.resourcesPath` must appear as a key here, and step 6 proves it.
 */
const RESOURCE_SOURCES = {
  'claude-instructions': 'resources/claude-instructions',
  'claude-instructions.md': 'resources/claude-instructions.md',
  'icon.png': 'resources/icon.png',
  'icon.ico': 'resources/icons/icon.ico',
  themes: 'resources/themes',
  sounds: 'resources/sounds',
  'wmux-orchestrator': 'resources/wmux-orchestrator',
  'opencode-plugin': 'resources/opencode-plugin',
  'cli-bin': 'src/cli-bin',
  'cli-bin-ps': 'src/cli-bin-ps',
  'shell-integration': 'src/shell-integration',
};

/**
 * The CLI is packaged FILE BY FILE rather than as a directory, so a shared
 * module has to be named. `wmux-hook.js` reached no install until 0.29.1 and
 * the sidebar sat on "Running" forever; `transport-deadline.js` is a
 * MODULE_NOT_FOUND on the first line of both, not a degraded feature.
 */
const CLI_FILES = ['wmux.js', 'wmux-hook.js', 'transport-deadline.js', 'wsl-network.js'];

function run(cmd, cmdArgs, cwd = ROOT) {
  // No shell: argv carries paths with spaces, and Node refuses to spawn a .cmd
  // without `shell: true` anyway (CVE-2024-27980). Every tool below is reachable
  // as a module or as `npm`, so nothing here needs cmd.exe.
  execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });
}

/**
 * npm, without cmd.exe.
 *
 * `npm` on Windows is a `.cmd`, which Node refuses to spawn without
 * `shell: true` (CVE-2024-27980) — and `shell: true` with an args array is
 * itself deprecated (DEP0190) because the args are concatenated rather than
 * escaped. This repo already documents that trap for `agent-browser-cli.ts`.
 * npm's real entry point is a plain `.js` beside the node binary, so the shell
 * is simply not needed.
 */
const npmCli = (() => {
  const guess = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(guess) ? guess : null;
})();
function npmRun(cmdArgs, cwd) {
  if (npmCli) {
    execFileSync(process.execPath, [npmCli, ...cmdArgs], { cwd, stdio: 'inherit' });
    return;
  }
  // Last resort on a layout where npm's JS entry is somewhere else. Fixed
  // arguments only — nothing here comes from a caller.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', cmdArgs,
    { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

function dirSize(p) {
  let total = 0;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

/* ── 0. Refuse to build over a running app ───────────────────────────────── */

function appIsRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq wmux.exe', '/NH'], { encoding: 'utf-8' });
    return /wmux\.exe/i.test(out);
  } catch {
    return false;
  }
}

if (appIsRunning()) {
  die('wmux.exe is running. Windows will not let rcedit stamp a running exe, and the\n'
    + '  copy would half-succeed. Close wmux and run this again.');
}

/* ── 1-2. Compile ────────────────────────────────────────────────────────── */

if (flag('--skip-build')) {
  step(1, 'skipping tsc + vite (--skip-build)');
  if (!existsSync(path.join(ROOT, 'dist', 'main', 'index.js'))) die('--skip-build, but dist/main is not built.');
} else {
  step(1, 'compiling main/preload/cli (tsc)');
  npmRun(['run', 'build:main'], ROOT);
  step(2, 'building renderer (vite)');
  npmRun(['run', 'build:renderer'], ROOT);
}

/* ── 3. Staging ──────────────────────────────────────────────────────────── */

step(3, 'staging app + production dependencies');
rmSync(STAGING, { recursive: true, force: true });
rmSync(BUILD_OUT, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });
mkdirSync(BUILD_OUT, { recursive: true });
cpSync(path.join(ROOT, 'dist'), path.join(STAGING, 'dist'), { recursive: true });
cpSync(path.join(ROOT, 'package.json'), path.join(STAGING, 'package.json'));
npmRun(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], STAGING);
/* Force the prebuilds load path: `conpty.dll` resolves relative to the LOADED
   `conpty.node`, and only `prebuilds/win32-x64/` has the `conpty/` dir beside
   it. Leaving `build/` in place loads the wrong one. */
rmSync(path.join(STAGING, 'node_modules', 'node-pty', 'build'), { recursive: true, force: true });

/* ── 4. Pack ─────────────────────────────────────────────────────────────── */

step(4, 'packing app.asar');
const asar = require('@electron/asar');
const asarPath = path.join(BUILD_OUT, 'app.asar');
await asar.createPackageWithOptions(STAGING, asarPath, {
  // A PATH, never a glob. `--unpack "**/*.node"` silently produces no
  // `.unpacked` dir on Windows shells and no error with it.
  unpackDir: 'node_modules/node-pty/prebuilds',
});

const natives = path.join(BUILD_OUT, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64');
if (!existsSync(natives)) die('node-pty natives were not unpacked — the app would not start a single shell.');
for (const f of ['conpty.node', 'conpty_console_list.node', 'pty.node']) {
  if (!existsSync(path.join(natives, f))) die(`missing unpacked native: ${f}`);
}
const asarMb = statSync(asarPath).size / 1024 / 1024;
say(`    app.asar ${asarMb.toFixed(1)} MB · natives unpacked`);
/* Sanity, not a constant: it was ~24 MB at 0.7.x and ~36 MB now, so a fixed
   threshold reads as a failure on a healthy build. What a number this large
   really means is that staging got polluted and the pack swallowed its own
   output — which has happened. */
if (asarMb > 120) die('app.asar is implausibly large — staging was probably polluted.');

/* ── 5. Electron runtime ─────────────────────────────────────────────────── */

step(5, 'laying out the Electron runtime');
const electronDist = path.dirname(require('electron'));
if (!existsSync(path.join(electronDist, 'electron.exe'))) die(`no electron.exe under ${electronDist}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(electronDist, OUT, { recursive: true });
renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'wmux.exe'));
/* The stock app Electron shows when it has nothing to run. Leaving it is how a
   broken package still opens a window and looks like it worked. */
rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });
cpSync(asarPath, path.join(OUT, 'resources', 'app.asar'));
cpSync(path.join(BUILD_OUT, 'app.asar.unpacked'), path.join(OUT, 'resources', 'app.asar.unpacked'), { recursive: true });

/* ── 6. Resources, checked against what main actually reads ──────────────── */

step(6, 'copying runtime resources');
const outResources = path.join(OUT, 'resources');
for (const [name, from] of Object.entries(RESOURCE_SOURCES)) {
  const src = path.join(ROOT, from);
  if (!existsSync(src)) die(`resource source missing: ${from}`);
  const dest = path.join(outResources, name);
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}
mkdirSync(path.join(outResources, 'cli'), { recursive: true });
for (const f of CLI_FILES) {
  const src = path.join(ROOT, 'dist', 'cli', f);
  if (!existsSync(src)) die(`CLI file missing from dist: ${f}`);
  cpSync(src, path.join(outResources, 'cli', f));
}

/*
 * THE CHECK THAT EARNS ITS KEEP. Every `process.resourcesPath` join in
 * `src/main/` names a file or directory this package must contain; a checklist
 * maintained by hand drifts from that set silently, and the result is an app
 * that starts and then fails at one feature.
 */
function mainResourceNames() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const src = readFileSync(full, 'utf-8');
      for (const m of src.matchAll(/resourcesPath[^;\n]*/g)) {
        for (const lit of m[0].matchAll(/'([A-Za-z0-9._-]+)'/g)) names.add(lit[1]);
      }
    }
  };
  walk(path.join(ROOT, 'src', 'main'));
  return [...names];
}

const missing = [];
for (const name of mainResourceNames()) {
  // A name may be a resource itself, or a file inside `resources/cli/`.
  if (existsSync(path.join(outResources, name))) continue;
  if (existsSync(path.join(outResources, 'cli', name))) continue;
  missing.push(name);
}
if (missing.length > 0) {
  die(`src/main reads these out of resourcesPath and the package has none of them:\n`
    + `  ${missing.join(', ')}\n`
    + '  Add each to RESOURCE_SOURCES (or CLI_FILES) in this script.');
}
say(`    ${Object.keys(RESOURCE_SOURCES).length + CLI_FILES.length} resources placed, all of main's reads satisfied`);

/* ── 7. Stamp the exe ────────────────────────────────────────────────────── */

step(7, 'stamping icon and version into wmux.exe');
const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const { rcedit } = require('rcedit');
await rcedit(path.join(OUT, 'wmux.exe'), {
  icon: path.join(ROOT, 'resources', 'icons', 'icon.ico'),
  'version-string': {
    ProductName: 'wmux',
    FileDescription: 'wmux',
    CompanyName: 'wmux',
    InternalName: 'wmux',
    // Windows uses FileDescription for a pinned shortcut's name, so this is
    // what a taskbar pin ends up called.
    OriginalFilename: 'wmux.exe',
    LegalCopyright: 'Copyright (c) 2026 wmux',
  },
  'file-version': version,
  'product-version': version,
});

/* ── 8. Done ─────────────────────────────────────────────────────────────── */

step(8, 'cleaning up');
rmSync(STAGING, { recursive: true, force: true });
rmSync(BUILD_OUT, { recursive: true, force: true });

if (flag('--zip')) {
  const zipPath = path.resolve(OUT, '..', `wmux-${version}-win-x64.zip`);
  say(`    compressing to ${zipPath} (this takes a while)`);
  rmSync(zipPath, { force: true });
  run('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${path.join(OUT, '*')}' -DestinationPath '${zipPath}' -CompressionLevel Optimal`]);
  say(`    ${mb(statSync(zipPath).size)}`);
}

say('');
say(`✓ ${path.join(OUT, 'wmux.exe')}`);
say(`  version ${version} · ${mb(dirSize(OUT))}`);
say('');
say('  Unsigned, on purpose: Windows only warns about a file carrying a');
say('  Mark of the Web, which a locally built one does not have. Run it, or');
say('  copy the whole folder to another machine.');
