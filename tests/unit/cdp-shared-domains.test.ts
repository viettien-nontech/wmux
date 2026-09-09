import { describe, it, expect } from 'vitest';
import { SharedDomains } from '../../src/main/cdp-shared-domains';

/**
 * The bug this file stands guard over, in one sentence: `Runtime.enable` is
 * state on a CDP SESSION, and every wmux client shares ONE real session per
 * pane (`wc.debugger`), so the second client to enable a domain gets an empty
 * `{}` and never learns the page's execution contexts — puppeteer then waits
 * for a main-world context that will never be announced, forever.
 */
describe('SharedDomains — who holds a domain on a pane', () => {
  it('tells the first claimer it must really enable, and later ones that it is already on', () => {
    const d = new SharedDomains();
    expect(d.claim(5, 'sess-a', 'Runtime')).toBe('first');
    expect(d.claim(5, 'sess-b', 'Runtime')).toBe('again');
  });

  it('counts a pane at a time — the same session on another pane is a first claim', () => {
    const d = new SharedDomains();
    d.claim(5, 'sess-a', 'Runtime');
    expect(d.claim(9, 'sess-a', 'Runtime')).toBe('first');
  });

  it('treats a repeated claim by the SAME session as idempotent, not a second holder', () => {
    const d = new SharedDomains();
    d.claim(5, 'sess-a', 'Runtime');
    d.claim(5, 'sess-a', 'Runtime');
    // One holder, so one release must free it. A double-counted claim would
    // leave the domain enabled forever after the only client went away.
    expect(d.release(5, 'sess-a', 'Runtime')).toBe('last');
  });

  it('keeps the domain on while anyone else still holds it', () => {
    const d = new SharedDomains();
    d.claim(5, 'sess-a', 'Network');
    d.claim(5, 'sess-b', 'Network');
    expect(d.release(5, 'sess-a', 'Network')).toBe('others-remain');
    expect(d.release(5, 'sess-b', 'Network')).toBe('last');
  });

  it('says so plainly when a session releases something it never held', () => {
    const d = new SharedDomains();
    expect(d.release(5, 'sess-a', 'Network')).toBe('not-held');
  });

  it('reports what a session holds, so events can be routed honestly', () => {
    const d = new SharedDomains();
    d.claim(5, 'sess-a', 'Network');
    expect(d.holds(5, 'sess-a', 'Network')).toBe(true);
    expect(d.holds(5, 'sess-b', 'Network')).toBe(false);
    d.release(5, 'sess-a', 'Network');
    expect(d.holds(5, 'sess-a', 'Network')).toBe(false);
  });

  it('frees every domain a session held when its connection goes, naming the ones now unheld', () => {
    const d = new SharedDomains();
    d.claim(5, 'sess-a', 'Runtime');
    d.claim(5, 'sess-a', 'Network');
    d.claim(5, 'sess-b', 'Network');
    // Network still has sess-b behind it; only Runtime actually goes off.
    expect(d.releaseSession(5, 'sess-a').sort()).toEqual(['Runtime']);
    expect(d.releaseSession(5, 'sess-b').sort()).toEqual(['Network']);
  });

  it('knows which domains are gated on a pane, and stays quiet about the rest', () => {
    const d = new SharedDomains();
    d.claim(5, 'sess-a', 'Network');
    expect(d.isGated(5, 'Network')).toBe(true);
    // Never enabled by anyone: an Inspector or Target event must not be
    // withheld from a client just because it never sent `Inspector.enable`.
    expect(d.isGated(5, 'Inspector')).toBe(false);
  });
});

describe('SharedDomains — the execution contexts a late client never hears about', () => {
  const ctx = (id: number, name: string) => ({ context: { id, name, origin: 'http://a', uniqueId: `u${id}` } });

  it('remembers every context the pane announced', () => {
    const d = new SharedDomains();
    d.noteEvent(5, 'Runtime.executionContextCreated', ctx(1, ''));
    d.noteEvent(5, 'Runtime.executionContextCreated', ctx(2, 'util'));
    expect(d.replayFor(5, 'Runtime')).toEqual([
      { method: 'Runtime.executionContextCreated', params: ctx(1, '') },
      { method: 'Runtime.executionContextCreated', params: ctx(2, 'util') },
    ]);
  });

  it('records a context once however many connections report it', () => {
    // Every connected client has its own listener on the same pane, so the
    // same frame arrives N times. Replaying it N times would hand a client
    // duplicate contexts for one world.
    const d = new SharedDomains();
    d.noteEvent(5, 'Runtime.executionContextCreated', ctx(1, ''));
    d.noteEvent(5, 'Runtime.executionContextCreated', ctx(1, ''));
    expect(d.replayFor(5, 'Runtime')).toHaveLength(1);
  });

  it('forgets a context the page destroyed', () => {
    const d = new SharedDomains();
    d.noteEvent(5, 'Runtime.executionContextCreated', ctx(1, ''));
    d.noteEvent(5, 'Runtime.executionContextCreated', ctx(2, 'util'));
    d.noteEvent(5, 'Runtime.executionContextDestroyed', { executionContextId: 1 });
    expect(d.replayFor(5, 'Runtime').map((f: any) => f.params.context.id)).toEqual([2]);
  });

  it('drops the lot on a navigation', () => {
    const d = new SharedDomains();
    d.noteEvent(5, 'Runtime.executionContextCreated', ctx(1, ''));
    d.noteEvent(5, 'Runtime.executionContextsCleared', {});
    expect(d.replayFor(5, 'Runtime')).toEqual([]);
  });

  it('has nothing to replay for a domain that carries no state', () => {
    const d = new SharedDomains();
    d.noteEvent(5, 'Runtime.executionContextCreated', ctx(1, ''));
    expect(d.replayFor(5, 'Network')).toEqual([]);
  });

  it('forgets a pane entirely when it closes', () => {
    const d = new SharedDomains();
    d.claim(5, 'sess-a', 'Runtime');
    d.noteEvent(5, 'Runtime.executionContextCreated', ctx(1, ''));
    d.forgetPane(5);
    expect(d.replayFor(5, 'Runtime')).toEqual([]);
    expect(d.isGated(5, 'Runtime')).toBe(false);
    // A pane id can come back around; the new pane must start clean.
    expect(d.claim(5, 'sess-b', 'Runtime')).toBe('first');
  });

  it('clears remembered contexts when the last holder turns Runtime off', () => {
    const d = new SharedDomains();
    d.claim(5, 'sess-a', 'Runtime');
    d.noteEvent(5, 'Runtime.executionContextCreated', ctx(1, ''));
    d.release(5, 'sess-a', 'Runtime');
    // The debugger really is disabled now, so the table is a stale story.
    expect(d.replayFor(5, 'Runtime')).toEqual([]);
  });
});
