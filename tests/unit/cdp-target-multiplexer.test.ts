import { describe, it, expect, vi } from 'vitest';
import {
  TargetMultiplexer,
  parseDebuggerPath,
  type MultiplexerDeps,
} from '../../src/main/cdp-target-multiplexer';
import { SharedDomains } from '../../src/main/cdp-shared-domains';
import { TargetRegistry } from '../../src/main/cdp-target-registry';

/**
 * A client connection, faked. `sent` is every frame the multiplexer pushed at
 * it, which is the whole observable surface — no socket, no Electron.
 */
function harness(
  panes: Record<number, { title: string; url: string }>,
  domains: SharedDomains = new SharedDomains(),
  registry: TargetRegistry = new TargetRegistry(),
) {
  const sent: any[] = [];
  const commands: { wcId: number; method: string; params: unknown }[] = [];
  /* Identity is no longer computed from the webContents id — a webContents does
     not survive a remount, which is what made closing one pane rename every
     other one's target. The real registry is used here rather than a stub, so
     these tests break if the two ever disagree about what an id is. */
  /* Bind on demand, the way `CdpProxy.addTarget` does when a pane attaches —
     a test that adds a pane mid-run must get an identity for it too. */
  const idOf = (wcId: number) => registry.targetIdFor(wcId) ?? registry.bind(`surf-${wcId}`, wcId);
  for (const wcId of Object.keys(panes).map(Number)) idOf(wcId);
  const deps: MultiplexerDeps = {
    listTargets: () => Object.keys(panes).map(Number),
    infoFor: (wcId) => panes[wcId] ?? null,
    targetIdFor: (wcId) => idOf(wcId),
    wcIdForTargetId: (targetId) => registry.wcIdFor(targetId),
    send: (m) => { sent.push(m); },
    sendCommand: async (wcId, method, params) => { commands.push({ wcId, method, params }); return { ok: wcId }; },
    version: () => ({
      protocolVersion: '1.3', product: 'Chrome/0.0.0.0', revision: '', userAgent: 'ua', jsVersion: '0',
    }),
    domains,
  };
  return { mux: new TargetMultiplexer(deps), sent, commands, panes, domains, registry, idOf };
}

/** A SECOND client on the same panes, sharing the one real debugger session. */
function secondClient(first: ReturnType<typeof harness>) {
  /* The SAME registry, not a copy. Identity is a fact about the app, not about
     a connection: two clients looking at one pane must see one target id. */
  return harness(first.panes, first.domains, first.registry);
}

/** Attach a client to one pane and hand back its session id. */
async function attach(h: ReturnType<typeof harness>, targetId: string, id = 900): Promise<string> {
  await h.mux.handle({ id, method: 'Target.attachToTarget', params: { targetId } });
  return replyTo(h.sent, id).result.sessionId;
}

const methodsOf = (commands: { method: string }[]) => commands.map((c) => c.method);

const framesOf = (sent: any[], method: string) => sent.filter((m) => m.method === method);
const replyTo = (sent: any[], id: number) => sent.find((m) => m.id === id);

describe('parseDebuggerPath', () => {
  it('recognises the browser socket', () => {
    expect(parseDebuggerPath('/devtools/browser/1')).toEqual({ kind: 'browser' });
    expect(parseDebuggerPath('/devtools/browser/abc-def')).toEqual({ kind: 'browser' });
  });

  it('recognises a page socket and keeps its target id', () => {
    expect(parseDebuggerPath('/devtools/page/wmux-page-7')).toEqual({ kind: 'page', targetId: 'wmux-page-7' });
  });

  it('ignores a query string', () => {
    expect(parseDebuggerPath('/devtools/page/wmux-page-7?foo=1')).toEqual({ kind: 'page', targetId: 'wmux-page-7' });
  });

  it('refuses anything else, including a page path with no id', () => {
    expect(parseDebuggerPath('/devtools/page/')).toBeNull();
    expect(parseDebuggerPath('/json/list')).toBeNull();
    expect(parseDebuggerPath(undefined)).toBeNull();
  });
});

describe('TargetMultiplexer — the browser-domain handshake puppeteer performs', () => {
  it('answers Target.getBrowserContexts instead of forwarding it to a page', async () => {
    // The exact frame that used to come back "Not allowed": the proxy pushed it
    // into a PAGE debugger, which has no browser domain.
    const { mux, sent, idOf } = harness({ 5: { title: 'a', url: 'http://a' } });
    await mux.handle({ id: 1, method: 'Target.getBrowserContexts' });
    expect(replyTo(sent, 1)).toEqual({ id: 1, result: { browserContextIds: [] } });
  });

  it('lists every browser pane as its own page target', async () => {
    const { mux, sent, idOf } = harness({
      5: { title: 'one', url: 'http://one' },
      9: { title: 'two', url: 'http://two' },
    });
    await mux.handle({ id: 1, method: 'Target.getTargets' });
    const infos = replyTo(sent, 1).result.targetInfos;
    expect(infos).toHaveLength(2);
    expect(infos.map((t: any) => t.targetId)).toEqual([idOf(5), idOf(9)]);
    expect(infos.map((t: any) => t.url)).toEqual(['http://one', 'http://two']);
    expect(infos.every((t: any) => t.type === 'page')).toBe(true);
  });

  it('skips a pane whose webContents has already gone', async () => {
    const { mux, sent, panes, idOf } = harness({ 5: { title: 'one', url: 'http://one' }, 9: { title: 't', url: 'u' } });
    delete (panes as any)[9];
    await mux.handle({ id: 1, method: 'Target.getTargets' });
    expect(replyTo(sent, 1).result.targetInfos).toHaveLength(1);
  });

  it('emits one targetCreated per pane once discovery is on', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' }, 9: { title: 'two', url: 'u2' } });
    await mux.handle({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } });
    expect(framesOf(sent, 'Target.targetCreated')).toHaveLength(2);
  });

  it('auto-attaches every pane, one distinct session each', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' }, 9: { title: 'two', url: 'u2' } });
    await mux.handle({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
    const attached = framesOf(sent, 'Target.attachedToTarget');
    expect(attached).toHaveLength(2);
    const ids = attached.map((f) => f.params.sessionId);
    expect(new Set(ids).size).toBe(2);
    expect(attached.every((f) => f.params.targetInfo.attached === true)).toBe(true);
  });

  it('does not re-attach a pane it already holds a session for', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' } });
    await mux.handle({ id: 1, method: 'Target.attachToTarget', params: { targetId: idOf(5), flatten: true } });
    await mux.handle({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true } });
    expect(framesOf(sent, 'Target.attachedToTarget')).toHaveLength(1);
    expect(mux.openSessions.size).toBe(1);
  });

  it('refuses an attach to a target id it does not own', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' } });
    await mux.handle({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'wmux-page-khong-ai-so-huu' } });
    expect(replyTo(sent, 1).error.code).toBe(-32602);
  });
});

describe('TargetMultiplexer — routing commands and events by session', () => {
  it('sends a session-tagged command to that session own pane, and tags the reply', async () => {
    const { mux, sent, commands, idOf } = harness({ 5: { title: 'one', url: 'u1' }, 9: { title: 'two', url: 'u2' } });
    await mux.handle({ id: 1, method: 'Target.attachToTarget', params: { targetId: idOf(9) } });
    const sessionId = replyTo(sent, 1).result.sessionId;

    // A one-shot command, deliberately: `Runtime.enable` used to stand in here,
    // but the enable family is no longer forwarded verbatim — it is refcounted
    // across clients, and its own block below covers that.
    await mux.handle({ id: 2, sessionId, method: 'Runtime.evaluate', params: {} });

    expect(commands).toEqual([{ wcId: 9, method: 'Runtime.evaluate', params: {} }]);
    expect(replyTo(sent, 2)).toEqual({ id: 2, sessionId, result: { ok: 9 } });
  });

  it('fans a page event out only to the sessions bound to that pane', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' }, 9: { title: 'two', url: 'u2' } });
    await mux.handle({ id: 1, method: 'Target.attachToTarget', params: { targetId: idOf(5) } });
    await mux.handle({ id: 2, method: 'Target.attachToTarget', params: { targetId: idOf(9) } });
    const sessionFive = replyTo(sent, 1).result.sessionId;

    mux.onPageEvent(5, 'Page.loadEventFired', { t: 1 });

    const events = sent.filter((m) => m.method === 'Page.loadEventFired');
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe(sessionFive);
  });

  it('answers an unknown sessionId rather than dropping the frame', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' } });
    await mux.handle({ id: 7, sessionId: 'nope', method: 'Runtime.evaluate' });
    expect(replyTo(sent, 7).error.message).toContain('nope');
  });

  it('turns a page-level command sent with no session into an error, never a guess', async () => {
    // Guessing which pane a sessionless Runtime.evaluate meant is the exact
    // cross-talk this module exists to remove.
    const { mux, sent, commands, idOf } = harness({ 5: { title: 'one', url: 'u1' }, 9: { title: 'two', url: 'u2' } });
    await mux.handle({ id: 3, method: 'Runtime.evaluate', params: { expression: '1' } });
    expect(commands).toHaveLength(0);
    expect(replyTo(sent, 3).error.code).toBe(-32601);
    expect(replyTo(sent, 3).error.message).toContain('sessionId');
  });

  it('surfaces a page command failure as a CDP error on the same session', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' } });
    await mux.handle({ id: 1, method: 'Target.attachToTarget', params: { targetId: idOf(5) } });
    const sessionId = replyTo(sent, 1).result.sessionId;
    (mux as any).deps.sendCommand = async () => { throw new Error('Browser not attached'); };
    await mux.handle({ id: 2, sessionId, method: 'Runtime.enable' });
    expect(replyTo(sent, 2)).toEqual({
      id: 2, sessionId, error: { code: -32000, message: 'Browser not attached' },
    });
  });
});

describe('TargetMultiplexer — closing one pane leaves the others alone (the bug)', () => {
  it('detaches only the closed pane sessions, then destroys only its target', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' }, 9: { title: 'two', url: 'u2' } });
    await mux.handle({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } });
    await mux.handle({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true } });
    const sessionFor = (wcId: number) =>
      [...mux.openSessions].find(([, id]) => id === idOf(wcId))?.[0];
    const sessionNine = sessionFor(9);
    sent.length = 0;

    mux.onTargetRemoved(5, idOf(5));

    const detached = framesOf(sent, 'Target.detachedFromTarget');
    expect(detached).toHaveLength(1);
    expect(detached[0].params.targetId).toBe(idOf(5));
    expect(framesOf(sent, 'Target.targetDestroyed').map((f) => f.params.targetId)).toEqual([idOf(5)]);
    // The surviving pane keeps the session it had.
    expect(sessionFor(9)).toBe(sessionNine);
    expect(mux.openSessions.size).toBe(1);
  });

  it('keeps driving the surviving pane after the other one closed', async () => {
    const { mux, sent, commands, idOf } = harness({ 5: { title: 'one', url: 'u1' }, 9: { title: 'two', url: 'u2' } });
    await mux.handle({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true } });
    const sessionNine = [...mux.openSessions].find(([, id]) => id === idOf(9))![0];

    mux.onTargetRemoved(5, idOf(5));
    await mux.handle({ id: 2, sessionId: sessionNine, method: 'Page.reload' });

    expect(commands).toEqual([{ wcId: 9, method: 'Page.reload', params: {} }]);
    expect(replyTo(sent, 2).result).toBeDefined();
  });

  it('two connected clients hold independent sessions over the same panes', async () => {
    // Two Claude sessions, one endpoint. Neither one closing a pane, detaching,
    // or driving a page may appear on the other socket.
    const a = harness({ 5: { title: 'one', url: 'u1' }, 9: { title: 'two', url: 'u2' } });
    const b = harness({ 5: { title: 'one', url: 'u1' }, 9: { title: 'two', url: 'u2' } });
    await a.mux.handle({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true } });
    await b.mux.handle({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true } });

    const aSessions = [...a.mux.openSessions.keys()];
    const bSessions = [...b.mux.openSessions.keys()];
    expect(aSessions).toHaveLength(2);
    expect(bSessions).toHaveLength(2);
    expect(aSessions.some((s) => bSessions.includes(s))).toBe(false);

    // A detaches from pane 5. B still has its own session for pane 5.
    const aFive = [...a.mux.openSessions].find(([, id]) => id === a.idOf(5))![0];
    await a.mux.handle({ id: 2, method: 'Target.detachFromTarget', params: { sessionId: aFive } });
    expect(a.mux.openSessions.size).toBe(1);
    expect(b.mux.openSessions.size).toBe(2);
    expect(b.sent.some((m) => m.method === 'Target.detachedFromTarget')).toBe(false);
  });

  it('announces a newly opened pane to a discovering client', async () => {
    const { mux, sent, panes, idOf } = harness({ 5: { title: 'one', url: 'u1' } });
    await mux.handle({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } });
    sent.length = 0;
    (panes as any)[9] = { title: 'two', url: 'u2' };

    mux.onTargetAdded(9);

    expect(framesOf(sent, 'Target.targetCreated')[0].params.targetInfo.targetId).toBe(idOf(9));
  });
});

describe('TargetMultiplexer — what it refuses', () => {
  it('will not let a remote client close a pane or the app', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' } });
    await mux.handle({ id: 1, method: 'Browser.close' });
    await mux.handle({ id: 2, method: 'Target.closeTarget', params: { targetId: idOf(5) } });
    await mux.handle({ id: 3, method: 'Target.createTarget', params: { url: 'http://x' } });
    for (const id of [1, 2, 3]) expect(replyTo(sent, id).error.code).toBe(-32601);
  });

  it('says nothing back to a notification (a frame with no id)', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' } });
    await mux.handle({ method: 'Target.getTargets' });
    expect(sent.filter((m) => m.id !== undefined)).toHaveLength(0);
  });

  it('ignores a frame that is not a command', async () => {
    const { mux, sent, idOf } = harness({ 5: { title: 'one', url: 'u1' } });
    await mux.handle({ id: 1 });
    await mux.handle(null);
    expect(sent).toHaveLength(0);
  });
});

/**
 * The hang this block exists to prevent.
 *
 * Found with the real client, never by a mock: puppeteer connected, listed the
 * panes, then sat forever on `page.title()` without sending a single frame —
 * waiting for a main-world execution context that the second `Runtime.enable`
 * never announced. Measured against the running app: a second enable produced
 * 0 `executionContextCreated`; `disable` then `enable` produced 3.
 */
describe('TargetMultiplexer — enable is session state on a session everyone shares', () => {
  it('really enables the domain for the first session that asks', async () => {
    const h = harness({ 5: { title: 'a', url: 'http://a' } });
    const sess = await attach(h, h.idOf(5));
    h.commands.length = 0;
    await h.mux.handle({ id: 1, method: 'Runtime.enable', sessionId: sess });
    // A disable first: a raw page socket, or a client from before this fix,
    // may have left the domain on, and only an off→on edge announces contexts.
    expect(methodsOf(h.commands)).toEqual(['Runtime.disable', 'Runtime.enable']);
    expect(replyTo(h.sent, 1)).toEqual({ id: 1, sessionId: sess, result: {} });
  });

  it('does NOT re-enable for a second client, and catches that client up instead', async () => {
    const a = harness({ 5: { title: 'a', url: 'http://a' } });
    const sessA = await attach(a, a.idOf(5));
    await a.mux.handle({ id: 1, method: 'Runtime.enable', sessionId: sessA });
    // The pane announces its worlds; every connection's listener sees them.
    const ctx = (id: number, name: string) => ({ context: { id, name, origin: 'http://a', uniqueId: 'u' + id } });
    a.mux.onPageEvent(5, 'Runtime.executionContextCreated', ctx(1, ''));
    a.mux.onPageEvent(5, 'Runtime.executionContextCreated', ctx(2, 'util'));

    const b = secondClient(a);
    const sessB = await attach(b, b.idOf(5));
    b.commands.length = 0;
    b.sent.length = 0;
    await b.mux.handle({ id: 7, method: 'Runtime.enable', sessionId: sessB });

    // Not forwarded — the one real session already has it on.
    expect(b.commands).toEqual([]);
    // But B hears what A heard, on B's own session, before the reply lands.
    const replayed = b.sent.filter((m: any) => m.method === 'Runtime.executionContextCreated');
    expect(replayed.map((m: any) => m.params.context.id)).toEqual([1, 2]);
    expect(replayed.every((m: any) => m.sessionId === sessB)).toBe(true);
    expect(b.sent.indexOf(replayed[1])).toBeLessThan(b.sent.findIndex((m: any) => m.id === 7));
    expect(replyTo(b.sent, 7)).toEqual({ id: 7, sessionId: sessB, result: {} });
  });

  it('keeps the domain on when one of two holders disables it', async () => {
    const a = harness({ 5: { title: 'a', url: 'http://a' } });
    const sessA = await attach(a, a.idOf(5));
    await a.mux.handle({ id: 1, method: 'Network.enable', sessionId: sessA });
    const b = secondClient(a);
    const sessB = await attach(b, b.idOf(5));
    await b.mux.handle({ id: 2, method: 'Network.enable', sessionId: sessB });

    a.commands.length = 0;
    await a.mux.handle({ id: 3, method: 'Network.disable', sessionId: sessA });
    // Measured against the live app: forwarding this took Network events away
    // from the OTHER client too — it saw 2 events, then 0.
    expect(a.commands).toEqual([]);
    expect(replyTo(a.sent, 3)).toEqual({ id: 3, sessionId: sessA, result: {} });
  });

  it('forwards the disable once the last holder lets go', async () => {
    const a = harness({ 5: { title: 'a', url: 'http://a' } });
    const sessA = await attach(a, a.idOf(5));
    await a.mux.handle({ id: 1, method: 'Network.enable', sessionId: sessA });
    a.commands.length = 0;
    await a.mux.handle({ id: 2, method: 'Network.disable', sessionId: sessA });
    expect(methodsOf(a.commands)).toEqual(['Network.disable']);
  });

  it('stops sending a domain’s events to the session that turned it off', async () => {
    const a = harness({ 5: { title: 'a', url: 'http://a' } });
    const sessA = await attach(a, a.idOf(5));
    const b = secondClient(a);
    const sessB = await attach(b, b.idOf(5));
    await a.mux.handle({ id: 1, method: 'Network.enable', sessionId: sessA });
    await b.mux.handle({ id: 2, method: 'Network.enable', sessionId: sessB });
    await a.mux.handle({ id: 3, method: 'Network.disable', sessionId: sessA });

    a.sent.length = 0;
    b.sent.length = 0;
    a.mux.onPageEvent(5, 'Network.requestWillBeSent', { requestId: 'r1' });
    b.mux.onPageEvent(5, 'Network.requestWillBeSent', { requestId: 'r1' });
    // A asked to stop hearing it; B never did.
    expect(framesOf(a.sent, 'Network.requestWillBeSent')).toEqual([]);
    expect(framesOf(b.sent, 'Network.requestWillBeSent')).toHaveLength(1);
  });

  it('never withholds an event from a domain nobody gates', async () => {
    const a = harness({ 5: { title: 'a', url: 'http://a' } });
    await attach(a, a.idOf(5));
    a.sent.length = 0;
    a.mux.onPageEvent(5, 'Inspector.targetCrashed', {});
    expect(framesOf(a.sent, 'Inspector.targetCrashed')).toHaveLength(1);
  });

  it('lets go of the domains a detached session held', async () => {
    const a = harness({ 5: { title: 'a', url: 'http://a' } });
    const sessA = await attach(a, a.idOf(5));
    await a.mux.handle({ id: 1, method: 'Runtime.enable', sessionId: sessA });
    a.commands.length = 0;
    await a.mux.handle({ id: 2, method: 'Target.detachFromTarget', params: { sessionId: sessA } });
    expect(methodsOf(a.commands)).toEqual(['Runtime.disable']);
  });

  it('lets go of everything when the connection drops', async () => {
    const a = harness({ 5: { title: 'a', url: 'http://a' } });
    const sessA = await attach(a, a.idOf(5));
    await a.mux.handle({ id: 1, method: 'Runtime.enable', sessionId: sessA });
    await a.mux.handle({ id: 2, method: 'Network.enable', sessionId: sessA });
    a.commands.length = 0;
    await a.mux.dispose();
    expect(methodsOf(a.commands).sort()).toEqual(['Network.disable', 'Runtime.disable']);
  });

  it('does not chase a closed pane with a disable it cannot deliver', async () => {
    const a = harness({ 5: { title: 'a', url: 'http://a' } });
    const sessA = await attach(a, a.idOf(5));
    await a.mux.handle({ id: 1, method: 'Runtime.enable', sessionId: sessA });
    a.commands.length = 0;
    a.mux.onTargetRemoved(5, a.idOf(5));
    await a.mux.dispose();
    expect(a.commands).toEqual([]);
    // And a recycled webContents id starts clean rather than inheriting.
    expect(a.domains.isGated(5, 'Runtime')).toBe(false);
  });
});

/*
 * Frame ORDER, not just frame presence. puppeteer's target manager snapshots
 * the discovered set the instant `setDiscoverTargets` resolves, so a reply
 * that overtakes its own announcements leaves a real client connected to
 * nothing at all — and a client that sees no panes reports no error, it just
 * quietly does nothing. Only order catches that.
 */
describe('announcements land before the reply that caused them', () => {
  const twoPanes = { 4: { title: 'A', url: 'http://a/' }, 5: { title: 'B', url: 'http://b/' } };
  const posOfReply = (sent: any[], id: number) => sent.findIndex((m) => m.id === id);
  const positionsOf = (sent: any[], method: string) =>
    sent.map((m, i) => (m.method === method ? i : -1)).filter((i) => i >= 0);

  it('Target.setDiscoverTargets announces every target first', async () => {
    const h = harness(twoPanes);
    await h.mux.handle({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } });

    const created = positionsOf(h.sent, 'Target.targetCreated');
    expect(created).toHaveLength(2);
    expect(Math.max(...created)).toBeLessThan(posOfReply(h.sent, 1));
  });

  it('Target.setAutoAttach attaches every target first', async () => {
    const h = harness(twoPanes);
    await h.mux.handle({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });

    const attached = positionsOf(h.sent, 'Target.attachedToTarget');
    expect(attached).toHaveLength(2);
    expect(Math.max(...attached)).toBeLessThan(posOfReply(h.sent, 2));
  });

  it('Target.attachToTarget announces the session before naming it in the reply', async () => {
    const h = harness(twoPanes);
    await h.mux.handle({ id: 3, method: 'Target.attachToTarget', params: { targetId: h.idOf(4) } });

    const attached = positionsOf(h.sent, 'Target.attachedToTarget');
    expect(attached).toHaveLength(1);
    expect(attached[0]).toBeLessThan(posOfReply(h.sent, 3));
    // The event and the reply still have to agree on which session it is.
    expect(framesOf(h.sent, 'Target.attachedToTarget')[0].params.sessionId)
      .toBe(replyTo(h.sent, 3).result.sessionId);
  });

  it('Target.detachFromTarget announces the detach before the reply', async () => {
    const h = harness(twoPanes);
    const sessionId = await attach(h, h.idOf(4));
    h.sent.length = 0;
    await h.mux.handle({ id: 4, method: 'Target.detachFromTarget', params: { sessionId } });

    const detached = positionsOf(h.sent, 'Target.detachedFromTarget');
    expect(detached).toHaveLength(1);
    expect(detached[0]).toBeLessThan(posOfReply(h.sent, 4));
  });

  it('a client that never asked to discover is told nothing', async () => {
    const h = harness(twoPanes);
    await h.mux.handle({ id: 5, method: 'Target.setDiscoverTargets', params: { discover: false } });

    expect(framesOf(h.sent, 'Target.targetCreated')).toHaveLength(0);
    expect(posOfReply(h.sent, 5)).toBe(0);
  });
});

/*
 * A session has to follow its SURFACE, not the webContents it started on.
 *
 * Found by the second AI in review, and it is the half the identity fix left
 * undone: target ids survive a remount, but `sessions` still mapped a session
 * to the webContents id it was opened against. So after a remount
 *
 *   - a command on that session is sent to a webContents that is GONE, and
 *   - closing the surface looks for sessions by the CURRENT webContents id,
 *     finds none, and destroys the target while leaving the session dangling
 *     with no `Target.detachedFromTarget` to tell the client.
 *
 * The acceptance run missed it because every client there connected fresh —
 * attach, drive, disconnect — and never held a session across a remount, which
 * is exactly the case the fix exists for.
 */
describe('a session survives its pane being remounted', () => {
  /** What a remount does: same surface, new webContents. */
  function remount(h: ReturnType<typeof harness>, cu: number, moi: number) {
    h.panes[moi] = h.panes[cu];
    delete h.panes[cu];
    h.registry.unbind(cu);
    h.registry.bind(`surf-${cu}`, moi);
  }

  it('sends a later command to the NEW webContents', async () => {
    const h = harness({ 4: { title: 'a', url: 'u' } });
    const sessionId = await attach(h, h.idOf(4));

    remount(h, 4, 44);
    await h.mux.handle({ id: 7, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId });

    expect(h.commands.map((c) => c.wcId)).toEqual([44]);
  });

  it('keeps the same target id across the remount', () => {
    const h = harness({ 4: { title: 'a', url: 'u' } });
    const truoc = h.idOf(4);

    remount(h, 4, 44);

    expect(h.registry.targetIdFor(44)).toBe(truoc);
  });

  it('detaches that session when the surface finally closes', async () => {
    const h = harness({ 4: { title: 'a', url: 'u' } });
    const targetId = h.idOf(4);
    // Discovery on, like a real client: `targetDestroyed` is only owed to a
    // client that asked to be told about targets in the first place.
    await h.mux.handle({ id: 99, method: 'Target.setDiscoverTargets', params: { discover: true } });
    const sessionId = await attach(h, targetId);
    remount(h, 4, 44);
    h.sent.length = 0;

    h.mux.onTargetRemoved(44, targetId);

    const detached = framesOf(h.sent, 'Target.detachedFromTarget');
    expect(detached).toHaveLength(1);
    expect(detached[0].params.sessionId).toBe(sessionId);
    expect(framesOf(h.sent, 'Target.targetDestroyed')).toHaveLength(1);
  });

  it('detaches it even when the pane is closed while detached', async () => {
    // surfaceGone straight after unbind: there is no current webContents at
    // all, so the proxy has none to pass. Identity still has to be enough.
    const h = harness({ 4: { title: 'a', url: 'u' } });
    const targetId = h.idOf(4);
    const sessionId = await attach(h, targetId);
    h.registry.unbind(4);
    h.sent.length = 0;

    h.mux.onTargetRemoved(-1, targetId);

    expect(framesOf(h.sent, 'Target.detachedFromTarget').map((f) => f.params.sessionId)).toEqual([sessionId]);
  });
});
