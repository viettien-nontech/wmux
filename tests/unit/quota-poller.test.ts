import { describe, it, expect } from 'vitest';
import { resolveQuotaTool } from '../../src/main/quota-poller';

// The tool that reads quota lives outside wmux — it is a separate Node script
// that knows how to read each agent's own usage files. wmux only needs to know
// where it is, and must degrade to "no quota line" rather than crash when the
// user does not have it.

describe('resolveQuotaTool', () => {
  it('prefers an explicit path from settings over the convention', () => {
    const p = resolveQuotaTool({ quotaTool: 'D:\tools\quota.js' }, 'C:\Users\Someone');
    expect(p).toBe('D:\tools\quota.js');
  });

  it('falls back to the conventional location under the home directory', () => {
    const p = resolveQuotaTool({}, 'C:\Users\Someone');
    expect(p).toContain('Someone');
    expect(p).toMatch(/quota\.js$/);
  });

  it('ignores a non-string setting rather than building a path out of it', () => {
    // A hand-edited settings file is the expected way to set this, so the value
    // can be anything. A number here would otherwise become the string "42".
    const p = resolveQuotaTool({ quotaTool: 42 as unknown as string }, 'C:\Users\Someone');
    expect(p).toMatch(/quota\.js$/);
    expect(p).not.toContain('42');
  });
});
