// src/main/cdp-proxy.ts
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { webContents } from 'electron';
import {
  TargetMultiplexer,
  parseDebuggerPath,
} from './cdp-target-multiplexer';
import { TargetRegistry } from './cdp-target-registry';
import { SharedDomains } from './cdp-shared-domains';

const DEFAULT_PORT = 9222;
const MAX_PORT = 9230;

// DNS-rebinding guard. The proxy binds to loopback only, but a browser on the
// same machine can still reach it if a malicious page resolves an attacker
// domain to 127.0.0.1. Chrome's own remote-debugging endpoint rejects such
// requests by requiring the Host header to be a loopback literal (or absent,
// as with non-HTTP WebSocket/native clients). We mirror that policy so the
// full CDP surface (Runtime.evaluate ⇒ arbitrary JS in the webview) can't be
// driven from a web origin.
export function isAllowedCdpHost(hostHeader: string | undefined): boolean {
  // Native CDP clients (e.g. raw ws) may omit Host — allow only when absent.
  if (hostHeader === undefined) return true;
  // Strip optional :port. Bracketed IPv6 arrives as "[::1]:9222"; a bare IPv6
  // literal ("::1") has multiple colons and no port to strip.
  let host = hostHeader.trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  } else {
    const colon = host.indexOf(':');
    // Only treat a single trailing :port as a port (IPv4 / hostname). Multiple
    // colons with no brackets ⇒ bare IPv6 literal, leave intact.
    if (colon !== -1 && host.indexOf(':', colon + 1) === -1) {
      host = host.slice(0, colon);
    }
  }
  host = host.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1';
}

// Origin guard for the WebSocket upgrade. The Host check alone is NOT enough:
// WebSocket connections are exempt from CORS preflight, so a malicious page in
// the user's browser can open ws://127.0.0.1:9222 directly — the browser sends
// Host: 127.0.0.1:9222 (which passes isAllowedCdpHost) but also an Origin
// header identifying the web page. Driving the proxy then yields
// Runtime.evaluate (arbitrary JS in the webview) ⇒ RCE-equivalent.
//
// Legit CDP clients (chrome-devtools-mcp / puppeteer-core / raw `ws`) do NOT
// send an Origin header, while browsers ALWAYS send one for a page-initiated
// WebSocket. So we allow only an absent Origin (plus the DevTools front-end
// scheme) and reject every web/file origin — mirroring Chrome's own
// --remote-allow-origins policy.
export function isAllowedCdpOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  if (origin.toLowerCase().startsWith('devtools://')) return true;
  return false;
}

/** A connected browser-level client, as the proxy needs to notify it. */
interface BrowserClient {
  /** A surface appeared for the FIRST time: announce a new target. */
  onTargetAdded(wcId: number): void;
  /** A surface is really gone: announce its target's death. */
  onTargetRemoved(wcId: number, targetId: string): void;
  /**
   * Same surface, new webContents. SILENT on purpose.
   *
   * A React remount produces detach-then-attach within milliseconds, and
   * announcing it made every client watching an untouched pane see its target
   * destroyed and replaced. Listeners move; nothing is said.
   */
  onTargetRebound(wcId: number): void;
  /** Its webContents went away, but the surface has not. Also silent. */
  onTargetUnbound(wcId: number): void;
}

export class CDPProxy {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  /**
   * The port this proxy actually bound, or null when it holds none (issue #157).
   *
   * Deliberately not seeded with DEFAULT_PORT. That initialiser was an optimistic
   * claim made before anything was bound, and `start()` resolves even when the
   * whole 9222-9230 range is busy — so exhausting the range left the field
   * asserting 9222, a port the proxy does not own and never listened on.
   * "Nothing bound" and "bound the default" then became indistinguishable to
   * every reader, including the test written to catch exactly this.
   */
  private port: number | null = null;
  /**
   * Every attached browser pane, in attach order.
   *
   * This used to be a single `webContentsId`, which is what made two CDP
   * clients on this port fight: whichever pane attached last owned the one
   * advertised target, and closing that pane set the field to null and took the
   * endpoint away from everyone — including clients driving a pane that was
   * still open. A Set both keeps the survivors and gives the Target domain
   * something to enumerate.
   */
  private targets = new Set<number>();
  private sockets = new Set<WebSocket>();
  private browserClients = new Set<BrowserClient>();

  /**
   * Who holds which CDP domain on which pane — ONE ledger for the whole proxy.
   *
   * Not per connection, because what it describes is not per connection: a pane
   * has a single real debugger session and `Runtime.enable` is state ON that
   * session. Give each client its own ledger and both believe they turned
   * Runtime on, the second is never told the page's execution contexts, and
   * puppeteer waits for a main-world context that never comes.
   */
  private domains = new SharedDomains();

  /**
   * Who each browser pane IS, independently of which webContents shows it.
   *
   * See `cdp-target-registry.ts` for the measurement this came out of: closing
   * ONE browser pane used to change the target id of every OTHER one, because
   * identity was the webContents id and a React remount mints a new one.
   */
  private registry = new TargetRegistry();

  /**
   * A browser pane attached, or re-attached after a remount.
   *
   * The FIRST attach for a surface announces a target. Every later one is a
   * rebind: same identity, new webContents, and clients are told nothing.
   */
  addTarget(wcId: number, surfaceId?: string | null): void {
    /* No surface id means a caller that predates identity-by-surface. Fall back
       to the webContents id so such a pane still gets a stable-enough handle
       rather than none at all. */
    const surface = surfaceId || `wc-${wcId}`;
    const laMoi = this.registry.targetIdForSurface(surface) === null;
    this.registry.bind(surface, wcId);
    this.targets.add(wcId);
    for (const client of this.browserClients) {
      if (laMoi) client.onTargetAdded(wcId);
      else client.onTargetRebound(wcId);
    }
  }

  /**
   * This webContents is going away — the pane may or may not be.
   *
   * A React unmount cannot tell the two apart, so this NEVER ends a target.
   * Only `surfaceGone` does.
   */
  detachTarget(wcId: number): void {
    if (!this.targets.delete(wcId)) return;
    this.registry.unbind(wcId);
    for (const client of this.browserClients) client.onTargetUnbound(wcId);
  }

  /** A browser pane is really closed. The only thing that kills a target. */
  surfaceGone(surfaceId: string): void {
    const targetId = this.registry.targetIdForSurface(surfaceId);
    if (!targetId) return;
    const wcId = this.registry.wcIdFor(targetId);
    this.registry.surfaceGone(surfaceId);
    if (typeof wcId === 'number') this.targets.delete(wcId);
    for (const client of this.browserClients) client.onTargetRemoved(wcId ?? -1, targetId);
  }

  /** Identity, for the multiplexer and for `/json/list`. */
  targetIdFor(wcId: number): string | null { return this.registry.targetIdFor(wcId); }
  wcIdForTargetId(targetId: unknown): number | null { return this.registry.wcIdFor(targetId); }

  /**
   * The pane a target-less client gets.
   *
   * Kept for `/devtools/page/<id>` sockets whose id names no live pane — a raw
   * client holding a URL from an older `/json/list`. Deliberately NOT used by
   * the browser socket, where guessing is the bug.
   */
  get currentWebContentsId(): number | null {
    const live = [...this.targets];
    return live.length > 0 ? live[live.length - 1] : null;
  }

  /** Attached panes, for tests and for the Target domain. */
  get attachedTargets(): number[] {
    return [...this.targets];
  }

  private infoFor(wcId: number): { title: string; url: string } | null {
    try {
      const wc = webContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) return null;
      return { title: wc.getTitle() || '', url: wc.getURL() || '' };
    } catch {
      return null;
    }
  }

  private browserVersion(): {
    protocolVersion: string; product: string; revision: string; userAgent: string; jsVersion: string;
  } {
    const chrome = process.versions.chrome || '0.0.0.0';
    const chromeMajor = chrome.split('.')[0];
    return {
      protocolVersion: '1.3',
      product: `Chrome/${chrome}`,
      revision: '',
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
      jsVersion: (process.versions.v8 || '').split('-')[0],
    };
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');

      // Reject cross-origin (DNS-rebinding) requests before exposing any
      // CDP target metadata or WebSocket debugger URLs.
      if (!isAllowedCdpHost(req.headers.host)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'Forbidden host' }));
        return;
      }

      if (req.url === '/json/version') {
        // Derive from the running Electron's actual versions so strict CDP
        // clients (chrome-devtools-mcp, puppeteer-core) negotiate correctly and
        // this never goes stale across Electron/Chromium bumps.
        const chrome = process.versions.chrome || '0.0.0.0';
        const chromeMajor = chrome.split('.')[0];
        const v8 = (process.versions.v8 || '').split('-')[0];
        res.end(JSON.stringify({
          Browser: `Chrome/${chrome}`,
          'Protocol-Version': '1.3',
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
          'V8-Version': v8,
          'WebKit-Version': '537.36',
          webSocketDebuggerUrl: `ws://localhost:${this.port}/devtools/browser/1`,
        }));
        return;
      }

      if (req.url === '/json/list' || req.url === '/json') {
        // One entry per open browser pane. Chrome lists every tab here and so
        // do we; a single hard-coded `id: '1'` was the reason a second pane was
        // invisible to anything that read this endpoint.
        const pages = [...this.targets].flatMap((wcId) => {
          const info = this.infoFor(wcId);
          const targetId = this.registry.targetIdFor(wcId);
          if (!info || !targetId) return [];
          return [{
            description: '',
            devtoolsFrontendUrl: '',
            id: targetId,
            type: 'page',
            title: info.title,
            url: info.url,
            webSocketDebuggerUrl: `ws://localhost:${this.port}/devtools/page/${targetId}`,
          }];
        });
        res.end(JSON.stringify(pages));
        return;
      }

      // Chrome DevTools also queries /json/protocol
      if (req.url === '/json/protocol') {
        res.end('{}');
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });

    // WebSocket server using ws library (handles handshake properly).
    // verifyClient applies BOTH a loopback-only Host policy AND an Origin policy
    // to the WS upgrade. The Host check stops DNS-rebinding; the Origin check
    // stops a page in the user's own browser from opening this debugger socket
    // directly (WebSockets bypass CORS, so a passing Host isn't sufficient).
    this.wss = new WebSocketServer({
      server: this.server,
      verifyClient: (info: { req: http.IncomingMessage }) =>
        isAllowedCdpHost(info.req.headers.host) && isAllowedCdpOrigin(info.req.headers.origin),
    });

    this.wss.on('connection', (ws, req) => {
      // The path decides what this socket IS. Ignoring it — which is what this
      // handler used to do — is why a browser-level client and a page-level one
      // were treated identically and both ended up bound to one arbitrary pane.
      const route = parseDebuggerPath(req?.url);
      this.sockets.add(ws);
      const forget = () => { this.sockets.delete(ws); };

      if (route?.kind === 'browser') {
        this.serveBrowserSocket(ws, forget);
        return;
      }

      const requested = route?.kind === 'page' ? this.registry.wcIdFor(route.targetId) : null;
      // An id naming no live pane falls back to the most recent one, which is
      // what a raw client holding a stale `/json/list` URL used to get.
      const wcId = requested !== null && this.targets.has(requested) ? requested : this.currentWebContentsId;
      if (wcId === null) {
        forget();
        ws.close(1011, 'Browser panel is not open');
        return;
      }
      this.servePageSocket(ws, wcId, forget);
    });

    // Safety nets: never let an 'error' event become an uncaught exception.
    // BOTH emitters need one. `ws` forwards the http server's 'error' events
    // onto the WebSocketServer, so without a wss listener the failed listen()
    // below (port busy — the common case when a second wmux instance starts and
    // the first already holds 9222) is re-emitted on the wss as an unhandled
    // 'error'. That crashes the main process with Electron's modal error dialog,
    // which in turn blocks the event loop and wedges the whole instance.
    this.server.on('error', () => {});
    this.wss.on('error', () => {});

    // Try ports 9222-9230
    for (let p = DEFAULT_PORT; p <= MAX_PORT; p++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onListenError = (err: Error): void => {
            // Drop this probe's SUCCESS listener too. `listen(port, host, cb)`
            // registers cb via once('listening'), and a probe that fails never
            // consumes it — so nine failures leave nine live callbacks, which
            // is the MaxListenersExceededWarning seen in issue #157. They are
            // not inert: they all fire when a later port succeeds, each one
            // assigning its own `p`. That is harmless today only because
            // listeners run in registration order and the winner registers
            // last. Removing it makes that harmless by construction instead.
            this.server!.removeListener('listening', onListening);
            reject(err);
          };
          const onListening = (): void => {
            // Drop only THIS probe's listener. removeAllListeners('error') would
            // also strip the safety net above and ws's own forwarder, leaving a
            // post-bind server error with no handler — uncaught again.
            this.server!.removeListener('error', onListenError);
            this.port = p;
            resolve();
          };
          this.server!.once('error', onListenError);
          this.server!.once('listening', onListening);
          this.server!.listen(p, '127.0.0.1');
        });
        console.log(`[wmux] CDP proxy listening on localhost:${p}`);
        return;
      } catch {
        continue;
      }
    }
    // Nothing bound. `port` stays null rather than reverting to an optimistic
    // DEFAULT_PORT, so getPort()/isListening() cannot present an unbound proxy
    // as a bound one (issue #157). Still resolves rather than rejecting: the
    // call site in index.ts treats the proxy as optional and would swallow a
    // rejection anyway — it is the STATE that has to be truthful, not the
    // control flow.
    console.warn(
      `[wmux] CDP proxy: all ports ${DEFAULT_PORT}-${MAX_PORT} busy — browser automation is unavailable`,
    );
  }

  /** Run one page-level command against a pane, or reject the way CDP does. */
  private async sendCommandTo(wcId: number, method: string, params: unknown): Promise<unknown> {
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) throw new Error('Browser not attached');
    return wc.debugger.sendCommand(method, (params ?? {}) as any);
  }

  /**
   * The multiplexed browser socket: every pane, addressed by sessionId.
   *
   * This is the socket `/json/version` advertises, and therefore the one
   * puppeteer-core — so chrome-devtools-mcp — actually connects to.
   */
  private serveBrowserSocket(ws: WebSocket, forget: () => void): void {
    const listeners = new Map<number, (event: any, method: string, params: any) => void>();
    const mux = new TargetMultiplexer({
      listTargets: () => [...this.targets],
      infoFor: (wcId) => this.infoFor(wcId),
      send: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      sendCommand: (wcId, method, params) => this.sendCommandTo(wcId, method, params),
      version: () => this.browserVersion(),
      targetIdFor: (wcId) => this.registry.targetIdFor(wcId),
      wcIdForTargetId: (targetId) => this.registry.wcIdFor(targetId),
      domains: this.domains,
    });

    const listen = (wcId: number): void => {
      if (listeners.has(wcId)) return;
      try {
        const wc = webContents.fromId(wcId);
        if (!wc || wc.isDestroyed()) return;
        const onMessage = (_e: any, method: string, params: any) => mux.onPageEvent(wcId, method, params);
        wc.debugger.on('message', onMessage);
        listeners.set(wcId, onMessage);
      } catch {
        // A pane that died between listing and listening simply has no events.
      }
    };
    const unlisten = (wcId: number): void => {
      const onMessage = listeners.get(wcId);
      if (!onMessage) return;
      listeners.delete(wcId);
      try { webContents.fromId(wcId)?.debugger.removeListener('message', onMessage); } catch { /* pane already gone */ }
    };

    for (const wcId of this.targets) listen(wcId);

    const client: BrowserClient = {
      onTargetAdded: (wcId) => { listen(wcId); mux.onTargetAdded(wcId); },
      // Order matters: the multiplexer still needs the target to describe it in
      // the detach/destroy frames, so stop listening only afterwards.
      onTargetRemoved: (wcId, targetId) => { mux.onTargetRemoved(wcId, targetId); unlisten(wcId); },
      // Silent halves of a remount: move the debugger listener, say nothing.
      onTargetRebound: (wcId) => { listen(wcId); },
      onTargetUnbound: (wcId) => { unlisten(wcId); },
    };
    this.browserClients.add(client);

    const cleanup = () => {
      this.browserClients.delete(client);
      // Hand the domains back BEFORE dropping the listeners: these sessions may
      // be the last holders, and only a real `disable` puts the pane back the
      // way a client that has gone away found it.
      void mux.dispose().finally(() => {
        for (const wcId of [...listeners.keys()]) unlisten(wcId);
      });
      forget();
    };

    ws.on('message', (data) => {
      let msg: unknown;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      void mux.handle(msg);
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    console.log('[wmux] CDP proxy: browser client connected');
  }

  /** A direct socket onto one pane — the shape `/json/list` advertises. */
  private servePageSocket(ws: WebSocket, wcId: number, forget: () => void): void {
    const wc = webContents.fromId(wcId);
    if (!wc) {
      forget();
      ws.close(1011, 'Browser webContents not found');
      return;
    }

    const onDebuggerMessage = (_event: any, method: string, params: any) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method, params }));
    };
    wc.debugger.on('message', onDebuggerMessage);

    const cleanup = () => {
      try { wc.debugger.removeListener('message', onDebuggerMessage); } catch { /* pane already gone */ }
      forget();
    };

    ws.on('message', async (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      try {
        const result = await this.sendCommandTo(wcId, msg.method, msg.params);
        ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (err: any) {
        ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: err.message } }));
      }
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    console.log(`[wmux] CDP proxy: page client connected (${this.registry.targetIdFor(wcId) ?? wcId})`);
  }

  stop(): void {
    // Every socket, not just the last one to connect. The old single `activeWs`
    // left earlier clients holding an open connection to a stopped proxy.
    for (const ws of this.sockets) { try { ws.close(); } catch { /* already closed */ } }
    this.sockets.clear();
    this.browserClients.clear();
    this.wss?.close();
    this.server?.close();
    this.server = null;
    this.wss = null;
    // A stopped proxy holds nothing, and must not keep claiming otherwise.
    this.port = null;
  }

  /** The port this proxy bound, or null when it holds none (issue #157). */
  getPort(): number | null {
    return this.port;
  }

  /** Whether the proxy actually holds a port. */
  isListening(): boolean {
    return this.port !== null;
  }
}
