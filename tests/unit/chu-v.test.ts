import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chuVEnabled, CHU_V_KEY } from '../../src/renderer/components/Sidebar/chu-v';

// The switch is read in two places, in two languages: this module, and
// `congTac()` in chuV/soat.js (a separate repo). They must agree, and the one
// answer they could disagree about is what an ABSENT key means — the case that
// covers every settings file written before the switch existed.

describe('chuVEnabled', () => {
  it('is ON when the key is absent', () => {
    // The switch was added to a workflow that already ran. Defaulting to off
    // would stop reviewing for everyone who never touched the setting, and the
    // symptom of that is an absence — nothing to notice.
    expect(chuVEnabled({})).toBe(true);
    expect(chuVEnabled({ 'wmux-terminal-prefs': {} })).toBe(true);
  });

  it('is ON with no settings at all', () => {
    // A first launch, or a settings read that failed.
    expect(chuVEnabled(null)).toBe(true);
    expect(chuVEnabled(undefined)).toBe(true);
  });

  it('is OFF only when explicitly turned off', () => {
    expect(chuVEnabled({ [CHU_V_KEY]: { bat: false } })).toBe(false);
  });

  it('is ON when explicitly turned on', () => {
    expect(chuVEnabled({ [CHU_V_KEY]: { bat: true } })).toBe(true);
  });

  it('reads a malformed value as ON, not as off', () => {
    // A broken value is not an instruction to stop spending. Every one of these
    // is something a hand-edited file can actually contain.
    expect(chuVEnabled({ [CHU_V_KEY]: null })).toBe(true);
    expect(chuVEnabled({ [CHU_V_KEY]: 'false' })).toBe(true);
    expect(chuVEnabled({ [CHU_V_KEY]: 0 })).toBe(true);
    expect(chuVEnabled({ [CHU_V_KEY]: {} })).toBe(true);
    expect(chuVEnabled({ [CHU_V_KEY]: { bat: 'no' } })).toBe(true);
  });

  it('uses the key name the external tool reads', () => {
    // `chuV/soat.js` looks up this exact string in settings.json. Renaming it
    // here alone turns the switch into two switches that cannot see each other,
    // and the checkbox would go on reporting a state nothing acts on.
    expect(CHU_V_KEY).toBe('chuV');
  });

  it('the toggle is the ONLY thing in the sidebar that writes this key', () => {
    // A second writer means two components that can disagree about what the
    // switch says — the same class of split the quota row already fixed once.
    // Matches the optional-chained spelling too — `settings?.set?.(` is what
    // the component actually writes, and a guard that only knows one spelling
    // is a guard that passes while looking at nothing.
    const goiSet = /settings\??\.set\??\.?\(/;
    const dir = path.join(__dirname, '../../src/renderer/components/Sidebar');
    const writers = fs.readdirSync(dir)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => goiSet.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(writers).toEqual(['ChuVToggle.tsx']);
  });
});
