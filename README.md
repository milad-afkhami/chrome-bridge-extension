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

## Tools (9)
- `list_tabs` → `[{tabId, url, title, active}]`
- `read {tabId?, selector?, html?}` → visible text (or `outerHTML`), optionally scoped to a selector.
  Works on every site incl. strict-CSP (no eval).
- `exec {code, tabId?}` → run JS (async body; `return`/`await`), returns the JSON value. MAIN world,
  no banner. Strict-CSP pages (GitHub/Google) can block eval → returns `null` there.
- `navigate {url, tabId?}` → background navigation.
- `open_tab {url?, active?, newWindow?, incognito?}` → new tab, background by default. `incognito:true`
  = isolated cookie jar (logged out). Returns `{tabId, windowId}`.
- `close_tab {tabId}`
- `screenshot {tabId?}` → PNG image. No tabId = the visible tab (zero disturbance); a background tabId
  briefly flashes to front to render, then restores focus.
- `upload_file {selector, filePaths[], tabId?}` → set a file `<input>`'s files. **The one tool that
  uses the debugger** (only way the browser allows it) → flashes the "debugging this browser" bar, then
  detaches.
- `network_capture {action:"start"|"stop", tabId?}` → record requests (url/method/type/status/timing)
  via webRequest. No response bodies (use `exec`+`fetch` for those).

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
  Google, some banks) → `exec` returns `null` there. `read`/`navigate`/screenshot still work.
- **Focus:** nothing calls `chrome.tabs.update(..., {active:true})` except `screenshot` of a background
  tab (brief flash-and-restore).
- **Parallelism vs isolation:** drive many tabs in parallel by `tabId` (shared login); true isolation =
  `incognito` windows (separate cookies, logged out). For massive isolated fan-out, Playwright is better.
- **Port:** override with `BRIDGE_PORT` env (must match `PORT` in `extension/background.js`).

## Privacy
The extension can see and act on every tab in your real profile. Tools only touch the tab you pass a
`tabId` for (or the active tab). Nothing leaves the machine except to the local MCP server on 127.0.0.1.
