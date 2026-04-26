# Join Leave And Invite UX Implementation Plan

## Goal

Implement Nugget's Matrix membership workflows so users can join rooms, leave
rooms, invite people, and recover from common membership states without needing
external Matrix clients for basic room access.

This phase starts after `docs/notifications-activity-plan.md` is complete.

## Scope

Implement:

- Join public room by alias.
- Join room by room ID where supported by the homeserver.
- Leave a room from chat or CLI.
- Invite a Matrix user from chat and optional CLI.
- Basic invited-room visibility in the home flow if practical.
- Clear membership-state errors for joined, invited, left, banned, and unknown
  rooms.

Do not implement full moderation, room directory search, knock flows, bans,
kicks, power-level editing, or invite inbox polish in this phase.

## Context

Reference docs:

- `docs/matrix-implementation-guide.md`
- `docs/room-chat-plan.md`
- `docs/cmux-workspace-plan.md`
- `docs/demo-hardening-plan.md`

Known gap from the Matrix guide:

```text
Current implementation can observe joined rooms and create rooms, but it does
not currently expose an explicit "join room by ID or alias" flow.
```

Missing primitives called out there:

- `joinRoom(roomIdOrAlias)`
- `leaveRoom(roomId)`

Expected source boundaries:

- `src/matrix/membership.ts` owns join/leave/invite helpers.
- `src/matrix/rooms.ts` owns membership state lookup and room display helpers.
- `src/ui/chat-view.ts` owns slash commands such as `/invite` and `/leave`.
- `src/ui/home-menu.ts` may show invited rooms if this phase includes that.
- `src/cli.ts` owns CLI commands for join/leave/invite.

Current implementation status before this phase:

- Home already shows pending DM and workspace invites.
- Home already supports accepting and rejecting pending DM and workspace invites.
- `src/matrix/client.ts` already provides `waitForRoomMembership()`.
- Chat already supports `/invite @user:server`, but it calls `client.invite()`
  directly instead of a shared helper.
- Explicit CLI `join`, `leave`, and `invite` commands are not implemented yet.
- Chat `/leave` is not implemented yet.

## Definition Of Done

- [x] `./nugget join <roomIdOrAlias>` joins a room when the homeserver allows it.
- [x] `./nugget leave <roomId>` leaves a joined room after confirmation or clear
  prompt behavior.
- [x] `./nugget invite <roomId> <userId>` invites a Matrix user to a room.
- [x] `/invite @user:server` still works from room chat.
- [x] `/leave` works from room chat and exits the chat view after a successful
  leave.
- [x] Joining by alias resolves or reports clear failure.
- [x] Joining by room ID reports clear failure if the server requires extra
  routing or does not allow the join.
- [x] Leaving a room updates the home/workspace lists after sync.
- [x] Inviting a user reports success or the Matrix error reason.
- [x] Membership errors do not corrupt terminal state.
- [x] `pnpm build` passes.
- [ ] Existing home, chat, cmux, thread, and agent flows still work.

## Proposed File Layout

```text
src
├── cli.ts
├── matrix
│   ├── index.ts
│   ├── membership.ts
│   └── rooms.ts
└── ui
    ├── chat-view.ts
    └── home-menu.ts
```

If existing `src/matrix/rooms.ts` already owns invite helpers, either move them
carefully into `membership.ts` or keep the implementation local and export a
stable API. Avoid broad churn.

## Matrix Membership Helpers

Implement helpers similar to:

```ts
joinRoom(client, roomIdOrAlias): Promise<string>
leaveRoom(client, roomId): Promise<void>
inviteToRoom(client, roomId, userId): Promise<void>
getRoomMembership(client, roomId): RoomMembershipState
waitForRoomMembership(client, roomId, membership): Promise<void>
```

Expected behavior:

- `joinRoom()` returns the joined room ID.
- `leaveRoom()` waits briefly for local sync to stop showing the room as joined.
- `inviteToRoom()` validates the user ID shape before calling Matrix where
  practical.
- Membership helpers should surface Matrix error messages without exposing
  tokens or session data.

## CLI Commands

Suggested commands:

```sh
./nugget join "#room:server"
./nugget join "!room:server"
./nugget leave "!room:server"
./nugget invite "!room:server" "@alice:server"
```

Behavior:

- `join` starts a synced client, joins, waits for the room to appear locally,
  then prints the joined room ID and suggested next command:

```text
Joined #room:server as !room:server
Open it with: ./nugget open !room:server
```

- `leave` starts a synced client, leaves, waits briefly for local sync, and
  prints success.
- `invite` starts a synced client, sends invite, and prints success.

## Chat Slash Commands

Existing:

```text
/invite @user:server
```

Add:

```text
/leave
```

Optional if easy:

```text
/join #room:server
```

Recommended behavior:

- `/leave` asks for confirmation unless the existing terminal prompt style makes
  confirmation awkward. If skipping confirmation, make the command explicit in
  help text.
- After successful `/leave`, show a local notice and close the chat view.
- `/invite` should block duplicate command submissions while invite is in
  flight.
- Unknown or malformed user IDs should show local errors without sending
  messages to Matrix.

## Home And Workspace Behavior

After membership changes:

- Leaving a room should remove it from joined room pickers after sync.
- Leaving a Space should remove it from the home workspace list after sync.
- Joining a room should make it available from `./nugget open` room picker.
- If the joined room belongs to no Space, it should not appear inside a Space
  picker unless linked there later.

Invited room visibility is optional in this phase:

- If implemented, show an `Invites` section in home.
- Support accept through `join`.
- Defer reject/decline if it expands scope.

## Implementation Checklist

- [x] Add `src/matrix/membership.ts`.
- [x] Implement `joinRoom(client, roomIdOrAlias)`.
- [x] Implement `leaveRoom(client, roomId)`.
- [x] Implement or move `inviteToRoom(client, roomId, userId)`.
- [x] Add membership state lookup helpers if needed by command UX.
- [x] Reuse existing sync wait helper for joined membership.
- [x] Add brief sync wait helper for leave visibility.
- [x] Add CLI `join`.
- [x] Add CLI `leave`.
- [x] Add CLI `invite`.
- [x] Add chat `/leave`.
- [x] Keep chat `/invite` working and update it to use shared helper.
- [x] Update slash help.
- [x] Update CLI help.
- [x] Ensure home/workspace room lists handle changed membership after refresh.
- [x] Pending DM and workspace invite visibility already exists in Home.
- [x] Run verification commands.

## Verification Commands

Run before handoff:

```sh
pnpm build
./nugget --help
```

Manual verification requiring Matrix account:

```sh
./nugget login
./nugget join "#some-public-room:server"
./nugget open "<joined-room-id>"
./nugget invite "<joined-room-id>" "@user:server"
./nugget leave "<joined-room-id>"
```

Manual checks:

- Join by alias succeeds for a public room.
- Join failure for a private room gives an actionable Matrix error.
- Joined room appears in `./nugget open` picker after sync.
- `/invite @user:server` reports success or the Matrix error reason.
- `/leave` leaves and exits the room chat cleanly.
- Left room no longer appears as joined after sync.
- Ctrl-C during prompts restores terminal state.

## Edge Cases To Handle

- Invalid room alias.
- Invalid room ID.
- Invalid Matrix user ID.
- Room already joined.
- Room already left.
- User is invited but not joined.
- User is banned from a room.
- Homeserver requires `via` routing for room ID joins.
- Leave succeeds server-side but local sync is delayed.
- Invite succeeds but invited user is already in the room.
- Invite fails due to power level.
- Leaving a room that has an open cmux pane.
- Leaving a Space that has an open cmux workspace.

## Non-Goals

- Do not implement room directory search.
- Do not implement invite decline/reject unless invited-room UI is trivial.
- Do not implement bans, kicks, or power-level changes.
- Do not implement knocking.
- Do not implement public room publishing.
- Do not implement full moderation UI.
- Do not persist membership history locally.

## Handoff Notes

This phase should close the basic lifecycle gap: users can create rooms, join
existing rooms, invite others, and leave rooms. Keep the UX direct and
terminal-friendly.

If invite inbox or room directory discovery becomes important, split those into
separate plans rather than expanding this phase.
