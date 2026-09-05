import { StateCreator } from 'zustand';
import { parseQuota, quotaThresholds, QuotaState } from '../components/Sidebar/quota';
import { quotaAlerts, alertTarget, type AlertMemory } from '../components/Sidebar/quota-alerts';
import { NotificationSlice } from './notification-slice';
import { SettingsSlice } from './settings-slice';
import { WorkspaceSlice } from './workspace-slice';

export interface QuotaSlice {
  quota: QuotaState | null;
  setQuotaRaw: (raw: unknown) => void;
}

/**
 * The alert memory is module state, not store state, on purpose.
 *
 * It changes on every poll and nothing renders it, so putting it in the store
 * would re-render every quota subscriber on a tick that has nothing new to
 * show — the same reason the prompt anchor's pending-line count lives in a
 * module map rather than a slice. It is also not worth persisting: on a fresh
 * launch an empty memory is exactly right, because a window already past 80%
 * is precisely when the user has not been told yet.
 */
let alertMemory: AlertMemory = {};

/** Test seam: start from a known memory. Not used by the app. */
export function __resetQuotaAlertMemory(): void {
  alertMemory = {};
}

export const createQuotaSlice: StateCreator<
  QuotaSlice & NotificationSlice & SettingsSlice & WorkspaceSlice,
  [],
  [],
  QuotaSlice
> = (set, get) => ({
  quota: null,
  setQuotaRaw(raw: unknown): void {
    const quota = parseQuota(raw);
    set({ quota });

    /* Thresholds read on every poll rather than captured once, so changing
       them in Settings takes effect on the next reading instead of the next
       launch — the moment somebody edits these is usually the moment they are
       watching a number climb. */
    const prefs = get().notificationPrefs;

    /* Ring after the store holds the new numbers, so a listener woken by the
       notification reads the reading it is about rather than the one before. */
    const { alerts, memory } = quotaAlerts(
      alertMemory,
      quota,
      quotaThresholds(prefs?.quotaWarnPct, prefs?.quotaAlertPct),
    );
    alertMemory = memory;
    if (alerts.length === 0) return;

    const state = get();
    const target = alertTarget(state.workspaces, state.activeWorkspaceId);
    if (!target) return;

    for (const a of alerts) {
      state.addNotification({ ...target, text: a.text, title: a.title });
    }
  },
});
