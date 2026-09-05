/**
 * The V-model review switch, as the sidebar sees it.
 *
 * A second AI reviews the first one's work before it is accepted. That review
 * is run by an external tool (`chuV/soat.js`, in a separate repo), so nothing
 * here starts or watches it — this is the one bit of that workflow the user
 * needs at hand: an off switch, because the review costs real money on every
 * run and the decision to spend it should not require editing a JSON file.
 *
 * The tool reads the same key straight off `settings.json`. Two readers, two
 * languages, one fact — so the DEFAULT has to match on both sides, and it is
 * stated here rather than assumed: see `chuVEnabled`.
 */

/** Top-level key in `%APPDATA%\wmux\settings.json`. */
export const CHU_V_KEY = 'chuV';

export interface ChuVSettings {
  /** Absent means on. See `chuVEnabled`. */
  bat?: boolean;
}

/**
 * Is the review switch on, given the whole settings snapshot?
 *
 * **Absent means ON**, and that is the load-bearing part: the switch was added
 * to a workflow that already ran, so a settings file written before it existed
 * must keep behaving the way it did. A default of `false` would silently stop
 * reviewing for everyone who never touched the setting — the failure nobody
 * notices, because its symptom is an absence.
 *
 * Anything malformed also reads as on, for the same reason: a broken value is
 * not an instruction to stop.
 */
export function chuVEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  const o = settings?.[CHU_V_KEY];
  if (!o || typeof o !== 'object') return true;
  return (o as ChuVSettings).bat !== false;
}
