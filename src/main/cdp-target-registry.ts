/**
 * Who a browser pane IS, as far as CDP is concerned.
 *
 * Identity used to be the webContents id, straight into the target id
 * (`wmux-page-<wcId>`). A webContents does not survive a React remount, and
 * closing ONE browser pane re-renders the split tree — so every BrowserPane
 * unmounts, detaches, remounts on a fresh webContents, and every OTHER pane's
 * target id changed with it. Measured on the running app, closing one of three:
 *
 *     before  wmux-page-32  wmux-page-33  wmux-page-34
 *     after   wmux-page-35  wmux-page-36
 *
 * The count was right and not one id survived. A client driving a pane that was
 * never closed lost every handle it held, with no error to show for it — it
 * just found zero pages where it had two. That is the whole reason this file
 * exists: a surface id DOES survive a remount, so identity hangs off that.
 *
 * The rule that falls out, and the one worth keeping:
 *
 *   - `bind`        a surface is showing on this webContents (attach)
 *   - `unbind`      that webContents is going away — the TARGET IS NOT
 *   - `surfaceGone` the pane is really closed; only this ends a target
 *
 * `unbind` is what an unmount produces and a remount follows it within
 * milliseconds, so letting unbind end a target is exactly the bug above.
 */

/** Counter for target ids. Module-level so ids stay unique across registries. */
let demTarget = 0;

export class TargetRegistry {
  /** surfaceId -> its permanent target id. */
  private theoSurface = new Map<string, string>();
  /** targetId -> webContents currently showing it, or null while detached. */
  private wcTheoTarget = new Map<string, number | null>();
  /** webContents -> targetId, for the reverse question. */
  private targetTheoWc = new Map<number, string>();

  /**
   * A surface is on this webContents now. Returns its permanent target id.
   *
   * Called again after a remount with a different webContents: same surface,
   * same id, nothing announced to clients.
   */
  bind(surfaceId: string, wcId: number): string {
    let targetId = this.theoSurface.get(surfaceId);
    if (!targetId) {
      targetId = `wmux-page-${++demTarget}`;
      this.theoSurface.set(surfaceId, targetId);
    }

    /* Electron reuses webContents ids. Whoever held this one before does not
       hold it now, so drop that binding rather than leave two targets both
       claiming the same webContents. */
    const cu = this.targetTheoWc.get(wcId);
    if (cu && cu !== targetId) this.wcTheoTarget.set(cu, null);

    /* And drop the surface's OWN previous webContents. A remount normally
       unbinds first, but nothing guarantees the order, and a stale reverse
       entry means a webContents id Electron later hands to someone else still
       resolves to this target. Raised in review. */
    const wcCu = this.wcTheoTarget.get(targetId);
    if (typeof wcCu === 'number' && wcCu !== wcId) this.targetTheoWc.delete(wcCu);

    this.wcTheoTarget.set(targetId, wcId);
    this.targetTheoWc.set(wcId, targetId);
    return targetId;
  }

  /**
   * This webContents is going away. The target STAYS — it is simply not
   * attached until the surface comes back on a new one.
   */
  unbind(wcId: number): string | null {
    const targetId = this.targetTheoWc.get(wcId);
    if (!targetId) return null;
    this.targetTheoWc.delete(wcId);
    if (this.wcTheoTarget.get(targetId) === wcId) this.wcTheoTarget.set(targetId, null);
    return targetId;
  }

  /**
   * The pane is really closed. The ONLY thing that ends a target, and so the
   * only thing that may make a client see `Target.targetDestroyed`.
   */
  surfaceGone(surfaceId: string): string | null {
    const targetId = this.theoSurface.get(surfaceId);
    if (!targetId) return null;
    this.theoSurface.delete(surfaceId);
    const wcId = this.wcTheoTarget.get(targetId);
    if (typeof wcId === 'number') this.targetTheoWc.delete(wcId);
    this.wcTheoTarget.delete(targetId);
    return targetId;
  }

  /**
   * The target id a surface owns, or null if it owns none.
   *
   * This is what tells a FIRST attach from a remount, and only the first may
   * announce `Target.targetCreated` to a client. A merely detached surface
   * still answers — detached is not gone.
   */
  targetIdForSurface(surfaceId: string): string | null {
    return this.theoSurface.get(surfaceId) ?? null;
  }

  /** The webContents behind a target, or null when nothing is attached to it. */
  wcIdFor(targetId: unknown): number | null {
    if (typeof targetId !== 'string') return null;
    return this.wcTheoTarget.get(targetId) ?? null;
  }

  /** The target a webContents is currently showing, or null. */
  targetIdFor(wcId: number): string | null {
    return this.targetTheoWc.get(wcId) ?? null;
  }

  /** Every target that still exists, attached or not. */
  liveTargetIds(): string[] {
    return [...this.wcTheoTarget.keys()];
  }

  /** Every webContents attached right now. Detached targets are not here. */
  liveWcIds(): number[] {
    return [...this.targetTheoWc.keys()];
  }
}
