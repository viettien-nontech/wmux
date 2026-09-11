# Driving the wmux browser panel from the CLI

Field notes for agents that automate the wmux browser panel (`wmux browser …`). The panel is a real
Chromium webview the user watches live — everything you do is visible, which is the point. These are
the sharp edges that cost time when discovered by trial and error.

## Core workflow

```bash
wmux browser open <url>      # navigate
wmux browser snapshot        # accessibility tree with element refs (eN)
wmux browser click e45       # click element by ref
wmux browser type e3 "text"  # type into element
wmux browser get-text        # page text
wmux browser eval "<js>"     # run JavaScript in the page
wmux browser screenshot      # capture PNG
```

## Sharp edges

- **Write refs bare: `wmux browser click e45`.** Both `e45` and `@e45` resolve since 0.36.0 (before
  that, only the `@` form did — which is why every ref command used to fail, issue #121). Keep using
  the bare form anyway: in PowerShell a leading `@` is the splatting operator, so `@e45` is mangled
  by the shell before wmux ever sees it.

- **Refs can go stale on SPAs.** Against client-rendered apps (React/Vue with re-renders), even a
  fresh-from-snapshot ref may return `ref_not_found`. Reliable fallback: `wmux browser eval` with
  DOM queries — `document.querySelectorAll('[role=radio]')[3].click()`. The user still sees every
  action live in the panel.

- **`eval` shares ONE persistent JS scope across calls.** A second `const x = …` throws
  `Uncaught SyntaxError` (redeclaration). Always wrap snippets in an IIFE:
  `(() => { …; return 'result' })()`.

- **`reload` may be rejected by the app** even though CLI usage lists it — use
  `wmux browser eval "location.reload()"` instead.

- **`snapshot` prints JSON** with the whole accessibility tree as a single `\n`-escaped string.
  Don't grep it raw — parse it with a real JSON parser (node/python/jq), and write it to a file
  first if it's large.

- **Shell quoting eats `$` in double-quoted eval one-liners.** `"…t.match(/\$611/)…"` gets `$6`
  expanded as a positional parameter and silently matches nothing. Single-quote any eval snippet
  containing `$` (money regexes!), or write the snippet to a file.

- **wmux binds a CDP endpoint on port 9222, and a second client on it is now FINE.** This page
  used to say "don't point other CDP clients at it"; that ban is obsolete. The endpoint is a
  multiplexer: every open browser pane is its own target, two clients share one real debugger
  session per pane, and a pane keeps its target id across a React remount. So a
  chrome-devtools MCP or a puppeteer-core on `127.0.0.1:9222` can run alongside
  `wmux browser …` on the same panes.

  `wmux browser …` is still the better tool for panel automation — it needs no client library,
  takes `--surface`, and works identically on both browser engines. Reach for a raw CDP client
  when you need what it cannot give: console and network events, or a real library's API.

  **Three things that are still true, and are the ones that bite:**

  - **Target ids are `wmux-page-<n>`, never `1`.** Read them from `/json/list`. A URL like
    `ws://localhost:9222/devtools/page/1` names no pane; it falls back to whichever pane attached
    most recently, which is how a client ends up driving a pane nobody asked it to.
  - **Closing a pane really does end its target**, and a client holding that socket is told so
    and gets its socket closed. That is a close, not a remount — a remount is silent and the
    session follows the pane onto its new webContents.
  - **Don't let a second client tear the first one's pane down.** Sharing a pane is supported;
    `Target.closeTarget` on a pane somebody else is driving is still just closing their browser.

  What a stale client looked like before the multiplexer, kept only so the symptom is recognised
  rather than re-debugged: a raw `…/devtools/page/1` client answered two or three commands, then
  a fresh connection opened fine and **hung at `Runtime.enable`** with no reply, no error and no
  close, while `/json/list` and the panel had silently diverged. If anything resembling that is
  seen today it is a bug worth reporting, not the expected cost of a second client. Recovery is
  `wmux browser open <url> [--surface <id>]`; the webview keeps its cookies, so a session the
  user logged into by hand survives the round trip and does not need logging in again.

- **`/wmux/cdp-state` is wmux's own diagnostic**, beside `/json/list` on the same port and behind
  the same loopback guard. `/json/list` follows Chrome and lists only ATTACHED targets, so through
  it a target that was destroyed and one whose pane is mid-remount look identical. This one lists
  every target that exists with `{targetId, surfaceId, wcId, attached}`, which is what tells those
  two apart. It is not part of the CDP contract — don't build a client on it, use it to answer
  "is this pane gone, or just between webContents?".

## Framework-specific input recipes

- **React controlled inputs** ignore a plain `.value =` assignment. Use the native setter, then
  dispatch an input event:
  ```js
  (() => {
    const el = document.querySelector('#email');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, 'user@example.com');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()
  ```
  A node's React handlers/props are reachable under its `__reactProps$…` key when you need them.

- **Radix UI / shadcn primitives ignore synthetic `.click()` and `.focus()`.** Plain buttons and
  links are fine with `.click()`; Radix primitives need real-looking event sequences:
  - **Tabs**: dispatch `pointerdown → mousedown → pointerup → mouseup → click` (PointerEvent with
    `pointerId: 1`) on the trigger. The `data-state` flip is **async** — verify it in a *later*
    eval call, not the same snippet.
  - **Tooltip**: gates on focus-visible; programmatic `.focus()` never opens it. Open via hover:
    `pointerover → pointerenter → pointermove` with `pointerType: "mouse"`.
  - **Select**: try the full pointer sequence on the trigger and then on the chosen
    `[data-slot=select-item]` / `[role=option]` first — in some Radix versions that works. If it
    does nothing, call the React handlers directly via `__reactProps$…`: `onPointerDown` on the
    trigger to open (`{button: 0, ctrlKey: false, pointerType: 'mouse', target: trigger,
    currentTarget: trigger, preventDefault(){}, stopPropagation(){}, defaultPrevented: false,
    nativeEvent: {}}`), then `onKeyDown` with `{key: 'Enter', code: 'Enter', …}` on the option to
    commit (its `onPointerUp` does NOT commit). Verify by re-reading the trigger's text in a later
    eval.

## Don't trust eval-polling for transient UI

Toasts, animations, and other short-lived UI can appear perfectly to the human watching the panel
while repeated `eval`/`get-text` polls report them absent (the poll cadence misses the
add/remove window). If transient UI "looks broken" only under polling: ask the user what they see
in the panel, or re-test with a long duration (e.g. `toast('x', { duration: 60000 })`) before
concluding the app is broken.
