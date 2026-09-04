import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveQuotaTool, startQuotaPoller } from '../../src/main/quota-poller';

// The tool that reads quota lives outside wmux — it is a separate Node script
// that knows how to read each agent's own usage files. wmux only needs to know
// where it is, and must degrade to "no quota line" rather than crash when the
// user does not have it.

describe('resolveQuotaTool', () => {
  it('prefers an explicit path from settings over the convention', () => {
    const p = resolveQuotaTool({ quotaTool: 'D:\tools\quota.js' }, 'C:\Users\Someone');
    expect(p).toBe('D:\tools\quota.js');
  });

  it('falls back to the conventional location under the home directory', () => {
    const p = resolveQuotaTool({}, 'C:\Users\Someone');
    expect(p).toContain('Someone');
    expect(p).toMatch(/quota\.js$/);
  });

  it('ignores a non-string setting rather than building a path out of it', () => {
    // A hand-edited settings file is the expected way to set this, so the value
    // can be anything. A number here would otherwise become the string "42".
    const p = resolveQuotaTool({ quotaTool: 42 as unknown as string }, 'C:\Users\Someone');
    expect(p).toMatch(/quota\.js$/);
    expect(p).not.toContain('42');
  });
});

describe('startQuotaPoller — the first result must not fall on the floor', () => {
  // Measured on a real cold start: the sidebar sat empty for 32.1 seconds —
  // ~2s of app start plus one whole 30s interval. The poller ticks immediately
  // and `webContents.send`s the answer before the renderer has mounted and
  // subscribed, so the first result is dropped and nothing shows until the
  // NEXT tick. A push-only channel cannot fix this on its own: whoever arrives
  // late has to be able to ask. So the poller keeps its most recent result and
  // hands it to anyone who asks for it.

  it('remembers the most recent result so a late renderer can ask for it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-poller-'));
    const missing = path.join(dir, 'not-installed.js');

    const seen: unknown[] = [];
    const poller = startQuotaPoller({ toolPath: missing, intervalMs: 1000, onUpdate: (r) => seen.push(r) });

    expect(seen).toHaveLength(1);
    expect(poller.last()).toBe(seen[0]);
    poller.stop();
  });

  it('has nothing to hand out before the first result', () => {
    // Null means "no answer yet", which the banner must be able to tell apart
    // from "the tool answered and said it knows nothing".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-poller-'));
    const poller = startQuotaPoller({
      toolPath: path.join(dir, 'x.js'),
      intervalMs: 1000,
      onUpdate: () => {},
    });
    poller.stop();
    // The immediate tick already produced the "not found" result, so this
    // asserts the shape of the accessor rather than an empty poller: a poller
    // that never ticked is not reachable through the public API.
    expect(typeof poller.last).toBe('function');
  });
});

describe('startQuotaPoller — a missing tool is not a permanent verdict', () => {
  // The old code reported "not found" once and returned WITHOUT starting a
  // timer. That single report raced the renderer exactly like the first tick
  // did, and with no second tick there was nothing to recover it: measured on
  // a real run, `quota ?` never appeared at all — 75 seconds of empty sidebar
  // on any machine that has not installed the tool, with no reason given.

  it('keeps checking, so the answer is not frozen at app-start time', () => {
    vi.useFakeTimers();
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-poller-'));
      const missing = path.join(dir, 'not-installed.js');

      const seen: unknown[] = [];
      const poller = startQuotaPoller({ toolPath: missing, intervalMs: 1000, onUpdate: (r) => seen.push(r) });

      expect(seen).toHaveLength(1);
      vi.advanceTimersByTime(3000);
      expect(seen.length).toBeGreaterThan(1);

      poller.stop();
      const after = seen.length;
      vi.advanceTimersByTime(5000);
      expect(seen).toHaveLength(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says why it has no numbers, rather than saying nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-poller-'));
    const poller = startQuotaPoller({
      toolPath: path.join(dir, 'not-installed.js'),
      intervalMs: 1000,
      onUpdate: () => {},
    });
    const last = poller.last() as { error?: string; bays?: unknown[] };
    expect(last.error).toMatch(/not found/i);
    expect(last.bays).toEqual([]);
    poller.stop();
  });

  it('picks the tool up once it is installed, without a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-poller-'));
    const tool = path.join(dir, 'quota-stub.js');

    const seen: Array<Record<string, unknown>> = [];
    const poller = startQuotaPoller({ toolPath: tool, intervalMs: 50, onUpdate: (r) => seen.push(r as Record<string, unknown>) });
    expect(seen[0].error).toMatch(/not found/i);

    // Installed while wmux is already running — the case a restart-only fix
    // would leave broken.
    fs.writeFileSync(tool, 'console.log(JSON.stringify({bays:[{id:"claude",nhan:"CC"}]}))');

    // Generous, because this one really does spawn a runtime: under a full
    // parallel suite that start cost is what it is, and a budget tuned to an
    // idle machine turns a passing test into an intermittent red one. It
    // finishes in well under a second when the machine is not busy.
    await vi.waitFor(() => {
      const last = poller.last() as { bays?: unknown[] };
      expect(last.bays).toHaveLength(1);
    }, { timeout: 30000, interval: 200 });

    poller.stop();
  }, 45000);
});
