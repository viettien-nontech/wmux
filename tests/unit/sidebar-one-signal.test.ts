import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Classic mode keeps ONE distinction in the workspace list: work that carries on
// by itself, and work that has stopped until the user acts.
//
// This is not a taste change. The sidebar encoded state as five dot colours plus
// two pulse rates plus a matching palette on the status line, and the person
// reading it said plainly that they could not hold that legend in their head and
// could not watch the screen continuously either. Both halves of that matter: a
// colour language only pays off for someone who has memorised it AND is looking.
//
// So the rule: if something is lit, it wants you. Nothing else is.
//
// Pinned against the stylesheet and the component source because there is no
// React test renderer in this repo (see quota-alerts.ts) — every rule here is
// invisible to a unit test that can only call functions, which is exactly the
// class of bug that has to be caught by opening the app. A source-text test at
// least fails when someone reintroduces the thing on purpose.

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer');
const sidebarCss = fs.readFileSync(path.join(SRC, 'styles', 'sidebar.css'), 'utf-8');
const rowTsx = fs.readFileSync(path.join(SRC, 'components', 'Sidebar', 'WorkspaceRow.tsx'), 'utf-8');

/** The selector prefix that scopes a rule to classic mode. */
const CLASSIC = ":root:not([data-ui-mode='trace'])";

describe('the workspace row in classic mode', () => {
  it('renders the state dot ONLY under TRACE', () => {
    // The dot repeated, in colour, what the line below it says in words. TRACE
    // keeps it because there it is a via on a copper trace and the mode is an
    // opt-in to that whole language.
    expect(rowTsx).toMatch(/uiMode === 'trace' && <span className=\{`workspace-row__state-dot/);
  });

  it('mutes every state except the one that wants the user', () => {
    // Running, idle, done and interrupted all describe work proceeding without
    // anybody — so they must be indistinguishable from each other, or there is
    // still a palette to learn.
    for (const variant of ['idle', 'running', 'working', 'done', 'interrupted']) {
      expect(sidebarCss).toContain(`${CLASSIC} .workspace-row__status--${variant}`);
    }
    // …and blocked must NOT be in that muted group, or the one signal is gone.
    expect(sidebarCss).not.toContain(`${CLASSIC} .workspace-row__status--blocked,`);
  });

  it('lights the whole row when a session is waiting on the user', () => {
    expect(rowTsx).toContain("blockedSessions > 0 ? 'workspace-row--needs-you' : ''");
    expect(sidebarCss).toContain(`${CLASSIC} .workspace-row--needs-you`);
  });

  it('does not put the lit-row signal on the selection rail', () => {
    // The rail already means SELECTED. Two meanings on one element is the exact
    // mistake this change removes, so the lit row draws its own edge instead.
    const rule = sidebarCss.slice(sidebarCss.indexOf(`${CLASSIC} .workspace-row--needs-you`));
    expect(rule.slice(0, 200)).toMatch(/inset 2px 0 0/);
    expect(rule.slice(0, 200)).not.toContain('__rail');
  });

  it('leaves nothing pulsing', () => {
    // Motion is the half of a legend you cannot ignore while reading something
    // else, which is the complaint that started this.
    const kill = sidebarCss.slice(sidebarCss.indexOf(`${CLASSIC} .workspace-row__agent-dot,`));
    expect(kill.slice(0, 400)).toMatch(/animation:\s*none/);
    expect(kill.slice(0, 400)).toContain('workspace-row__state-dot--running');
    expect(kill.slice(0, 400)).toContain('workspace-row__state-dot--blocked');
  });

  it('keeps a per-session dot only for a session that is blocked', () => {
    expect(sidebarCss).toContain(
      `${CLASSIC} .workspace-row__agent-dot:not(.workspace-row__agent-dot--blocked)`,
    );
  });

  it('changes no words — every status string still comes from the same chain', () => {
    // The point is to remove the SECOND, dimmer copy of the state (its hue),
    // never the state itself. `statusClassFor` still computes the full chain.
    const status = fs.readFileSync(path.join(SRC, 'components', 'Sidebar', 'workspace-status.ts'), 'utf-8');
    for (const variant of ['running', 'working', 'done', 'interrupted', 'blocked', 'idle']) {
      expect(status).toContain(`workspace-row__status--${variant}`);
    }
  });
});

describe('TRACE, which is now opt-in, keeps its language', () => {
  const trace = fs.readFileSync(path.join(SRC, 'styles', 'trace.css'), 'utf-8');

  it('is untouched by the classic-only rules', () => {
    // Every rule added for classic is scoped with :not([data-ui-mode='trace']),
    // so somebody who deliberately chooses the copper-trace sidebar still gets
    // all of it. Muting TRACE would leave a mode that is all shell and no
    // meaning, which is worse than either choice.
    expect(trace).toContain("[data-ui-mode='trace'] .workspace-row__state-dot");
    const classicRules = sidebarCss.split('\n').filter((l) => l.includes('workspace-row--needs-you') || l.includes('workspace-row__status--running'));
    for (const line of classicRules) {
      if (line.trim().startsWith(':root')) expect(line).toContain("not([data-ui-mode='trace'])");
    }
  });
});
