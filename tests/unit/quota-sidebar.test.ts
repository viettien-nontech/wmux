import { describe, it, expect } from 'vitest';
import { parseQuota, isNearLimit, formatResetTime, staleBadge } from '../../src/renderer/components/Sidebar/quota';
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
