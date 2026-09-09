// src/main/cdp-target-multiplexer.ts
//
// The Target domain, spoken on the BROWSER-level CDP socket.
//
// Why this exists at all: wmux advertises a Chrome-shaped debugging endpoint on
// 9222, and the clients that matter do NOT read `/json/list` to find a page.
// puppeteer-core (and therefore chrome-devtools-mcp, which bundles it) reads
// `/json/version`, connects to the `webSocketDebuggerUrl` it finds there, and
// then discovers pages over that socket with `Target.getBrowserContexts`,
// `Target.setAutoAttach` and friends, addressing each one by `sessionId`.
//
// Before this module the proxy forwarded every frame straight into ONE page's
// `wc.debugger`, so those browser-level methods reached a page debugger that
// answers `Not allowed`, and every wmux browser pane collapsed into a single
// advertised target. Two Claude sessions pointed at 9222 were therefore driving
// the same pane no matter which one each had opened, and closing that pane took
// the endpoint away from both.
//
// Transport-agnostic on purpose: it takes `send` and `sendCommand` as deps, so
// the whole protocol can be tested with plain objects — no WebSocket, no
// Electron, no browser.

import type { SharedDomains } from './cdp-shared-domains';

/** A page target as the Target domain describes it. */
export interface CdpTargetInfo {
  targetId: string;
  type: 'page';
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener: false;
}

/** The stable target id for a browser pane's webContents. */
export function targetIdForWcId(wcId: number): string {
  return `wmux-page-${wcId}`;
}

/**
 * The webContents behind a target id, or null when the id is not one of ours.
 *
 * Ids arrive from a client, so this rejects rather than coerces: `Number('')`
 * is 0 and `Number('12abc')` is NaN, and both would otherwise be handed to
 * `webContents.fromId`.
 */
export function wcIdFromTargetId(targetId: unknown): number | null {
  if (typeof targetId !== 'string') return null;
  const match = /^wmux-page-(\d+)$/.exec(targetId);
  if (!match) return null;
  const wcId = Number(match[1]);
  return Number.isSafeInteger(wcId) ? wcId : null;
}

/**
 * Which socket a WebSocket upgrade is asking for.
 *
 * The proxy used to ignore the path entirely and bind every connection to
 * whichever pane was current, which is half of why two clients could not
 * coexist. `/devtools/browser/<id>` is the multiplexed browser socket;
 * `/devtools/page/<targetId>` is a direct page socket, kept because
 * `/json/list` advertises those URLs and raw CDP clients use them.
 */
export function parseDebuggerPath(
  rawUrl: string | undefined,
): { kind: 'browser' } | { kind: 'page'; targetId: string } | null {
  if (!rawUrl) return null;
  const path = rawUrl.split('?')[0];
  if (path.startsWith('/devtools/browser/')) return { kind: 'browser' };
  if (path.startsWith('/devtools/page/')) {
    const targetId = path.slice('/devtools/page/'.length);
    return targetId ? { kind: 'page', targetId } : null;
  }
  return null;
}

/** What the multiplexer needs from the world it runs in. */
export interface MultiplexerDeps {
  /** Every browser pane currently attached, as webContents ids. */
  listTargets(): number[];
  /** Title/url for a pane. Returns null when its webContents is gone. */
  infoFor(wcId: number): { title: string; url: string } | null;
  /** Send one CDP frame to the connected client. */
  send(message: unknown): void;
  /** Run a page-level command against one pane. */
  sendCommand(wcId: number, method: string, params: unknown): Promise<unknown>;
  /** Version strings for `Browser.getVersion`. */
  version(): { protocolVersion: string; product: string; revision: string; userAgent: string; jsVersion: string };
  /**
   * Who holds which domain on which pane — shared by every connection.
   *
   * It has to live outside this class: one pane has ONE real debugger session
   * (`wc.debugger`), so `Runtime.enable` and its family are state two clients
   * share whether they like it or not. See `cdp-shared-domains.ts`.
   */
  domains: SharedDomains;
}

/** Commands that turn a domain on or off, rather than asking the page something. */
const DOMAIN_GATE = /^([A-Za-z]+)\.(enable|disable)$/;

const CDP_METHOD_NOT_FOUND = -32601;
const CDP_INVALID_PARAMS = -32602;
const CDP_SERVER_ERROR = -32000;

/**
 * Session ids are minted per PROCESS, not per connection.
 *
 * A per-instance counter looks fine — each connection only ever resolves ids in
 * its own map — right up until two clients attach to the same pane and both are
 * handed `wmux-session-5-1`. Nothing in wmux would confuse them, but a shared
 * id is a lie about a protocol whose ids are documented as unique, and the next
 * thing that keys on one (a log, a metric, a future shared registry) inherits a
 * collision that is invisible until it isn't.
 */
let sessionCounter = 0;

/**
 * One connected browser-level client.
 *
 * Sessions are per-connection: two clients that both attach to the same pane
 * get different session ids and neither sees the other's frames. That is what
 * makes "session A closes its browser" stop being an event session B feels —
 * B's sessions are keyed to B's own targets and are untouched.
 */
export class TargetMultiplexer {
  private sessions = new Map<string, number>();
  private autoAttach = false;
  private discovering = false;

  constructor(private deps: MultiplexerDeps) {}

  /** Sessions this connection holds, as `sessionId → wcId`. Test seam. */
  get openSessions(): ReadonlyMap<string, number> {
    return this.sessions;
  }

  private targetInfo(wcId: number): CdpTargetInfo | null {
    const info = this.deps.infoFor(wcId);
    if (!info) return null;
    return {
      targetId: targetIdForWcId(wcId),
      type: 'page',
      title: info.title,
      url: info.url,
      attached: [...this.sessions.values()].includes(wcId),
      canAccessOpener: false,
    };
  }

  private allTargetInfos(): CdpTargetInfo[] {
    const infos: CdpTargetInfo[] = [];
    for (const wcId of this.deps.listTargets()) {
      const info = this.targetInfo(wcId);
      if (info) infos.push(info);
    }
    return infos;
  }

  private openSession(wcId: number): string {
    const sessionId = `wmux-session-${wcId}-${++sessionCounter}`;
    this.sessions.set(sessionId, wcId);
    return sessionId;
  }

  private emitAttached(sessionId: string, targetInfo: CdpTargetInfo, waitingForDebugger = false): void {
    this.deps.send({
      method: 'Target.attachedToTarget',
      params: { sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger },
    });
  }

  /** A browser pane appeared. Tell a client that asked to be told. */
  onTargetAdded(wcId: number): void {
    const info = this.targetInfo(wcId);
    if (!info) return;
    if (this.discovering) {
      this.deps.send({ method: 'Target.targetCreated', params: { targetInfo: info } });
    }
    if (this.autoAttach) {
      this.emitAttached(this.openSession(wcId), info);
    }
  }

  /**
   * A browser pane went away.
   *
   * Detach events come FIRST, then `targetDestroyed` — the order puppeteer
   * expects, and the order that lets a client tear a page down before its
   * target stops existing.
   */
  onTargetRemoved(wcId: number): void {
    for (const [sessionId, boundWcId] of [...this.sessions]) {
      if (boundWcId !== wcId) continue;
      this.sessions.delete(sessionId);
      this.deps.send({ method: 'Target.detachedFromTarget', params: { sessionId, targetId: targetIdForWcId(wcId) } });
    }
    if (this.discovering) {
      this.deps.send({ method: 'Target.targetDestroyed', params: { targetId: targetIdForWcId(wcId) } });
    }
    // The debugger died with the pane, so there is nothing to disable and
    // nothing worth remembering — and webContents ids are recycled, so a stale
    // entry would hand the NEXT pane a table of contexts that never existed.
    this.deps.domains.forgetPane(wcId);
  }

  /**
   * A page-level event from a pane, fanned out to this client's sessions for it.
   *
   * Filtered by who actually holds the domain: a client that sent
   * `Network.disable` must stop hearing Network, even though the real debugger
   * is still reporting it on behalf of somebody else. Domains nobody gates
   * (`Inspector`, `Target`) are never withheld.
   */
  onPageEvent(wcId: number, method: string, params: unknown): void {
    this.deps.domains.noteEvent(wcId, method, params);
    const domain = method.split('.')[0];
    const gated = this.deps.domains.isGated(wcId, domain);
    for (const [sessionId, boundWcId] of this.sessions) {
      if (boundWcId !== wcId) continue;
      if (gated && !this.deps.domains.holds(wcId, sessionId, domain)) continue;
      this.deps.send({ sessionId, method, params });
    }
  }

  /**
   * The client went away.
   *
   * Its sessions cannot release their own domains — nobody is left to send the
   * `disable` — so the connection does it on their behalf, or a pane stays
   * pinned in whatever state a client that no longer exists asked for.
   */
  async dispose(): Promise<void> {
    for (const [sessionId, wcId] of [...this.sessions]) {
      this.sessions.delete(sessionId);
      await this.releaseSessionDomains(wcId, sessionId);
    }
  }

  /** Hand back every domain a session held, really disabling the ones now unheld. */
  private async releaseSessionDomains(wcId: number, sessionId: string): Promise<void> {
    for (const domain of this.deps.domains.releaseSession(wcId, sessionId)) {
      try {
        await this.deps.sendCommand(wcId, `${domain}.disable`, {});
      } catch {
        // The pane is gone; the domain went with it.
      }
    }
  }

  /**
   * `Runtime.enable` and its family, which are state on a session everyone shares.
   *
   * Forwarding these verbatim is the bug: the second client's `enable` reaches
   * an already-enabled debugger, gets `{}` back and is told about no execution
   * contexts, and the first client's `disable` takes the domain away from every
   * other client at once.
   */
  private async handleDomainGate(
    id: number | undefined,
    sessionId: string,
    wcId: number,
    domain: string,
    action: 'enable' | 'disable',
    params: unknown,
  ): Promise<void> {
    const domains = this.deps.domains;

    if (action === 'disable') {
      const release = domains.release(wcId, sessionId, domain);
      try {
        if (release === 'last') await this.deps.sendCommand(wcId, `${domain}.disable`, params);
        this.reply(id, sessionId, { result: {} });
      } catch (err: any) {
        this.reply(id, sessionId, { error: { code: CDP_SERVER_ERROR, message: String(err?.message ?? err) } });
      }
      return;
    }

    const claim = domains.claim(wcId, sessionId, domain);
    try {
      if (claim === 'first') {
        // An off→on edge is the only thing that makes a domain announce its
        // state, and this process is not the only way the domain can have been
        // turned on: a raw `/devtools/page/...` socket forwards commands
        // straight through. So force the edge rather than trust the ledger.
        try {
          await this.deps.sendCommand(wcId, `${domain}.disable`, {});
        } catch {
          // Never enabled, or the domain has no disable. Either way, on we go.
        }
        await this.deps.sendCommand(wcId, `${domain}.enable`, params);
      } else {
        // Already on for somebody else, so the pane will announce nothing.
        // Replay what it announced the first time, to this session alone.
        for (const frame of domains.replayFor(wcId, domain)) {
          this.deps.send({ sessionId, method: frame.method, params: frame.params });
        }
      }
      this.reply(id, sessionId, { result: {} });
    } catch (err: any) {
      // The claim never took effect; holding it would keep the domain "on" for
      // a session that was told it failed.
      domains.release(wcId, sessionId, domain);
      this.reply(id, sessionId, { error: { code: CDP_SERVER_ERROR, message: String(err?.message ?? err) } });
    }
  }

  /** Handle one frame from the client. */
  async handle(raw: unknown): Promise<void> {
    const msg = raw as { id?: number; method?: string; params?: any; sessionId?: string };
    if (!msg || typeof msg.method !== 'string') return;
    const { id, method, params, sessionId } = msg;

    // A frame carrying a sessionId is for a page, not for the browser.
    if (sessionId !== undefined) {
      const wcId = this.sessions.get(sessionId);
      if (wcId === undefined) {
        this.reply(id, sessionId, { error: { code: CDP_SERVER_ERROR, message: `No session with id ${sessionId}` } });
        return;
      }
      const gate = DOMAIN_GATE.exec(method);
      if (gate) {
        await this.handleDomainGate(id, sessionId, wcId, gate[1], gate[2] as 'enable' | 'disable', params ?? {});
        return;
      }
      try {
        const result = await this.deps.sendCommand(wcId, method, params ?? {});
        this.reply(id, sessionId, { result: result ?? {} });
      } catch (err: any) {
        this.reply(id, sessionId, { error: { code: CDP_SERVER_ERROR, message: String(err?.message ?? err) } });
      }
      return;
    }

    switch (method) {
      case 'Target.getBrowserContexts':
        // wmux has no browser contexts to hand out; the empty list is the
        // truthful answer and is what puppeteer expects from a browser with
        // only a default context.
        this.reply(id, undefined, { result: { browserContextIds: [] } });
        return;

      case 'Target.getTargets':
        this.reply(id, undefined, { result: { targetInfos: this.allTargetInfos() } });
        return;

      case 'Target.setDiscoverTargets': {
        this.discovering = params?.discover !== false;
        this.reply(id, undefined, { result: {} });
        if (this.discovering) {
          for (const info of this.allTargetInfos()) {
            this.deps.send({ method: 'Target.targetCreated', params: { targetInfo: info } });
          }
        }
        return;
      }

      case 'Target.setAutoAttach': {
        this.autoAttach = params?.autoAttach === true;
        this.reply(id, undefined, { result: {} });
        if (!this.autoAttach) return;
        for (const info of this.allTargetInfos()) {
          const wcId = wcIdFromTargetId(info.targetId);
          if (wcId === null) continue;
          if ([...this.sessions.values()].includes(wcId)) continue;
          this.emitAttached(this.openSession(wcId), info);
        }
        return;
      }

      case 'Target.attachToTarget': {
        const wcId = wcIdFromTargetId(params?.targetId);
        const info = wcId === null ? null : this.targetInfo(wcId);
        if (wcId === null || !info) {
          this.reply(id, undefined, {
            error: { code: CDP_INVALID_PARAMS, message: `No target with given id found: ${params?.targetId}` },
          });
          return;
        }
        const newSessionId = this.openSession(wcId);
        this.reply(id, undefined, { result: { sessionId: newSessionId } });
        this.emitAttached(newSessionId, info);
        return;
      }

      case 'Target.detachFromTarget': {
        const target = params?.sessionId;
        const wcId = typeof target === 'string' ? this.sessions.get(target) : undefined;
        if (wcId === undefined) {
          this.reply(id, undefined, { error: { code: CDP_INVALID_PARAMS, message: 'No session with given id found' } });
          return;
        }
        this.sessions.delete(target);
        await this.releaseSessionDomains(wcId, target);
        this.reply(id, undefined, { result: {} });
        this.deps.send({
          method: 'Target.detachedFromTarget',
          params: { sessionId: target, targetId: targetIdForWcId(wcId) },
        });
        return;
      }

      case 'Browser.getVersion':
        this.reply(id, undefined, { result: this.deps.version() });
        return;

      case 'Target.createTarget':
      case 'Target.closeTarget':
      case 'Target.createBrowserContext':
      case 'Target.disposeBrowserContext':
      case 'Browser.close':
        // Refused rather than forwarded. A wmux browser pane is part of the
        // user's split tree, not a tab a remote client may open or close, and
        // `Browser.close` would take the whole app down with it.
        this.reply(id, undefined, {
          error: { code: CDP_METHOD_NOT_FOUND, message: `${method} is not supported by the wmux CDP proxy` },
        });
        return;

      default:
        // Everything else is page-level and was sent without a session. Say so
        // instead of forwarding it to an arbitrary pane — guessing which pane a
        // sessionless command meant is exactly the cross-talk this file removes.
        this.reply(id, undefined, {
          error: {
            code: CDP_METHOD_NOT_FOUND,
            message: `${method} needs a sessionId — attach to a target first (Target.attachToTarget)`,
          },
        });
    }
  }

  private reply(id: number | undefined, sessionId: string | undefined, body: Record<string, unknown>): void {
    if (id === undefined) return;
    this.deps.send(sessionId === undefined ? { id, ...body } : { id, sessionId, ...body });
  }
}
