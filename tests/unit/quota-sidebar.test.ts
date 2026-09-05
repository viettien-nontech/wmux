import { describe, it, expect } from 'vitest';
import { parseQuota, isNearLimit, formatResetTime, staleBadge, quotaThresholds, DEFAULT_QUOTA_THRESHOLDS } from '../../src/renderer/components/Sidebar/quota';
import type { QuotaBay } from '../../src/renderer/components/Sidebar/quota';

// The sidebar shows one account-wide quota line, not one per pane: three Claude
// panes still share a single 5-hour window, so repeating the number on every row
// would be three chances to disagree with itself and no extra information.
//
// The numbers arrive as JSON from `quota.js --json` (a separate Node tool). This
// module is the boundary: it turns whatever that tool printed into something the
// banner can render, and it must never invent a number it was not given.

describe('parseQuota', () => {
  it('keeps a missing percentage as null, never 0', () => {
    // "not measured yet" and "none left" are different facts. Collapsing them
    // once let a dashboard lie for three days; the guard travels with the data.
    const state = parseQuota({
      bays: [{ id: 'claude', nhan: 'CC', five_hour: null, seven_day: { pct: 19 } }],
    });

    expect(state.bays[0].fiveHour.pct).toBeNull();
    expect(state.bays[0].fiveHour.pct).not.toBe(0);
    expect(state.bays[0].sevenDay.pct).toBe(19);
  });


  it('carries the reason forward when the tool could not read anything', () => {
    // A blank line where a number belongs reads as "you have used nothing".
    // Saying why beats saying nothing, even in the few characters a sidebar has.
    const state = parseQuota({ error: 'could not read rollout', bays: [] });

    expect(state.error).toBe('could not read rollout');
    expect(state.bays).toEqual([]);
  });

  it('survives anything the tool might print', () => {
    expect(() => parseQuota(null)).not.toThrow();
    expect(() => parseQuota(undefined)).not.toThrow();
    expect(() => parseQuota('not json at all')).not.toThrow();
    expect(parseQuota(null).bays).toEqual([]);
  });
});

describe('isNearLimit', () => {
  it('turns on at 80 percent, not before', () => {
    expect(isNearLimit(79)).toBe(false);
    expect(isNearLimit(80)).toBe(true);
    expect(isNearLimit(100)).toBe(true);
  });

  it('an unmeasured window is not an alarm', () => {
    // Colouring null red would report a problem the numbers do not support.
    expect(isNearLimit(null)).toBe(false);
  });
});

describe('formatResetTime', () => {
  it('formats the same way quota.js\'s gio() does — vi-VN, hour:2-digit, minute:2-digit', () => {
    // Computed the same way at test-run time rather than hardcoded, so this
    // isn't flaky across machines in different timezones — quota.js's gio()
    // also has no timeZone override, so both must track the RUNNING clock.
    const ts = 1788439200;
    const expected = new Date(ts * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    expect(formatResetTime(ts)).toBe(expected);
  });

  it('returns empty string when there is no reset time — never fabricates one', () => {
    expect(formatResetTime(null)).toBe('');
  });
});

describe('parseQuota — why a bay has no numbers', () => {
  // `?` was doing two jobs. "This agent has never run here" and "the reading
  // expired" both rendered as `CX 5h ? Weekly ?`, and on 2026-09-04 that cost
  // real time: Codex hit its usage limit, the collector said so in as many
  // words (`status: stale`, with a reason), and the sidebar showed the same
  // `?` it shows for an agent nobody has started. The tool always knew; the
  // door it came through dropped the answer.
  //
  // Carried, never invented: the reason is the collector's own sentence.

  it('keeps the status and reason a bay was given', () => {
    const state = parseQuota({
      bays: [{
        id: 'codex', nhan: 'CX', five_hour: null, seven_day: null,
        status: 'stale', reason: 'số đã hết hạn — chạy Codex một lượt là có số mới',
      }],
    });

    expect(state.bays[0].status).toBe('stale');
    expect(state.bays[0].reason).toMatch(/hết hạn/);
    expect(state.bays[0].fiveHour.pct).toBeNull();
  });

  it('a bay that read fine is not made to explain itself', () => {
    const state = parseQuota({
      bays: [{ id: 'claude', nhan: 'CC', five_hour: { pct: 41 }, seven_day: { pct: 22 }, status: 'ok', reason: '' }],
    });

    expect(state.bays[0].status).toBe('ok');
    expect(state.bays[0].reason).toBe('');
  });

  it('an older tool that sends neither field still renders', () => {
    // The two repos ship separately, so a wmux with this change WILL meet a
    // cockpit without it. Missing explanation must not cost the numbers.
    const state = parseQuota({
      bays: [{ id: 'claude', nhan: 'CC', five_hour: { pct: 41 }, seven_day: { pct: 22 } }],
    });

    expect(state.bays[0].fiveHour.pct).toBe(41);
    expect(state.bays[0].status).toBe('ok');
    expect(state.bays[0].reason).toBe('');
  });
});

/* ── The badge only appeared when BOTH windows were missing ──────────────
 *
 * Measured 2026-09-05. The tool reported, for Codex:
 *
 *   five_hour: null, seven_day: { pct: 18 }, status: "ok",
 *   reason: "số 5h đã hết hạn · bỏ qua bản mới hơn (premium)"
 *
 * Every other surface the same tool feeds — `quota.js --tho`, `--mot-dong`,
 * the TUI frame, both boards — printed `5h ? · Weekly 18% · <reason>`. The
 * sidebar printed a bare `5h ?`, because the badge was gated on BOTH windows
 * being empty. The reason was still there as the row's tooltip, so nothing
 * was wrong on screen — there was just less of it than everywhere else, and
 * only on hover.
 *
 * Half a reading is the normal shape for Codex, not an edge case: the 5h
 * window expires while the weekly one is still good.
 */
describe('staleBadge', () => {
  const bay = (over: Partial<QuotaBay>): QuotaBay => ({
    id: 'codex', label: 'CX',
    fiveHour: { pct: null, resetsAt: null },
    sevenDay: { pct: null, resetsAt: null },
    status: 'ok', reason: '',
    ...over,
  });

  it('names the missing window when only one reading is gone', () => {
    expect(staleBadge(bay({
      sevenDay: { pct: 18, resetsAt: 1789009987 },
      status: 'ok',
      reason: 'số 5h đã hết hạn · bỏ qua bản mới hơn (premium)',
    }))).toBe('5h cũ');
  });

  it('names the weekly window when that is the one missing', () => {
    expect(staleBadge(bay({
      fiveHour: { pct: 43, resetsAt: 1788598800 },
      status: 'ok',
      reason: 'số Weekly đã hết hạn',
    }))).toBe('Weekly cũ');
  });

  it('keeps the plain word when the whole reading is gone', () => {
    /* Unchanged behaviour: naming both windows in a row this narrow buys
       nothing — there is no number left to qualify. */
    expect(staleBadge(bay({
      status: 'stale',
      reason: 'số đã hết hạn — chạy Codex một lượt là có số mới',
    }))).toBe('cũ');
  });

  it('shows the tool\'s own word for a status it does not know', () => {
    expect(staleBadge(bay({ status: 'missing', reason: 'không có thư mục phiên Codex' })))
      .toBe('missing');
  });

  it('says nothing when both readings are there', () => {
    expect(staleBadge(bay({
      fiveHour: { pct: 43, resetsAt: 1 }, sevenDay: { pct: 22, resetsAt: 2 },
      status: 'ok', reason: '',
    }))).toBeNull();
  });

  it('stays quiet on a half reading it cannot explain', () => {
    /* An older tool sends no `reason`. A missing number with no explanation
       may simply never have been measured; calling it `cũ` would be inventing
       a cause the tool never claimed. */
    expect(staleBadge(bay({
      sevenDay: { pct: 18, resetsAt: 1 }, status: 'ok', reason: '',
    }))).toBeNull();
  });
});

// ─── the two thresholds, once they came out of the source ────────────────────
//
// 80 and 95 were written into three places (`isNearLimit`, the bell's
// THRESHOLDS, and cockpit's statusline) before anybody could change them, and
// the third one had drifted to 90 without anyone noticing. Moving them into
// Settings only helps if the reading side can be handed a number it did not
// choose — hence a sanitiser with no error state.

describe('quotaThresholds', () => {
  it('gives back the written-down defaults when nothing is set', () => {
    expect(quotaThresholds(undefined, undefined)).toEqual(DEFAULT_QUOTA_THRESHOLDS);
    expect(DEFAULT_QUOTA_THRESHOLDS).toEqual({ warn: 80, alert: 95 });
  });

  it('takes the numbers it is given', () => {
    expect(quotaThresholds(50, 70)).toEqual({ warn: 50, alert: 70 });
  });

  it('reads an inverted pair as the pair it obviously is, rather than refusing', () => {
    // settings.json has a second writer (a person with an editor), and the two
    // fields are not distinguishable once they are two numbers on a page. The
    // lower one warns; the higher one alerts. That is true either way round,
    // so there is nothing here worth failing over.
    expect(quotaThresholds(95, 80)).toEqual({ warn: 80, alert: 95 });
  });

  it('clamps into 1..100 and rounds, so a slip of the keyboard cannot mute the bell', () => {
    // 0 would make every reading "crossed" forever; 900 would make none of them.
    expect(quotaThresholds(0, 900)).toEqual({ warn: 1, alert: 100 });
    expect(quotaThresholds(79.6, 94.4)).toEqual({ warn: 80, alert: 94 });
  });

  it('falls back per FIELD, not for the whole pair', () => {
    // A garbled `warn` must not also throw away a good `alert`.
    expect(quotaThresholds('x' as any, 90)).toEqual({ warn: 80, alert: 90 });
    expect(quotaThresholds(NaN, 90)).toEqual({ warn: 80, alert: 90 });
    expect(quotaThresholds(60, null as any)).toEqual({ warn: 60, alert: 95 });
  });

  it('lets the two collapse onto one number', () => {
    // Somebody who wants a single alarm at 90 should get exactly one.
    expect(quotaThresholds(90, 90)).toEqual({ warn: 90, alert: 90 });
  });
});

describe('isNearLimit with a chosen threshold', () => {
  it('colours on the number it is handed', () => {
    expect(isNearLimit(59, 60)).toBe(false);
    expect(isNearLimit(60, 60)).toBe(true);
  });

  it('still means 80 when nobody says otherwise', () => {
    // The existing call sites pass one argument. Changing what they mean by
    // accident is exactly the failure this default exists to prevent.
    expect(isNearLimit(80)).toBe(true);
    expect(isNearLimit(79)).toBe(false);
  });

  it('an unmeasured window is not an alarm at any threshold', () => {
    expect(isNearLimit(null, 1)).toBe(false);
  });
});
