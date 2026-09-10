/**
 * cdp-reconcile.ts — the renderer declares which browser surfaces really exist.
 *
 * A CDP target is ended by exactly one thing: `CDP_SURFACE_GONE`, sent from the
 * store actions that close a pane. That is right, and it is not enough. Startup
 * mounts the DEFAULT workspace tree — BrowserPanes and all, each one attaching a
 * target — and then replaces it wholesale with the tree restored from the last
 * session. The replaced panes never pass through a close action, so nothing ever
 * tells the proxy they are gone and their targets outlive them. Measured moments
 * after launch: 5 targets against 2 real browser panes.
 *
 * So alongside the event ("this pane closed") there is a statement of fact
 * ("these are the panes that exist"), and main drops whatever is not in it. The
 * precedent is `reconcileOrphanSessions` in `agent-browser-runtime.ts`, which
 * exists because one crash reaches no teardown path either.
 *
 * ⚠ The list must be computed AT SEND TIME, never captured and sent later. IPC
 * from one renderer arrives in order, so a list built now and sent now can only
 * omit surfaces that have not attached yet — harmless, they own no target. A
 * list built now and sent after a debounce can arrive AFTER the attach of a
 * surface it predates, and would then kill a pane that just opened.
 */
import { SplitNode, SurfaceRef, WorkspaceInfo } from '../../shared/types';

function collect(node: SplitNode, out: string[]): void {
  if (node.type === 'leaf') {
    for (const surface of node.surfaces as SurfaceRef[]) {
      if (surface.type === 'browser') out.push(surface.id);
    }
    return;
  }
  collect(node.children[0], out);
  collect(node.children[1], out);
}

/**
 * The surface id of a workspace's side browser panel.
 *
 * ONE producer, deliberately. This panel is a real `BrowserPane` that lives
 * OUTSIDE the split tree, so a sweep that walked only the tree would call it a
 * ghost and destroy the CDP target of a browser the user is looking at —
 * measured, on the first run of the rig, before this existed. Anything that
 * mints this id by hand re-opens that hole the moment the scheme changes on
 * one side only.
 */
export function browserPanelSurfaceId(workspaceId: string): string {
  return `browser-${workspaceId}`;
}

/**
 * Every browser surface that exists right now.
 *
 * ALL workspaces, not just the active one: a background workspace's browser
 * pane is unmounted but absolutely not closed, and reporting only the active
 * one would have main destroy the targets of every pane the user is not
 * currently looking at.
 *
 * `panelOpen` is the side panel's mounted state, and it is a real input rather
 * than a convenience. With the panel open, EVERY workspace's panel is mounted
 * (only the active one is visible), so all of them are alive. With it closed,
 * none is mounted and none is driveable — reopening remounts and re-attaches,
 * which is a fresh target, so keeping the old one alive would only preserve a
 * handle nothing can use.
 */
export function browserSurfaceIds(
  workspaces: readonly WorkspaceInfo[],
  panelOpen: boolean,
): string[] {
  const out: string[] = [];
  for (const ws of workspaces) {
    collect(ws.splitTree, out);
    if (panelOpen) out.push(browserPanelSurfaceId(ws.id));
  }
  return out;
}

/**
 * Tell main the current truth. Safe to call as often as the layout changes —
 * the sweep is a set difference, and a list that matches is a no-op.
 */
export function declareLiveBrowserSurfaces(
  workspaces: readonly WorkspaceInfo[],
  panelOpen: boolean,
): void {
  try {
    (globalThis as {
      window?: { wmux?: { cdp?: { surfacesAlive?: (ids: string[]) => void } } };
    }).window?.wmux?.cdp?.surfacesAlive?.(browserSurfaceIds(workspaces, panelOpen));
  } catch {
    /* preload/window unavailable (tests) — nothing to tell */
  }
}
