import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fireNotification, notificationChannels } from '../../src/renderer/notify';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/renderer/store/settings-slice';

// Four switches in Settings → Notifications were declared, drawn, persisted —
// and read by nothing. Turning "Show toast notifications" off changed no
// behaviour whatsoever.
//
// A switch that does nothing is worse than a missing one: the user believes
// they have already told the app something, so when it keeps doing the thing
// they conclude the app is broken in some other way, and they are right to.

const SRC = path.join(__dirname, '..', '..', 'src');

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** Capture what reaches the OS side of the chokepoint. */
function withFireSpy() {
  const fired: Array<Record<string, unknown>> = [];
  (globalThis as { window?: unknown }).window = {
    wmux: { notification: { fire: (d: Record<string, unknown>) => fired.push(d) } },
  };
  return fired;
}

describe('notificationChannels', () => {
  it('carries the two switches main cannot see for itself', () => {
    // The prefs live in the renderer store; the toast and the taskbar flash are
    // raised in main, which has no copy of them. Sound already worked this way
    // in reverse — main asks the renderer to play, because only the renderer
    // knows the sound preference.
    expect(notificationChannels({ ...DEFAULT_NOTIFICATION_PREFS, toast: false }))
      .toEqual({ toast: false, taskbarFlash: true });
    expect(notificationChannels({ ...DEFAULT_NOTIFICATION_PREFS, taskbarFlash: false }))
      .toEqual({ toast: true, taskbarFlash: false });
  });

  it('treats a missing pref as ON', () => {
    // A settings blob written before these were honoured has no opinion, and
    // "no opinion" must not silence a notification.
    expect(notificationChannels(undefined)).toEqual({ toast: true, taskbarFlash: true });
    expect(notificationChannels({} as never)).toEqual({ toast: true, taskbarFlash: true });
  });
});

describe('fireNotification', () => {
  it('sends the channel flags on to main', () => {
    const fired = withFireSpy();
    fireNotification('surf-1', 'ws-1' as never, 'hello', () => {}, 'wmux', { toast: false, taskbarFlash: true });
    expect(fired[0]).toMatchObject({ toast: false, taskbarFlash: true });
  });

  it('sends no flags when a caller has none, so main keeps its old behaviour', () => {
    // `surface.trigger_flash` is fired by MAIN, which has no renderer prefs at
    // all. Absent flags have to mean "as before", or that path goes silent.
    const fired = withFireSpy();
    fireNotification('surf-1', 'ws-1' as never, 'hello', () => {});
    expect(fired[0]).not.toHaveProperty('toast');
    expect(fired[0]).not.toHaveProperty('taskbarFlash');
  });

  it('records the bell entry whatever the channels say', () => {
    // The switches govern how a notification leaves the window, never whether
    // it happened. Losing the bell entry too would make "no toasts" mean "no
    // record", which is a different feature nobody asked for.
    const added: Array<Record<string, unknown>> = [];
    withFireSpy();
    fireNotification('surf-1', 'ws-1' as never, 'hello', (n) => added.push(n as never), 'wmux',
      { toast: false, taskbarFlash: false });
    expect(added).toHaveLength(1);
  });
});

describe('main honours the flags', () => {
  const handlers = fs.readFileSync(path.join(SRC, 'main', 'ipc-handlers.ts'), 'utf-8');
  const block = handlers.slice(
    handlers.indexOf('IPC_CHANNELS.NOTIFICATION_FIRE'),
    handlers.indexOf('IPC_CHANNELS.WINDOW_CREATE'),
  );

  it('gates the toast on the flag, defaulting to on', () => {
    expect(block).toMatch(/data\.toast !== false/);
  });

  it('gates the taskbar flash on its own flag', () => {
    expect(block).toMatch(/data\.taskbarFlash !== false/);
  });

  it('still asks for the sound either way', () => {
    // Sound is a THIRD switch with its own setting, decided in the renderer.
    // Muting it along with the toast would make one switch govern two things.
    const sound = block.slice(block.indexOf("'notification:play-sound'") - 400);
    expect(sound).toContain("notification:play-sound");
    expect(block.indexOf("data.toast !== false")).toBeLessThan(block.indexOf("'notification:play-sound'"));
  });
});

describe('the pane ring', () => {
  const wrapper = fs.readFileSync(path.join(SRC, 'renderer', 'components', 'SplitPane', 'PaneWrapper.tsx'), 'utf-8');

  it('is gated on paneRing', () => {
    expect(wrapper).toMatch(/visible=\{hasUnread && notificationPrefs\.paneRing\}/);
  });

  it('flashes only when paneFlashAnimation is on', () => {
    expect(wrapper).toMatch(/flashing=\{justFired && notificationPrefs\.paneFlashAnimation\}/);
  });
});

describe('no call site can quietly skip the switches', () => {
  // The bug being fixed was one of omission, so the guard has to be about
  // omission too: every renderer caller of the chokepoint must pass channels.
  const files = [
    path.join(SRC, 'renderer', 'App.tsx'),
    path.join(SRC, 'renderer', 'store', 'quota-slice.ts'),
  ];

  it('every renderer call passes channels', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      const calls = src.split('fireNotification(').slice(1);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const args = call.slice(0, call.indexOf(';'));
        expect(args, `${path.basename(f)}: ${args.slice(0, 80)}`).toContain('notificationChannels(');
      }
    }
  });
});

// Guard against the whole class: a pref nothing reads.
describe('every notification pref is read somewhere', () => {
  it('has a consumer outside Settings and the store', () => {
    const roots = ['main', 'renderer'];
    let corpus = '';
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'i18n' && e.name !== 'Settings') walk(full); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        if (e.name === 'settings-slice.ts') continue;
        corpus += fs.readFileSync(full, 'utf-8');
      }
    };
    for (const r of roots) walk(path.join(SRC, r));

    for (const key of Object.keys(DEFAULT_NOTIFICATION_PREFS)) {
      expect(corpus, `notificationPrefs.${key} is declared and drawn but read by nothing`).toContain(key);
    }
  });
});
