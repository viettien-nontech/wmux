/**
 * The one place a notification both lights the in-app bell and leaves the window.
 *
 * It used to live in `App.tsx`, where its comment already called it "the single
 * place that both adds the in-app bell entry and raises the OS toast". That was
 * true only of the agent events App.tsx handles. Quota alerts, raised from
 * `quota-slice`, called `addNotification` on their own and therefore never
 * reached the OS: no toast, no taskbar flash, no sound — the bell lit in a
 * window nobody was looking at, which is the entire situation a quota alert
 * exists for. You are typing in a pane; the sidebar is a strip of colour in the
 * corner of your eye.
 *
 * A slice cannot import from `App.tsx` (App imports the store), so the
 * chokepoint moved here rather than being duplicated. Duplicating it is how the
 * two paths drifted apart in the first place.
 */

import type { SurfaceId, WorkspaceId } from '../shared/types';
import type { NotificationPrefs } from './store/settings-slice';

type AddNotification = (n: { surfaceId: SurfaceId; workspaceId: WorkspaceId; text: string; title?: string }) => void;

/**
 * `window` via `globalThis`, because this module is imported by store slices
 * that are constructed in `environment: 'node'` tests — where a bare `window`
 * is a ReferenceError rather than undefined, and would take the whole store
 * down with it.
 */
/**
 * Which ways a notification is allowed to leave the window.
 *
 * These two switches live in the renderer store, and both things they govern
 * happen in MAIN, which has no copy of the prefs — so the decision travels with
 * the notification. It is the mirror of how sound already worked: main asks the
 * renderer to play, because only the renderer knows the sound preference.
 *
 * They were declared, drawn in Settings, persisted, and read by NOTHING before
 * this. A switch that does nothing is worse than a missing one — the user
 * believes they have already told the app, so when it carries on they conclude
 * something else is broken, and they are right to.
 */
export interface NotificationChannels {
  toast: boolean;
  taskbarFlash: boolean;
}

/**
 * Absent means ON, per field. A settings blob written before these were honoured
 * holds no opinion, and no opinion must never silence a notification — that is
 * the failure nobody notices, because its symptom is an absence.
 */
export function notificationChannels(prefs: NotificationPrefs | undefined): NotificationChannels {
  return {
    toast: prefs?.toast !== false,
    taskbarFlash: prefs?.taskbarFlash !== false,
  };
}

function osNotify(data: {
  surfaceId: string;
  text: string;
  title?: string;
  toast?: boolean;
  taskbarFlash?: boolean;
}): void {
  try {
    (globalThis as { window?: { wmux?: { notification?: { fire?: (d: typeof data) => void } } } })
      .window?.wmux?.notification?.fire?.(data);
  } catch {
    /* Fire-and-forget over IPC. A toast that could not be raised must not stop
       the bell entry that was already recorded. */
  }
}

/**
 * Record a notification and raise it outside the window.
 *
 * `title` is optional, and the asymmetry in how it is defaulted is deliberate:
 *
 * - The OS toast falls back to `'wmux'`, which is what the agent path has
 *   always sent — its text already names the pane, so the title carries
 *   nothing, and a toast has to say something.
 * - The bell entry gets NO title unless one was given. Agent entries have never
 *   had one, and quietly stamping every row in the notification panel with
 *   "wmux" would change what the panel looks like for a reason nobody asked
 *   for.
 *
 * Quota passes its own, because a toast reading only "wmux" would drop the two
 * things that make it actionable: which bay, and which window.
 */
export function fireNotification(
  surfaceId: string,
  workspaceId: WorkspaceId | null,
  text: string,
  addNotification: AddNotification,
  title?: string,
  channels?: NotificationChannels,
): void {
  if (workspaceId) {
    addNotification({
      surfaceId: (surfaceId || '') as SurfaceId,
      workspaceId,
      text,
      ...(title ? { title } : {}),
    });
  }
  /* The bell entry above is recorded whatever the channels say. These switches
     govern how a notification LEAVES the window, never whether it happened —
     dropping the record too would make "no toasts" quietly mean "no history",
     which is a different feature nobody asked for.

     Omitted entirely rather than defaulted here, so that main can tell "a
     caller with no prefs" from "a caller who said yes". `surface.trigger_flash`
     is fired by main itself and has neither. */
  osNotify({ surfaceId: surfaceId || '', text, title: title || 'wmux', ...(channels ?? {}) });
}
