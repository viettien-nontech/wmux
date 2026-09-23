import { describe, it, expect, vi } from 'vitest';
import {
  iconNoticeDue,
  iconFingerprint,
  iconCacheRefreshScript,
  refreshShellIconCache,
} from '../../src/main/icon-cache';

// ─────────────────────────────────────────────────────────────────────────────
// Issues #137 / #226 — the taskbar keeps the previous version's icon after a
// rebrand, because Explorer's icon cache is memory-mapped and only an Explorer
// restart re-reads it. Two things wmux can do: tell the user once, and offer
// the restart behind a confirm.
// ─────────────────────────────────────────────────────────────────────────────

describe('iconNoticeDue', () => {
  it('fires once when the shipped icon differs from the one last seen', () => {
    expect(iconNoticeDue({ previousFingerprint: 'aaa', currentFingerprint: 'bbb', upgraded: true })).toBe(true);
    expect(iconNoticeDue({ previousFingerprint: 'aaa', currentFingerprint: 'bbb', upgraded: false })).toBe(true);
  });

  it('stays quiet when the icon is unchanged, upgrade or not', () => {
    expect(iconNoticeDue({ previousFingerprint: 'aaa', currentFingerprint: 'aaa', upgraded: true })).toBe(false);
    expect(iconNoticeDue({ previousFingerprint: 'aaa', currentFingerprint: 'aaa', upgraded: false })).toBe(false);
  });

  it('with no record, tells an UPGRADED install once — that is the #226 reporter', () => {
    // Every version before 2.10.2 recorded nothing, so "no previous
    // fingerprint" on an upgrade means the cache may hold any older mark.
    expect(iconNoticeDue({ previousFingerprint: null, currentFingerprint: 'bbb', upgraded: true })).toBe(true);
  });

  it('with no record, leaves a fresh install alone — nothing is stale yet', () => {
    expect(iconNoticeDue({ previousFingerprint: null, currentFingerprint: 'bbb', upgraded: false })).toBe(false);
  });

  it('never fires without a current fingerprint to compare', () => {
    // A dev tree without the .ico, or an unreadable file: a false notice sends
    // the user to restart Explorer for nothing.
    expect(iconNoticeDue({ previousFingerprint: 'aaa', currentFingerprint: null, upgraded: true })).toBe(false);
    expect(iconNoticeDue({ previousFingerprint: null, currentFingerprint: null, upgraded: true })).toBe(false);
  });
});

describe('iconFingerprint', () => {
  it('hashes the file contents, so a byte-identical icon has one identity', () => {
    const read = () => Buffer.from('icon-bytes');
    expect(iconFingerprint('a.ico', read)).toBe(iconFingerprint('b.ico', read));
    expect(iconFingerprint('a.ico', read)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is null when there is no path or the read fails', () => {
    expect(iconFingerprint(undefined)).toBeNull();
    expect(iconFingerprint('missing.ico', () => { throw new Error('ENOENT'); })).toBeNull();
  });
});

describe('the Explorer restart', () => {
  it('kills Explorer, clears the cache, and restarts it — in that order', () => {
    const script = iconCacheRefreshScript();
    const kill = script.indexOf('Stop-Process -Name explorer');
    const del = script.indexOf('iconcache*');
    const start = script.indexOf('explorer.exe');
    expect(kill).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(kill);
    expect(start).toBeGreaterThan(del);
  });

  it('only starts Explorer when none is left — Windows sometimes restarts it itself', () => {
    expect(iconCacheRefreshScript()).toMatch(/if \(-not \(Get-Process -Name explorer/);
  });

  it('deletes hidden cache files and points at the user profile, not a fixed drive', () => {
    const script = iconCacheRefreshScript();
    expect(script).toContain('Remove-Item -Force');
    expect(script).toContain('$env:LOCALAPPDATA');
    expect(script).not.toMatch(/C:\\Users/);
  });

  it('runs PowerShell by absolute System32 path, detached, without a console', () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    refreshShellIconCache(spawnImpl as never);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [exe, args, opts] = spawnImpl.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(exe).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    expect(args[args.length - 1]).toBe(iconCacheRefreshScript());
    expect(opts.detached).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect(opts.stdio).toBe('ignore');
  });
});
