# Chrome Bridge (MCP)

Let Claude Code drive your **real, everyday Chrome** — read pages, run JavaScript, navigate, screenshot,
capture network, upload files, open/close tabs — **without stealing window focus** and (almost entirely)
**without a debugger banner**.

Two parts:
- `extension/` — an MV3 Chrome extension that auto-connects to a localhost WebSocket and executes
  commands. Reads/execs via `chrome.scripting` (MAIN world). Operates on any tab by `tabId`; never
  activates/raises a tab (the one exception: `screenshot` of a *background* tab briefly flashes it).
- `server/` — an MCP stdio server (Node) that Claude Code spawns; it relays tool calls to the extension
  over `ws://127.0.0.1:9223`.

## Tools (16)

**Read & understand**
- `list_tabs` → `[{tabId, url, title, active}]`
- `read {tabId?, selector?, format?}` → page content as `text` (default), `html` (outerHTML), or
  `markdown` (main/article content, clean). Optionally scoped to a selector. Works on every site
  incl. strict-CSP (no eval).
- `snapshot {tabId?, selector?, interactiveOnly?}` → an indented accessibility outline of interactive
  elements with stable refs, e.g. `- button "Sign in" [ref=e7]`. The token-cheap way to understand a
  page and act on it — feed the refs to `click`/`fill`/`hover`. No eval, so it works on strict-CSP sites.
- `cookies {tabId?|url?}` → cookies incl. httpOnly (which `exec` can't see). Read-only.

**Act** (all background, no focus change, no banner)
- `click {ref?|selector?, tabId?}` → click by snapshot ref (preferred) or CSS selector.
- `fill {ref?|selector?, value, submit?, tabId?}` → set an input/textarea/contenteditable (native
  setter + input/change events for React/Vue); `submit:true` presses Enter / submits the form.
- `hover {ref?|selector?, tabId?}` → dispatch real pointer/mouse-over events. Opens JS-driven hover
  menus (React/Vue/jQuery `onmouseenter`/`onmouseover`); **pure-CSS `:hover` menus won't open** —
  synthetic events can't drive CSS `:hover` (that needs the debugger, which we avoid).
- `navigate {url, tabId?}` → background navigation.
- `open_tab {url?, active?, newWindow?, incognito?}` → new tab, background by default. `incognito:true`
  = isolated cookie jar (logged out). Returns `{tabId, windowId}`.
- `close_tab {tabId}`
- `exec {code, tabId?}` → run JS (async body; `return`/`await`), returns the JSON value. MAIN world,
  no banner. Strict-CSP pages (GitHub/Google) can block eval → returns `null` there.

**Wait, capture, upload**
- `wait_for {tabId?, selector?, text?, gone?, timeoutMs?}` → poll in-page until a selector appears
  (or disappears with `gone:true`), text is present, or (with neither) the page finishes loading.
- `screenshot {tabId?}` → PNG image. No tabId = the visible tab (zero disturbance); a background tabId
  briefly flashes to front to render, then restores focus.
- `network_capture {action:"start"|"stop", tabId?}` → record requests (url/method/type/status/timing)
  via webRequest. No response bodies (use `exec`+`fetch` for those).
- `console_capture {action:"start"|"stop", tabId?}` → record console logs + uncaught errors
  (`{level, text, t}`). No banner; the hook resets on full navigation.
- `upload_file {selector, filePaths[], tabId?}` → set a file `<input>`'s files. **The one tool that
  uses the debugger** (only way the browser allows it) → flashes the "debugging this browser" bar, then
  detaches.

### The agent loop
`snapshot` → act by `ref` (`click`/`fill`/`hover`) → `wait_for` → `snapshot` again. This lets the LLM
drive a page it has never seen — including CSP-locked ones — without dumping raw HTML into context or
guessing selectors.

## Install

**1. Server deps**
```
cd server && npm install
```

**2. Register with Claude Code** (run from the repo root; user scope = every project)
```
claude mcp add --scope user chrome-bridge -- node "$(pwd)/server/index.js"
```
Restart Claude Code (`claude --continue`) so the tools load (MCP servers load at startup).

**3. Load the extension in your real Chrome**
- `chrome://extensions` → Developer mode → **Load unpacked** → select this repo's `extension/` folder.
- Popup shows connection status + last action + command count. Auto-connects; no per-tab step.
- Optional: **Details → Allow in Incognito** if you want `open_tab {incognito:true}` to work.

## Sharing & updates
Public repo: **https://github.com/milad-afkhami/chrome-bridge-extension** — clone it and follow
**Install** above. Not on the Chrome Web Store, so: loading unpacked shows Chrome's
*"disable developer-mode extensions"* bubble on some startups → click **Keep** (it stays enabled),
and updates are manual — `git pull`, then reload the extension at `chrome://extensions`.

## Architecture: hub / controller (why it's stable)
Multiple server instances **cooperate** instead of fighting over the port:
- the first to bind `9223` is the **HUB** and owns the single extension connection;
- any later instance (another session, a `claude mcp list` probe) becomes a **CONTROLLER** that forwards
  its tool calls to the hub over the same port;
- if the hub dies, a controller promotes itself.

This permanently avoids the "two servers, extension talks to the wrong one" split-brain. Servers also
exit when their parent (Claude Code) goes away (stdin EOF / signals / ppid reparent), so no orphans
squat the port. A crash-guard (`uncaughtException`/`unhandledRejection`) ensures a bug in one tool can
never take the bridge down.

## Notes / limits
- **exec + strict CSP:** MAIN-world eval is blocked by some pages' `Content-Security-Policy` (GitHub,
  Google, some banks) → `exec` returns `null` there. `read`/`snapshot`/`click`/`fill`/`navigate`/
  screenshot still work (static functions, no eval).
- **Snapshot refs are ephemeral:** `data-cb-ref="eN"` refs stay valid only until the DOM re-renders or
  the page navigates. Re-`snapshot` before reusing refs; use a CSS `selector` when you need durability.
- **Privileged pages aren't scriptable:** `about:blank`, `chrome://*`, and the Chrome Web Store can't
  be read/exec'd/snapshotted (`<all_urls>` doesn't grant them) — expect an "Extension manifest must
  request permission to access this host" error.
- **Focus:** nothing calls `chrome.tabs.update(..., {active:true})` except `screenshot` of a background
  tab (brief flash-and-restore).
- **Parallelism vs isolation:** drive many tabs in parallel by `tabId` (shared login); true isolation =
  `incognito` windows (separate cookies, logged out). For massive isolated fan-out, Playwright is better.
- **Port:** override with `BRIDGE_PORT` env (must match `PORT` in `extension/background.js`).

## Privacy
The extension can see and act on every tab in your real profile. Tools only touch the tab you pass a
`tabId` for (or the active tab). Nothing leaves the machine except to the local MCP server on 127.0.0.1.
