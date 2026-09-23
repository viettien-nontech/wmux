import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FORK_SELF_UPDATE } from '../../src/main/fork-updates';

/*
 * The fork must never update itself from upstream's releases (fork-updates.ts).
 *
 * Pinned at the SOURCE, because the thing that breaks it is a merge: upstream
 * keeps reworking the updater, and a conflict resolved by taking their side of
 * index.ts silently rewires both entry points. Nothing at runtime would notice
 * until the next time the app replaced itself with the stock build.
 */
const indexSrc = fs.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf8');

/** The statement guarding the first occurrence of `call`. */
function guardOf(call: string): string {
  const at = indexSrc.indexOf(call);
  expect(at, `${call} not found in index.ts`).toBeGreaterThan(-1);
  return indexSrc.slice(Math.max(0, at - 200), at);
}

describe('fork self-update is off', () => {
  it('the switch itself is false', () => {
    expect(FORK_SELF_UPDATE).toBe(false);
  });

  it('the release poller and the auto-updater start only behind the switch', () => {
    expect(guardOf('initUpdateChecker();')).toMatch(/if \(FORK_SELF_UPDATE\) \{\s*initAutoUpdater\(\);\s*$/);
  });

  it('the install IPC refuses unless the switch is on', () => {
    expect(guardOf('requestUpdateNow()\n')).toMatch(/UPDATE_INSTALL, \(\) => \(FORK_SELF_UPDATE\s*\?\s*$/);
  });

  it('nothing else in main starts an update', () => {
    // Every call site of the three entry points, outside their own modules.
    const mainDir = path.join(__dirname, '../../src/main');
    const callers = fs.readdirSync(mainDir)
      .filter((f) => f.endsWith('.ts') && !['updater.ts', 'update-checker.ts', 'zip-updater.ts'].includes(f))
      .filter((f) => /\b(initAutoUpdater|initUpdateChecker|requestUpdateNow)\(/.test(
        fs.readFileSync(path.join(mainDir, f), 'utf8')));
    expect(callers).toEqual(['index.ts']);
  });
});
