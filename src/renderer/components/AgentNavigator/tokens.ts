/**
 * Per-pane token counts, normalised for the agent navigator.
 *
 * The numbers come from `token.js --json --kind <k> --cwd <dir>`, which reads
 * one agent session's own transcript. This module is the boundary between that
 * tool's output and the row that draws it, and like `Sidebar/quota.ts` it never
 * invents a number it was not given.
 *
 * Deliberately the SESSION total rather than the last turn. "How much has this
 * pane spent" is the question a token count is being asked here; the last turn
 * answers "was that turn unusually expensive", which changes on every turn and
 * cannot be summed. The tool reports both — this reads one of them.
 */

export interface PaneTokens {
  /** Tokens this agent session has used, or null when it could not be read. */
  sessionTotal: number | null;
  /** How the tool arrived at the total, when it said. */
  source: string | null;
  /** Why there is no number. Present only when there is a reason to give. */
  error?: string;
}

export function parsePaneTokens(raw: unknown): PaneTokens {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const total = (obj.sessionTotal ?? null) as Record<string, unknown> | null;
  const error = typeof obj.error === 'string' && obj.error ? obj.error : undefined;
  return {
    ...(error ? { error } : {}),
    sessionTotal: total && typeof total.totalTokens === 'number' ? total.totalTokens : null,
    source: total && typeof total.source === 'string' ? total.source : null,
  };
}

/**
 * "48.0k" from 48031 — the same shortening `token.js`'s own `gonSo()` does.
 *
 * Same rule as `formatResetTime` and quota.js's `gio()`: a number the user can
 * also read in the terminal must look identical in both places, or one figure
 * seen twice reads as two figures that disagree.
 */
export function formatTokens(total: number | null): string {
  if (total == null) return '';
  const v = Number(total) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (v >= 1e5) return `${Math.round(v / 1e3)}k`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}
