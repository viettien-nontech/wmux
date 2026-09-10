import { describe, it, expect, vi } from 'vitest';

/**
 * GHOST TARGETS: a CDP target that outlives the pane it belonged to (issue #111
 * in BAN_GIAO — a regression introduced by the fix for the opposite bug).
 *
 * Making `detachTarget` stop killing targets was right: a React unmount is not a
 * close, and destroying on it took every OTHER pane's target down with it. But
 * it left exactly one way for a target to die — `CDP_SURFACE_GONE`, fired from
 * the store's close actions — and startup does not use it. The default
 * workspace tree mounts, its BrowserPanes attach, and then the RESTORED tree
 * replaces the whole thing: those panes vanish without passing through any close
 * path, so nothing ever tells the proxy they are gone. Measured twice on the
 * running app, moments after launch:
 *
 *     3 targets / 0 real browser surfaces
 *     5 targets / 2 real browser surfaces
 *
 * The fix is a RECONCILIATION, on the precedent of `reconcileOrphanSessions`:
 * the renderer — the only side that knows which surfaces actually exist —
 * declares the live browser surfaces, and the proxy drops every target whose
 * surface is not among them.
 *
 * ⚠ The trap these tests exist to avoid: the obvious sweep keys on ATTACHMENT
 * ("no webContents ⇒ dead"), and that reintroduces the very bug the detach
 * change fixed, because a pane mid-remount is detached and perfectly alive.
 * Liveness here means "the renderer still lists this surface" and nothing else,
 * so both directions are pinned below.
 */

vi.mock('electron', () => ({
  webContents: { fromId: () => undefined },
}));

import { CDPProxy, danhSachSurfaceHopLe } from '../../src/main/cdp-proxy';
import { TargetRegistry } from '../../src/main/cdp-target-registry';
import { browserSurfaceIds, browserPanelSurfaceId } from '../../src/renderer/store/cdp-reconcile';
import type { SplitNode, WorkspaceInfo } from '../../src/shared/types';

/** Records what a connected CDP client is told, so a silent drop fails loudly. */
function fakeClient() {
  const removed: string[] = [];
  return {
    client: {
      onTargetAdded: () => {},
      onTargetRemoved: (_wcId: number, targetId: string) => { removed.push(targetId); },
      onTargetRebound: () => {},
      onTargetUnbound: () => {},
    },
    removed,
  };
}

/** The proxy only accepts browser clients from a live socket; tests need one
 *  without standing a server up, and the set is the whole seam. */
function withClient(proxy: CDPProxy) {
  const spy = fakeClient();
  (proxy as unknown as { browserClients: Set<unknown> }).browserClients.add(spy.client);
  return spy;
}

describe('TargetRegistry.surfaceIds', () => {
  it('lists every surface that still owns a target, attached or not', () => {
    const reg = new TargetRegistry();
    reg.bind('s1', 10);
    reg.bind('s2', 11);
    reg.unbind(11); // s2 is mid-remount: no webContents, still very much alive
    expect(new Set(reg.surfaceIds())).toEqual(new Set(['s1', 's2']));
  });

  it('forgets a surface once it is really gone', () => {
    const reg = new TargetRegistry();
    reg.bind('s1', 10);
    reg.surfaceGone('s1');
    expect(reg.surfaceIds()).toEqual([]);
  });
});

describe('CDPProxy.reconcileSurfaces', () => {
  it('drops a target whose surface the renderer no longer lists', () => {
    const proxy = new CDPProxy();
    const spy = withClient(proxy);
    proxy.addTarget(10, 's-live');
    proxy.addTarget(11, 's-ghost');
    const ghostId = proxy.targetIdFor(11);

    const dropped = proxy.reconcileSurfaces(['s-live']);

    expect(dropped).toEqual([ghostId]);
    expect(spy.removed).toEqual([ghostId]);
    expect(proxy.attachedTargets).toEqual([10]);
    expect(proxy.targetIdFor(11)).toBeNull();
  });

  it('drops a ghost that is still ATTACHED — liveness is the surface, not the webContents', () => {
    /*
     * The measured ghosts were attached: their guest webContents outlived the
     * pane by minutes, so they kept answering `/json/list` with a real title.
     * A sweep that only collected detached targets would have found NOTHING
     * and reported the leak fixed.
     */
    const proxy = new CDPProxy();
    proxy.addTarget(10, 's-ghost');
    expect(proxy.attachedTargets).toEqual([10]);

    proxy.reconcileSurfaces([]);

    expect(proxy.attachedTargets).toEqual([]);
  });

  it('KEEPS a live surface that is merely detached mid-remount', () => {
    /*
     * The other direction, and the expensive one: this is the exact state a
     * pane passes through on every split-tree restructure. Dropping here is
     * the bug the detach change was made to fix, wearing a new hat.
     */
    const proxy = new CDPProxy();
    const spy = withClient(proxy);
    proxy.addTarget(10, 's1');
    const targetId = proxy.targetIdFor(10);
    proxy.detachTarget(10); // unmount half of a remount

    proxy.reconcileSurfaces(['s1']);

    expect(spy.removed).toEqual([]);
    proxy.addTarget(12, 's1'); // remount lands on a fresh webContents
    expect(proxy.targetIdFor(12)).toBe(targetId);
  });

  it('is a no-op when every target has a surface', () => {
    const proxy = new CDPProxy();
    const spy = withClient(proxy);
    proxy.addTarget(10, 's1');
    proxy.addTarget(11, 's2');

    expect(proxy.reconcileSurfaces(['s1', 's2', 's3'])).toEqual([]);
    expect(spy.removed).toEqual([]);
    expect(proxy.attachedTargets).toEqual([10, 11]);
  });

  it('never touches a target belonging to ANOTHER window', () => {
    /*
     * Found in review, and it is the "window ≠ workspace" mistake again. The
     * proxy is one object for the whole app while a renderer knows only its own
     * workspaces, so window A's list says nothing whatsoever about window B's
     * panes. Without scoping, opening a second window and touching its layout
     * announced `targetDestroyed` for every browser pane in the first.
     */
    const proxy = new CDPProxy();
    const spy = withClient(proxy);
    proxy.addTarget(10, 's-cuaA', 100);
    proxy.addTarget(11, 's-cuaB', 200);
    const cuaA = proxy.targetIdFor(10);
    const cuaB = proxy.targetIdFor(11);

    // Window A restructures and now has nothing. It speaks only for itself.
    expect(proxy.reconcileSurfaces([], 100)).toEqual([cuaA]);
    expect(spy.removed).toEqual([cuaA]);
    expect(proxy.targetIdFor(11)).toBe(cuaB);
    expect(proxy.attachedTargets).toEqual([11]);
  });

  it('ends a window\'s targets when the window itself dies', () => {
    /*
     * The other half of scoping, and it has to exist: once nobody speaks for a
     * closed window's surfaces, no later list can name them, so they would sit
     * in the registry forever — the same leak this whole change is about. A
     * window's death is unambiguous in the way an unmount is not.
     */
    const proxy = new CDPProxy();
    const spy = withClient(proxy);
    proxy.addTarget(10, 's-cuaA', 100);
    proxy.addTarget(11, 's-cuaB', 200);
    const cuaA = proxy.targetIdFor(10);

    expect(proxy.windowGone(100)).toEqual([cuaA]);
    expect(spy.removed).toEqual([cuaA]);
    expect(proxy.attachedTargets).toEqual([11]);
  });

  it('leaves an owner-less surface alone rather than guessing', () => {
    const proxy = new CDPProxy();
    proxy.addTarget(10, 's-khong-chu'); // registered before owners were tracked
    expect(proxy.reconcileSurfaces([], 100)).toEqual([]);
    expect(proxy.attachedTargets).toEqual([10]);
  });

  it('reports state that tells a ghost from a detached pane', () => {
    /*
     * `/json/list` cannot answer this: since the identity change it lists only
     * ATTACHED targets, so "gone" and "detached" read identically through it —
     * the measuring stick was broken in exactly the place the investigation
     * needed to measure. `snapshot()` is the one that distinguishes them.
     */
    const proxy = new CDPProxy();
    proxy.addTarget(10, 's-attached');
    proxy.addTarget(11, 's-detached');
    proxy.detachTarget(11);

    const snap = proxy.snapshot();
    const bySurface = new Map(snap.map((row) => [row.surfaceId, row]));

    expect(snap).toHaveLength(2);
    expect(bySurface.get('s-attached')).toMatchObject({ wcId: 10, attached: true });
    expect(bySurface.get('s-detached')).toMatchObject({ wcId: null, attached: false });
    // Both still EXIST — the distinction the old measurement could not make.
    expect(bySurface.get('s-detached')?.targetId).toBeTruthy();
  });
});

describe('danhSachSurfaceHopLe (the IPC boundary)', () => {
  it('accepts a list of non-empty strings, including the empty list', () => {
    expect(danhSachSurfaceHopLe([])).toEqual([]);
    expect(danhSachSurfaceHopLe(['s1', 's2'])).toEqual(['s1', 's2']);
  });

  it('refuses a malformed list WHOLE rather than filtering it', () => {
    /*
     * Found in review, and the reason is what the list MEANS: it is a complete
     * statement, so a cleaned-up `[null]` becomes "nothing is alive" and closes
     * every target, and `['s1', null]` becomes "only s1 is alive" and closes
     * the rest. Both look like a successful sweep from every side.
     */
    expect(danhSachSurfaceHopLe([null])).toBeNull();
    expect(danhSachSurfaceHopLe(['s1', null])).toBeNull();
    expect(danhSachSurfaceHopLe([123])).toBeNull();
    expect(danhSachSurfaceHopLe([''])).toBeNull();
    expect(danhSachSurfaceHopLe(['s1', {}])).toBeNull();
  });

  it('refuses anything that is not a list at all', () => {
    expect(danhSachSurfaceHopLe(undefined)).toBeNull();
    expect(danhSachSurfaceHopLe(null)).toBeNull();
    expect(danhSachSurfaceHopLe('s1')).toBeNull();
    expect(danhSachSurfaceHopLe({ 0: 's1', length: 1 })).toBeNull();
  });
});

describe('browserSurfaceIds (what the renderer declares)', () => {
  const leaf = (surfaces: Array<{ id: string; type: string }>): SplitNode =>
    ({ type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id } as unknown as SplitNode);

  const ws = (id: string, tree: SplitNode): WorkspaceInfo =>
    ({ id, title: id, pinned: false, shell: '', splitTree: tree, unreadCount: 0 } as unknown as WorkspaceInfo);

  it('collects browser surfaces from every workspace, not just the active one', () => {
    const a = ws('w1', leaf([{ id: 'b1', type: 'browser' }, { id: 't1', type: 'terminal' }]));
    const b = ws('w2', leaf([{ id: 'b2', type: 'browser' }]));
    expect(new Set(browserSurfaceIds([a, b], false))).toEqual(new Set(['b1', 'b2']));
  });

  it('walks nested splits', () => {
    const nested = {
      type: 'split',
      children: [leaf([{ id: 'b1', type: 'browser' }]), leaf([{ id: 'b2', type: 'browser' }])],
    } as unknown as SplitNode;
    expect(new Set(browserSurfaceIds([ws('w1', nested)], false))).toEqual(new Set(['b1', 'b2']));
  });

  it('includes every workspace SIDE PANEL while the panel is open', () => {
    /*
     * The bug the rig caught before this shipped. The side browser panel is a
     * real BrowserPane per workspace, mounted outside the split tree — with the
     * panel open it holds a live CDP target, and a list built from the tree
     * alone declared it dead. Measured: 3 ghosts reported against 1 real pane,
     * two of them open panels.
     */
    const a = ws('w1', leaf([{ id: 't1', type: 'terminal' }]));
    const b = ws('w2', leaf([{ id: 'b2', type: 'browser' }]));

    expect(new Set(browserSurfaceIds([a, b], true))).toEqual(
      new Set(['b2', browserPanelSurfaceId('w1'), browserPanelSurfaceId('w2')]),
    );
    // Closed: nothing is mounted, so nothing is driveable and reopening
    // re-attaches as a fresh target.
    expect(browserSurfaceIds([a, b], false)).toEqual(['b2']);
  });

  it('mints the panel id in ONE place, so the sweep and the mount cannot drift', () => {
    expect(browserPanelSurfaceId('ws-abc')).toBe('browser-ws-abc');
  });

  it('ignores non-browser surfaces entirely', () => {
    const t = ws('w1', leaf([{ id: 't1', type: 'terminal' }, { id: 'm1', type: 'markdown' }]));
    expect(browserSurfaceIds([t], false)).toEqual([]);
  });
});
