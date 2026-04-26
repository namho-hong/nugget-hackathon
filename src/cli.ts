#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EventType,
  MatrixEvent,
  MsgType,
  RoomEvent,
  type MatrixClient,
} from "matrix-js-sdk";
import type { Room } from "matrix-js-sdk";

import {
  addDirectRoomAccountData,
  createDirectRoom,
  createRoom,
  createSpace,
  getJoinedRooms,
  getJoinedDirectRooms,
  getJoinedSpaceRooms,
  getRoomDisplayName,
  getPendingDirectRoomInvites,
  getJoinedSpaces,
  getSpaceDisplayName,
  getPendingSpaceInvites,
  getSpaceStateName,
  getSpaceChildRoomIds,
  getSpaceRooms,
  inviteToRoom,
  isMatrixUserId,
  joinRoom,
  leaveRoom,
  loginWithSso,
  resolveRoomOrThrow,
  waitForJoinedSpace,
  waitForJoinedRoom,
  waitForRoomMembership,
  withMatrixClient,
  type LoginAction,
} from "./matrix/index.js";
import {
  CmuxClient,
  WorkspaceController,
  getOpenDirectRoomIds,
  getRequiredCmuxContext,
  launchWorkspace,
  openDirectRoomBesideCurrentSurface,
  openThreadBesideCurrentSurface,
} from "./cmux/index.js";
import {
  clearAppState,
  clearSession,
  getAppStatePath,
  getSessionPath,
  loadAppState,
  loadSession,
  recordRecentDm,
  recordRecentWorkspace,
  saveAppState,
  saveSession,
  type NuggetAppState,
} from "./store/index.js";
import { formatErrorMessage } from "./util/errors.js";
import {
  openChatView,
  openThreadView,
  promptRequired,
  promptRequiredNavigation,
  runSpaceRoomPicker,
  selectHomeAction,
  selectJoinedRoom,
  selectWorkspaceAction,
  type HomeAction,
} from "./ui/index.js";

type CommandResult = {
  exitCode: number;
  output: string;
  stream: "stdout" | "stderr";
};

const HELP_TEXT = `Nugget

Usage:
  nugget [command]

Commands:
  home              Show the Matrix home menu.
  help              Show this help.
  version           Show the local package version.
  login [action]    Start Matrix SSO. Action: login or register.
  logout            Clear the local Matrix session.
  reset-state       Clear local Nugget app state without logging out.
  doctor            Print local session, state, and cmux diagnostics.
  whoami            Show the saved Matrix session identity.
  create-workspace [name]
                    Create a private Matrix Space.
  create-room [name] [spaceId]
                    Create a private Matrix room, optionally linked to a Space.
  create-dm [userId]
                    Create a direct room and invite a Matrix user.
  join <roomIdOrAlias>
                    Join a Matrix room by room ID or alias.
  leave <roomId>    Leave a Matrix room or reject a pending invite.
  invite <roomId> <userId>
                    Invite a Matrix user to a room.
  workspace [spaceId]
                    Open a joined Matrix Space and choose one of its rooms.
  workspace-controller <spaceId>
                    Run the cmux room picker for a Matrix Space.
  open [roomId]     Open a joined Matrix room, or pick one when omitted.
  room <roomId>     Open a joined Matrix room chat view.
  thread <roomId> <threadRootEventId>
                    Open a Matrix thread chat view.
  send <roomId> <message...>
                    Send one text message and exit.
`;

function readPackageVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(currentDir, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };

  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

async function run(argv: string[]): Promise<CommandResult> {
  const args = argv.slice(2);
  const command = (args[0] === "--" ? args[1] : args[0]) ?? "home";

  if (command === "--help" || command === "-h" || command === "help") {
    return {
      exitCode: 0,
      output: HELP_TEXT,
      stream: "stdout",
    };
  }

  if (command === "--version" || command === "-v" || command === "version") {
    return {
      exitCode: 0,
      output: `${readPackageVersion()}\n`,
      stream: "stdout",
    };
  }

  if (command === "login") {
    return handleLogin(args.slice(1));
  }

  if (command === "home") {
    return handleDefaultHome();
  }

  if (command === "logout") {
    await clearSession();
    return {
      exitCode: 0,
      output: "Logged out. Local Matrix session cleared.\n",
      stream: "stdout",
    };
  }

  if (command === "reset-state") {
    await clearAppState();
    return {
      exitCode: 0,
      output: `Cleared local Nugget app state at ${getAppStatePath()}.\n`,
      stream: "stdout",
    };
  }

  if (command === "doctor") {
    return handleDoctor();
  }

  if (command === "whoami" || command === "session") {
    return handleWhoami();
  }

  if (command === "create-workspace") {
    return handleCreateWorkspaceCommand(args.slice(1));
  }

  if (command === "create-room") {
    return handleCreateRoomCommand(args.slice(1));
  }

  if (command === "create-dm") {
    return handleCreateDmCommand(args.slice(1));
  }

  if (command === "join") {
    return handleJoinCommand(args.slice(1));
  }

  if (command === "leave") {
    return handleLeaveCommand(args.slice(1));
  }

  if (command === "invite") {
    return handleInviteCommand(args.slice(1));
  }

  if (command === "workspace") {
    return handleWorkspaceCommand(args.slice(1));
  }

  if (command === "workspace-controller") {
    return handleWorkspaceControllerCommand(args.slice(1));
  }

  if (command === "open") {
    return handleOpenCommand(args.slice(1));
  }

  if (command === "room") {
    return handleRoomCommand(args.slice(1));
  }

  if (command === "thread") {
    return handleThreadCommand(args.slice(1));
  }

  if (command === "send") {
    return handleSendCommand(args.slice(1));
  }

  return {
    exitCode: 1,
    output: `Unknown command: ${command}\n\n${HELP_TEXT}`,
    stream: "stderr",
  };
}

async function handleLogin(args: string[]): Promise<CommandResult> {
  const action = parseLoginAction(args[0]);

  if (!action) {
    return {
      exitCode: 1,
      output: "Usage: nugget login [login|register]\n",
      stream: "stderr",
    };
  }

  process.stdout.write(`Starting Matrix ${action} SSO...\n`);
  const session = await loginWithSso(action, {
    onLoginUrl: (url) => {
      process.stdout.write(`If the browser does not open, visit:\n${url}\n`);
    },
  });

  await saveSession(session);
  process.stdout.write(`Logged in as ${session.userId}\n`);

  return handleDefaultHome();
}

async function handleDefaultHome(): Promise<CommandResult> {
  const session = await loadSession();

  if (!session) {
    process.stdout.write("No Matrix session found.\nStarting login...\n");
    return handleLogin([]);
  }

  process.stdout.write("Loading Matrix account state...\n");
  const action = await selectHomeActionFromMatrix();

  return handleHomeAction(action);
}

async function selectHomeActionFromMatrix(): Promise<HomeAction> {
  return withMatrixClient(async (client, session) => {
    const localState = await loadAppState();
    const workspaces = await getJoinedSpaces(client);
    const childRooms = await getSpaceChildRoomIds(client, workspaces);
    const directMessages = await getJoinedDirectRooms(client, {
      excludeRoomIds: childRooms.roomIds,
    });
    const prunedState = pruneAppState(localState.state, {
      directRoomIds: new Set(directMessages.map((directMessage) => directMessage.roomId)),
      spaceIds: new Set(workspaces.map((workspace) => workspace.roomId)),
    });

    if (localState.warnings.length === 0 && prunedState !== localState.state) {
      await saveAppState(prunedState);
    }

    const joinedDirectUserIds = new Set(
      directMessages.flatMap((directMessage) => directMessage.userIds),
    );
    const pendingDirectInvites = getPendingDirectRoomInvites(client, {
      excludeRoomIds: childRooms.roomIds,
    }).filter((invite) => !joinedDirectUserIds.has(invite.inviterUserId));
    const pendingWorkspaceInvites = getPendingSpaceInvites(client);
    const openDirectRoomIds = await getOpenDirectRoomIds(
      new Set(directMessages.map((directMessage) => directMessage.roomId)),
    );

    return selectHomeAction({
      accountUserId: session.userId,
      directMessages: rankByRecent(
        directMessages,
        prunedState.recentDms,
        (directMessage) => directMessage.roomId,
        (recent) => recent.roomId,
      ),
      openDirectRoomIds,
      pendingDirectInvites,
      pendingWorkspaceInvites,
      warnings: [...childRooms.warnings, ...localState.warnings],
      workspaces: rankByRecent(
        workspaces,
        prunedState.recentWorkspaces,
        (workspace) => workspace.roomId,
        (recent) => recent.spaceId,
      ),
    });
  });
}

async function handleHomeAction(action: HomeAction): Promise<CommandResult> {
  if (action.type === "logout") {
    await clearSession();
    process.stdout.write("Logged out. Local Matrix session cleared.\nStarting login...\n");
    return handleLogin([]);
  }

  if (action.type === "quit") {
    return {
      exitCode: 0,
      output: "",
      stream: "stdout",
    };
  }

  if (action.type === "home") {
    return handleDefaultHome();
  }

  if (action.type === "view-all-workspaces") {
    return {
      exitCode: 1,
      output: "No joined Matrix Spaces found.\n",
      stream: "stderr",
    };
  }

  if (action.type === "open-workspace") {
    return handleOpenWorkspace(action.spaceId);
  }

  if (action.type === "accept-workspace-invite") {
    return handleAcceptWorkspaceInvite(action.spaceId);
  }

  if (action.type === "reject-workspace-invite") {
    return handleRejectWorkspaceInvite(action.spaceId);
  }

  if (action.type === "open-dm") {
    return handleOpenDirectRoomFromHome(action.roomId);
  }

  if (action.type === "accept-dm-invite") {
    return handleAcceptDmInvite(action.roomId);
  }

  if (action.type === "reject-dm-invite") {
    return handleRejectDmInvite(action.roomId);
  }

  if (action.type === "create-workspace") {
    return handleCreateWorkspaceInteractive();
  }

  if (action.type === "create-dm") {
    return handleCreateDmInteractive();
  }

  return {
    exitCode: 0,
    output: "",
    stream: "stdout",
  };
}

async function handleWhoami(): Promise<CommandResult> {
  const session = await loadSession();

  if (!session) {
    return {
      exitCode: 1,
      output: "Not logged in. Run `nugget login` first.\n",
      stream: "stderr",
    };
  }

  return {
    exitCode: 0,
    output: `${session.userId}\n${session.baseUrl}\n`,
    stream: "stdout",
  };
}

async function handleDoctor(): Promise<CommandResult> {
  const lines = ["Nugget doctor", ""];

  lines.push(`Session path: ${getSessionPath()}`);
  try {
    const session = await loadSession();
    lines.push(
      session
        ? `Session: ok (${session.userId} on ${session.baseUrl})`
        : "Session: missing",
    );
  } catch (error) {
    lines.push(`Session: invalid (${formatError(error)})`);
  }

  const appState = await loadAppState();
  lines.push(`App state path: ${appState.path}`);
  lines.push(
    `App state: ${appState.warnings.length > 0 ? "ignored" : "ok"} (${appState.state.recentWorkspaces.length} workspaces, ${appState.state.recentDms.length} DMs)`,
  );

  for (const warning of appState.warnings) {
    lines.push(`App state warning: ${warning}`);
  }

  const cmux = new CmuxClient();
  try {
    await cmux.tree({ all: true });
    lines.push("cmux: ok");
  } catch (error) {
    lines.push(`cmux: unavailable (${formatError(error)})`);
  }

  return {
    exitCode: 0,
    output: `${lines.join("\n")}\n`,
    stream: "stdout",
  };
}

async function handleCreateWorkspaceCommand(args: string[]): Promise<CommandResult> {
  return handleCreateWorkspaceInteractive(args.length > 0 ? args.join(" ") : undefined);
}

async function handleCreateRoomCommand(args: string[]): Promise<CommandResult> {
  const parsed = parseCreateRoomArgs(args);
  const name = parsed.name ?? (await promptRequired("Room name"));

  return handleCreateMatrixRoom(name, parsed.spaceId);
}

async function handleCreateDmCommand(args: string[]): Promise<CommandResult> {
  return handleCreateDmInteractive(args[0]);
}

async function handleJoinCommand(args: string[]): Promise<CommandResult> {
  const roomIdOrAlias = args[0];

  if (!roomIdOrAlias || args.length > 1) {
    return {
      exitCode: 1,
      output: "Usage: nugget join <roomIdOrAlias>\n",
      stream: "stderr",
    };
  }

  return withMatrixClient(async (client) => {
    const roomId = await joinRoom(client, roomIdOrAlias);
    const joinedAs = roomId === roomIdOrAlias ? roomId : `${roomIdOrAlias} as ${roomId}`;

    return {
      exitCode: 0,
      output: `Joined ${joinedAs}.\nOpen it with: nugget open ${roomId}\n`,
      stream: "stdout",
    };
  });
}

async function handleLeaveCommand(args: string[]): Promise<CommandResult> {
  const roomId = args[0];

  if (!roomId || args.length > 1) {
    return {
      exitCode: 1,
      output: "Usage: nugget leave <roomId>\n",
      stream: "stderr",
    };
  }

  return withMatrixClient(async (client) => {
    await leaveRoom(client, roomId);

    return {
      exitCode: 0,
      output: `Left room ${roomId}.\n`,
      stream: "stdout",
    };
  });
}

async function handleInviteCommand(args: string[]): Promise<CommandResult> {
  const roomId = args[0];
  const userId = args[1];

  if (!roomId || !userId || args.length > 2) {
    return {
      exitCode: 1,
      output: "Usage: nugget invite <roomId> <userId>\n",
      stream: "stderr",
    };
  }

  return withMatrixClient(async (client) => {
    await waitForJoinedRoom(client, roomId);
    await inviteToRoom(client, roomId, userId);

    return {
      exitCode: 0,
      output: `Invited ${userId} to ${roomId}.\n`,
      stream: "stdout",
    };
  });
}

async function handleWorkspaceCommand(args: string[]): Promise<CommandResult> {
  if (args.length > 1) {
    return {
      exitCode: 1,
      output: "Usage: nugget workspace [spaceId]\n",
      stream: "stderr",
    };
  }

  const requestedSpaceId = args[0];

  if (requestedSpaceId) {
    return handleOpenWorkspace(requestedSpaceId);
  }

  const result = await withMatrixClient(async (client) => {
    const action = await selectWorkspaceAction(await getJoinedSpaces(client));

    if (action.type === "home") {
      return { type: "home" } as const;
    }

    if (action.type !== "open-workspace") {
      return { type: "quit" } as const;
    }

    return await openWorkspaceFromClient(client, action.spaceId);
  });

  return handleNavigationResult(result);
}

async function handleWorkspaceControllerCommand(args: string[]): Promise<CommandResult> {
  const spaceId = args[0];

  if (!spaceId || args.length > 1) {
    return {
      exitCode: 1,
      output: "Usage: nugget workspace-controller <spaceId>\n",
      stream: "stderr",
    };
  }

  const context = getRequiredCmuxContext();
  const cmux = new CmuxClient();
  const controller = new WorkspaceController(
    cmux,
    context.workspaceRef,
    context.surfaceRef,
  );

  const result = await withMatrixClient(async (client) => {
    return await runWorkspacePickerForSpace(client, spaceId, cmux, controller);
  });

  return handleNavigationResult(result);
}

function watchWorkspaceRoomActivity(
  client: MatrixClient,
  spaceId: string,
  cmux: CmuxClient,
  onActivity: (roomId: string) => void,
): () => void {
  const localUserId = client.getUserId();
  const rooms = getJoinedSpaceRooms(client, spaceId)
    .map((room) => client.getRoom(room.roomId))
    .filter((room): room is Room => room !== null);
  const seenEventIds = new Set(
    rooms.flatMap((room) =>
      room
        .getLiveTimeline()
        .getEvents()
        .map((event) => event.getId())
        .filter((eventId): eventId is string => typeof eventId === "string"),
    ),
  );

  const onTimeline = (
    event: MatrixEvent,
    eventRoom: Room | undefined,
    toStartOfTimeline: boolean | undefined,
    removed: boolean | undefined,
  ): void => {
    const roomId = eventRoom?.roomId;

    if (removed || toStartOfTimeline || !roomId || !isWorkspaceActivityEvent(event)) {
      return;
    }

    const eventId = event.getId();

    if (eventId) {
      if (seenEventIds.has(eventId)) {
        return;
      }

      seenEventIds.add(eventId);
    }

    if (!isCurrentWorkspaceRoom(client, spaceId, roomId)) {
      return;
    }

    onActivity(roomId);

    if (event.getSender() === localUserId) {
      return;
    }

    const body = getMessageBody(event);

    if (!body || !eventRoom) {
      return;
    }

    void cmux.notify({
      title: getRoomDisplayName(eventRoom),
      body: `${event.getSender() ?? "Someone"}: ${body}`,
    });
  };

  for (const room of rooms) {
    room.on(RoomEvent.Timeline, onTimeline);
  }

  return () => {
    for (const room of rooms) {
      room.off(RoomEvent.Timeline, onTimeline);
    }
  };
}

function isWorkspaceActivityEvent(event: MatrixEvent): boolean {
  return getMessageBody(event) !== null;
}

function isCurrentWorkspaceRoom(
  client: MatrixClient,
  spaceId: string,
  roomId: string,
): boolean {
  try {
    return getJoinedSpaceRooms(client, spaceId).some((room) => room.roomId === roomId);
  } catch {
    return false;
  }
}

function getMessageBody(event: MatrixEvent): string | null {
  if (event.getType() !== EventType.RoomMessage) {
    return null;
  }

  const content = event.getContent<Record<string, unknown>>();
  const body = typeof content.body === "string" ? content.body.trim() : "";

  return body.length > 0 ? body : null;
}

async function handleOpenCommand(args: string[]): Promise<CommandResult> {
  if (args.length > 1) {
    return {
      exitCode: 1,
      output: "Usage: nugget open [roomId]\n",
      stream: "stderr",
    };
  }

  const requestedRoomId = args[0];

  if (requestedRoomId) {
    return handleOpenRoom(requestedRoomId);
  }

  const result = await withMatrixClient(async (client) => {
    const selection = await selectJoinedRoom(getJoinedRooms(client));

    if (selection.type !== "open-room") {
      return selection;
    }

    await recordRecentDmIfJoinedDirect(client, selection.roomId);

    return await openChatView(client, selection.roomId, {
      onOpenThread: (threadRootEventId) =>
        openThreadBesideCurrentSurface(selection.roomId, threadRootEventId),
    });
  });

  return handleNavigationResult(result);
}

async function handleRoomCommand(args: string[]): Promise<CommandResult> {
  const roomId = args[0];

  if (!roomId || args.length > 1) {
    return {
      exitCode: 1,
      output: "Usage: nugget room <roomId>\n",
      stream: "stderr",
    };
  }

  return handleOpenRoom(roomId);
}

async function handleThreadCommand(args: string[]): Promise<CommandResult> {
  const roomId = args[0];
  const threadRootEventId = args[1];

  if (!roomId || !threadRootEventId || args.length > 2) {
    return {
      exitCode: 1,
      output: "Usage: nugget thread <roomId> <threadRootEventId>\n",
      stream: "stderr",
    };
  }

  const result = await withMatrixClient(async (client) => {
    await waitForJoinedRoom(client, roomId);
    return await openThreadView(client, roomId, threadRootEventId);
  });

  return handleNavigationResult(result);
}

async function handleSendCommand(args: string[]): Promise<CommandResult> {
  const roomId = args[0];
  const message = args.slice(1).join(" ").trim();

  if (!roomId || message.length === 0) {
    return {
      exitCode: 1,
      output: "Usage: nugget send <roomId> <message...>\n",
      stream: "stderr",
    };
  }

  return withMatrixClient(async (client) => {
    await waitForJoinedRoom(client, roomId);

    try {
      await client.sendMessage(roomId, {
        body: message,
        msgtype: MsgType.Text,
      });
    } catch (error) {
      throw new Error(`Could not send message to room ${roomId}: ${formatError(error)}`);
    }

    return {
      exitCode: 0,
      output: `Sent message to ${roomId}.\n`,
      stream: "stdout",
    };
  });
}

async function handleOpenRoom(roomId: string): Promise<CommandResult> {
  const result = await withMatrixClient(async (client) => {
    const room = await waitForJoinedRoom(client, roomId);

    await recordRecentDmIfJoinedDirect(client, room.roomId);

    return await openChatView(client, room.roomId, {
      onOpenThread: (threadRootEventId) =>
        openThreadBesideCurrentSurface(room.roomId, threadRootEventId),
    });
  });

  return handleNavigationResult(result);
}

async function handleOpenDirectRoomFromHome(roomId: string): Promise<CommandResult> {
  const result = await withMatrixClient(async (client) => {
    return await openDirectRoomFromClient(client, roomId);
  });

  return handleNavigationResult(result);
}

async function openDirectRoomFromClient(
  client: MatrixClient,
  roomId: string,
): Promise<{ type: "home" | "quit" }> {
  const room = await waitForJoinedRoom(client, roomId);
  const directRooms = await getJoinedDirectRooms(client);
  const directRoomIds = new Set(directRooms.map((directRoom) => directRoom.roomId));
  const directRoom = directRooms.find((item) => item.roomId === room.roomId);

  directRoomIds.add(room.roomId);

  if (directRoom) {
    await recordRecentDm({
      name: directRoom.name,
      roomId: directRoom.roomId,
    });
  } else {
    await recordRecentDmIfJoinedDirect(client, room.roomId);
  }

  if (
    await openDirectRoomBesideCurrentSurface(room.roomId, {
      knownDirectRoomIds: directRoomIds,
    })
  ) {
    return { type: "home" };
  }

  return await openChatView(client, room.roomId, {
    onOpenThread: (threadRootEventId) =>
      openThreadBesideCurrentSurface(room.roomId, threadRootEventId),
  });
}

async function handleOpenWorkspace(spaceId: string): Promise<CommandResult> {
  const result = await withMatrixClient(async (client) => {
    return await openWorkspaceFromClient(client, spaceId);
  });

  return handleNavigationResult(result);
}

async function openWorkspaceFromClient(
  client: MatrixClient,
  spaceId: string,
): Promise<{ type: "home" | "quit" }> {
  const workspace = await waitForJoinedSpace(client, spaceId);

  await recordRecentWorkspace({
    name: workspace.name,
    spaceId: workspace.roomId,
  });

  const inlineContext = await getCurrentCmuxContext();

  if (inlineContext) {
    await launchWorkspace(workspace);

    const cmux = new CmuxClient();
    const controller = new WorkspaceController(
      cmux,
      inlineContext.workspaceRef,
      inlineContext.surfaceRef,
    );

    return await runWorkspacePickerForSpace(client, workspace.roomId, cmux, controller);
  }

  try {
    await launchWorkspace(workspace);
  } catch (error) {
    throw new Error(
      `Space ${workspace.roomId} is joined, but Nugget could not open its cmux workspace: ${formatError(error)}`,
    );
  }

  return { type: "quit" };
}

async function runWorkspacePickerForSpace(
  client: MatrixClient,
  spaceId: string,
  cmux: CmuxClient,
  controller: WorkspaceController,
): Promise<{ type: "home" | "quit" }> {
  const space = await waitForJoinedSpace(client, spaceId);

  await controller.hydrateOpenRooms(
    getJoinedSpaceRooms(client, spaceId).map((room) => room.roomId),
  );

  return await runSpaceRoomPicker({
    loadRooms: () => getSpaceRooms(client, spaceId),
    onAcceptRoomInvite: async (room) => {
      await joinRoom(client, room.roomId, { viaServers: room.viaServers });
    },
    onInviteUser: async (userId) => {
      await inviteToRoom(client, spaceId, userId);
    },
    onJoinRoom: async (room) => {
      await joinRoom(client, room.roomId, { viaServers: room.viaServers });
    },
    onOpenRoom: (roomId) => controller.openRoom(roomId),
    title: `Workspace: ${space.name}`,
    watchRoomActivity: (onActivity) =>
      watchWorkspaceRoomActivity(client, spaceId, cmux, onActivity),
  });
}

async function getCurrentCmuxContext(): Promise<{
  surfaceRef: string;
  workspaceRef: string;
} | null> {
  const cmux = new CmuxClient();
  const tree = await cmux.tree({ all: true, preserveCallerEnv: true });
  const surfaceRef =
    tree.caller?.surface_ref ??
    tree.active?.surface_ref ??
    process.env.CMUX_SURFACE_ID;
  const currentWorkspaceRef =
    tree.caller?.workspace_ref ??
    tree.active?.workspace_ref ??
    process.env.CMUX_WORKSPACE_ID;

  if (!surfaceRef || !currentWorkspaceRef) {
    return null;
  }

  return { surfaceRef, workspaceRef: currentWorkspaceRef };
}

function resolveJoinedSpace(
  client: MatrixClient,
  spaceId: string,
): { roomId: string; name: string } {
  const space = client.getRoom(spaceId);

  if (!space) {
    throw new Error(`Space ${spaceId} is not visible in the synced client store.`);
  }

  getJoinedSpaceRooms(client, spaceId);

  return {
    name: getSpaceDisplayName(space),
    roomId: space.roomId,
  };
}

async function handleCreateWorkspace(name: string): Promise<CommandResult> {
  const created = await withMatrixClient(async (client) => createSpace(client, name));

  return {
    exitCode: 0,
    output:
      `Created workspace: ${created.name}\n` +
      `Space ID: ${created.roomId}\n\n` +
      `Open it with: nugget workspace ${created.roomId}\n`,
    stream: "stdout",
  };
}

async function handleCreateWorkspaceInteractive(
  initialName?: string,
): Promise<CommandResult> {
  let nextName = initialName;

  while (true) {
    const name = nextName ?? (await promptCreationValue("Workspace name"));
    nextName = undefined;

    if (typeof name !== "string") {
      return handleNavigationResult(name);
    }

    const cleanName = name.trim();

    if (cleanName.length === 0) {
      const message = "A workspace name is required.";

      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(message);
      }

      process.stdout.write(`${message}\n`);
      continue;
    }

    try {
      return await handleCreateWorkspace(cleanName);
    } catch (error) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw error;
      }

      process.stdout.write(`Could not create workspace: ${formatError(error)}\n`);
    }
  }
}

async function handleCreateMatrixRoom(
  name: string,
  spaceId: string | undefined,
): Promise<CommandResult> {
  const created = await withMatrixClient(async (client) =>
    createRoom(client, {
      name,
      ...(spaceId ? { spaceId } : {}),
    }),
  );

  return {
    exitCode: 0,
    output:
      `Created room: ${created.name}\n` +
      `Room ID: ${created.roomId}\n` +
      `${spaceId ? `Linked Space ID: ${spaceId}\n` : ""}\n` +
      `Open it with: nugget room ${created.roomId}\n`,
    stream: "stdout",
  };
}

async function handleCreateDm(userId: string): Promise<CommandResult> {
  const result = await withMatrixClient(async (client) => {
    const created = await createDirectRoom(client, userId);
    await recordRecentDm({ name: created.name, roomId: created.roomId });

    try {
      return await openDirectRoomFromClient(client, created.roomId);
    } catch (error) {
      throw new Error(
        `Created DM room ${created.roomId} for ${userId}, but could not open chat: ${formatError(error)}`,
      );
    }
  });

  return handleNavigationResult(result);
}

async function handleCreateDmInteractive(initialUserId?: string): Promise<CommandResult> {
  let nextUserId = initialUserId;

  while (true) {
    const userId = nextUserId ?? (await promptCreationValue("Matrix user ID"));
    nextUserId = undefined;

    if (typeof userId !== "string") {
      return handleNavigationResult(userId);
    }

    const cleanUserId = userId.trim();

    if (!isMatrixUserId(cleanUserId)) {
      const message = `Invalid Matrix user ID: ${userId}`;

      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(message);
      }

      process.stdout.write(`${message}\n`);
      continue;
    }

    try {
      return await handleCreateDm(cleanUserId);
    } catch (error) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw error;
      }

      process.stdout.write(`Could not create DM: ${formatError(error)}\n`);
    }
  }
}

async function handleAcceptDmInvite(roomId: string): Promise<CommandResult> {
  const result = await withMatrixClient(async (client) => {
    const invite = getPendingDirectRoomInvites(client).find((item) => item.roomId === roomId);

    if (!invite) {
      throw new Error(`DM invite ${roomId} is no longer pending.`);
    }

    const joinedRoom = await client.joinRoom(roomId);
    const directUserId = invite.inviterUserId;
    const currentUserId = client.getUserId();

    if (directUserId !== currentUserId) {
      try {
        await addDirectRoomAccountData(client, directUserId, joinedRoom.roomId);
      } catch (error) {
        process.stdout.write(
          `Accepted DM invite, but could not update direct chat metadata: ${formatError(error)}\n`,
        );
      }
    }

    await recordRecentDm({
      name: getRoomDisplayName(joinedRoom),
      roomId: joinedRoom.roomId,
    });

    try {
      return await openDirectRoomFromClient(client, joinedRoom.roomId);
    } catch (error) {
      throw new Error(
        `Accepted DM invite and joined ${joinedRoom.roomId}, but could not open chat: ${formatError(error)}`,
      );
    }
  });

  return handleNavigationResult(result);
}

async function handleAcceptWorkspaceInvite(spaceId: string): Promise<CommandResult> {
  return withMatrixClient(async (client) => {
    const invite = getPendingSpaceInvites(client).find((item) => item.roomId === spaceId);

    if (!invite) {
      throw new Error(`Workspace invite ${spaceId} is no longer pending.`);
    }

    const joinedSpace = await client.joinRoom(spaceId);
    await waitForRoomMembership(client, joinedSpace.roomId, "join");
    const joinedSpaceSummary = await waitForJoinedSpace(client, joinedSpace.roomId);
    const syncedSpace = client.getRoom(joinedSpace.roomId) ?? joinedSpace;
    const stateName = await getSpaceStateName(client, syncedSpace.roomId);
    const workspace = {
      name: stateName ?? getSpaceDisplayName(syncedSpace, invite.name),
      roomId: joinedSpaceSummary.roomId,
    };

    try {
      await launchWorkspace(workspace);
    } catch (error) {
      throw new Error(
        `Accepted workspace invite for ${workspace.roomId}, but Nugget could not open its cmux workspace: ${formatError(error)}`,
      );
    }

    await recordRecentWorkspace({
      name: workspace.name,
      spaceId: workspace.roomId,
    });

    return {
      exitCode: 0,
      output: "",
      stream: "stdout",
    };
  });
}

async function handleRejectWorkspaceInvite(spaceId: string): Promise<CommandResult> {
  return withMatrixClient(async (client) => {
    const invite = getPendingSpaceInvites(client).find((item) => item.roomId === spaceId);

    if (!invite) {
      throw new Error(`Workspace invite ${spaceId} is no longer pending.`);
    }

    await client.leave(spaceId);

    return {
      exitCode: 0,
      output: `Rejected workspace invite from ${invite.inviterUserId}.\n`,
      stream: "stdout",
    };
  });
}

async function handleRejectDmInvite(roomId: string): Promise<CommandResult> {
  return withMatrixClient(async (client) => {
    const invite = getPendingDirectRoomInvites(client).find((item) => item.roomId === roomId);

    if (!invite) {
      throw new Error(`DM invite ${roomId} is no longer pending.`);
    }

    await client.leave(roomId);

    return {
      exitCode: 0,
      output: `Rejected DM invite from ${invite.inviterUserId}.\n`,
      stream: "stdout",
    };
  });
}

async function handleNavigationResult(result: {
  type: "home" | "quit";
}): Promise<CommandResult> {
  if (result.type === "home") {
    return handleDefaultHome();
  }

  return {
    exitCode: 0,
    output: "",
    stream: "stdout",
  };
}

async function promptCreationValue(
  label: string,
): Promise<string | { type: "home" | "quit" }> {
  const result = await promptRequiredNavigation(label);

  if (result.type === "value") {
    return result.value;
  }

  return result;
}

function parseCreateRoomArgs(args: string[]): { name?: string; spaceId?: string } {
  if (args.length === 0) {
    return {};
  }

  const lastArg = args.at(-1);

  if (args.length > 1 && lastArg?.startsWith("!")) {
    return {
      name: args.slice(0, -1).join(" "),
      spaceId: lastArg,
    };
  }

  return {
    name: args.join(" "),
  };
}

function rankByRecent<T, R extends { openedAt: number }>(
  items: readonly T[],
  recents: readonly R[],
  getItemId: (item: T) => string,
  getRecentId: (recent: R) => string,
): T[] {
  const originalIndex = new Map(items.map((item, index) => [getItemId(item), index]));
  const openedAtById = new Map(recents.map((recent) => [getRecentId(recent), recent.openedAt]));

  return [...items].sort((a, b) => {
    const aOpenedAt = openedAtById.get(getItemId(a)) ?? 0;
    const bOpenedAt = openedAtById.get(getItemId(b)) ?? 0;
    const recentDelta = bOpenedAt - aOpenedAt;

    if (recentDelta !== 0) {
      return recentDelta;
    }

    return (originalIndex.get(getItemId(a)) ?? 0) - (originalIndex.get(getItemId(b)) ?? 0);
  });
}

function pruneAppState(
  state: NuggetAppState,
  joined: { spaceIds: ReadonlySet<string>; directRoomIds: ReadonlySet<string> },
): NuggetAppState {
  const recentWorkspaces = state.recentWorkspaces.filter((recent) =>
    joined.spaceIds.has(recent.spaceId),
  );
  const recentDms = state.recentDms.filter((recent) =>
    joined.directRoomIds.has(recent.roomId),
  );

  if (
    recentWorkspaces.length === state.recentWorkspaces.length &&
    recentDms.length === state.recentDms.length
  ) {
    return state;
  }

  return {
    ...(state.lastOpenedAt === undefined ? {} : { lastOpenedAt: state.lastOpenedAt }),
    recentDms,
    recentWorkspaces,
    version: state.version,
  };
}

async function recordRecentDmIfJoinedDirect(
  client: MatrixClient,
  roomId: string,
): Promise<void> {
  const directMessage = (await getJoinedDirectRooms(client)).find(
    (candidate) => candidate.roomId === roomId,
  );

  if (!directMessage) {
    return;
  }

  await recordRecentDm({
    name: directMessage.name,
    roomId: directMessage.roomId,
  });
}

function parseLoginAction(value: string | undefined): LoginAction | null {
  if (value === undefined || value === "login" || value === "--login") {
    return "login";
  }

  if (
    value === "register" ||
    value === "signup" ||
    value === "sign-up" ||
    value === "--register"
  ) {
    return "register";
  }

  return null;
}

try {
  const result = await run(process.argv);
  process[result.stream].write(result.output);
  process.exit(result.exitCode);
} catch (error) {
  process.stderr.write(`${formatError(error)}\n`);
  process.exit(1);
}

function formatError(error: unknown): string {
  return formatErrorMessage(error);
}
