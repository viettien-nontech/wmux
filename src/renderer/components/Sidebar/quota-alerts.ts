/**
 * Turning the quota reading into an alert that rings once.
 *
 * The banner already colours a window at 80% (`isNearLimit`), and that was the
 * whole warning: a passive one, which exists only while somebody is looking at
 * the sidebar. On 2026-09-05 a session ran to 92% of its 5-hour window mid-task
 * and found out by running the tool by hand — it had been typing in a terminal
 * pane, where the sidebar is a strip of colour in the corner of the eye.
 *
 * So: same numbers, active signal. Nothing here polls or notifies; it decides,
 * and `quota-slice.ts` does both of those with the answer.
 *
 * A pure function of (what has already been announced, what the tool just
 * said), rather than a `useEffect` comparing against a ref, because the one
 * rule this must never break — ring once, not on every poll — would then live
 * in the part of the app that is hardest to test. Here it is a table of
 * sequences.
 */

import type { QuotaState, QuotaWindow } from './quota';
import type { SplitNode, SurfaceId, WorkspaceId } from '../../../shared/types';

/** Announce at these, high to low. The 80 is deliberately the same number
 *  `isNearLimit` colours on, so the badge and the bell never disagree. */
const THRESHOLDS = [95, 80] as const;

const WINDOWS = [
  { key: 'fiveHour', label: '5h' },
  { key: 'sevenDay', label: 'Weekly' },
] as const;

export interface QuotaAlert {
  bayId: string;
  /** The two-letter label the tool chose, e.g. `CC`. */
  bayLabel: string;
  windowKey: 'fiveHour' | 'sevenDay';
  windowLabel: string;
  /** Which threshold was crossed: 80 or 95. */
  threshold: number;
  /** The reading that crossed it. */
  pct: number;
  resetsAt: number | null;
  title: string;
  text: string;
}

/**
 * Highest threshold already announced for a window, and which cycle that was.
 *
 * The cycle is a FIELD, not part of the key, and the reason is a bug a review
 * caught: when a window expires the tool sends `five_hour: null` — the whole
 * object, not an object with a null `pct` — so `resetsAt` goes missing at the
 * same instant `pct` does. With `resetsAt` in the key, a blind reading was
 * filed under `bay:window:unknown` while the real cycle's entry, present in no
 * key touched that round, was dropped from the rebuilt memory. The number
 * coming back for the SAME cycle then looked like a first sighting and rang
 * again. Codex sits in that shape most of the time, and any transient failure
 * of the tool puts every bay there for a tick.
 *
 * Keyed on (bay, window) alone, the memory also has an exact bound — two
 * entries per bay, forever — instead of one per cycle that has to be swept.
 */
export interface AlertMark {
  /** Highest threshold announced for `cycle`. */
  announced: number;
  /** `resetsAt` of the window this was announced for; null when unknown. */
  cycle: number | null;
}

export type AlertMemory = Record<string, AlertMark>;

const windowKeyOf = (bayId: string, windowKey: string): string => `${bayId}:${windowKey}`;

/** The highest threshold this reading is at or above, or 0 for none. */
function crossedBy(pct: number): number {
  return THRESHOLDS.find((t) => pct >= t) ?? 0;
}

function hhmm(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * User-facing wording. Vietnamese, matching the `cũ` badge already in the
 * banner — this fork is read in Vietnamese, and one row saying `cũ` beside a
 * bell saying "stale" is the kind of split the project spends its effort
 * avoiding.
 */
function wording(bayLabel: string, windowLabel: string, pct: number, resetsAt: number | null) {
  const when = resetsAt != null ? ` · mở lại ${hhmm(resetsAt)}` : '';
  return {
    title: `${bayLabel} ${windowLabel} ${pct}%`,
    text: pct >= 95
      ? `Gần cạn: cửa ${windowLabel} của ${bayLabel} đã dùng ${pct}%${when}`
      : `Cửa ${windowLabel} của ${bayLabel} đã dùng ${pct}%${when}`,
  };
}

/**
 * What to ring about, given what has already been rung about.
 *
 * Returns a NEW memory rather than mutating the old one, and that memory holds
 * only the cycles present in this reading — a rollover every five hours would
 * otherwise leak one entry per window, forever.
 */
export function quotaAlerts(
  memory: AlertMemory,
  state: QuotaState,
): { alerts: QuotaAlert[]; memory: AlertMemory } {
  const alerts: QuotaAlert[] = [];
  const next: AlertMemory = {};

  for (const bay of state.bays ?? []) {
    for (const { key, label } of WINDOWS) {
      const w: QuotaWindow | undefined = bay[key];
      const pct = w?.pct ?? null;
      const resetsAt = w?.resetsAt ?? null;
      const k = windowKeyOf(bay.id, key);
      const mark = memory[k];

      /* No number is not a low number, and it is not a new cycle either. A
         blind reading says nothing about which five hours this is, so the mark
         travels through untouched — the alternative is ringing again for a
         cycle already announced, the moment the tool recovers. */
      if (pct == null) {
        if (mark) next[k] = mark;
        continue;
      }

      /* A different `resetsAt` is a different five hours, so whatever was
         announced belongs to a window that is over. */
      const announced = mark && mark.cycle === resetsAt ? mark.announced : 0;
      const crossed = crossedBy(pct);

      if (crossed > announced) {
        alerts.push({
          bayId: bay.id,
          bayLabel: bay.label,
          windowKey: key,
          windowLabel: label,
          threshold: crossed,
          pct,
          resetsAt,
          ...wording(bay.label, label, pct, resetsAt),
        });
      }

      /* Written even when `crossed` is 0, so a reading that FELL back below a
         threshold lowers the mark and can ring again inside the same cycle.
         Not only theoretical: the tool reads files an agent writes, and a
         window can genuinely read lower than it did a moment ago. */
      next[k] = { announced: crossed, cycle: resetsAt };
    }
  }

  return { alerts, memory: next };
}

/**
 * The surface a quota alert is filed under. Owned by no pane, on purpose.
 *
 * `NotificationInfo` requires a surface, because everything that had ever fired
 * one was something a pane did. Quota is not: three Claude panes share one
 * 5-hour window, which is why the banner is a single row rather than one per
 * pane. There is no correct pane — and picking a plausible one is worse than
 * having none.
 *
 * FOUND BY RUNNING THE APP, not by a test. The first version filed the alert
 * against the focused pane's active surface. `PaneWrapper` marks every surface
 * of a pane read the moment that pane takes focus, and the focused pane is
 * exactly the one that was picked, so the alert arrived and was marked read in
 * the same breath: the store held it, `read: true`, and the bell never lit. The
 * unit tests all passed — they count notifications at the moment of firing,
 * which is precisely the moment before the bug happens.
 *
 * An id no pane can hold means no focus transition can ever match it. Clicking
 * the row in the panel still works: the jump handler finds no pane, so it
 * selects the workspace and marks that one notification read — dismissal, which
 * is the only sensible action for an account-wide fact anyway.
 */
export const QUOTA_ALERT_SURFACE = 'quota' as SurfaceId;

/**
 * Which workspace an account-wide alert is filed under: the one the user is in,
 * so the sidebar's unread count appears where they are looking.
 */
export function alertTarget(
  workspaces: { id: WorkspaceId; splitTree: SplitNode }[],
  activeWorkspaceId: WorkspaceId | null,
): { workspaceId: WorkspaceId; surfaceId: SurfaceId } | null {
  const ws = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  if (!ws) return null;
  return { workspaceId: ws.id, surfaceId: QUOTA_ALERT_SURFACE };
}
