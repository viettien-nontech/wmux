import { describe, it, expect } from 'vitest';
import { resolveTokenTool, planReads } from '../../src/main/token-poller';
import { parsePaneTokens, formatTokens } from '../../src/renderer/components/AgentNavigator/tokens';

// Token counts are PER PANE, which is what makes them a different thing from
// quota. One account has one 5-hour window however many panes are open, so
// quota is a single account-wide line; a token count belongs to one agent
// session in one directory, so it is read once per pane that has an agent.
//
// The reading itself lives outside wmux, in `token.js --json --kind <k> --cwd
// <dir>`, for the same reason quota's does: the file formats belong to the
// vendors and change when they do.

describe('resolveTokenTool', () => {
  it('prefers an explicit path from settings over the convention', () => {
    expect(resolveTokenTool({ tokenTool: 'D:/tools/token.js' }, 'C:/Users/Someone'))
      .toBe('D:/tools/token.js');
  });

  it('falls back to the conventional location under the home directory', () => {
    const p = resolveTokenTool({}, 'C:/Users/Someone');
    expect(p).toContain('Someone');
    expect(p).toMatch(/token\.js$/);
  });

  it('ignores a non-string setting rather than building a path out of it', () => {
    const p = resolveTokenTool({ tokenTool: 42 as unknown as string }, 'C:/Users/Someone');
    expect(p).toMatch(/token\.js$/);
    expect(p).not.toContain('42');
  });
});

describe('planReads', () => {
  it('reads once per (kind, cwd) and gives the answer to every pane that shares it', () => {
    // The tool locates a session by its working directory, so two panes in the
    // same folder running the same agent are the same session as far as it can
    // tell. They get the same number — a known limitation, recorded rather
    // than papered over — but they must not cost two process spawns to say so.
    const reads = planReads([
      { surfaceId: 'surf-a', kind: 'claude', cwd: 'C:/repo' },
      { surfaceId: 'surf-b', kind: 'claude', cwd: 'C:/repo' },
      { surfaceId: 'surf-c', kind: 'codex', cwd: 'C:/repo' },
    ]);

    expect(reads).toHaveLength(2);
    const claude = reads.find((r) => r.kind === 'claude');
    expect(claude?.surfaceIds).toEqual(['surf-a', 'surf-b']);
    expect(reads.find((r) => r.kind === 'codex')?.surfaceIds).toEqual(['surf-c']);
  });

  it('treats the same folder spelled differently as one session', () => {
    // A cwd reaches wmux from several places — a shell-integration report, a
    // saved session, a launch spec — and they disagree about separators and
    // case. Spawning the tool twice for one directory reads the same file
    // twice and can still show two different numbers if a turn lands between.
    const reads = planReads([
      { surfaceId: 'surf-a', kind: 'claude', cwd: 'C:\\Repo\\App' },
      { surfaceId: 'surf-b', kind: 'claude', cwd: 'c:/repo/app/' },
    ]);

    expect(reads).toHaveLength(1);
    expect(reads[0].surfaceIds).toEqual(['surf-a', 'surf-b']);
  });

  it('drops panes the tool cannot answer for, instead of asking anyway', () => {
    // `--kind` accepts claude and codex and nothing else; wmux can launch
    // opencode and omp too. Sending those spawns a process to be told off.
    // A pane with no cwd yet (a shell that has not reported one) is the same
    // case: there is nothing to look up.
    const reads = planReads([
      { surfaceId: 'surf-a', kind: 'opencode', cwd: 'C:/repo' },
      { surfaceId: 'surf-b', kind: 'claude', cwd: '' },
      { surfaceId: 'surf-c', kind: null as unknown as string, cwd: 'C:/repo' },
      { surfaceId: 'surf-d', kind: 'claude', cwd: 'C:/repo' },
    ]);

    expect(reads).toHaveLength(1);
    expect(reads[0].surfaceIds).toEqual(['surf-d']);
  });

  it('survives being handed nothing', () => {
    expect(planReads([])).toEqual([]);
    expect(planReads(null as unknown as [])).toEqual([]);
  });
});

describe('parsePaneTokens', () => {
  it('reads the session total, which is the number that was asked for', () => {
    const t = parsePaneTokens({
      lastTurn: { totalTokens: 7204 },
      sessionTotal: { totalTokens: 48031, source: 'thread_token_usage' },
    });

    expect(t.sessionTotal).toBe(48031);
    expect(t.source).toBe('thread_token_usage');
  });

  it('keeps "no session found" as null, never 0', () => {
    // The tool answers `{lastTurn: null, sessionTotal: null}` when no session
    // file matches the pane's cwd. Zero would read as "this agent has used
    // nothing", which is a different and much more interesting claim.
    const t = parsePaneTokens({ lastTurn: null, sessionTotal: null });
    expect(t.sessionTotal).toBeNull();
    expect(t.sessionTotal).not.toBe(0);
  });

  it('survives anything the tool might print', () => {
    expect(() => parsePaneTokens(null)).not.toThrow();
    expect(() => parsePaneTokens('not json')).not.toThrow();
    expect(() => parsePaneTokens({ error: '--kind bắt buộc' })).not.toThrow();
    expect(parsePaneTokens({ error: 'x' }).sessionTotal).toBeNull();
  });
});

describe('formatTokens', () => {
  it('formats the same way token.js gonSo() does', () => {
    // Same rule as formatResetTime and quota.js's gio(): the sidebar and the
    // Node tool must not disagree about what a number looks like, or the same
    // figure read in two places looks like two figures.
    expect(formatTokens(842)).toBe('842');
    expect(formatTokens(7204)).toBe('7.2k');
    expect(formatTokens(48031)).toBe('48.0k');
    expect(formatTokens(733000)).toBe('733k');
    expect(formatTokens(1200000)).toBe('1.2M');
    expect(formatTokens(2000000)).toBe('2M');
  });

  it('shows nothing rather than a zero when there is no number', () => {
    expect(formatTokens(null)).toBe('');
  });
});

describe('planReads — the session id, when there is one', () => {
  // The tool finds a session by working directory, so two panes open on one
  // folder read the same file and show the same number — wrong for at least
  // one of them. An agent that reports its session id (`wmux report-session`)
  // gives wmux a more precise key. It is an ADDITIONAL key, never a
  // replacement: the id exists only when the agent volunteers it, so a pane
  // without one has to keep working exactly as it does today.

  it('separates two panes in one folder when they report different sessions', () => {
    const reads = planReads([
      { surfaceId: 'surf-a', kind: 'claude', cwd: 'C:/repo', sessionId: 'aaaa-1111' },
      { surfaceId: 'surf-b', kind: 'claude', cwd: 'C:/repo', sessionId: 'bbbb-2222' },
    ]);

    expect(reads).toHaveLength(2);
    expect(reads.map((r) => r.surfaceIds)).toEqual([['surf-a'], ['surf-b']]);
  });

  it('still shares one read between panes that report the SAME session', () => {
    // Two tabs on one agent session are one session. Reading twice would spend
    // two spawns to produce one number, and could produce two if a turn landed
    // between them.
    const reads = planReads([
      { surfaceId: 'surf-a', kind: 'claude', cwd: 'C:/repo', sessionId: 'aaaa-1111' },
      { surfaceId: 'surf-b', kind: 'claude', cwd: 'C:/repo', sessionId: 'aaaa-1111' },
    ]);

    expect(reads).toHaveLength(1);
    expect(reads[0].surfaceIds).toEqual(['surf-a', 'surf-b']);
  });

  it('does not merge a pane that has an id with one that has none', () => {
    // They are not known to be the same session — one is identified and the
    // other is a guess by directory. Merging them would hand the identified
    // pane's number to a pane nothing established a link to.
    const reads = planReads([
      { surfaceId: 'surf-a', kind: 'claude', cwd: 'C:/repo', sessionId: 'aaaa-1111' },
      { surfaceId: 'surf-b', kind: 'claude', cwd: 'C:/repo' },
    ]);

    expect(reads).toHaveLength(2);
  });

  it('treats an empty or whitespace id as no id at all', () => {
    // A report can arrive blank. "" must mean "not reported", not "a session
    // whose id is the empty string", or one blank pane splits off on its own.
    const reads = planReads([
      { surfaceId: 'surf-a', kind: 'claude', cwd: 'C:/repo', sessionId: '' },
      { surfaceId: 'surf-b', kind: 'claude', cwd: 'C:/repo', sessionId: '   ' },
      { surfaceId: 'surf-c', kind: 'claude', cwd: 'C:/repo' },
    ]);

    expect(reads).toHaveLength(1);
    expect(reads[0].surfaceIds).toEqual(['surf-a', 'surf-b', 'surf-c']);
    expect(reads[0].sessionId).toBeUndefined();
  });

  it('carries the id through to the read, so the caller can pass --session', () => {
    const reads = planReads([
      { surfaceId: 'surf-a', kind: 'codex', cwd: 'C:/repo', sessionId: 'cccc-3333' },
    ]);
    expect(reads[0].sessionId).toBe('cccc-3333');
  });
});
