/**
 * Account-wide agent quota, normalised for the sidebar banner.
 *
 * The numbers come from `quota.js --json`, a Node tool that reads each agent's
 * own usage files. This module is the boundary between that tool's output and
 * the banner: it turns whatever was printed into a shape the renderer can draw,
 * and it never invents a number it was not given.
 *
 * One line for the whole window, not one per pane. Three Claude panes share a
 * single 5-hour window, so a per-row number would be three chances to disagree
 * with itself and no extra information.
 */

export interface QuotaWindow {
  /** Percent consumed, or null when it could not be measured. Never defaulted to 0. */
  pct: number | null;
  /** Unix seconds when this window resets, or null when unknown. */
  resetsAt: number | null;
}

export interface QuotaBay {
  id: string;
  /** Two-letter label the tool already chose, e.g. `CC` / `CX`. */
  label: string;
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
}

export interface QuotaState {
  bays: QuotaBay[];
  /** Why the numbers are missing. Present only when they are. */
  error?: string;
}

/**
 * A window is "near limit" at 80% or more.
 *
 * This lives here, as a function of the value, because it could not live
 * anywhere useful before: the previous host coloured cells by *token name*, so
 * the same threshold had to be faked by publishing two differently-named tokens
 * and deleting whichever one did not apply. A renderer that colours by value
 * needs one predicate and no bookkeeping.
 */
export function isNearLimit(pct: number | null): boolean {
  return pct != null && pct >= 80;
}

/** Read one window off the tool's JSON, keeping "not measured" distinct from 0. */
function readWindow(raw: unknown): QuotaWindow {
  const w = (raw ?? {}) as Record<string, unknown>;
  return {
    pct: typeof w.pct === 'number' ? w.pct : null,
    resetsAt: typeof w.resets_at === 'number' ? w.resets_at : null,
  };
}

export function parseQuota(raw: unknown): QuotaState {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const bays = Array.isArray(obj.bays) ? obj.bays : [];
  const error = typeof obj.error === "string" && obj.error ? obj.error : undefined;
  return {
    ...(error ? { error } : {}),
    bays: bays.map((b: Record<string, unknown>) => ({
      id: String(b.id ?? ''),
      label: String(b.nhan ?? ''),
      fiveHour: readWindow(b.five_hour),
      sevenDay: readWindow(b.seven_day),
    })),
  };
}
