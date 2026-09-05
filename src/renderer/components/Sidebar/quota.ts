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
  /**
   * How the tool's reading of THIS bay went: `ok`, or something else when the
   * numbers are missing or no longer trustworthy.
   *
   * Absent from an older tool, so it defaults to `ok` — the two repos ship
   * separately and a wmux with this field will meet a tool without it.
   */
  status: string;
  /**
   * Why the numbers are missing, in the tool's own words. Empty when there is
   * nothing to explain.
   *
   * `?` was doing two jobs and hiding the difference: "no agent has ever run
   * here" and "the reading expired" rendered identically. Carried rather than
   * composed here, so the sidebar and the terminal never word it differently.
   */
  reason: string;
}

export interface QuotaState {
  bays: QuotaBay[];
  /** Why the numbers are missing. Present only when they are. */
  error?: string;
}

/**
 * The two numbers the whole quota signal turns on: colour the banner at `warn`,
 * ring the bell at `warn` and again at `alert`.
 */
export interface QuotaThresholds {
  /** Colour + first ring. */
  warn: number;
  /** Second ring, and the point where the wording stops being calm. */
  alert: number;
}

/**
 * What they were before anyone could change them, and still what they mean when
 * a settings file says nothing.
 *
 * Stated once, here, because the same pair was written into three places by
 * hand — this module, `quota-alerts.ts`, and cockpit's `statusline.js` — and
 * the third had drifted to 90 with nobody noticing. Two of those now read this.
 */
export const DEFAULT_QUOTA_THRESHOLDS: QuotaThresholds = { warn: 80, alert: 95 };

/**
 * Turn whatever settings hold into a usable pair. Never throws, never refuses.
 *
 * `settings.json` has a second writer — a person with an editor — so these
 * arrive as `unknown` far more often than the Settings inputs suggest. The
 * repairs are deliberate rather than defensive:
 *
 * - **Per field**, so a garbled `warn` cannot also discard a good `alert`.
 * - **Clamped to 1..100**, the range percentages live in. Above 100 is the one
 *   that matters: a threshold no reading can reach is a bell that never rings
 *   and never says why. The bottom of the range is honest rather than
 *   protective — 1 really does mean "tell me about everything", and there is no
 *   way to tell that apart from a typo, so it is taken at its word.
 * - **Sorted, not rejected.** Once they are two numbers on a page, an inverted
 *   pair is indistinguishable from a mistyped one, and the lower number is the
 *   warning under either reading. There is no error state worth having here:
 *   the alternative is a bell that stops working and says why in a file nobody
 *   opens.
 */
export function quotaThresholds(warnPct: unknown, alertPct: unknown): QuotaThresholds {
  const a = clampPct(warnPct, DEFAULT_QUOTA_THRESHOLDS.warn);
  const b = clampPct(alertPct, DEFAULT_QUOTA_THRESHOLDS.alert);
  return { warn: Math.min(a, b), alert: Math.max(a, b) };
}

function clampPct(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/**
 * A window is "near limit" at `warn` percent or more.
 *
 * This lives here, as a function of the value, because it could not live
 * anywhere useful before: the previous host coloured cells by *token name*, so
 * the same threshold had to be faked by publishing two differently-named tokens
 * and deleting whichever one did not apply. A renderer that colours by value
 * needs one predicate and no bookkeeping.
 *
 * The threshold is an argument with a default rather than a required one, so
 * that a caller which has not been given the user's setting keeps the old
 * meaning instead of colouring on `undefined` — silently never, which looks
 * exactly like a quiet account.
 */
export function isNearLimit(pct: number | null, warn: number = DEFAULT_QUOTA_THRESHOLDS.warn): boolean {
  return pct != null && pct >= warn;
}

/**
 * The short word next to a bay when part of its reading is missing, or `null`
 * when there is nothing to flag.
 *
 * Half a reading is Codex's normal shape, not an edge case: the 5-hour window
 * expires while the weekly one is still good. The banner used to flag a bay
 * only when BOTH windows were empty, so on 2026-09-05 it showed a bare `5h ?`
 * while every other surface the same tool feeds — two terminal renderings, the
 * TUI frame, both boards — printed `5h ? · Weekly 18% · <reason>`. Nothing on
 * screen was false; there was just less of it here, and only on hover.
 *
 * Silent without a `reason`. A missing number with no explanation may simply
 * never have been measured, and calling that stale would invent a cause the
 * tool never claimed.
 */
export function staleBadge(bay: QuotaBay): string | null {
  const missing = [
    bay.fiveHour.pct == null ? '5h' : null,
    bay.sevenDay.pct == null ? 'Weekly' : null,
  ].filter((w): w is string => w !== null);

  if (missing.length === 0) return null;
  if (bay.status === 'ok' && !bay.reason) return null;

  /* Both gone: naming the windows buys nothing in a row this narrow, because
     no number is left for the name to qualify. Unchanged from before. */
  if (missing.length === 2) return bay.status === 'stale' ? 'cũ' : bay.status;

  return `${missing[0]} cũ`;
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
      status: typeof b.status === 'string' && b.status ? b.status : 'ok',
      reason: typeof b.reason === 'string' ? b.reason : '',
    })),
  };
}

/**
 * "22:14" from a unix-seconds reset time — the same formatting quota.js's
 * own `gio()` uses, so the sidebar and the Node tool never disagree about
 * what a reset time looks like.
 */
export function formatResetTime(unixSeconds: number | null): string {
  if (unixSeconds == null) return '';
  const d = new Date(unixSeconds * 1000);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}
