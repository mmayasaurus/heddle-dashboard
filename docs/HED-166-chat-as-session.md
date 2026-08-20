# HED-166 Amendment — Chat as a First-Class Session

**Status:** Ratified design record. Direction approved by Maya 2026-08-19 (the chatroom becomes a first-class
`SessionKind`); build is underway — see §0. Co-authored by Agent T (UI surface + heddle.db mapping + build) and
Agent R (reuse analysis + design decisions + review). Landed to `docs/` for durability (HED-251).
**Hard prerequisite: HED-183 (operator-send fix) — MERGED (#58).**

---

## 0. Build Status — 2026-08-20 (T)

Progress against the §10 breakdown. Pieces land as separate PRs off the shared foundations.

| §10 Piece | Status | Landed as |
| --- | --- | --- |
| 1. Chat `SessionKind` (`types.ts` + db + Rust `SessionKind`) | **MERGED** | PR #67 (HED-195) |
| 2. ProjectTree chat nodes (render) | **MERGED** | PR #71 (HED-216) |
| 3. CenterPane chat render (`ChatSessionPane`) | **MERGED** | PR #71 (HED-216) — shipped with piece 2 |
| 4. Room-management UI | pending | — |
| 5. Unread state (operator-side last-read) | pending (UI) | broker `heddleUnreadState` support merged by W |
| 6. C / HED-169 default-room provisioning (backend) — **materializes rooms as chat sessions** | pending | HED-169 |
| 7. E2 participants reader | **MERGED** | HED-197 (W, HED-166 backend) |

Foundations (all merged): HED-163, E1, F/HED-168, HED-183. **The render surface is in place on `main` as of #71**
and unit-tested: a `chat`-kind session renders as a node in the left `ProjectTree` under its project and, when
selected, opens the chatroom in the `CenterPane` like any session. Desktop-only (gated on Tauri).

**Not yet visible end-to-end.** Nothing populates rooms as chat sessions yet: `chat_target` has no write path in
the foundation (documented in `src-tauri/src/db/repo.rs`) — the pieces that CREATE chat sessions set it. The
provisioning that materializes room→chat-session nodes is **HED-169 (default-room provisioning), still pending**;
until it lands, a clean DB shows no rooms. The new pane also **coexists with the legacy `ChatroomPane` overlay**
(still mounted in `CenterPane.tsx`), so retiring chat's `useSuspendNativeViews` is not done yet.

---

## 1. Decision & Supersession (R)

Maya's decision (2026-08-19): the chatroom stops being a full-window pop-up overlay and becomes a first-class
`SessionKind`. Each room or DM is a **session** that appears in the left-panel `ProjectTree` for its project;
selecting it renders in the `CenterPane` like any terminal session, with the active / unread / needs-human
indicators terminals already have. Plus full Discord-style room management (create / name rooms, add / remove
agents), and subagents addressable in-chat.

This **extends** HED-166 and does not collide with it. It **supersedes HED-154** (chatroom-as-pull-up-drawer — a
drawer and a center-pane occupant are conflicting designs; the newer decision wins) and **shrinks HED-153's
drawer-stack** to essentially just the fleet drawer. Add supersession notes to HED-153 and HED-154.

## 2. Read-this-first — the subagent capability ENVELOPE (T; Maya-facing)

"@-tag a subagent and chat with it" delivers differently by **what kind of subagent**, and the common case is the
narrower one — approve on the real capability:

- **Live child terminal** (an interactive `claude` session opened in the dashboard): **LIVE.** An @mention/DM pushes
  into its session mid-task and costs it a turn, exactly like messaging a top-level agent.
- **Headless `dispatch_worker`** (the `claude -p`/codex labor path — **how MOST fleet subagents run**): **addressable,
  but not a live conversation.** A bounded one-shot run with no injecting channel — it does its task and exits, so
  there is no live mid-run back-and-forth. How an addressed message surfaces for a worker that isn't live (to its
  parent/orchestrator to fold into a re-dispatch, vs. a next-check if it's still running) is exactly what the
  build-time gate below pins down.

**Blunt:** most subagents are headless workers, so "@-tag any active subagent and chat live" is real for live
terminals but **not a live conversation for the far more common labor workers** — you can address them, but there is
no interactive back-and-forth. (Evidence: the `post_message` tool contract returns a tactical SendMessage for
"Claude targets without a live channel" — that IS the headless case.) A concrete push-to-live-child-vs-headless-worker
test is a **named build-time gate** before the subagent surface ships.

## 3. Verified Feasibility (R)

`src/types.ts:77-203` — the persistent `Session` and in-memory `SessionRuntime` interfaces are cleanly separate, so a
chat session can be a `Session { kind: 'chat' }` with **no PTY runtime**, exactly as the existing `browser` kind
works. Chat-as-`SessionKind` is architecturally cheap. `parentSessionId` already exists (relevant to subagents).

## 4. Reuse Enumeration — exists / extend / new (R)

| Component | Status | Notes |
| --- | --- | --- |
| Chat renderer in center pane | EXTEND | `ChatroomPane` content minus the `ExpandedOverlay` wrapper; a pane swap doesn't overlay native views, so this likely retires the HED-111 `useSuspendNativeViews` machinery for chat. |
| Left-panel conversation list | EXTEND | `ProjectTree` already lists sessions per project with status indicators; rooms/DMs become session nodes, via T's `heddle.db` room→project mapping. |
| Tab/activity indicators | EXISTS | `SessionStatusBadge` / `SessionTabStatus` / `StatusIndicator`. |
| Room management (create/name/add/remove/list) | EXISTS (broker) + NEW (UI) | Broker has `create_room` / `join_room` / `leave_room` / `list_rooms` (membership is join/leave, not add/remove member); only the UI is new. |
| Per-agent DMs | NEW (view-model) | Derived from sender/target pairs in `comms.db`; no hidden per-agent rooms. |
| Unread counts | NEW | Operator-side per-conversation last-read store; nothing required broker-side. |
| Permission-request indicator | EXTEND | Broker `needs-human` signal (`NeedsHumanStrip`) surfaced as a row badge. |
| Subagent addressing | broker EXISTS + naming/lifecycle/UI NEW | §7. |

## 5. Design Decisions (R)

**Push/pull economics (load-bearing).** Rooms are **PULL**: agents read a room's transcript when they choose;
everyone in the room sees every message as shared context. Only DMs and **@-mentions PUSH** (inject into a live
agent's session, costing it a turn). If every room message pushed to every member, a busy channel would interrupt
every agent on every message and burn the usage meters the project exists to protect. The @-mention is the
"this needs YOU" escape hatch — direct + elevate to a specific member. This is Maya's stated intent: group context
for all, with a mechanism to direct/elevate to specific members.

- DMs are a derived filtered view, not hidden rooms (avoids room sprawl).
- Keep the fleet drawer a **DRAWER** — its roster/usage bars are ambient status, not a conversation.
- @-mentions must **carry enough room context** for a pinged agent to act without re-reading the whole thread.

## 6. UI Surface Layout (T)

**Left panel — rooms & DMs as session nodes in ProjectTree.** A chat conversation is a `Session { kind: 'chat' }`,
rendering through the existing `session` row (no new `TreeRow` variant) with a chat glyph, under its project beside
the terminal sessions. Which rooms belong to a project comes from the shipped `heddle.db` mapping (§8):
`listRoomAssociations()` joined to the comms room list, filtered to the current project; the `is_default` room sorts
first. Status via the existing `SessionStatusBadge`/`SessionTabStatus`/`StatusIndicator` (unread from the operator-side
last-read store). A global **"Fleet"** section holds unassociated + agent-created rooms and `#fleet`. **DMs** are
synthesized per distinct sender/target pair from `comms.db`, shown under the counterpart's project (via E1 membership).
Selecting a chat node sets it active → renders in CenterPane, using the same active-session path terminals use.

**CenterPane — a chat session renders like any session.** A `kind:'chat'` session renders `Transcript` + `Composer`
(with `RefusalBanner`/`FloorBanner`) + `NeedsHumanStrip` as the pane body — the `ChatroomPane` content minus the
`ExpandedOverlay` wrapper. As a pane (not an overlay over native views), this **retires chat's `useSuspendNativeViews`**.
The comms poll moves to a store owner keyed on the active chat session (the reshaped remnant of the old "comms store
slice" — driven by session selection, not a separate overlay target). `@all` stays a composer address toggle;
`@mention` is authored in the body and elevated to a directed push by the broker.

**Room-management controls (Discord-style) — broker EXISTS, UI NEW.** Create/name a room (reuse `RoomCreateModal` /
`MemberPicker`, extended to list subagent children via the deferred participants reader) → broker `create_room`
(CLOSED by default) → `associate_room_to_project` so it lands under the right project. Add/remove members surface
`RoomMemberControls` in a room session's header. Rename is a UI-display concern (rooms can't rename broker-side —
flag any gap to V). All of these write through the operator-send path (gated on HED-183, now merged).

## 7. Subagent Addressing — capability + lifecycle (R + T)

The broker models subagents as child participants (e.g. `V.1` with labels) and has `mint_child`, so naming/addressing
is feasible. **Delivery is bounded by the §2 envelope** (live child vs headless worker). Temporary-name lifecycle:
mint with a temp name on spawn; grey out & retire on completion; persist the transcript after retirement; route
messages to a retired subagent to its parent.

## 8. heddle.db room↔project mapping (T; Maya-locked — SHIPPED as HED-168)

`project_rooms(room_name PK, project_id → projects ON DELETE CASCADE, is_default, created_at)` + partial unique index
(one default per project). **Merged in PR #56.** Keyed on the stable `project_id`, so a project rename never orphans
its rooms. Per-project rooms = `listRoomAssociations()` filtered by project; default = `is_default`; **Fleet bucket** =
rooms with no row. **C / HED-169** auto-provisions the default CLOSED room on project open (Maya-approved AUTO,
2026-08-19); membership = the project's agents via E1's exact worktree-set match.

## 9. What else we're missing (R)

Room member list (who's in a channel); per-room notification level (mute / normal / all — lighter-weight since rooms
are pull); persistent scrollback (already in `comms.db`); the mention-carries-context requirement (§5).

## 10. Build Breakdown (T) — supersedes the old B/A shape

Foundations DONE: **HED-163** (broker resolution) · **E1** (project→agent membership) · **F** (room↔project
association) · **HED-183** (operator-send) — all merged.

New/updated pieces (replacing old B "scope the overlay" + A "Rooms subsection"):
1. **Chat `SessionKind`** — add `kind:'chat'` to `Session` (types.ts + db + Rust `SessionKind`), no PTY, mirroring `browser`. (small) — **MERGED (#67, HED-195).**
2. **ProjectTree chat nodes (render)** — renders room/DM chat sessions as tree nodes with status; global Fleet section. (medium) — **MERGED (#71).** Renders chat sessions that *exist*; the provisioning that CREATES them from rooms is piece 6 (HED-169), still pending.
3. **CenterPane chat render** — `ChatroomPane` content minus `ExpandedOverlay`, driven by the active chat session. (medium) — **MERGED (#71).** Retiring chat's `useSuspendNativeViews` is NOT yet done — the legacy `ChatroomPane` overlay still mounts alongside the new pane.
4. **Room-management UI** (§6). (medium)
5. **Unread state** — operator-side per-conversation last-read store; per-room notif level. (small)
6. **C / HED-169** — default room provisioning (backend). (medium)
7. **E2** — participants reader so children are pickable/addressable. (small)

## 11. Sequencing & Ownership (R + T)

- **Hard prerequisite:** HED-183 operator-send fix — **MERGED (#58).** Every message writes through it.
- **Ownership:** **T** — UI surface (`ProjectTree` nodes, `CenterPane` wiring, room-management controls) + the
  `heddle.db` room↔project mapping. **V** — broker additions (child-naming/lifecycle surface, any rename gap,
  unread-count support if needed). **R** — reuse analysis, design decisions, review.
- **Process:** this combined doc → R review (gating on the §2 envelope reading clearly to Maya) → Maya page-by-page
  approval → build (T: tree/UI; V: broker additions; R: review). **Subagent-surface build-time gate:** the concrete
  push-to-live-child-vs-headless-worker test before that surface ships (§2).
