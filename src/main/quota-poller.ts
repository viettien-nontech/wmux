import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { getNodeRuntime } from './node-runtime';

/**
 * Where the quota tool lives.
 *
 * Reading an agent's remaining quota means reading that agent's own usage files,
 * which is a job that changes whenever a vendor changes their format. wmux does
 * not do it: it runs a small external Node script and draws whatever it prints.
 * That keeps vendor-shaped knowledge out of this codebase, and lets the script
 * be tested on its own.
 *
 * `quotaTool` in settings.json overrides the conventional location. The setting
 * is hand-edited today, so it is treated as untrusted input rather than as a
 * string that happens to be there.
 */
export function resolveQuotaTool(settings: Record<string, unknown>, home: string): string {
  const explicit = settings.quotaTool;
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  return path.join(home, '.claude', 'cockpit', 'quota.js');
}

/**
 * Run the quota tool on a timer and hand each result to `onUpdate`.
 *
 * Thirty seconds, not two: quota moves slowly, and every read is a full run of
 * the tool. A faster tick would spend power to redraw the same number.
 *
 * The tool is optional. A machine without it gets one "not installed" result and
 * no timer at all — a missing side feature must not put a spawn on a loop.
 */
export function startQuotaPoller(opts: {
  toolPath: string;
  intervalMs?: number;
  onUpdate: (raw: unknown) => void;
}): () => void {
  const { toolPath, intervalMs = 30_000, onUpdate } = opts;

  if (!fs.existsSync(toolPath)) {
    onUpdate({ error: 'quota tool not found', bays: [] });
    return () => {};
  }

  const runtime = getNodeRuntime();
  const env = { ...process.env, ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };

  const tick = (): void => {
    execFile(
      runtime.path,
      [toolPath, '--json'],
      { env, timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          onUpdate({ error: String(err.message || err).slice(0, 80), bays: [] });
          return;
        }
        try {
          onUpdate(JSON.parse(stdout));
        } catch {
          // The tool printed something that is not JSON. Say so rather than
          // leaving the last good number on screen, which would quietly go stale.
          onUpdate({ error: 'quota tool printed non-JSON', bays: [] });
        }
      },
    );
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
