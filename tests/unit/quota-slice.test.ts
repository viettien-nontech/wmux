import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createNotificationSlice, NotificationSlice } from '../../src/renderer/store/notification-slice';
import { createSettingsSlice, SettingsSlice } from '../../src/renderer/store/settings-slice';
import { createQuotaSlice, QuotaSlice, __resetQuotaAlertMemory } from '../../src/renderer/store/quota-slice';

// `quota-alerts.test.ts` pins the DECISION. This pins the WIRING — that a
// reading crossing a threshold actually reaches the bell. The two are worth
// separating: a correct pure function nobody calls rings exactly as often as a
// broken one.

type TestStore = WorkspaceSlice & NotificationSlice & QuotaSlice;

function makeStore() {
  return create<TestStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createNotificationSlice(...args),
    ...createQuotaSlice(...args),
  }));
}

/** The tool's JSON, not the parsed shape — this is the boundary being tested. */
const raw = (fivePct: number | null, resetsAt = 1788618000) => ({
  bays: [{
    id: 'claude', nhan: 'CC',
    five_hour: fivePct == null ? null : { pct: fivePct, resets_at: resetsAt },
    seven_day: { pct: 10, resets_at: 1789002000 },
    status: 'ok', reason: '',
  }],
});

describe('quota-slice → the bell', () => {
  let useStore: ReturnType<typeof makeStore>;

  beforeEach(() => {
    __resetQuotaAlertMemory();
    useStore = makeStore();
    useStore.getState().createWorkspace({ title: 'Test WS' });
  });

  it('stays silent below the threshold', () => {
    useStore.getState().setQuotaRaw(raw(70));
    expect(useStore.getState().notifications).toHaveLength(0);
    expect(useStore.getState().quota?.bays[0].fiveHour.pct).toBe(70);
  });

  it('rings once when a window crosses 80%, and not again as it climbs', () => {
    const s = () => useStore.getState();
    s().setQuotaRaw(raw(85));
    expect(s().notifications).toHaveLength(1);
    expect(s().notifications[0].title).toContain('CC');

    s().setQuotaRaw(raw(88));
    s().setQuotaRaw(raw(91));
    expect(s().notifications).toHaveLength(1);
  });

  it('rings a second time at 95%', () => {
    const s = () => useStore.getState();
    s().setQuotaRaw(raw(85));
    s().setQuotaRaw(raw(96));
    expect(s().notifications).toHaveLength(2);
    expect(s().notifications[1].title).toContain('96%');
  });

  it('counts against the workspace, so the sidebar shows something happened', () => {
    const s = () => useStore.getState();
    s().setQuotaRaw(raw(85));
    expect(s().workspaces[0].unreadCount).toBe(1);
  });

  it('still stores the reading when there is no workspace to hang an alert on', () => {
    // Quota arrives on a timer that can tick before the first workspace exists.
    // The banner must still get its numbers; only the bell has nowhere to go.
    const empty = create<TestStore>()((...args) => ({
      ...createWorkspaceSlice(...args),
      ...createNotificationSlice(...args),
      ...createQuotaSlice(...args),
    }));
    __resetQuotaAlertMemory();
    empty.getState().setQuotaRaw(raw(91));
    expect(empty.getState().quota?.bays[0].fiveHour.pct).toBe(91);
    expect(empty.getState().notifications).toHaveLength(0);
  });

  it('SURVIVES the focused pane being marked read — the bug the unit tests missed', () => {
    // Found by opening the app, not here. The alert used to be filed against
    // the focused pane's active surface, and `PaneWrapper` marks every surface
    // of a pane read the moment that pane takes focus — so the alert arrived
    // and was cleared in the same breath. The store held it with `read: true`
    // and the bell stayed dark. Every test above still passed: they count at
    // the moment of firing, which is exactly the moment before the bug.
    const s = () => useStore.getState();
    s().setQuotaRaw(raw(91));
    expect(s().notifications).toHaveLength(1);
    expect(s().notifications[0].read).toBe(false);

    // Every surface any pane could hold, marked read.
    for (const surfaceId of ['surf-1', 'surf-2', 'surf-3'] as any[]) s().markRead(surfaceId);

    expect(s().notifications[0].read).toBe(false);
    expect(s().workspaces[0].unreadCount).toBe(1);
  });

  it('never rings on a reading the tool could not take', () => {
    const s = () => useStore.getState();
    s().setQuotaRaw(raw(null));
    expect(s().notifications).toHaveLength(0);
  });
});

// ─── the thresholds Settings owns actually reaching the bell ─────────────────
//
// The pure function is pinned in `quota-alerts.test.ts`; what can rot here is
// the wiring. Two numbers that a Settings box writes and nothing reads look
// exactly like two numbers that work, right up until the bell rings at 80 for
// somebody who asked for 60.

type PrefStore = TestStore & SettingsSlice;

function makeStoreWithSettings() {
  return create<PrefStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createNotificationSlice(...args),
    ...createSettingsSlice(...args),
    ...createQuotaSlice(...args),
  }));
}

describe('quota-slice → the thresholds from Settings', () => {
  let useStore: ReturnType<typeof makeStoreWithSettings>;

  beforeEach(() => {
    __resetQuotaAlertMemory();
    useStore = makeStoreWithSettings();
    useStore.getState().createWorkspace({ title: 'Test WS' });
  });

  it('ships with 80/95, so nobody who never opens Settings notices a change', () => {
    const s = () => useStore.getState();
    expect(s().notificationPrefs.quotaWarnPct).toBe(80);
    expect(s().notificationPrefs.quotaAlertPct).toBe(95);
    s().setQuotaRaw(raw(79));
    expect(s().notifications).toHaveLength(0);
    s().setQuotaRaw(raw(81));
    expect(s().notifications).toHaveLength(1);
  });

  it('rings on the number the user set, not on 80', () => {
    const s = () => useStore.getState();
    s().setNotificationPrefs({ quotaWarnPct: 60, quotaAlertPct: 70 });
    s().setQuotaRaw(raw(62));
    expect(s().notifications).toHaveLength(1);
    expect(s().notifications[0].title).toContain('62%');
  });

  it('takes a threshold change on the NEXT reading, not the next launch', () => {
    // The moment somebody edits these is usually the moment they are watching a
    // number climb, so a value captured once at startup would be useless
    // exactly when it is being changed.
    const s = () => useStore.getState();
    s().setQuotaRaw(raw(62));
    expect(s().notifications).toHaveLength(0);

    s().setNotificationPrefs({ quotaWarnPct: 60 });
    s().setQuotaRaw(raw(63));
    expect(s().notifications).toHaveLength(1);
  });

  it('reads an inverted pair in the order it obviously means', () => {
    const s = () => useStore.getState();
    s().setNotificationPrefs({ quotaWarnPct: 70, quotaAlertPct: 60 });
    s().setQuotaRaw(raw(62));
    expect(s().notifications).toHaveLength(1);          // the 60 rung, not the 70
    expect(s().notifications[0].text).not.toContain('Gần cạn');
    s().setQuotaRaw(raw(71));
    expect(s().notifications).toHaveLength(2);
    expect(s().notifications[1].text).toContain('Gần cạn');
  });

  it('a settings file with garbage in it still rings at the default', () => {
    // `settings.json` has a second writer: a person with an editor. A field
    // that is not a number is not an instruction, so it falls back — and it
    // falls back ALONE, without taking the good field with it.
    const s = () => useStore.getState();
    s().setNotificationPrefs({ quotaWarnPct: 'x' as any, quotaAlertPct: undefined as any });
    s().setQuotaRaw(raw(79));
    expect(s().notifications).toHaveLength(0);
    s().setQuotaRaw(raw(81));
    expect(s().notifications).toHaveLength(1);
  });

  it('a threshold above 100 is pulled back to 100 rather than silencing the bell', () => {
    // The only genuinely unreachable value. Left alone it would be a bell that
    // never rings and never explains itself — the failure nobody notices.
    const s = () => useStore.getState();
    s().setNotificationPrefs({ quotaWarnPct: 400 as any, quotaAlertPct: 900 as any });
    s().setQuotaRaw(raw(100));
    expect(s().notifications).toHaveLength(1);
  });
});
