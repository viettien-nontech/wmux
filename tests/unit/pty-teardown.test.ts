import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { killSurfacePty, killTreeTerminalPtys } from '../../src/renderer/store/pty-teardown';
import { SplitNode, SurfaceRef, SurfaceId, PaneId } from '../../src/shared/types';

// Regression coverage for issue #65: PTY teardown must run on every destructive
// close transition. These helpers are the shared reaping primitives the store
// actions call. They read window.wmux.pty.kill, which we mock here.

const term = (id: string): SurfaceRef => ({ id: id as SurfaceId, type: 'terminal' });
const browser = (id: string): SurfaceRef => ({ id: id as SurfaceId, type: 'browser' });
const leaf = (paneId: string, surfaces: SurfaceRef[]): SplitNode => ({
  type: 'leaf',
  paneId: paneId as PaneId,
  surfaces,
  activeSurfaceIndex: 0,
});

describe('pty-teardown', () => {
  let kill: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    kill = vi.fn();
    (globalThis as any).window = { wmux: { pty: { kill } } };
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it('kills the PTY of a terminal surface', () => {
    killSurfacePty(term('surf-1'));
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('surf-1');
  });

  it('does NOT kill non-terminal surfaces (no PTY to reap)', () => {
    killSurfacePty(browser('surf-b'));
    killSurfacePty({ id: 'surf-d' as SurfaceId, type: 'diff' });
    killSurfacePty({ id: 'surf-m' as SurfaceId, type: 'markdown' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('walks a split tree and kills every terminal, skipping non-terminals', () => {
    const tree: SplitNode = {
      type: 'branch',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        leaf('pane-1', [term('surf-1'), browser('surf-b'), term('surf-2')]),
        {
          type: 'branch',
          direction: 'vertical',
          ratio: 0.5,
          children: [
            leaf('pane-2', [term('surf-3')]),
            leaf('pane-3', [{ id: 'surf-md' as SurfaceId, type: 'markdown' }]),
          ],
        },
      ],
    };

    killTreeTerminalPtys(tree);

    expect(kill).toHaveBeenCalledTimes(3);
    expect(kill).toHaveBeenCalledWith('surf-1');
    expect(kill).toHaveBeenCalledWith('surf-2');
    expect(kill).toHaveBeenCalledWith('surf-3');
    expect(kill).not.toHaveBeenCalledWith('surf-b');
    expect(kill).not.toHaveBeenCalledWith('surf-md');
  });

  it('is a safe no-op when window/preload is unavailable (Node context)', () => {
    delete (globalThis as any).window;
    expect(() => killSurfacePty(term('surf-1'))).not.toThrow();
    expect(() => killTreeTerminalPtys(leaf('pane-1', [term('surf-1')]))).not.toThrow();
  });
});

/*
 * Telling a close from a re-render, at the one place that already knows.
 *
 * A CDP target used to die on the React unmount, and closing ONE browser pane
 * unmounts EVERY BrowserPane because the split tree re-renders. Measured on the
 * running app, closing one of three panes:
 *
 *     before  wmux-page-32  wmux-page-33  wmux-page-34
 *     after   wmux-page-35  wmux-page-36
 *
 * Right count, not one surviving id — so a client driving a pane nobody touched
 * lost every handle it held, with no error to show for it.
 *
 * This module is the chokepoint that already distinguishes the two: its own
 * doc says "this is close, NOT unmount". So the close notification belongs here
 * and nowhere near a React lifecycle.
 */
describe('pty-teardown — telling CDP a browser surface is really gone', () => {
  let kill: ReturnType<typeof vi.fn>;
  let surfaceGone: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    kill = vi.fn();
    surfaceGone = vi.fn();
    (globalThis as any).window = { wmux: { pty: { kill }, cdp: { surfaceGone } } };
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it('tells CDP when a browser surface is closed', () => {
    killSurfacePty(browser('surf-b'));

    expect(surfaceGone).toHaveBeenCalledWith('surf-b');
  });

  it('says nothing about a terminal surface', () => {
    // Terminals have no CDP target; announcing one would name an id the proxy
    // has never heard of.
    killSurfacePty(term('surf-t'));

    expect(surfaceGone).not.toHaveBeenCalled();
  });

  it('tells CDP about every browser surface a closed pane held', () => {
    killTreeTerminalPtys(leaf('pane-1', [term('surf-t'), browser('surf-b1'), browser('surf-b2')]));

    expect(surfaceGone.mock.calls.map((c) => c[0]).sort()).toEqual(['surf-b1', 'surf-b2']);
  });

  it('survives a preload with no cdp bridge', () => {
    // Older preload, or a test harness: a missing bridge must not throw on a
    // close path that is also reaping PTYs.
    (globalThis as any).window = { wmux: { pty: { kill } } };

    expect(() => killSurfacePty(browser('surf-b'))).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });
});
