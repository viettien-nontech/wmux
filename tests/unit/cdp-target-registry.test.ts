import { describe, it, expect } from 'vitest';
import { TargetRegistry } from '../../src/main/cdp-target-registry';

/*
 * Who a browser pane IS, as far as CDP is concerned.
 *
 * This exists because identity used to be the webContents id, and a webContents
 * does not survive a React remount. Closing one browser pane re-renders the
 * split tree, every BrowserPane unmounts and remounts, and each one comes back
 * with a NEW webContents — so every OTHER pane's target id changed too.
 * Measured on the running app: closing one of three panes left the right COUNT
 *
 *     before  wmux-page-32  wmux-page-33  wmux-page-34
 *     after   wmux-page-35  wmux-page-36
 *
 * but not one surviving id. A client attached to a pane that was never closed
 * lost every handle it held, permanently.
 *
 * A surface id does survive a remount, so identity is keyed on that instead.
 */
describe('TargetRegistry — identity survives a remount', () => {
  it('gives a surface the same target id after its webContents changes', () => {
    const r = new TargetRegistry();

    const truoc = r.bind('surf-a', 10);
    r.unbind(10);
    const sau = r.bind('surf-a', 99);

    expect(sau).toBe(truoc);
  });

  it('gives different surfaces different target ids', () => {
    const r = new TargetRegistry();

    expect(r.bind('surf-a', 10)).not.toBe(r.bind('surf-b', 11));
  });

  it('re-binding the same surface and webContents changes nothing', () => {
    const r = new TargetRegistry();

    const a = r.bind('surf-a', 10);
    const b = r.bind('surf-a', 10);

    expect(b).toBe(a);
    expect(r.liveTargetIds()).toEqual([a]);
  });

  /*
   * The load-bearing one. `unbind` is what a React unmount produces, and a
   * remount follows it within milliseconds — so unbind must NOT be the thing
   * that ends a target's life, or a re-render reads as a close.
   */
  it('unbind keeps the target alive, just not attached', () => {
    const r = new TargetRegistry();
    const id = r.bind('surf-a', 10);

    r.unbind(10);

    expect(r.liveTargetIds()).toEqual([id]);
    expect(r.wcIdFor(id)).toBeNull();
  });

  it('only a gone surface ends a target', () => {
    const r = new TargetRegistry();
    const id = r.bind('surf-a', 10);

    expect(r.surfaceGone('surf-a')).toBe(id);
    expect(r.liveTargetIds()).toEqual([]);
    expect(r.wcIdFor(id)).toBeNull();
  });

  it('a surface that was never here reports nothing gone', () => {
    const r = new TargetRegistry();
    r.bind('surf-a', 10);

    expect(r.surfaceGone('surf-khong-co')).toBeNull();
  });

  it('closing one surface leaves the others' + " ids untouched", () => {
    // The whole point, stated as the bug it replaces.
    const r = new TargetRegistry();
    const a = r.bind('surf-a', 10);
    const b = r.bind('surf-b', 11);
    const c = r.bind('surf-c', 12);

    // A close re-renders the tree: everything unmounts…
    r.unbind(10); r.unbind(11); r.unbind(12);
    // …one surface is really gone, the rest come back on new webContents.
    r.surfaceGone('surf-a');
    const b2 = r.bind('surf-b', 21);
    const c2 = r.bind('surf-c', 22);

    expect(r.liveTargetIds().sort()).toEqual([b, c].sort());
    expect(b2).toBe(b);
    expect(c2).toBe(c);
    expect(a).not.toBe(b);
  });

  describe('asking by surface', () => {
    it('answers the target id a surface already owns', () => {
      const r = new TargetRegistry();
      const id = r.bind('surf-a', 10);

      expect(r.targetIdForSurface('surf-a')).toBe(id);
    });

    it('answers null for a surface it has never seen', () => {
      // The caller needs this to tell a FIRST attach from a remount: only the
      // first may announce `Target.targetCreated` to a client.
      const r = new TargetRegistry();

      expect(r.targetIdForSurface('surf-la')).toBeNull();
    });

    it('answers null once the surface is gone', () => {
      const r = new TargetRegistry();
      r.bind('surf-a', 10);
      r.surfaceGone('surf-a');

      expect(r.targetIdForSurface('surf-a')).toBeNull();
    });

    it('still answers while the surface is merely detached', () => {
      const r = new TargetRegistry();
      const id = r.bind('surf-a', 10);
      r.unbind(10);

      expect(r.targetIdForSurface('surf-a')).toBe(id);
    });
  });

  describe('looking identity up both ways', () => {
    it('finds the webContents behind a live target', () => {
      const r = new TargetRegistry();
      const id = r.bind('surf-a', 10);

      expect(r.wcIdFor(id)).toBe(10);
    });

    it('finds the target id for an attached webContents', () => {
      const r = new TargetRegistry();
      const id = r.bind('surf-a', 10);

      expect(r.targetIdFor(10)).toBe(id);
    });

    it('answers null for ids and webContents it does not know', () => {
      const r = new TargetRegistry();
      r.bind('surf-a', 10);

      expect(r.wcIdFor('wmux-page-999')).toBeNull();
      expect(r.wcIdFor('rac')).toBeNull();
      expect(r.targetIdFor(999)).toBeNull();
    });

    it('lists only the webContents that are attached right now', () => {
      const r = new TargetRegistry();
      r.bind('surf-a', 10);
      r.bind('surf-b', 11);
      r.unbind(10);

      expect(r.liveWcIds()).toEqual([11]);
    });
  });

  it('reuses a webContents id after the old owner let it go', () => {
    /* Electron reuses webContents ids. If `unbind` left a stale reverse entry,
       the next pane to get id 10 would answer as the old surface. */
    const r = new TargetRegistry();
    const a = r.bind('surf-a', 10);
    r.unbind(10);

    const b = r.bind('surf-b', 10);

    expect(b).not.toBe(a);
    expect(r.targetIdFor(10)).toBe(b);
    expect(r.wcIdFor(a)).toBeNull();
  });
});

/*
 * Re-binding a live surface, without an unbind in between.
 *
 * Raised in review. `bind` dropped the reverse entry of whoever ELSE held that
 * webContents, but not the surface's own previous one — so after
 * `bind('s',10); bind('s',99)` the registry still answered target `s` for
 * webContents 10, and `surfaceGone('s')` cleaned up only 99. A webContents id
 * that Electron later reuses would then resolve to a target that is gone.
 */
describe('TargetRegistry — re-binding without an unbind first', () => {
  it('forgets the webContents the surface used to be on', () => {
    const r = new TargetRegistry();
    r.bind('surf-a', 10);

    r.bind('surf-a', 99);

    expect(r.targetIdFor(10)).toBeNull();
    expect(r.liveWcIds()).toEqual([99]);
  });

  it('leaves nothing behind once that surface is gone', () => {
    const r = new TargetRegistry();
    r.bind('surf-a', 10);
    r.bind('surf-a', 99);

    r.surfaceGone('surf-a');

    expect(r.liveWcIds()).toEqual([]);
    expect(r.targetIdFor(10)).toBeNull();
    expect(r.targetIdFor(99)).toBeNull();
  });

  it('still keeps the same identity', () => {
    const r = new TargetRegistry();
    const id = r.bind('surf-a', 10);

    expect(r.bind('surf-a', 99)).toBe(id);
  });
});
