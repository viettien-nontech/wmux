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

/** A running quota poller: it can be stopped, and it can be asked what it last saw. */
export interface QuotaPoller {
  stop: () => void;
  /** The most recent result handed to `onUpdate`, or null before the first one. */
  last: () => unknown;
}

/**
 * Run the quota tool on a timer and hand each result to `onUpdate`.
 *
 * Thirty seconds, not two: quota moves slowly, and every read is a full run of
 * the tool. A faster tick would spend power to redraw the same number.
 *
 * **The result is also kept, not just pushed.** The first tick fires while the
 * app is still starting, and `webContents.send` to a window whose renderer has
 * not mounted yet goes nowhere — measured on a cold start, that dropped answer
 * left the sidebar blank for 32 seconds until the next tick. Push alone cannot
 * fix that, because the party who arrives late is the one who needs the answer;
 * so the poller holds its latest result and a renderer can ask on mount.
 *
 * **A missing tool is re-checked, not decided once.** The previous version
 * reported "not found" and returned with no timer, so that single report raced
 * the renderer with no second chance behind it: on a machine without the tool
 * the explanation never arrived at all. Re-checking each tick costs one
 * `existsSync` per 30 seconds and makes installing the tool take effect without
 * restarting wmux.
 */
export function startQuotaPoller(opts: {
  toolPath: string;
  intervalMs?: number;
  onUpdate: (raw: unknown) => void;
}): QuotaPoller {
  const { toolPath, intervalMs = 30_000, onUpdate } = opts;

  let latest: unknown = null;
  const publish = (raw: unknown): void => {
    latest = raw;
    onUpdate(raw);
  };

  const runtime = getNodeRuntime();
  const env = { ...process.env, ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };

  const tick = (): void => {
    if (!fs.existsSync(toolPath)) {
      publish({ error: 'quota tool not found', bays: [] });
      return;
    }
    execFile(
      runtime.path,
      [toolPath, '--json'],
      { env, timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          publish({ error: String(err.message || err).slice(0, 80), bays: [] });
          return;
        }
        try {
          publish(JSON.parse(stdout));
        } catch {
          // The tool printed something that is not JSON. Say so rather than
          // leaving the last good number on screen, which would quietly go stale.
          publish({ error: 'quota tool printed non-JSON', bays: [] });
        }
      },
    );
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer), last: () => latest };
}
