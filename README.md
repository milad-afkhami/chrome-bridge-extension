# Chrome Bridge (MCP)

Let **Claude Code or Codex** drive your **real, everyday Chrome** — read pages, run JavaScript, navigate, screenshot,
capture network, upload files, open/close tabs — **without stealing window focus** and (almost entirely)
**without a debugger banner**.

Two parts:
- `extension/` — an MV3 Chrome extension that auto-connects to a localhost WebSocket and executes
  commands. Reads/execs via `chrome.scripting` (MAIN world). Operates on any tab by `tabId`; never
  activates/raises a tab (the one exception: `screenshot` of a *background* tab briefly flashes it).
- `server/` — a standard MCP **stdio** server (Node) that your agent (Claude Code or Codex) spawns; it
  relays tool calls to the extension over `ws://127.0.0.1:9223`. Nothing in it is agent-specific — any
  MCP-over-stdio client works; Claude Code and Codex are the two that are wired up and tested.

## Tools (16)

**Every tab-targeting tool requires an explicit `tabId`** — get one from `list_tabs` (drive a tab
that's already open) or `open_tab` (start fresh). The bridge **never** falls back to your focused tab,
so a session can't hijack the page you're working on. Only `list_tabs` and `open_tab` take no `tabId`
(`cookies` accepts `tabId` **or** `url`; `network_capture`'s `tabId` is an optional filter).

**Read & understand**
- `list_tabs` → `[{tabId, url, title, active}]`. Start here to pick a tab.
- `read {tabId, selector?, format?}` → page content as `text` (default), `html` (outerHTML), or
  `markdown` (main/article content, clean). Optionally scoped to a selector. Works on every site
  incl. strict-CSP (no eval).
- `snapshot {tabId, selector?, interactiveOnly?}` → an indented accessibility outline of interactive
  elements with stable refs, e.g. `- button "Sign in" [ref=e7]`. The token-cheap way to understand a
  page and act on it — feed the refs to `click`/`fill`/`hover`. No eval, so it works on strict-CSP sites.
- `cookies {tabId|url}` → cookies incl. httpOnly (which `exec` can't see). Read-only.

**Act** (all background, no focus change, no banner)
- `click {ref?|selector?, tabId}` → click by snapshot ref (preferred) or CSS selector.
- `fill {ref?|selector?, value, submit?, tabId}` → set an input/textarea/contenteditable (native
  setter + input/change events for React/Vue); `submit:true` presses Enter / submits the form.
- `hover {ref?|selector?, tabId}` → dispatch real pointer/mouse-over events. Opens JS-driven hover
  menus (React/Vue/jQuery `onmouseenter`/`onmouseover`); **pure-CSS `:hover` menus won't open** —
  synthetic events can't drive CSS `:hover` (that needs the debugger, which we avoid).
- `navigate {url, tabId}` → background navigation of an existing tab (to start fresh, `open_tab` first).
- `open_tab {url?, active?, newWindow?, incognito?}` → new tab, background by default. `incognito:true`
  = isolated cookie jar (logged out). Returns `{tabId, windowId}`.
- `close_tab {tabId}`
- `exec {code, tabId}` → run JS (async body; `return`/`await`), returns the JSON value. MAIN world,
  no banner. Strict-CSP pages (GitHub/Google) can block eval → returns `null` there.

**Wait, capture, upload**
- `wait_for {tabId, selector?, text?, gone?, timeoutMs?}` → poll in-page until a selector appears
  (or disappears with `gone:true`), text is present, or (with neither) the page finishes loading.
- `screenshot {tabId}` → PNG image. If the tab isn't frontmost it briefly flashes to front to render,
  then restores focus.
- `network_capture {action:"start"|"stop", tabId?}` → record requests (url/method/type/status/timing)
  via webRequest (optionally scoped to one tab). No response bodies (use `exec`+`fetch` for those).
- `console_capture {action:"start"|"stop", tabId}` → record console logs + uncaught errors
  (`{level, text, t}`). No banner; the hook resets on full navigation.
- `upload_file {selector, filePaths[], tabId}` → set a file `<input>`'s files. **The one tool that
  uses the debugger** (only way the browser allows it) → flashes the "debugging this browser" bar, then
  detaches.

### The agent loop
Pick a tab first: `list_tabs` to drive one that's already open, or `open_tab` to start fresh — then
thread that `tabId` through every call. Then `snapshot` → act by `ref` (`click`/`fill`/`hover`) →
`wait_for` → `snapshot` again. This lets the LLM drive a page it has never seen — including CSP-locked
ones — without dumping raw HTML into context or guessing selectors, and without ever touching the tab
you're working in.

## Install

**1. Server deps**
```
cd server && npm install
```

**2. Register with your agent** (run from the repo root)

*Claude Code* (user scope = every project):
```
claude mcp add --scope user chrome-bridge -- node "$(pwd)/server/index.js"
```
Restart Claude Code (`claude --continue`) so the tools load (MCP servers load at startup).

*Codex* — same server, registered in `~/.codex/config.toml`:
```
codex mcp add chrome-bridge -- node "$(pwd)/server/index.js"
```
(equivalently, add by hand:)
```toml
[mcp_servers.chrome-bridge]
command = "node"
args = ["/absolute/path/to/chrome-bridge/server/index.js"]
```
Start a fresh Codex session so it spawns the server. Verify with `codex mcp list` (shows
`chrome-bridge … enabled`) — the `Auth: Unsupported` column just means it's a local stdio server
with no OAuth, which is expected.

**Both at once is fine.** If Claude Code and Codex run together, each spawns its own copy of the
server; the first to bind port `9223` becomes the **hub** (owns the single extension link) and the
rest become **controllers** that forward over the same port (see *Architecture* below). So the two
agents cooperate on one browser instead of fighting over it.

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
- **Explicit tab targeting (v0.4):** every tab-targeting tool requires a `tabId` and there is **no
  active-tab fallback** — a call without one errors instead of grabbing your focused tab. Sessions get
  a tab from `list_tabs` (existing) or `open_tab` (fresh). This is a hard guarantee in the extension,
  not just guidance, so "fresh work starts in a fresh tab" holds regardless of how the model behaves.
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
The extension can see and act on every tab in your real profile. Tools only touch the tab you pass an
explicit `tabId` for — there is no active-tab fallback, so a session can't wander onto the page you're
working in. Nothing leaves the machine except to the local MCP server on 127.0.0.1.
