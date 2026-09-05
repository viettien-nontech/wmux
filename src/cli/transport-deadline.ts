/**
 * How long a wmux client waits for the pipe, derived from the transport rather
 * than written down per client.
 *
 * Two processes talk to wmux over the same socket: the CLI (`wmux.ts`) and the
 * Claude Code hook helper (`wmux-hook.ts`). Both had their own copy of the same
 * pair of numbers and their own idea of when to use which — the CLI derived it
 * from `remoteTarget || usesNpiperelay()`, the hook hardcoded
 * `remote ? 30000 : 5000`. Same intent, two spellings, and only one of them
 * knew about npiperelay. A third client, or a change to either number, would
 * have had to find both.
 *
 * So the transport describes itself and the deadline follows. Nothing here does
 * I/O; the caller supplies what it already knows about its own connection.
 */

/**
 * What a local named pipe on the same machine is worth waiting.
 *
 * Sized for a round-trip that is sub-millisecond, so the whole budget is the
 * server's own thinking time. This deadline has to stay LARGER than whatever
 * the main process spends serving the same request, or the client loses a race
 * it should never have been in: a command that succeeds late is reported as a
 * failure and the server's own diagnosis is discarded unread.
 */
export const DEFAULT_V2_TIMEOUT_MS = 5000;

/**
 * A floor under every deadline, for transports slower than a local pipe.
 *
 * Neither transport added for issue #19 is a local pipe: TCP to a `wmux bridge`
 * from inside a devcontainer, and npiperelay over WSL interop. Both measure ~7s
 * worst case on a corporate-managed host — above the 5s default on their own,
 * before wmux has done anything — so every request from a container reported a
 * timeout for a call that had already succeeded.
 *
 * A floor rather than a replacement, so a browser verb keeps the longer budget
 * it asked for and a local run keeps its original timings exactly.
 */
export const SLOW_TRANSPORT_FLOOR_MS = 30000;

export interface Transport {
  /** Talking TCP to a `wmux bridge` instead of a local pipe. */
  remote: boolean;
  /** The pipe path this client would dial locally. */
  pipePath: string;
  /** Where WSL_DISTRO_NAME / WSLENV / WMUX_RPC_TIMEOUT_MS are read from. */
  env: NodeJS.ProcessEnv;
}

/**
 * Whether the local hop goes through npiperelay.exe over WSL interop.
 *
 * A Windows pipe path (`\\.\pipe\wmux`, not something rooted at `/`) reached
 * from inside a WSL distro cannot be dialled directly — npiperelay is what
 * bridges it, and spawning a Windows executable over interop is the slow part,
 * especially where AV scans the binary on each exec.
 *
 * **Not `WSLENV`.** That variable names which variables to FORWARD into a
 * distro, so it is set by whoever is doing the forwarding — Windows Terminal
 * sets it on the WINDOWS side, and a native Windows machine with no WSL
 * installed carries `WSLENV=WT_SESSION:WT_PROFILE_ID:`. Reading it as "we are
 * inside WSL" sent the CLI down the relay branch on a machine that could dial
 * the pipe directly, and every verb died with "npiperelay.exe not found".
 *
 * `WSL_DISTRO_NAME` and `WSL_INTEROP` are set INSIDE a distro, and interop is
 * the thing npiperelay actually needs — with interop off the relay could not
 * run anyway, so the branch would be wrong even if we were in WSL. Same two
 * signals `readWslEnvironment()` in wmux.ts already used.
 */
export function usesNpiperelay(t: Transport): boolean {
  return !t.remote && !t.pipePath.startsWith('/')
    && Boolean(t.env.WSL_DISTRO_NAME || t.env.WSL_INTEROP);
}

/** Whether this transport needs the floor at all. */
export function isSlowTransport(t: Transport): boolean {
  return t.remote || usesNpiperelay(t);
}

/**
 * `base`, raised to the slow-transport floor when the transport is a slow one.
 *
 * `WMUX_RPC_TIMEOUT_MS` overrides the floor for anyone whose link is slower
 * still, and is itself a floor rather than a cap — it can only ever lengthen a
 * deadline, so setting it can never cause the truncation this exists to avoid.
 */
export function transportDeadline(base: number, t: Transport): number {
  const override = parseInt(t.env.WMUX_RPC_TIMEOUT_MS || '', 10);
  if (Number.isFinite(override) && override > 0) return Math.max(base, override);
  return isSlowTransport(t) ? Math.max(base, SLOW_TRANSPORT_FLOOR_MS) : base;
}
