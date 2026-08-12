# Changelog

> Created: 2026-07-09 16:10 · Updated: 2026-08-11

All notable changes to heddle are documented here, newest first.
v0.1.91 is the first public release; earlier version numbers were internal iterations and are not covered.

---

## v0.1.100 — 2026-08-10

### AI agents

- **Kiro CLI is now a first-class session type.** Kiro sessions get their own node in the tree, an authoritative Working/Waiting status dot driven by Kiro's own lifecycle hooks, notifications when a turn ends, automatic resume of the same conversation when you reopen the node, launch arguments and a skip-confirmations toggle, and spawning through vspawn — everything the other agents already had. heddle clones your default Kiro agent into its own `vlx-term` agent, adds observe-only lifecycle hooks to the copy, and launches that — your own agent file is never edited, and your prompt, tools and MCP servers come along unchanged. Kiro has no permission-request hook, so the dot stays Working while it waits for your approval.

### Fixed

- **Programs started from the terminal no longer inherit the AppImage's own environment (Linux).** The AppImage launcher points `PYTHONHOME`, `PYTHONPATH`, `PERLLIB`, `QT_PLUGIN_PATH` and the GStreamer plugin paths at the bundle's temporary mount directory, and puts bundle directories ahead of everything else in `PATH` and `LD_LIBRARY_PATH`. A terminal hands its whole environment to the shell it starts, so the system `python3` looked for its standard library inside the bundle and refused to run at all, and other dynamically linked programs loaded the bundle's copy of a library in preference to the system one. heddle now strips those bundle paths before starting a shell or an external tool, and leaves values you set yourself untouched. `APPDIR` and `APPIMAGE` stay visible, so programs that check whether they are running from an AppImage still get their answer. Only AppImage builds were affected; the deb package, macOS and Windows behave as before.

---

## v0.1.99 — 2026-08-09

### Terminal

- **Shift+Enter writes a new line instead of submitting.** Terminals have no encoding for Enter with a modifier, so agent CLIs such as Claude Code and Codex received a plain carriage return and sent the prompt while you were still writing it. heddle now emits ESC+CR, the same sequence those tools expect from an iTerm2 key mapping, so multi-line prompts work — including on macOS, where the custom key handler was previously not installed at all. Composition in an input method is left alone, so Enter still confirms a candidate word.

### Projects and organisation

- **Refresh the status of a single session.** Sessions in a status-filtered pane gain a Refresh status action that re-evaluates only that session against the pane's own conditions, adding or removing it while every other session keeps its place. The action belongs to the pane its menu was opened from, so recursive splits never borrow another pane's filter, and the result is stored per pane and restored after restart.
- **Clearing a mark takes one click.** Choosing the emoji already applied now removes it, so the separate entry for clearing a mark and its divider are gone. The filter button also drops its emoji badge: the highlight already says a mark filter is active, and the menu says which one.

### Fixed

- **Linux AppImage desktop integration installs on any machine.** The bundled icon was a symbolic link to an absolute path on the build machine, so tools such as Gear Lever and AppImageLauncher failed to extract it, even though the application itself ran normally. The link is now relative. The published glibc requirement was also corrected to 2.35 after measuring the bundled libraries rather than the executable alone, which makes Ubuntu 22.04 the oldest supported release for the desktop application.

---

## v0.1.98 — 2026-08-02

### AI agents

- **Grok Build joins heddle as a first-class agent.** Install, start and resume Grok 4.5 with stable session IDs, official lifecycle hooks, accurate working and permission states, merged transcripts, usage details and a theme-aware official icon across desktop, browser and mobile views.

### Projects and organisation

- **Split the project sidebar into independent working views.** Any tree pane can split downward again, with its own search, status and emoji filters, collapse state and resize ratio restored after restart. Every pane remains a projection of the same backend-owned project tree, so edits stay in sync without duplicating business data.
- **Mark nodes and filter without losing context.** Projects, groups and sessions can carry emoji markers. A marked container keeps its full subtree visible, status membership remains stable while you work, dynamic additions and manual refresh are both available, and status plus emoji conditions combine as a union.
- **Create an empty project in place.** Choose a parent directory, validate the name and create then import the folder in one flow. Partial failures retry the import without creating duplicate directories.

### Interface

- **Share heddle where your community is.** The share dialog now covers WeChat Moments, Weibo, Xiaohongshu, X, Reddit, Hacker News, LinkedIn, Facebook, Telegram and WhatsApp, with a QR flow for WeChat and a share prompt in the update dialog.
- **Small interactions feel more deliberate.** Temporary terminal tabs can be renamed before they become saved sessions, and ordinary inputs disable automatic capitalisation on mobile keyboards without changing terminal input.

---

## v0.1.97 — 2026-07-25

### AI agents

- **Sessions no longer stay stuck on “working”.** Codex reported tool activity and turn completion through separate short-lived processes whose callbacks could arrive out of order, leaving a finished turn shown as still working. Mid-turn reports that arrive after their own turn ended are now discarded, and an additional session-end hook covers sessions that exit without a completion event.
- **Interrupted turns settle within seconds.** Pressing Esc, or a stream error, ends a Claude or Codex turn without any completion callback at all. Six seconds of terminal silence now quietly corrects such a session to waiting, without raising a “replied” notification.

### Interface

- **Reliable split shortcuts on macOS.** Split Right (Cmd+D) and Split Down (Cmd+Shift+D) are now registered as native Terminal menu commands, so macOS no longer intercepts the key combination before heddle receives it.
- **Documents save exactly once per keystroke.** Cmd+S was handled by both the global shortcut and the focused editor, which could write the same file twice in a single keypress.

---

## v0.1.96 — 2026-07-23

### AI agents

- **Trust Codex lifecycle hooks, not terminal guesses.** Modern Codex sessions now use official lifecycle hooks as their only activity source. A `SessionStart` handshake verifies the bridge, missing callbacks are shown as “Status unavailable,” and terminal text or output activity can no longer overwrite working, confirmation or completed states.
- **Fresher Codex usage after every turn.** The Info panel shows the local rollout snapshot immediately, reconciles it with live rate limits, refreshes again after Codex finishes writing its final token snapshot, and ignores late responses from an older session.

### Interface

- **Reliable project-tree targeting on macOS.** Virtual rows no longer depend on compositor transforms, preventing stale WKWebView hit-test coordinates from sending hover, click or drag actions to a different row after scrolling or tree updates.

---

## v0.1.95 — 2026-07-21

### AI agents

- **Kimi Code and Zoo Code join the session tree.** heddle can now launch, resume, install and configure both agents. Kimi uses its official lifecycle hooks for authoritative working, permission and waiting states; Zoo Code keeps a stable task identity and uses terminal detection where external hooks are not available.
- **Live Codex usage refresh.** The Info panel can actively query Codex's app server for current rate limits, while retaining the local rollout snapshot as a compatibility fallback.

### Projects and terminals

- **Open projects with `vela <path>`.** Packaged builds can install a VS Code-style shell command. A second invocation forwards the project to the existing heddle window instead of opening a duplicate app instance.
- **Visible, cancellable Git clones.** Clone Project now reports Git stages, percentage and elapsed time, warns when progress stalls, and can cancel the entire Git process tree without leaving a half-cloned target. Credentials and query tokens are redacted from displayed errors and audit logs.
- **WSL terminals on Windows.** Every installed WSL distribution is detected and offered alongside PowerShell, cmd and Git Bash for plain terminal sessions. Agent sessions remain on the Windows host shell so hooks and executable paths stay reliable.

### Interface and reliability

- **Clearer background-session control.** Background-tab menus now show every session's live state, and the over-limit dialog can end several selected tabs at once.
- **Safer app lifecycle and release notes.** Quitting now confirms before stopping live sessions; Codex lifecycle identity wins over ambiguous rollout scans; and automatic-update notes can be delivered in every bundled interface language.

---

## v0.1.94 — 2026-07-12

### Localization

- **Vietnamese interface.** Tiếng Việt is now available in the language picker and is selected automatically for Vietnamese system locales.

### Browser

- **Faster starts in the built-in browser.** Every browser tab now has one-click shortcuts for ChatGPT, Claude, Gemini and Google. Project and group context menus can also create a permanent browser page directly in that part of the session tree.

### Images and documents

- **Reliable image-path paste on macOS.** When WebKit does not expose a copied image as a file, heddle now reads it from the native clipboard and still uploads it as a file path instead of silently falling through to an agent's native image placeholder. Remote windows always show the image-paste setting, explain why file-path mode is required, and disable the unavailable native option.
- **Paste images into source documents.** The source editor now accepts clipboard images. Saved Markdown documents store them beside the document under `assets/` and insert portable Markdown image syntax; unsaved drafts embed the image data so it is not lost when temporary files are cleaned up.

### Interface

- **Context menus stay visible and target the right item.** Menus opened near the right edge are measured and shifted correctly. Right-clicking a tree node now highlights only the menu target without changing the existing selection, and group menus include a terminal scoped to that group.
- **Cleaner editing and status labels.** Source text no longer renders arrow-like font ligatures for sequences such as HTML comments, usage percentages are explicitly labelled as used, and the host WebView's unrelated native context menu no longer appears behind heddle's own menus.

### Fixed

- **Codex stays in normal terminal history.** Codex sessions launched by heddle now use inline terminal mode, so pressing Esc to interrupt or step back no longer switches terminal screen buffers and jumps the scrollback viewport to the top. Your own Codex configuration is left untouched.

---

## v0.1.93 — 2026-07-11

### Updates

- **See what changed before you install.** When a new version is available, a status-bar chip and a dedicated dialog now show this version's release notes. You can update now, skip this version, keep downloading in the background, or open the installer download manually; progress is shown live and the app restarts to finish. If you skipped several versions, the notes for every one in between are shown together, not just the latest.

### AI agents

- **Codex sessions name themselves.** A Codex session is renamed from your first message the moment you send it — the same way Claude sessions already were — so the tree no longer fills up with "Codex 1", "Codex 2". A name you set by hand is never overwritten.
- **vspawn and vopen now work in Codex too.** The built-in `vspawn`, `vspawn-tree` and `vopen` skills are installed into Codex's skill directory as well as Claude's, so `$vspawn <task>` and `$vopen <file>` work from a Codex session.
- **More reliable Codex resume.** Capturing a Codex conversation for later resume no longer gives up on a fixed timer, so it still works if you pause before typing the first message; and two Codex sessions started in the same folder can no longer end up wired to each other's conversation.
- **Model and context usage for Codex.** The Info panel now shows the current model, context-window usage and the tool in flight for Codex sessions, the same as it already did for Claude, read live from the session's rollout.

### Remote and terminal

- **Rebuilt remote file browser.** The directory picker for remote sessions gains search-as-you-type, jump-to-path (with `~`), Up / Home / Recent navigation, and inline New Folder.
- **Links open on your own machine.** Clicking a link in the terminal — including an agent's login link — now opens in your local browser, from remote windows too.
- **The "reuse remote database" option is tucked away.** It appears only when you Option/Alt-click Connect to Remote; a normal click always connects with an independent database.

### Fixed

- **Tools are found when launched from the Dock.** Starting heddle from the Dock or Finder no longer left it with a stripped-down PATH, so git and other Homebrew-installed tools that agents rely on are located correctly.
- **New terminals open in the right folder.** Creating a terminal from a project or group in the sidebar now opens it in that node's directory, instead of reusing the last active session's folder.

---

## v0.1.92 — 2026-07-09

### Fixed

- **No more false "SSH link lost" warnings.** The tunnel monitor used to treat the exit of the port-forwarding child process as a dropped link, showing the red banner and rebuilding the tunnel. In reality the forwarding listener lives in the ControlMaster process, so forwarding keeps working after the child exits — the terminal stayed perfectly usable while the UI claimed the link was down, and the rebuild would tear down a healthy connection for nothing.

  The link is now checked in two stages: when the child process exits, heddle first probes whether the local forwarding port still has a listener. If it does, nothing happens. Only when the port is gone as well is the link considered dead and rebuilt. The red banner is also debounced — it appears only after the first rebuild attempt fails, so a hiccup that heals within a few seconds no longer flashes a warning.

  Genuine disconnects still recover on their own. If the ControlMaster process is killed or the network drops for an extended period, the tunnel rebuilds automatically; once retries are exhausted the banner switches to "SSH link is down", and Reconnect now restores the session — remote processes are still running and pick up where they left off.

---

## v0.1.91 — 2026-07-09 00:00

**First public release.** Everything below shipped in this version.

### AI agents as first-class citizens

- Built-in support for nine agents — Claude Code, Codex, OpenCode, Copilot CLI, Cursor CLI, Cline, Pi, Antigravity (Gemini CLI) and crush. Pick a type when creating a session and it launches ready to go.
- Agent status is reported, not guessed. heddle injects each vendor's official callback mechanism at launch (hooks for Claude, notify for Codex, a plugin for OpenCode, and so on), so every state change is pushed back immediately. The session tree shows a status dot for working, waiting on you, and finished-but-unseen; the sidebar filters by status and the status bar keeps a live count.
- System notifications fire when an agent needs a permission decision or finishes a task, and clicking one jumps straight to that session. Screen detection acts as a fallback for anything without a callback.
- Conversations survive everything. Each agent's own session id is captured and stored, so closing a session, restarting the app, or restoring an archived session all resume the original conversation — after verifying it still exists. Claude Code, Codex and Pi can also fork the current conversation into a parallel session.
- Sessions spawn sessions. Subtasks become child sessions, spawned by the agent itself or by you, optionally in an isolated git worktree so several agents can work on the same repository at once. A graphical merge dialog brings the branches back together when they are done.
- Missing agents get an install card with a recommended command and one-click install, with automatic path discovery afterwards. A side panel shows Claude and Codex usage quotas, and any conversation can be viewed in place or exported as a full Markdown transcript.

### Session organisation

- A three-level tree — project, group, session — with unlimited group nesting and child sessions beneath sessions. Nodes drag freely and collapse state persists across restarts.
- Any subtree can be archived: hidden into the archive panel without deleting data, restorable at any time, and still able to resume its conversation.
- Global content search (⌘⇧F) is backed by a SQLite FTS5 index and covers both agent transcripts and terminal output, with a result tree on the left, a linked preview on the right, and step-through navigation across sessions.

### A proper terminal, first

- Real PTYs (portable-pty, from wezterm), so vim, htop and the agent TUIs themselves all run exactly as they should.
- Multiple tabs with arbitrary splits — each tab holds its own split tree, divided horizontally or vertically however you like.
- Browser-style tab lifecycle: background tabs stay alive and their processes keep running, the live-tab budget is configurable, and exceeding it retires the oldest inactive session. Closing a tab is what ends a process.
- Typing stays responsive under load, thanks to input-priority scheduling and output frame coalescing — an agent flooding the screen no longer costs you keystrokes.
- In-terminal search (⌘F), session recording and replay, paste or drag images straight to an agent, and free switching between cmd, PowerShell and Git Bash on Windows.

### Beyond the terminal

- Run `vopen <file>` in any session to open a document tab in place, alongside your terminals: Markdown opens as a WYSIWYG editor and exports to vector PDF, images open in the built-in viewer, and source files get syntax highlighting.
- A built-in browser tab can be used as a scratch tab or pinned into the project tree as a permanent node.

### Remote and multi-device

- The desktop app serves the same interface over the web, sharing one live set of sessions. Output streams to every client in real time and any of them can type — desktop and browser see and drive the same terminal.
- End-to-end encryption with per-frame NaCl box, pairing by QR code or link, and per-device management including individual revocation.
- Headless mode: `--serve` runs the same service on a server with no GUI, ready for a browser to connect.
- SSH remote connections put remote machines in your tree. heddle connects directly from the desktop, deploys a slim vela-server on the far side, and remote sessions behave like local ones. The tunnel heals and reconnects on its own.
- Mobile: the service ships a mobile web view, and a native app shell (xterm rendering with native input and an accessory key bar) is available as well.

### Platform and polish

- macOS, Linux and Windows.
- Automatic updates, with notarised macOS builds.
- Light and dark themes follow the system, and running agent sessions are told about the switch through the standard terminal notification (DEC 2031) — TUI colours change instantly, no restart needed.
- English by default, with 10 bundled languages following the system locale.
