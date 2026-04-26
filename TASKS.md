# Invite Accept And Reject Refresh

## Goal

Make pending DM and workspace invite accept/reject flows work reliably from the
terminal home menu.

## Definition of Done

- [x] Accepting a pending DM invite supplies server hints for room-ID joins.
- [x] Accepting a pending workspace invite uses the same server-hinted join path.
- [x] Rejecting a pending invite waits until Matrix sync no longer reports it as
  pending.
- [x] Focused tests cover invite via-server derivation.
- [x] `pnpm build` passes.
- [x] Relevant tests pass.
- [x] Working diff is reviewed for unrelated edits.

## Checklist

- [x] Inspect home invite actions, Matrix membership helpers, and invite summaries.
- [x] Add invite server-hint extraction for joined room IDs.
- [x] Route pending invite accepts through the membership helper.
- [x] Make pending invite rejection wait for invite membership to clear.
- [x] Add focused tests.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
pnpm test
git diff --check
```

Manual verification requiring Matrix account:

```sh
./nugget
# Accept a pending DM invite and confirm it joins instead of "No known servers".
# Reject a pending DM/workspace invite, refresh home, and confirm it disappears.
```

## Current Status

Implementation is complete with local verification:

- `pnpm build`
- `pnpm test`
- `git diff --check`

Pending DM and workspace accepts now pass invite-derived server hints to the
shared `joinRoom` helper. Pending invite rejection now goes through `leaveRoom`,
which waits for the original membership state to clear before returning.

# DM Leave Cleanup

## Goal

Make leaving a DM remove the room from Nugget's DM surfaces instead of leaving
stale DM metadata or recent hints behind.

## Definition of Done

- [x] Leaving a Matrix room removes that room ID from `m.direct` account data.
- [x] Leaving a room removes the room ID from local recent DM state.
- [x] Focused tests cover DM account-data and recent-state cleanup.
- [x] `pnpm build` passes.
- [x] Relevant tests pass.
- [x] Working diff is reviewed for unrelated edits.

## Checklist

- [x] Inspect DM list, leave, recent-state, and direct-room metadata paths.
- [x] Add account-data cleanup for left DM rooms.
- [x] Add local recent DM cleanup for leave paths.
- [x] Add focused tests.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
pnpm test
git diff --check
```

Manual verification requiring Matrix account:

```sh
./nugget leave "<dm-room-id>"
./nugget
# Confirm the left DM no longer appears in the DMs section.
```

## Current Status

Investigation found `leaveRoom` changes Matrix membership, while DM metadata
comes from `m.direct` account data and Nugget also keeps local recent-DM hints.
Implementation is complete with local verification:

- `pnpm build`
- `pnpm test`
- `git diff --check`

Manual live Matrix verification still requires leaving a real DM and reopening
the home menu.

# Persistence And Recovery

## Goal

Implement `docs/persistence-recovery-plan.md` so Nugget keeps non-secret local
state separate from Matrix credentials, recovers cleanly from damaged local
files, and treats stale cmux panes as hints instead of authoritative state.

## Definition of Done

- [x] Matrix credentials remain isolated in `session.json`.
- [x] Non-secret app state is stored in a separate `state.json`.
- [x] Corrupt session files produce an actionable recovery message.
- [x] Corrupt or unknown app-state files do not block login or chat.
- [x] Home menu ranks Matrix-derived workspaces and DMs with recent hints only.
- [x] Workspace and DM opens record recent hints.
- [x] `reset-state` clears app state without logging out.
- [x] `doctor` prints local diagnostics without exposing secrets.
- [x] cmux workspace scoring keeps description matches highest priority.
- [x] Stale room, thread, and agent pane focus failures open fresh panes where
  the current code has those pane types.
- [x] Partial Matrix create/link/open failures report created durable IDs.
- [x] `pnpm build` passes.
- [x] `./nugget --help`, `./nugget reset-state`, and `./nugget doctor` run.
- [x] Working diff is reviewed for unrelated edits.

## Checklist

- [x] Read `docs/persistence-recovery-plan.md`.
- [x] Inspect store, CLI, home, Matrix create, and cmux controller code.
- [x] Add `src/store/app-state.ts`.
- [x] Export app-state helpers from `src/store/index.ts`.
- [x] Improve session load diagnostics without changing credential storage.
- [x] Rank home workspaces and DMs with validated app-state recents.
- [x] Record recent workspace and DM opens.
- [x] Add `reset-state` and `doctor` commands.
- [x] Harden cmux stale focus handling.
- [x] Improve partial create/link/open messages.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
./nugget --help
./nugget reset-state
./nugget doctor
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget login
./nugget
./nugget workspace "<joined-space-id>"
```

## Current Status

Implementation is complete with local verification:

- `pnpm build`
- `./nugget --help`
- `./nugget reset-state`
- `./nugget doctor`
- `git diff --check`

Manual live Matrix/cmux verification still requires a Matrix account and a
running cmux session. `./nugget doctor` reported cmux unavailable in this
sandboxed run because the cmux socket was not accessible.

# Workspace Room Pane Ratio

## Goal

When the workspace picker opens the first room beside itself, size the new room
pane to roughly 80% of the split width and leave the picker at roughly 20%.

## Definition of Done

- [x] Confirm cmux has a pane resize API usable from Nugget.
- [x] First workspace room split computes a resize amount from the picker width.
- [x] Existing room pane reuse does not resize again.
- [x] Unit coverage verifies the 2:8 resize amount calculation.
- [x] `pnpm build` passes.
- [x] Relevant tests pass.
- [x] Working diff is reviewed for unrelated edits.

## Checklist

- [x] Inspect workspace controller and cmux client split/resize flow.
- [x] Check local cmux CLI/API support for pane resize.
- [x] Replace fixed resize amount with calculated 2:8 amount.
- [x] Add focused test coverage.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
pnpm test
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget workspace "<joined-space-id>"
# Open the first room and confirm picker:room width is approximately 2:8.
```

## Current Status

Investigation found `cmux resize-pane` and the raw `pane.resize` method are
available. The CLI accepts tmux-style directional resizing, not direct ratios,
so Nugget now calculates a cell amount and keeps the resize best-effort.
Local verification passed: `pnpm build`, `pnpm test`, and `git diff --check`.
Manual live layout verification still requires opening a Matrix workspace inside
cmux.

# Shared Chat Room Pane

## Goal

Workspace child rooms and DMs should open as surfaces in the same chat room pane
instead of creating separate cmux panes for each source.

## Definition of Done

- [x] Confirm the workspace room and DM cmux open paths.
- [x] DM opens reuse an existing Nugget room pane, including one
  created by the workspace controller.
- [x] Existing DM surface focus behavior is preserved.
- [x] Focused unit coverage verifies DM pane selection reuses a workspace room
  pane.
- [x] `pnpm build` passes.
- [x] Relevant tests pass.
- [x] Working diff is reviewed for unrelated edits.

## Checklist

- [x] Inspect workspace controller, DM controller, CLI open paths, and cmux tests.
- [x] Update DM pane selection to share the existing chat room pane.
- [x] Add focused test coverage.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
pnpm test
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget workspace "<joined-space-id>"
# Open a workspace child room, then open a DM and confirm it appears as another
# surface in the same room pane.
```

## Current Status

Investigation found `WorkspaceController` already reuses any existing Nugget
room pane, while `dm-controller` only searched known DM room surfaces before
splitting. `dm-controller` now chooses an existing Nugget room pane for new DM
surfaces, preferring a non-source pane but reusing the current pane when it
already contains chat surfaces. Local verification passed: `pnpm build`,
`pnpm test`, and `git diff --check`. Live Matrix/cmux layout verification still
needs a running session.

# Shared Thread Agent Pane

## Goal

Thread views and `@Codex`/`@Claude` agent launches should open as surfaces in
the chat room's shared right pane instead of creating separate cmux panes.

## Definition of Done

- [x] Confirm thread and agent cmux open paths.
- [x] Thread opens reuse an existing right-side thread/agent pane.
- [x] Agent opens reuse the same right-side thread/agent pane.
- [x] Opening from an existing thread/agent pane creates a new surface there,
  not another split.
- [x] Focused unit coverage verifies shared pane selection for thread and agent
  surfaces.
- [x] `pnpm build` passes.
- [x] Relevant tests pass.
- [x] Working diff is reviewed for unrelated edits.

## Checklist

- [x] Inspect sidecar, thread, agent, CLI, and cmux tests.
- [x] Tighten shared right-pane selection for thread/agent surfaces.
- [x] Add focused test coverage.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
pnpm test
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget workspace "<joined-space-id>"
# Open a room, open a thread, then @Codex/@Claude and confirm they appear as
# surfaces in the same right pane.
```

## Current Status

Investigation found thread and agent launches share `createThreadAgentSurface`,
but pane reuse depends on detecting an existing thread/agent pane. Implementation
now also treats the pane immediately to the right of a Nugget room pane as the
shared thread/agent pane when cmux title markers are missing or mangled. Local
verification passed: `pnpm build`, `pnpm test`, and `git diff --check`. Diff
review found pre-existing/shared edits in other files; they were left intact.

# Join Leave And Invite UX

## Goal

Implement and verify the remaining `docs/membership-plan.md` membership flows:
explicit room join, room leave, and room invite commands through the CLI and
chat view.

## Definition of Done

- [x] `./nugget join <roomIdOrAlias>` is wired and returns the joined room ID.
- [x] `./nugget leave <roomId>` is wired and waits until the room is no longer
  joined locally.
- [x] `./nugget invite <roomId> <userId>` is wired and validates Matrix user IDs.
- [x] Chat `/invite @user:server` uses the shared invite helper.
- [x] Chat `/leave` leaves the room and exits the chat view after success.
- [x] CLI and slash help list the new implemented commands.
- [x] `pnpm build` passes.
- [x] Working diff is reviewed for unrelated edits.

## Checklist

- [x] Read `docs/membership-plan.md`.
- [x] Inspect existing Matrix membership, invite, home, CLI, and chat code.
- [x] Identify already implemented invite visibility and invite accept/reject
  flows.
- [x] Update the membership plan for already implemented pieces.
- [x] Add shared membership helpers.
- [x] Wire CLI join, leave, and invite commands.
- [x] Wire chat `/leave` and shared `/invite`.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
./nugget --help
git diff --check
```

Manual verification requiring Matrix account:

```sh
./nugget login
./nugget join "#some-public-room:server"
./nugget open "<joined-room-id>"
./nugget invite "<joined-room-id>" "@user:server"
./nugget leave "<joined-room-id>"
```

## Current Status

Implementation is complete at build level. Inspection found that pending
DM/workspace invite visibility, accept, and reject flows already existed in
Home, and `waitForRoomMembership` already existed in `src/matrix/client.ts`.

# Workspace Leave Action

## Goal

Allow a user who has opened a Matrix workspace picker to leave that workspace
from the picker actions, with a Home refresh action available for stale Matrix
state after returning.

## Definition of Done

- [x] Workspace picker exposes a `Leave workspace` action.
- [x] Selecting the action leaves the Matrix Space and returns to Home.
- [x] Failed leaves keep the picker open with an actionable error.
- [x] Home exposes a `Refresh` action.
- [x] Home `r` shortcut refreshes when available.
- [x] Focused unit coverage verifies the picker option is present.
- [x] `pnpm build` passes.
- [x] Relevant tests pass.
- [x] Working diff is reviewed for unrelated edits.

## Checklist

- [x] Inspect workspace picker, CLI workspace controller, and membership helper.
- [x] Add picker action plumbing for leaving the workspace.
- [x] Wire workspace leave to the existing Matrix leave helper.
- [x] Add Home refresh action and shortcut.
- [x] Add focused test coverage.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
pnpm test
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget workspace "<joined-space-id>"
# Choose Actions -> Leave workspace and confirm it returns to Home.
```

## Current Status

Implementation is complete at build/test level. Local verification passed:
`pnpm test`, `pnpm build`, and `git diff --check`. Diff review found unrelated
pre-existing/shared changes in other files; they were left intact.

Added:

- Shared `src/matrix/membership.ts` helpers for join, leave, invite, membership
  lookup, user ID validation, and leave sync waiting.
- CLI `join`, `leave`, and `invite` commands.
- Chat `/leave`, plus shared-helper-backed `/invite`.
- Minimal TypeScript fixes in concurrent `src/store/app-state.ts` work so
  `pnpm build` remains green.

Verification passed:

- `pnpm build`
- `./nugget --help`
- `./nugget join`
- `./nugget leave`
- `./nugget invite`
- `git diff --check`

Not run:

- Live Matrix join/invite/leave commands.

Diff review:

- Membership work changed `src/cli.ts`, `src/matrix/index.ts`,
  `src/matrix/membership.ts`, and `src/ui/chat-view.ts`.
- `src/store/app-state.ts`, `src/store/index.ts`, and `src/store/session.ts`
  came from unrelated concurrent app-state/session work. Only the app-state
  TypeScript build errors were minimally fixed; the session/index changes were
  left otherwise untouched.

# Demo Hardening

## Follow-up: Workspace Child Room Discovery

Goal: A workspace should list all visible child rooms, not only rooms the user
has already joined, and let the user join or accept invites from that list.

Definition of Done:

- [x] Workspace picker shows joined child rooms as openable.
- [x] Workspace picker shows invited child rooms with an accept action.
- [x] Workspace picker shows unjoined visible child rooms with a join action.
- [x] Workspace picker shows missing/inaccessible child rooms as disabled.
- [x] Joining or accepting a child room refreshes the picker and then allows
  opening the room.
- [x] Existing workspace activity tracking continues to watch joined rooms only.
- [x] `pnpm build` passes.
- [x] `git diff --check` passes.

Checklist:

- [x] Inspect current Space child room filtering.
- [x] Inspect workspace picker action flow.
- [x] Add child-room summary/status helper.
- [x] Extend workspace picker actions and rendering.
- [x] Wire join/accept actions in workspace controller.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

Verification Commands:

```sh
pnpm build
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget workspace "<joined-space-id>"
# Confirm joined, invited, joinable, and inaccessible child rooms render with status.
# Join/accept a child room and confirm the picker refreshes.
```

Current Status:

Implementation now loads Space children with hierarchy metadata where available,
renders status labels, and wires open/join/accept behavior. Local verification
passed:

- `pnpm build`
- `git diff --check`

Manual Matrix/cmux verification still requires a workspace with joined, invited,
joinable, and inaccessible child rooms.

## Follow-up: Workspace Invite Accept Sync

Goal: Accepting a workspace invite should not leave the invite pending or launch
a workspace controller before the Matrix session sees the Space as joined.

Definition of Done:

- [x] Workspace invite accept waits until the accepted Space membership is synced
  as `join`.
- [x] The cmux workspace controller is launched only after the join is visible.
- [x] The pending workspace invite should disappear from home after accept once
  sync completes.
- [x] `pnpm build` passes.
- [x] Working diff is reviewed for unrelated edits.

Checklist:

- [x] Inspect workspace invite accept flow.
- [x] Inspect workspace controller joined-space validation.
- [x] Add a narrow Matrix membership wait helper.
- [x] Use the helper in workspace invite accept.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

Verification Commands:

```sh
pnpm build
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget
# Accept a pending workspace invite from Home.
# Confirm the workspace picker opens without "Space ... is not joined".
# Return Home and confirm the invite no longer appears.
```

Current Status:

Implementation added a Matrix membership wait after `client.joinRoom(spaceId)`
and before launching cmux. Local verification passed:

- `pnpm build`
- `git diff --check`

Manual live Matrix/cmux verification still requires accepting a real pending
workspace invite.

## Goal

Implement the remaining `docs/demo-hardening-plan.md` stabilization work without
redoing the already-completed thread, workspace reuse, DM, and invite changes in
this worktree.

## Definition of Done

- [x] `./nugget --help` lists implemented CLI commands only.
- [x] Room slash help lists commands that work in room mode.
- [x] Thread slash help lists commands that work in thread mode.
- [x] Unknown CLI and slash commands fail locally without sending Matrix text.
- [x] Ctrl-C and quit flows restore raw terminal mode in pickers and chat views.
- [x] Pickers redraw on terminal resize.
- [x] Pickers and chat views stay readable in narrow terminals and with wide text.
- [x] Matrix and cmux failures include action context without leaking session tokens.
- [x] Agent-specific hardening is explicitly skipped because the current source
  has no implemented `@agent` or `/ask` command path.
- [x] `docs/demo-script.md` exists and matches current commands.
- [x] Credential-free smoke script exists.
- [x] `pnpm build` passes.
- [x] Smoke commands run where practical.

## Checklist

- [x] Audit current CLI/slash command surface.
- [x] Add or reuse terminal display helpers for picker layout.
- [x] Add resize handlers and idempotent cleanup to pickers.
- [x] Align room/thread slash help with implemented behavior.
- [x] Improve high-risk Matrix/cmux error messages.
- [x] Create `docs/demo-script.md`.
- [x] Create credential-free `scripts/smoke.sh`.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
./nugget --help
./nugget logout
./scripts/smoke.sh
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget login
./nugget
./nugget workspace "<joined-space-id>"
```

## Current Status

Implementation and local verification are complete. Existing completed
thread/workspace/DM/invite work was preserved and skipped. `docs/` and
`TASKS.md` are ignored by this repo's `.gitignore`, so their changes exist in
the workspace but do not appear in `git status`.

Verification passed:

- `pnpm build`
- `./nugget --help`
- `./nugget logout` with escalated filesystem access for the local session file
- `./scripts/smoke.sh` with escalated filesystem access for logout
- `./nugget nope`
- `git diff --check`
- Self-review follow-up:
  - cmux missing-binary errors now hit the actionable fallback path.
  - Error redaction now covers `loginToken`, `accessToken`, and `refreshToken`.
  - Local checks passed for cmux `ENOENT` fallback and redaction.

Not run:

- Live Matrix/cmux demo path.

# Notifications And Activity

## Goal

Implement `docs/notifications-activity-plan.md` so incoming Matrix activity is
visible in room/thread chat and workspace pickers without stealing terminal
focus or corrupting composer input.

## Definition of Done

- [ ] Incoming messages preserve composer input and cursor position.
- [ ] Bottom-pinned room/thread views render incoming messages normally.
- [ ] Scrolled-up room/thread views do not force-scroll to the bottom.
- [ ] Scrolled-up room/thread views show a "new messages below" marker.
- [ ] Jumping or scrolling to bottom clears the new-message marker.
- [ ] Messages authored by the local user do not trigger external notifications.
- [ ] Duplicate events do not trigger duplicate notifications.
- [ ] Hidden main-room thread replies do not trigger main-room notifications.
- [ ] Thread views receive only matching thread events.
- [ ] Thread replies update main-room reply badges where local data permits.
- [ ] Workspace picker marks rooms with new activity while running.
- [ ] Opening/focusing a room clears its workspace picker activity mark.
- [ ] cmux notification failures do not interrupt chat or picker flows.
- [x] `pnpm build` passes.
- [x] `./nugget --help` still works.

## Checklist

- [x] Read `docs/notifications-activity-plan.md`.
- [x] Inspect chat view, workspace picker, cmux client, room helpers, and CLI wiring.
- [x] Add best-effort cmux notification helper.
- [x] Add chat view bottom/new-message marker handling.
- [x] Add chat notification filtering and summary formatting.
- [x] Add workspace picker activity tracking and clearing.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
./nugget --help
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget login
./nugget workspace "<joined-space-id>"
```

## Current Status

Code implementation is complete with local verification:

- `pnpm build`
- `./nugget --help`
- `git diff --check`

Not run:

- Live Matrix/cmux checks for incoming messages, picker activity, and cmux
  notification delivery.

# Matrix Thread Support

## Goal

Implement the `docs/thread-plan.md` phase: Nugget can select room messages,
open Matrix thread panes in cmux, load thread-only timelines, send thread
replies, and keep normal room timelines readable.

## Definition of Done

- [x] `/select` enters message selection mode in a normal room view.
- [x] Selection mode highlights one selectable message at a time.
- [x] Up/down movement changes the selected message.
- [x] Enter opens the selected message's thread.
- [x] Escape exits selection mode without opening a thread.
- [x] Selecting a thread reply resolves back to its thread root event ID.
- [x] `./nugget thread <roomId> <threadRootEventId>` opens a thread-only chat view.
- [x] Room views open thread panes beside the current cmux surface.
- [x] Opening the same thread again focuses the existing thread pane.
- [x] Thread view loads events with Matrix relations instead of full room history.
- [x] Thread view sends replies with `m.relates_to.rel_type = m.thread`.
- [x] Thread replies render immediately with a local pending event.
- [x] Main room timeline hides thread reply events.
- [x] Root messages show reply count badges where local events provide enough data.
- [x] `pnpm build` passes.
- [x] Existing room chat and cmux workspace flows still work at build/API level.

## Checklist

- [x] Read `docs/thread-plan.md`.
- [x] Inspect current CLI, chat view, Matrix client, and cmux controller code.
- [x] Add Matrix thread relation helpers.
- [x] Add thread pane cmux helper.
- [x] Add `thread` CLI command and help text.
- [x] Add `openThreadView()` and thread-only chat behavior.
- [x] Add `/select` mode, selection rendering, and thread root resolution.
- [x] Add main-room thread filtering and local reply count badges.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
./nugget --help
git diff --check
```

Manual verification requiring a Matrix account and cmux:

```sh
./nugget login
./nugget workspace "<joined-space-id>"
./nugget thread "<room-id>" "<root-event-id>"
```

## Current Status

Implementation is complete and local verification passed:

- `pnpm build`
- `./nugget --help`
- `git diff --check`

Not run:

- Live Matrix/cmux checks, because they require a joined Matrix room and active
  cmux workspace.

## Follow-up: Unique DMs

Goal: Creating a DM with a user should reuse an existing joined DM with that
user instead of creating duplicate rooms and invites.

Definition of Done:

- [x] Existing joined DMs are detected from local direct chat metadata.
- [x] `create-dm <userId>` opens the existing joined DM when present.
- [x] `create-dm <userId>` creates and invites only when no joined DM exists.
- [x] Pending DM invites without `is_direct` continue to appear on home.
- [x] Pending invites from users with an existing joined DM are hidden on home.
- [x] `pnpm build` passes.

Current status:

- Current Matrix session `@namho-hong:matrix.org` has three joined DMs and
  three pending invites involving `@dan-hong:matrix.org`.
- `findJoinedDirectRoomForUser(client, "@dan-hong:matrix.org")` resolves the
  latest joined DM `!FhnwcwDUFPxvqYjyzA:matrix.org`.
- Home filters pending DM invites from users already present in joined DMs.
- `pnpm build` and `git diff --check` pass.

## Follow-up: Workspace Picker Stability

Goal: Selecting a workspace from Nugget home should switch to the cmux workspace
and leave the workspace room picker visible.

Definition of Done:

- [x] Compare current workspace launch flow against `/Users/dan/nugget`.
- [x] Existing room panes are not reused as the workspace picker surface.
- [x] Existing controller surface is respawned when selecting a workspace.
- [x] Existing workspaces with only a shell surface reuse that shell as picker.
- [x] Existing workspaces with room panes create a separate picker split.
- [x] `./nugget workspace "<spaceId>"` leaves the cmux workspace selected.
- [x] Workspace picker remains visible instead of dropping back to the shell.
- [x] `pnpm build` passes.
- [x] `git diff --check` passes.

Current status:

- OFFLIGHT workspace `workspace:30` opens to `surface:182`.
- `cmux tree --json --all` reports `selected_workspace_ref: workspace:30`.
- `cmux read-screen --workspace workspace:30 --surface surface:182` shows the
  `Workspace: OFFLIGHT` room picker.

## Follow-up: Already-Open Workspace Reuse

Goal: Running `./nugget workspace "<spaceId>"` when the same Nugget workspace is
already open in cmux should select and reuse that workspace instead of creating a
new terminal that immediately exits or appears to do nothing.

Definition of Done:

- [x] Existing Nugget workspaces are detected by stable `nugget-space:<spaceId>`
  description.
- [x] Duplicate candidate workspaces prefer the exact space description and an
  existing matching workspace-controller surface.
- [x] Existing workspaces with only room panes can create a picker split and
  resolve its pane from a refreshed cmux tree.
- [x] Workspace selection activates cmux app focus before selecting, because
  inactive focus can make `select-workspace` return OK without changing the
  selected workspace.
- [x] cmux control commands clear caller-only `CMUX_WORKSPACE_ID`,
  `CMUX_SURFACE_ID`, `CMUX_TAB_ID`, and pane/panel env vars before spawning
  cmux so explicit workspace refs are not overridden by the launching terminal.
- [x] Already-visible workspace picker surfaces are reused without respawning.
- [x] `./nugget workspace "<spaceId>"` reuses the already-open workspace in a
  live cmux session.
- [x] `pnpm build` passes.
- [x] `git diff --check` passes.

Current status:

- Code path updated.
- Manual `cmux set-app-focus active` + `cmux select-workspace --workspace
  workspace:37` confirmed that app focus was the missing cmux condition.
- `pnpm build` and `git diff --check` pass.
- Live verification passed for OFFLIGHT:
  `./nugget workspace '!BzZtZEJPYExMbDngnK:matrix.org'` selected existing
  `workspace:37` and showed the workspace picker on `surface:195`.

## Follow-up: Workspace Invites

Goal: After opening a workspace menu, Nugget should allow inviting a Matrix user
to the selected workspace, and recipients should see and accept/reject workspace
invites from home.

Definition of Done:

- [x] Workspace room picker includes an invite action.
- [x] Invite action prompts for a Matrix user ID without breaking terminal raw
  mode.
- [x] `/home` and `/quit` still work from invite prompt.
- [x] Valid invite sends a Matrix invite to the selected Space room.
- [x] Invite success and failure messages are shown in the workspace picker.
- [x] Home shows pending workspace invites separately from DM invites.
- [x] Workspace invite detail screen shows inviter and Space ID.
- [x] Accepting a workspace invite joins the Space and opens it in cmux.
- [x] Rejecting a workspace invite leaves/rejects the invite.
- [x] `pnpm build` passes.
- [x] `git diff --check` passes.

Checklist:

- [x] Inspect current workspace picker and CLI controller flow.
- [x] Inspect current DM invite and Space summary helpers.
- [x] Add invite action and prompt handling to `runSpaceRoomPicker`.
- [x] Wire workspace-controller invite callback to `client.invite`.
- [x] Add pending Space invite detection.
- [x] Add home UI actions for workspace invite accept/reject.
- [x] Wire CLI handlers for workspace invite accept/reject.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

Verification Commands:

```sh
pnpm build
git diff --check
```

Manual verification requiring a Matrix account and cmux:

```sh
./nugget workspace "<joined-space-id>"
```

Current status:

- Workspace picker and controller flow inspected.
- DM invite handling and Space summary helpers inspected.
- Code path updated.
- `pnpm build` passes.
- `git diff --check` passes.
- Diff reviewed. This follow-up changed workspace invite paths in `src/cli.ts`,
  `src/matrix/spaces.ts`, `src/ui/home-menu.ts`, and
  `src/ui/space-room-picker.ts`; other dirty files are pre-existing thread and
  cmux work from the current worktree.

## Follow-up: Active Workspace Reentry

Goal: Selecting a Nugget workspace should keep the current terminal surface,
rename the current cmux workspace, and show the workspace picker inline without
creating a new cmux workspace, pane, or terminal.

Definition of Done:

- [x] Current cmux workspace/surface context is detected before launching.
- [x] Initial cmux tree lookup preserves caller env for accurate reentry
  detection.
- [x] Picker surface creation avoids reusing the current CLI surface.
- [x] Existing controller-surface reuse avoids respawning stale controller
  surfaces unless the picker is visibly running.
- [x] Selecting the current cmux workspace runs the workspace picker inline
  instead of creating another split and leaving the Home surface at a shell.
- [x] Workspace open no longer creates cmux workspaces, creates picker splits,
  or respawns a separate workspace-controller pane.
- [x] Already-selected cmux workspaces skip redundant `select-workspace`.
- [x] Picker focus is best-effort after controller startup.
- [x] `pnpm build` passes.
- [x] `git diff --check` passes.
- [x] Working diff is reviewed for unrelated edits.

Checklist:

- [x] Inspect current workspace launch and cmux client flow.
- [x] Compare with `/Users/dan/nugget` workspace launch behavior.
- [x] Implement active workspace reentry guard.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

Verification Commands:

```sh
pnpm build
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget workspace "<joined-space-id>"
# Run once from another workspace, then again while that cmux workspace is active.
```

Current status:

- Code path updated in `src/cli.ts` and `src/cmux/workspace-controller.ts`.
- Initial `cmux tree --json --all` now preserves caller env so active
  workspace reentry can identify the launching surface before later cmux control
  commands clear caller-only env vars.
- Home/workspace selection now switches to the workspace picker in the current
  process when the selected Space already matches the current cmux workspace.
- Workspace open now renames the current cmux workspace to `nugget: <workspace>`
  and does not create a new cmux workspace or picker pane.
- `pnpm build` passes.
- `git diff --check` passes.
- Manual live Matrix/cmux reentry verification still requires selecting a real
  joined Space from inside its active cmux workspace.

## Follow-up: Workspace Controller Join Visibility

Goal: A newly launched workspace controller should tolerate Matrix sync lag
after accepting a Space invite instead of immediately failing that the Space is
not joined.

Definition of Done:

- [x] Workspace controller waits briefly for the target Space to become visible
  as a joined Space before validating child rooms.
- [x] Direct `nugget workspace <spaceId>` launch uses the same joined-Space
  visibility guard.
- [x] Existing workspace invite accept flow still records and launches the
  accepted workspace.
- [x] `pnpm build` passes.
- [x] Working diff is reviewed for unrelated edits.

Checklist:

- [x] Inspect workspace invite accept and controller launch flow.
- [x] Identify the remaining race in the fresh controller process.
- [x] Add a narrow joined-Space visibility wait helper.
- [x] Use the helper in workspace launch/controller paths.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

Verification Commands:

```sh
pnpm build
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
# Accept a workspace invite, then confirm the spawned workspace-controller
# opens the picker instead of printing "Space ... is not joined".
./nugget
```

Current status:

- Added `waitForJoinedSpace` and wired it into direct workspace open, workspace
  invite accept, and workspace-controller startup.
- `pnpm build` passes.
- `git diff --check` passes.
- Diff reviewed. This follow-up changed `src/cli.ts`, `src/matrix/spaces.ts`,
  and `TASKS.md`; `src/cmux/workspace-controller.ts` was already dirty before
  this follow-up.

## Follow-up: DM Pane Opening

Goal: Opening or accepting a DM from the home TUI should keep the home menu in
the current/left pane and open the DM chat in a right-side cmux pane, reusing an
existing DM pane with new surfaces when available.

Definition of Done:

- [x] Home-opened joined DMs launch in a cmux room surface outside the current
  menu pane when cmux context is available.
- [x] Accepted DM invites launch the joined room outside the current menu pane
  when cmux context is available.
- [x] Newly created DMs use the same cmux launch behavior.
- [x] If a DM pane already exists, additional DMs open as new surfaces in that
  pane instead of creating another split.
- [x] Home DM labels mark DMs already open in the current cmux workspace.
- [x] Non-cmux usage still opens the chat view inline.
- [x] `pnpm build` passes.
- [x] Working diff is reviewed for unrelated edits.

Checklist:

- [x] Inspect current DM open/create/accept flows.
- [x] Inspect cmux split/surface helpers and workspace room behavior.
- [x] Add a narrow cmux helper for opening DM rooms beside the current surface.
- [x] Wire home DM open/create/accept flows to use the helper with inline
  fallback outside cmux.
- [x] Add home-menu open-DM marker support.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

Verification Commands:

```sh
pnpm build
git diff --check
```

Manual verification requiring cmux and Matrix account:

```sh
./nugget
# Open a DM from Home; confirm the Home menu remains in the original pane and
# the DM opens in a right pane.
# Open another DM; confirm it appears as a new surface in the existing DM pane.
# Confirm already-open DMs are marked in the Home DM list.
```

Current status:

- Added cmux DM room launching via `openDirectRoomBesideCurrentSurface`.
- Home open, DM invite accept, and new DM creation now use that launcher when a
  cmux context is present, then return to Home in the original surface.
- Existing DM panes are reused with `cmux new-surface`; first opens create a
  right split.
- Home DM labels now mark open DMs with `*`.
- `pnpm build` passes.
- `git diff --check` passes.
- Diff reviewed. This follow-up changed `src/cmux/dm-controller.ts`,
  `src/cmux/index.ts`, `src/ui/home-menu.ts`, part of `src/cli.ts`, and this
  section of `TASKS.md`; other dirty hunks in `src/cli.ts`, `src/matrix/rooms.ts`,
  `src/cmux/workspace-controller.ts`, and earlier `TASKS.md` sections were
  already present or unrelated.

## Follow-up: Workspace Invite Name Preservation

Goal: Accepting or opening an invited Matrix Space should preserve the explicit
workspace name in Nugget and cmux instead of creating cmux workspaces from
Matrix SDK member-name fallbacks.

Definition of Done:

- [x] Space summaries prefer explicit `m.room.name` state over SDK fallback
  display names.
- [x] Workspace invite accept uses the invite's explicit name if join sync has
  not yet populated the joined room name.
- [x] cmux workspace launch updates legacy or fallback Nugget workspace titles
  to the explicit workspace name when possible.
- [x] `pnpm build` passes.
- [x] `git diff --check` passes.
- [x] Working diff is reviewed for unrelated edits.

Checklist:

- [x] Inspect Matrix Space summary and invite accept paths.
- [x] Inspect cmux workspace creation/reuse logic.
- [x] Add explicit Space name resolution.
- [x] Use explicit Space names in home/open/accept flows.
- [x] Add cmux workspace title repair support.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

Verification Commands:

```sh
pnpm build
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget
# Accept a pending workspace invite.
# Confirm cmux shows "nugget: <actual workspace name>".
```

Current Status:

Investigation found that Space paths use `getRoomDisplayName()` / `room.name`,
which can fall back to member-derived Matrix SDK names during invite/join sync.
Patch is complete with local verification:

- `pnpm build`
- `git diff --check`

Manual live Matrix/cmux verification still requires accepting a real pending
workspace invite.

# Tests And Verification Harness

Goal: Implement `docs/tests-verification-plan.md` so Nugget has
credential-free tests and smoke checks for parser, Matrix event, cmux tree,
session/app-state, and terminal formatting behavior.

Definition of Done:

- [x] `pnpm test` runs credential-free tests.
- [x] `pnpm build` passes.
- [x] `pnpm smoke` runs credential-free smoke checks.
- [x] Agent mention parser has unit coverage.
- [x] Slash parser has coverage for implemented commands and `/ask` syntax.
- [x] Matrix thread/relation helper behavior has fixture coverage.
- [x] Room/Space/DM classification has coverage where pure enough.
- [x] cmux tree parser and stale surface decision helpers have coverage.
- [x] Session/app-state validation has malformed and missing-field coverage.
- [x] Terminal sanitization/width helpers have coverage.
- [x] Manual verification docs separate no-credential, Matrix, cmux, and agent
  checks.
- [x] Tests do not require Matrix credentials, cmux, browser SSO, or agent CLIs.
- [x] Working diff is reviewed for accidental unrelated edits.

Checklist:

- [x] Read `docs/tests-verification-plan.md`.
- [x] Inspect existing parser, Matrix, cmux, store, terminal, and smoke code.
- [x] Choose test runner and add scripts.
- [x] Add fixtures directory.
- [x] Add or extract pure parser helpers.
- [x] Add agent mention parser tests.
- [x] Add slash parser tests.
- [x] Add Matrix event/thread helper tests.
- [x] Add room/Space/DM classification tests where practical.
- [x] Add cmux tree parser/stale decision tests.
- [x] Add session/app-state validation tests.
- [x] Add terminal formatting/sanitization tests.
- [x] Update manual verification docs.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

Verification Commands:

```sh
pnpm build
pnpm test
pnpm smoke
git diff --check
```

Manual verification requiring Matrix account, cmux, or agent CLIs:

```sh
./nugget login
./nugget
./nugget workspace "<joined-space-id>"
```

Current status:

Implementation is complete with local verification:

- `pnpm build`
- `pnpm test`
- `git diff --check`

Diff review found pre-existing/shared edits in `TASKS.md`, `src/cli.ts`, cmux,
chat, workspace picker, and related tests. They were left intact.
- `pnpm smoke`
- `git diff --check`

The smoke script now runs Nugget commands with a temporary `HOME` so logout and
state reset checks do not touch the user's real Matrix session files.

Manual live Matrix/cmux/agent verification remains separate because automated
tests intentionally do not require credentials, cmux, browser SSO, or agent
CLIs.

# Joined Room Reopen Sync Gap

Goal: Make `nugget room <roomId>` reopen a room that was already joined from a
workspace, even when a new CLI process starts before the room is visible in the
local Matrix sync store.

Definition of Done:

- [x] Direct room open waits for an already-joined room to become visible in
  local sync before opening chat.
- [x] Thread, send, and invite direct room-id flows use the same joined-room
  visibility check where appropriate.
- [x] Missing/not-joined rooms still produce actionable errors.
- [x] `pnpm build` passes.
- [x] Working diff is reviewed for accidental unrelated edits.

Checklist:

- [x] Inspect `room` command and Matrix room resolution flow.
- [x] Confirm existing workspace/cmux changes in the worktree are unrelated and
  should be preserved.
- [x] Add async joined-room resolution helper.
- [x] Wire direct room-id commands through the helper.
- [x] Run verification commands.
- [x] Review working diff.

Verification Commands:

```sh
pnpm build
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
CMUX_WORKSPACE_ID='workspace:6' CMUX_SURFACE_ID='surface:17' ./nugget room '<joined-room-id>'
```

Current status:

Implemented `waitForJoinedRoom`, which verifies server-side membership when a
room is missing from local sync, then waits for the room to arrive before
opening. `room`, `thread`, `send`, and `invite` now use that async joined-room
check before operating on direct room IDs.

Verification run:

- `pnpm build`
- `pnpm test`
- `git diff --check`

Diff review notes:

- This fix intentionally changes `src/matrix/rooms.ts`, direct room-id command
  call sites in `src/cli.ts`, and this `TASKS.md` section.
- Existing in-progress cmux/DM changes in `src/cli.ts`, `src/cmux/*`, and
  `src/ui/home-menu.ts` are preserved.

# Workspace Room Pane Surface Reuse

Goal: Opening another room from a Nugget workspace should reuse the existing room
pane by adding a new cmux surface instead of creating another pane when a room
pane is already present.

Definition of Done:

- [x] First room opened from a workspace still creates a right-side room pane.
- [x] Additional workspace rooms open as new surfaces in the existing room pane.
- [x] Reopening the same room still focuses/reuses its existing surface when it
  can be respawned and focused.
- [x] `pnpm build` passes.
- [x] Relevant tests pass.
- [x] Working diff is reviewed for accidental unrelated edits.

Checklist:

- [x] Inspect workspace room open and cmux surface helpers.
- [x] Compare existing DM pane surface reuse behavior.
- [x] Update workspace room opening to prefer `cmux new-surface` on an existing
  room pane.
- [x] Add focused coverage for room pane selection behavior.
- [x] Run verification commands.
- [x] Review working diff.

Verification Commands:

```sh
pnpm build
pnpm test
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget workspace "<joined-space-id>"
# Open one workspace room, then another; confirm the second appears as a new
# surface in the existing room pane instead of creating another pane.
```

Current status:

Implementation is complete at build/test level. `WorkspaceController` now uses
`new-surface` when a non-picker room pane already exists, while the first room
still creates the initial right-side split.

Verification run:

- `pnpm build`
- `pnpm test`

Diff review notes:

- This change intentionally updates `src/cmux/workspace-controller.ts`,
  `tests/cmux-tree.test.ts`, and this `TASKS.md` section.
- The `renameCurrentWorkspace` hunk in `src/cmux/workspace-controller.ts`,
  `src/cli.ts`, `src/cmux/dm-controller.ts`, and the later DM cmux
  stale-context `TASKS.md` section are separate worktree changes and were left
  intact.

# DM cmux Stale Context

Goal: Opening a DM from Home should not fail when caller-only cmux environment
variables contain a stale workspace ID that is no longer present in `cmux tree`.

Definition of Done:

- [x] DM cmux context selection prefers valid `cmux tree` caller/active refs.
- [x] Stale `CMUX_WORKSPACE_ID` values are ignored unless they resolve to a
  workspace and surface in the current tree.
- [x] If no valid cmux context is available, DM opening falls back to inline chat
  instead of throwing `cmux workspace ... was not found`.
- [x] `pnpm build` passes.
- [x] Working diff is reviewed for accidental unrelated edits.

Checklist:

- [x] Inspect DM cmux context selection.
- [x] Compare with the earlier workspace caller-context issue.
- [x] Validate cmux context candidates against the current tree.
- [x] Run verification commands.
- [x] Review working diff.

Verification Commands:

```sh
pnpm build
git diff --check
```

Current status:

Updated `currentCmuxContext` to try `tree.caller`, then `tree.active`, then
environment variables, and to accept a candidate only when both its workspace
and surface exist in the current `cmux tree`. Local verification passed:

- `pnpm build`
- `git diff --check`

# cmux Workspace Title Sync

Goal: The current cmux workspace title should follow Nugget's active screen:
Home, a selected Matrix workspace, or a selected DM/chat.

Definition of Done:

- [x] Entering Home renames the current cmux workspace to `nugget: Home`.
- [x] Opening a Matrix workspace renames the current cmux workspace to that
  workspace name.
- [x] Opening a DM or room chat renames the current cmux workspace to that
  room's display name.
- [x] Title updates are best-effort and do not break non-cmux terminal flows.
- [x] `pnpm build` passes.
- [x] `git diff --check` passes.

Checklist:

- [x] Inspect Home, workspace, and DM/chat transition paths.
- [x] Add shared current-workspace rename helper.
- [x] Wire title updates into Home and DM/chat entry paths.
- [x] Run verification commands.
- [x] Review working diff.

Verification Commands:

```sh
pnpm build
git diff --check
```

Current status:

Implemented title sync for Home and DM/chat paths. Existing workspace title sync
now uses the same `renameCurrentWorkspace` helper. Local verification passed:

- `pnpm build`
- `git diff --check`

# cmux Message Notification Payload

Goal: Matrix message notifications sent through cmux should use the sender as
the notification title and the message text as the body/description, while
documenting why macOS native notifications may not appear when cmux is focused.

Definition of Done:

- [x] Chat view message notifications use sender title and message body.
- [x] Workspace picker activity notifications use sender title and message body.
- [x] cmux notification behavior is investigated with local cmux commands.
- [x] `pnpm build` passes.
- [x] Working diff is reviewed for unrelated edits.

Checklist:

- [x] Inspect current chat and workspace notification call sites.
- [x] Inspect cmux notify command behavior and live notification queue.
- [x] Update notification payload formatting.
- [x] Run verification commands.
- [x] Review working diff.

Verification Commands:

```sh
pnpm build
git diff --check
```

Current status:

Investigation found Nugget sends notifications via `cmux notify`; diagnostic
notifications appear in `cmux list-notifications`. Native macOS delivery appears
to be governed by cmux focus/notification routing outside Nugget's payload code.
Local verification passed:

- `pnpm build`
- `git diff --check`

Diff review notes:

- This change intentionally updates the notification payloads in `src/cli.ts`,
  `src/ui/chat-view.ts`, and this `TASKS.md` section.
- Existing concurrent sender-color rendering changes in `src/ui/chat-view.ts`
  were left intact.

# cmux Notification Surface Targeting

Goal: Message notifications should use the sender as the title, the message as
the body, and cmux should flash the surface that owns the relevant room/thread
instead of whichever pane is currently active.

Definition of Done:

- [x] Notification title is always the sender display name.
- [x] Notification body is the message text without a sender prefix.
- [x] Room chat notifications target the current room surface.
- [x] Thread chat notifications target the current thread surface.
- [x] Workspace picker activity notifications target the open room surface when
  Nugget knows one, with a deterministic fallback.
- [x] `pnpm build` passes.
- [x] Working diff is reviewed for unrelated edits.

Checklist:

- [x] Inspect current notification payload and cmux target handling.
- [x] Identify missing `--workspace/--surface` as likely random flash cause.
- [x] Add explicit notification target support to `CmuxClient`.
- [x] Add workspace room notification target lookup.
- [x] Wire notification targets at chat and workspace call sites.
- [x] Run verification commands.
- [x] Review working diff.

Verification Commands:

```sh
pnpm build
git diff --check
```

Current status:

Investigation found `CmuxClient.run()` strips caller cmux environment variables
by default, while `notify()` did not pass `--workspace` or `--surface`. That lets
cmux choose a default target from active/focused state, which explains the
observed border flash on the wrong pane.
Implemented explicit cmux notification targeting and verified locally:

- `pnpm build`
- `pnpm test`
- `git diff --check`

Diff review notes:

- This change intentionally updates `src/cmux/client.ts`,
  `src/cmux/workspace-controller.ts`, `src/cli.ts`, `tests/cmux-tree.test.ts`,
  and this `TASKS.md` section.
- Existing in-progress agent mention work in `src/agent/`,
  `src/cmux/agent-controller.ts`, `src/cmux/index.ts`, `src/ui/chat-commands.ts`,
  and `src/ui/chat-view.ts` was left intact.

# Agent Mention Pane Flow

Goal: Make local `@codex`, `@claude`, and `@hermes` chat composer mentions
start a right-side cmux agent pane instead of being treated only as plain chat.

Definition of Done:

- [x] Chat view handles supported `@agent <request>` mentions.
- [x] Empty `@agent` prompts show usage and do not send a Matrix message.
- [x] `@agent <request>` sends the typed message to Matrix before starting the
  local agent.
- [x] Agent pane startup receives room/thread context and recent messages.
- [x] cmux opens/focuses a right-side agent surface with a prompt file.
- [x] `pnpm build` passes.
- [x] Working diff is reviewed for unrelated edits.

Checklist:

- [x] Inspect existing chat composer, parser tests, docs, and cmux controllers.
- [x] Add agent prompt/command helpers.
- [x] Add cmux agent pane controller.
- [x] Wire chat view `@agent` handling and CLI callbacks.
- [x] Run verification commands.
- [x] Review working diff.

Verification Commands:

```sh
pnpm build
git diff --check
```

Manual verification requiring Matrix account, cmux, and an installed agent CLI:

```sh
./nugget workspace "<joined-space-id>"
# Open a room and type: @codex summarize this room
# Confirm a right-side agent pane opens and receives prompt context.
```

Current status:

Implementation is complete at local verification level. Investigation found
`parseAgentMention()` and parser tests existed, but `src/ui/chat-view.ts` never
called the parser and there was no agent pane controller.

Added:

- Shared agent request, prompt file, and command helpers under `src/agent/`.
- `openAgentBesideCurrentSurface()` cmux controller for right-side agent panes.
- Chat view `@agent` handling and CLI callbacks for room/thread views.

Verification passed:

- `pnpm build`
- `pnpm test`
- `git diff --check`

Manual live Matrix/cmux verification still requires a Matrix account, running
cmux workspace, and installed Codex/Claude/Hermes CLI.

# Shared Thread Agent Pane

Goal: Thread views and `@agent` sessions should share one right-side cmux pane,
adding new surfaces in that pane instead of creating a new pane for every
thread or agent session.

Definition of Done:

- [x] Opening the first thread creates a right-side shared pane when needed.
- [x] Opening another thread adds a surface to the existing shared pane.
- [x] Starting the first `@agent` session creates/reuses the shared pane.
- [x] Starting another `@agent` session adds a surface to the existing shared
  pane.
- [x] Thread and agent sessions can reuse each other's pane.
- [x] Exact existing thread surfaces are still focused instead of duplicated.
- [x] `pnpm build` passes.
- [x] `pnpm test` passes.
- [x] Working diff is reviewed for unrelated edits.

Checklist:

- [x] Inspect thread and agent cmux controllers.
- [x] Add shared sidecar pane detection and surface creation.
- [x] Wire thread controller to add surfaces in the shared pane.
- [x] Wire agent controller to use the same shared pane.
- [x] Run verification commands.
- [x] Review working diff.

Verification Commands:

```sh
pnpm build
pnpm test
git diff --check
```

Manual verification requiring Matrix account and cmux:

```sh
./nugget workspace "<joined-space-id>"
# Open two different threads from a room; confirm one right-side pane with two surfaces.
# Start @codex from a room/thread; confirm it appears as another surface in that same pane.
```

Current status:

Implementation is complete at local verification level. `src/cmux/sidecar-pane.ts`
now centralizes shared thread/agent pane detection and surface creation.
`openThreadBesideCurrentSurface()` and `openAgentBesideCurrentSurface()` both
use that helper, so the first session creates a right-side pane and subsequent
thread/agent sessions add surfaces to that pane. Exact existing thread surfaces
are still focused instead of duplicated.

Verification passed:

- `pnpm build`
- `pnpm test`
- `git diff --check`

Manual live Matrix/cmux verification still requires a Matrix account and a
running cmux workspace.

# Home And Workspace UI Polish

Goal: Home and workspace-level terminal screens should feel more structured and
less empty while remaining readable in narrow terminals.

Definition of Done:

- [x] Home menu has a stronger header, section framing, visible selection state,
  and concise empty states.
- [x] Workspace room picker uses the same visual language for rooms, status, and
  actions.
- [x] General room picker remains consistent with the updated picker style.
- [x] Narrow terminal widths still truncate labels cleanly.
- [x] `pnpm build` passes.
- [x] Working diff is reviewed for unrelated edits.

Checklist:

- [x] Inspect existing home, workspace, room picker, and terminal formatting code.
- [x] Add scoped terminal picker formatting helpers.
- [x] Update home menu rendering.
- [x] Update workspace and room picker rendering.
- [x] Run verification commands.
- [x] Review working diff.

Verification Commands:

```sh
pnpm build
pnpm test
git diff --check
```

Current status:

Implementation is complete at local verification level. Added shared picker
rendering helpers and applied them to Home, workspace room picker, and the
general room picker. The updated screens now have a stronger header, compact
section labels, bracketed tags, inverse selected rows, summary lines, and
consistent footer hints while preserving narrow-terminal truncation.

Verification passed:

- `pnpm build`
- `pnpm test`
- `git diff --check`

Manual live visual verification still requires opening Nugget against a Matrix
session.

# DM Invite Visibility

## Goal

Make DM invites visible when one side already has older DM room state.

## Definition of Done

- [x] Existing local DM reuse re-invites the target when they are not already
  joined or invited.
- [x] Home shows pending DM invites even when the inviter already has a joined
  DM with the current account.
- [x] Focused tests cover the invite visibility and re-invite behavior.
- [x] `pnpm build` passes.
- [x] Relevant tests pass.
- [x] Working diff is reviewed for unrelated edits.

## Checklist

- [x] Inspect DM create, pending invite detection, and home filtering paths.
- [x] Update DM create reuse to send a re-invite when needed.
- [x] Stop hiding pending DM invites solely because a joined DM exists.
- [x] Add focused tests.
- [x] Run verification commands.
- [x] Review working diff for accidental unrelated edits.

## Verification Commands

```sh
pnpm build
pnpm test
git diff --check
```

Manual verification requiring two Matrix accounts:

```sh
./nugget create-dm "@other:server"
# From the other account, confirm Home shows a pending DM invite.
```

## Current Status

Implementation is complete at build and test level. `createDirectRoom()` now
re-invites the target when it reuses an existing local DM and the target is not
joined or already invited. Home no longer filters out pending DM invites only
because the inviter already has a joined DM with the current account.

Verification passed:

- `pnpm build`
- `pnpm test`
- `git diff --check`

Diff review found pre-existing/shared edits in `TASKS.md`, `src/cli.ts`, cmux,
chat, workspace picker, and related tests. They were left intact.
