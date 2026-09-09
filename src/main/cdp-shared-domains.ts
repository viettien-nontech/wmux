// src/main/cdp-shared-domains.ts
//
// One pane, one real CDP session — shared by every client on 9222.
//
// Electron gives a webContents exactly ONE debugger session (`wc.debugger`,
// attached in cdp-bridge), and the multiplexer hands out many virtual sessions
// over it. That works for one-shot commands, which carry their whole meaning in
// the frame, and breaks for the `enable`/`disable` family, which is SESSION
// state:
//
//   * `Runtime.enable` announces the page's execution contexts once, to the
//     session that turned it on. A second client's `enable` reaches an already
//     enabled session, gets a bare `{}`, and hears about no contexts at all —
//     puppeteer then waits for a main-world context that never comes, forever.
//     Measured, not deduced: second enable → 0 `executionContextCreated`;
//     `disable` then `enable` → 3.
//   * `disable` is worse, because it is loud. One client turning Network off
//     took the events away from every other client on the same pane.
//
// So the enable-family stops being forwarded blindly. This registry owns it:
// who holds a domain on which pane, and what state a latecomer must be told to
// catch up. It holds no sockets and no Electron types on purpose — the whole
// thing is testable with plain objects.

/** What a claim means for the caller: really enable, or just catch this session up. */
export type ClaimResult = 'first' | 'again';

/** What a release means: really disable, leave it on, or the session never held it. */
export type ReleaseResult = 'last' | 'others-remain' | 'not-held';

/** A frame to replay to a session that arrived late. */
export interface ReplayFrame {
  method: string;
  params: unknown;
}

/** The `Runtime.executionContextCreated` payload, as much of it as we keep. */
interface ContextParams {
  context: { id: number; [k: string]: unknown };
}

interface PaneState {
  /** domain → sessions holding it. A domain key exists once anyone has claimed it. */
  holders: Map<string, Set<string>>;
  /** Execution contexts the pane has announced, by context id, in arrival order. */
  contexts: Map<number, ContextParams>;
}

/** Domains whose `enable` replays state, and therefore need catching up. */
const REPLAYING_DOMAINS = new Set(['Runtime']);

export class SharedDomains {
  private panes = new Map<number, PaneState>();

  private paneState(wcId: number): PaneState {
    let state = this.panes.get(wcId);
    if (!state) {
      state = { holders: new Map(), contexts: new Map() };
      this.panes.set(wcId, state);
    }
    return state;
  }

  /**
   * Register that a session wants `domain` on `wcId`.
   *
   * `first` means nobody held it, so the caller must send the real `enable`.
   * `again` means the underlying session already has it on and the caller must
   * instead replay `replayFor(...)` to the newcomer.
   */
  claim(wcId: number, sessionId: string, domain: string): ClaimResult {
    const holders = this.paneState(wcId).holders;
    let sessions = holders.get(domain);
    if (!sessions) {
      sessions = new Set();
      holders.set(domain, sessions);
    }
    const wasEmpty = sessions.size === 0;
    sessions.add(sessionId);
    return wasEmpty ? 'first' : 'again';
  }

  /** Drop one session's hold. Only `last` may be turned into a real `disable`. */
  release(wcId: number, sessionId: string, domain: string): ReleaseResult {
    const state = this.panes.get(wcId);
    const sessions = state?.holders.get(domain);
    if (!state || !sessions || !sessions.delete(sessionId)) return 'not-held';
    if (sessions.size > 0) return 'others-remain';
    if (REPLAYING_DOMAINS.has(domain)) state.contexts.clear();
    return 'last';
  }

  /** Drop every hold a session had on a pane, naming the domains now unheld. */
  releaseSession(wcId: number, sessionId: string): string[] {
    const state = this.panes.get(wcId);
    if (!state) return [];
    const freed: string[] = [];
    for (const domain of [...state.holders.keys()]) {
      if (this.release(wcId, sessionId, domain) === 'last') freed.push(domain);
    }
    return freed;
  }

  /** Does this session currently hold the domain? Used to route events truthfully. */
  holds(wcId: number, sessionId: string, domain: string): boolean {
    return this.panes.get(wcId)?.holders.get(domain)?.has(sessionId) ?? false;
  }

  /**
   * Has anyone ever gated this domain on this pane?
   *
   * Events from a domain nobody enables (`Inspector`, `Target`) must keep
   * flowing to every session; only a gated domain is filtered by holder.
   */
  isGated(wcId: number, domain: string): boolean {
    return this.panes.get(wcId)?.holders.has(domain) ?? false;
  }

  /**
   * Watch the pane's own frames for the state a latecomer would miss.
   *
   * Every connected client has its own listener on the same pane, so the same
   * frame arrives once per connection — keying by context id makes that
   * idempotent rather than tripling the table.
   */
  noteEvent(wcId: number, method: string, params: unknown): void {
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const p = params as ContextParams;
        const id = p?.context?.id;
        if (typeof id !== 'number') return;
        this.paneState(wcId).contexts.set(id, p);
        return;
      }
      case 'Runtime.executionContextDestroyed': {
        const id = (params as { executionContextId?: number })?.executionContextId;
        if (typeof id !== 'number') return;
        this.panes.get(wcId)?.contexts.delete(id);
        return;
      }
      case 'Runtime.executionContextsCleared':
        this.panes.get(wcId)?.contexts.clear();
        return;
      default:
        return;
    }
  }

  /** The frames that bring a newly-enabled session level with the pane. */
  replayFor(wcId: number, domain: string): ReplayFrame[] {
    if (domain !== 'Runtime') return [];
    const contexts = this.panes.get(wcId)?.contexts;
    if (!contexts) return [];
    return [...contexts.values()].map((params) => ({ method: 'Runtime.executionContextCreated', params }));
  }

  /** The pane is gone. A recycled webContents id must not inherit its state. */
  forgetPane(wcId: number): void {
    this.panes.delete(wcId);
  }
}
