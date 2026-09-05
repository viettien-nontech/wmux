import { describe, it, expect } from 'vitest';
import { quotaAlerts, alertTarget, QUOTA_ALERT_SURFACE, type AlertMemory } from '../../src/renderer/components/Sidebar/quota-alerts';
import type { QuotaState } from '../../src/renderer/components/Sidebar/quota';

// The sidebar already colours a window at 80% (`isNearLimit`), but that signal
// only exists while somebody is LOOKING at the sidebar. On 2026-09-05 a session
// ran to 92% of its 5-hour window mid-task and found out only by running the
// tool by hand, from inside a terminal pane. Colour is a passive signal; this
// module is the active one.
//
// It is a pure function of (what was already announced, what the tool just
// reported) because the alternative — a `useEffect` comparing against a ref —
// puts the one rule that must never fire twice inside the part of the app
// hardest to test.

/* A window the tool could not read comes back as `pct: null` AND
   `resetsAt: null`, because the tool sends `five_hour: null` — the whole
   object — and `readWindow` turns that into two nulls. The first version of
   this fixture held `resetsAt` fixed while nulling `pct`, a shape the tool
   never produces, and that is exactly why it missed the bug a review found:
   the mark was filed under a cycle key that vanished with the reading. */
const win = (pct: number | null, resetsAt: number | null = 1788618000) =>
  (pct == null ? { pct: null, resetsAt: null } : { pct, resetsAt });

/* `??` is wrong here and cost two red tests to notice: `null ?? 10` is 10, so
   `{ five: null }` — "the tool could not measure it", the case half these tests
   are about — silently became the number 10. Not specified is `undefined`;
   `null` is a value this fixture must pass through untouched. That is the exact
   distinction the module under test exists to keep, walked into while writing
   the tests for it. */
const or = <T>(given: T | undefined, fallback: T): T => (given === undefined ? fallback : given);

const state = (over: {
  cc?: { five?: number | null; week?: number | null; reset?: number | null };
  cx?: { five?: number | null; week?: number | null; reset?: number | null };
} = {}): QuotaState => ({
  bays: [
    {
      id: 'claude', label: 'CC', status: 'ok', reason: '',
      fiveHour: win(or(over.cc?.five, 10), or(over.cc?.reset, 1788618000)),
      sevenDay: win(or(over.cc?.week, 10)),
    },
    {
      id: 'codex', label: 'CX', status: 'ok', reason: '',
      fiveHour: win(or(over.cx?.five, 10), or(over.cx?.reset, 1788618000)),
      sevenDay: win(or(over.cx?.week, 10)),
    },
  ],
});

/** Feed a sequence of readings through, collecting every alert that came out. */
function run(readings: QuotaState[]): ReturnType<typeof quotaAlerts>['alerts'][] {
  let memory: AlertMemory = {};
  const out = [];
  for (const r of readings) {
    const res = quotaAlerts(memory, r);
    memory = res.memory;
    out.push(res.alerts);
  }
  return out;
}

describe('quotaAlerts', () => {
  it('announces 80% once, and stays quiet while the same window keeps climbing', () => {
    // The whole point of the memory. A poll every few seconds against a bare
    // `pct >= 80` would ring continuously from 80 to 100.
    const rounds = run([
      state({ cc: { five: 79 } }),
      state({ cc: { five: 80 } }),
      state({ cc: { five: 81 } }),
      state({ cc: { five: 85 } }),
      state({ cc: { five: 90 } }),
    ]);
    expect(rounds.map((r) => r.length)).toEqual([0, 1, 0, 0, 0]);
    expect(rounds[1][0].threshold).toBe(80);
  });

  it('announces 95% as a second, differently-worded alert', () => {
    const rounds = run([state({ cc: { five: 82 } }), state({ cc: { five: 95 } })]);
    expect(rounds[0]).toHaveLength(1);
    expect(rounds[1]).toHaveLength(1);
    expect(rounds[1][0].threshold).toBe(95);
    expect(rounds[1][0].text).not.toBe(rounds[0][0].text);
  });

  it('announces only the HIGHEST threshold when a reading jumps past both', () => {
    // Opening wmux at 97% should ring once, not hand the user a backlog of
    // every threshold it slept through.
    const [first] = run([state({ cc: { five: 97 } })]);
    expect(first).toHaveLength(1);
    expect(first[0].threshold).toBe(95);
  });

  it('rings on the FIRST reading, with nothing to compare against', () => {
    // Starting wmux while already at 91% is exactly when the warning is worth
    // most, and is also the case a naive "compare with the previous value"
    // implementation misses entirely.
    const { alerts } = quotaAlerts({}, state({ cc: { five: 91 } }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].threshold).toBe(80);
  });

  it('keeps every window and every bay independent', () => {
    // Four counters, not one. CC's 5-hour window crossing 80 says nothing about
    // CC's week or about CX.
    const rounds = run([
      state({ cc: { five: 85 } }),
      state({ cc: { five: 85, week: 85 } }),
      state({ cc: { five: 85, week: 85 }, cx: { five: 85 } }),
      state({ cc: { five: 85, week: 85 }, cx: { five: 85, week: 85 } }),
    ]);
    expect(rounds.map((r) => r.length)).toEqual([1, 1, 1, 1]);
    expect(rounds.map((r) => `${r[0].bayLabel} ${r[0].windowLabel}`))
      .toEqual(['CC 5h', 'CC Weekly', 'CX 5h', 'CX Weekly']);
  });

  it('re-arms when the window rolls over to a new cycle', () => {
    // `resetsAt` moving means this is a DIFFERENT five hours. Remembering that
    // 80% was announced would silence the alert for every window after the
    // first one it ever fired on.
    const rounds = run([
      state({ cc: { five: 85, reset: 1000 } }),
      state({ cc: { five: 5, reset: 2000 } }),
      state({ cc: { five: 85, reset: 2000 } }),
    ]);
    expect(rounds.map((r) => r.length)).toEqual([1, 0, 1]);
  });

  it('re-arms when a reading drops back below a threshold inside one cycle', () => {
    const rounds = run([
      state({ cc: { five: 85 } }),
      state({ cc: { five: 40 } }),
      state({ cc: { five: 85 } }),
    ]);
    expect(rounds.map((r) => r.length)).toEqual([1, 0, 1]);
  });

  it('never rings on a missing number, and never treats it as 0', () => {
    // `null` is "could not measure", which is the shape Codex is in most of
    // the time. Reading it as 0 would silently re-arm every threshold.
    const rounds = run([
      state({ cc: { five: null } }),
      state({ cc: { five: 85 } }),
      state({ cc: { five: null } }),
      state({ cc: { five: 85 } }),
    ]);
    expect(rounds.map((r) => r.length)).toEqual([0, 1, 0, 0]);
  });

  it('does not ring twice for one cycle just because a reading went blind', () => {
    // The bug a review caught, and the reason the mark's cycle is a FIELD and
    // not part of its key. A blind reading carries no `resetsAt`, so filing it
    // under `bay:window:unknown` dropped the real cycle's mark from the rebuilt
    // memory — and the number coming back for the SAME window looked new.
    //
    // Not a rare path: Codex's 5-hour reading is null most of the time, and any
    // transient failure of the tool puts every bay here for a tick.
    const rounds = run([
      state({ cc: { five: 85, reset: 5000 } }),   // rings
      state({ cc: { five: null } }),              // tool blind: pct AND resetsAt gone
      state({ cc: { five: 88, reset: 5000 } }),   // same five hours, back with a number
    ]);
    expect(rounds.map((r) => r.length)).toEqual([1, 0, 0]);
  });

  it('still re-arms across a blind reading when the cycle really did roll over', () => {
    // The other half of the same rule: going quiet must not become going deaf.
    const rounds = run([
      state({ cc: { five: 85, reset: 5000 } }),
      state({ cc: { five: null } }),
      state({ cc: { five: 85, reset: 9000 } }),
    ]);
    expect(rounds.map((r) => r.length)).toEqual([1, 0, 1]);
  });

  it('says which bay, which window, and how much', () => {
    const { alerts } = quotaAlerts({}, state({ cc: { five: 91 } }));
    expect(alerts[0].title).toContain('CC');
    expect(alerts[0].title).toContain('5h');
    expect(alerts[0].text).toContain('91');
  });

  it('mentions the reset time when the tool gave one, and omits it when it did not', () => {
    const withReset = quotaAlerts({}, state({ cc: { five: 91, reset: 1788618000 } })).alerts[0];
    const without = quotaAlerts({}, state({ cc: { five: 91, reset: null } })).alerts[0];
    expect(withReset.resetsAt).toBe(1788618000);
    expect(without.resetsAt).toBeNull();
    expect(without.text).not.toMatch(/\d\d:\d\d/);
  });

  it('does not grow its memory without bound as cycles roll over', () => {
    // The key carries `resetsAt`, so every rollover mints a new one. Keeping
    // the dead ones would leak an entry per window per five hours, forever.
    let memory: AlertMemory = {};
    for (let i = 0; i < 50; i++) {
      memory = quotaAlerts(memory, state({ cc: { five: 85, reset: 1000 + i } })).memory;
    }
    expect(Object.keys(memory).length).toBeLessThanOrEqual(4);
  });

  it('survives a tool that reported no bays at all', () => {
    expect(quotaAlerts({}, { bays: [] }).alerts).toEqual([]);
    expect(quotaAlerts({}, { bays: [], error: 'tool missing' }).alerts).toEqual([]);
  });
});

// ─── where an account-wide alert gets hung ───────────────────────────────────

describe('alertTarget', () => {
  const leaf = (paneId: string, surfaceIds: string[], activeIndex = 0) =>
    ({ type: 'leaf', paneId, surfaces: surfaceIds.map((id) => ({ id, type: 'terminal' })),
       activeSurfaceIndex: activeIndex } as any);

  it('files the alert against the workspace the user is in', () => {
    const wss = [
      { id: 'ws-1' as any, splitTree: leaf('pane-1', ['surf-1']) },
      { id: 'ws-2' as any, splitTree: leaf('pane-2', ['surf-2']) },
    ];
    expect(alertTarget(wss, 'ws-2' as any)?.workspaceId).toBe('ws-2');
  });

  it('NEVER files it against a surface a pane owns', () => {
    // The regression this whole constant exists for. Filing against the focused
    // pane's surface meant `PaneWrapper`'s mark-read-on-focus cleared the alert
    // in the same breath it arrived: stored, read: true, bell dark. Every unit
    // test still passed, because they count at the moment of firing.
    const surfaces = ['surf-1', 'surf-2', 'surf-3'];
    const wss = [{ id: 'ws-1' as any, splitTree: leaf('pane-1', surfaces, 1) }];
    const target = alertTarget(wss, 'ws-1' as any)!;
    expect(surfaces).not.toContain(target.surfaceId);
    expect(target.surfaceId).toBe(QUOTA_ALERT_SURFACE);
  });

  it('falls back to any workspace when none is active', () => {
    const wss = [{ id: 'ws-1' as any, splitTree: leaf('p1', ['s1']) }];
    expect(alertTarget(wss, null)?.workspaceId).toBe('ws-1');
  });

  it('answers null rather than inventing a target when there is no workspace', () => {
    // Quota arrives on a timer that starts before the first workspace exists.
    expect(alertTarget([], null)).toBeNull();
    expect(alertTarget([], 'ws-gone' as any)).toBeNull();
  });
});

// ─── the thresholds, once Settings owns them ─────────────────────────────────

describe('quotaAlerts with chosen thresholds', () => {
  const at = (warn: number, alert: number) => ({ warn, alert });

  it('rings on the numbers it is handed, not on 80/95', () => {
    const seen = quotaAlerts({}, state({ cc: { five: 62 } }), at(60, 70)).alerts;
    expect(seen.map((a) => a.threshold)).toEqual([60]);
  });

  it('keeps ringing once per level with custom numbers', () => {
    let memory: AlertMemory = {};
    const th = at(60, 70);
    const first = quotaAlerts(memory, state({ cc: { five: 62 } }), th);
    memory = first.memory;
    const again = quotaAlerts(memory, state({ cc: { five: 65 } }), th);
    memory = again.memory;
    const higher = quotaAlerts(memory, state({ cc: { five: 71 } }), th);

    expect(first.alerts.map((a) => a.threshold)).toEqual([60]);
    expect(again.alerts).toEqual([]);           // same level, already said
    expect(higher.alerts.map((a) => a.threshold)).toEqual([70]);
  });

  it('rings ONCE when the two numbers are set to the same value', () => {
    // Two identical levels in the ladder would announce the same crossing
    // twice, and the second one carries no information at all.
    const th = at(90, 90);
    const first = quotaAlerts({}, state({ cc: { five: 91 } }), th);
    expect(first.alerts.map((a) => a.threshold)).toEqual([90]);
    expect(quotaAlerts(first.memory, state({ cc: { five: 99 } }), th).alerts).toEqual([]);
  });

  it('says "Gần cạn" at the ALERT number, wherever that was put', () => {
    // The wording used to test `pct >= 95` on its own. With 95 configurable,
    // a bell set to 70 would have rung with the calm sentence — the message
    // and the level it was chosen for must not be able to disagree.
    const [a] = quotaAlerts({}, state({ cc: { five: 71 } }), at(60, 70)).alerts;
    expect(a.text).toContain('Gần cạn');

    const [b] = quotaAlerts({}, state({ cc: { five: 62 } }), at(60, 70)).alerts;
    expect(b.text).not.toContain('Gần cạn');
  });

  it('still means 80/95 when no thresholds are passed', () => {
    // Every existing call site passes two arguments.
    expect(quotaAlerts({}, state({ cc: { five: 81 } })).alerts.map((a) => a.threshold)).toEqual([80]);
    expect(quotaAlerts({}, state({ cc: { five: 96 } })).alerts.map((a) => a.threshold)).toEqual([95]);
  });
});
