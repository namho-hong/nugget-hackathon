import {
  ClientEvent,
  EventType,
  RoomCreateTypeField,
  RoomEvent,
  RoomType,
  SyncState,
  type MatrixClient,
} from "matrix-js-sdk";
import type { Room } from "matrix-js-sdk";

export interface JoinedRoom {
  roomId: string;
  name: string;
  lastActivityTs?: number;
}

export interface JoinedDirectRoom extends JoinedRoom {
  userIds: string[];
}

export interface PendingDirectRoomInvite extends JoinedRoom {
  inviterUserId: string;
}

export interface JoinedRoomOptions {
  excludeRoomIds?: ReadonlySet<string>;
}

export function getJoinedRooms(
  client: MatrixClient,
  options: JoinedRoomOptions = {},
): JoinedRoom[] {
  return client
    .getRooms()
    .filter((room) => isJoinedRoom(room))
    .filter((room) => !isSpaceRoom(room))
    .filter((room) => !options.excludeRoomIds?.has(room.roomId))
    .map((room) => roomSummary(room))
    .sort(compareRooms);
}

export function getRoomDisplayName(room: Room): string {
  return resolveRoomName(room);
}

export function resolveRoomOrThrow(client: MatrixClient, roomId: string): Room {
  const room = client.getRoom(roomId);

  if (!room) {
    throw new Error(
      `Room ${roomId} is not visible in the synced client store. Join it first or run sync again.`,
    );
  }

  if (!isJoinedRoom(room)) {
    throw new Error(`Room ${roomId} is not joined by the current Matrix session.`);
  }

  if (isSpaceRoom(room)) {
    throw new Error(`Room ${roomId} is a Matrix Space, not a chat room.`);
  }

  return room;
}

export async function waitForJoinedRoom(
  client: MatrixClient,
  roomId: string,
  timeoutMs = 30_000,
): Promise<Room> {
  type JoinedRoomWaitState =
    | { kind: "ready"; room: Room; status: string }
    | { kind: "waiting"; status: string }
    | { kind: "failed"; status: string };

  const currentRoom = (): JoinedRoomWaitState => {
    const room = client.getRoom(roomId);

    if (!room) {
      return { kind: "waiting", status: "missing from local sync" };
    }

    const membership = room.getMyMembership() ?? "unknown";

    if (membership !== "join") {
      return { kind: "waiting", status: `membership ${membership}` };
    }

    if (isSpaceRoom(room)) {
      return { kind: "failed", status: "Matrix Space" };
    }

    return { kind: "ready", room, status: "ready" };
  };

  const initial = currentRoom();

  if (initial.kind === "ready") {
    return initial.room;
  }

  if (initial.kind === "failed") {
    throw joinedRoomWaitError(roomId, initial.status);
  }

  if (!(await isJoinedOnServer(client, roomId))) {
    if (initial.status !== "missing from local sync") {
      throw joinedRoomWaitError(roomId, initial.status);
    }

    throw new Error(
      `Room ${roomId} is not visible in the local Matrix sync store, and the server does not report this session as joined. Join it first or refresh sync.`,
    );
  }

  return await new Promise<Room>((resolve, reject) => {
    let lastStatus = initial.status;
    let lastState = client.getSyncState() ?? "none";
    let lastError: Error | undefined;
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Room ${roomId} is joined on the server, but did not appear in local Matrix sync after ${Math.round(
            timeoutMs / 1000,
          )}s. Last status: ${lastStatus}; last sync state: ${lastState}${
            lastError ? ` (${lastError.message})` : ""
          }.`,
        ),
      );
    }, timeoutMs);

    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      client.off(ClientEvent.Room, onRoom);
      client.off(ClientEvent.Sync, onSync);
      client.off(RoomEvent.MyMembership, onMembership);
    };

    const check = (): void => {
      const next = currentRoom();
      lastStatus = next.status;

      if (next.kind === "ready") {
        cleanup();
        resolve(next.room);
        return;
      }

      if (next.kind === "failed") {
        cleanup();
        reject(joinedRoomWaitError(roomId, next.status));
      }
    };

    const onRoom = (room: { roomId: string }): void => {
      if (room.roomId !== roomId) {
        return;
      }

      check();
    };

    const onSync = (
      state: SyncState,
      _previousState: SyncState | null,
      data?: { error?: Error },
    ): void => {
      lastState = state;
      lastError = data?.error;
      check();
    };

    const onMembership = (room: Room, nextMembership: string): void => {
      if (room.roomId !== roomId) {
        return;
      }

      lastStatus = `membership ${nextMembership}`;
      check();
    };

    client.on(ClientEvent.Room, onRoom);
    client.on(ClientEvent.Sync, onSync);
    client.on(RoomEvent.MyMembership, onMembership);
    check();
  });
}

export async function getJoinedDirectRooms(
  client: MatrixClient,
  options: JoinedRoomOptions = {},
): Promise<JoinedDirectRoom[]> {
  const directRoomUsers = getDirectRoomUsers(client);
  const rooms = await Promise.all(
    Array.from(directRoomUsers.entries()).map(async ([roomId, userIds]) => {
      const room = client.getRoom(roomId);

      if (
        room &&
        !isSpaceRoom(room) &&
        !options.excludeRoomIds?.has(roomId) &&
        await isJoinedDirectRoomVisible(client, room)
      ) {
        return directRoomSummary(room, userIds);
      }

      return null;
    }),
  );

  return rooms.filter((room): room is JoinedDirectRoom => room !== null).sort(compareRooms);
}

export function findJoinedDirectRoomForUser(
  client: MatrixClient,
  userId: string,
  options: JoinedRoomOptions = {},
): JoinedDirectRoom | null {
  const directRoomUsers = getDirectRoomUsers(client);
  const rooms = Array.from(directRoomUsers.entries()).map(([roomId, userIds]) => {
    if (!userIds.includes(userId)) {
      return null;
    }

    const room = client.getRoom(roomId);

    if (
      room &&
      isJoinedRoom(room) &&
      !isSpaceRoom(room) &&
      !options.excludeRoomIds?.has(roomId)
    ) {
      return directRoomSummary(room, userIds);
    }

    return null;
  });

  return rooms.filter((room): room is JoinedDirectRoom => room !== null).sort(compareRooms)[0] ?? null;
}

export function isJoinedRoom(room: Room): boolean {
  return room.getMyMembership() === "join";
}

async function isJoinedDirectRoomVisible(client: MatrixClient, room: Room): Promise<boolean> {
  const localMembership = room.getMyMembership();

  if (localMembership !== "join" && localMembership !== "invite") {
    return false;
  }

  const serverMembership = await getOwnMembershipOnServer(client, room.roomId);

  if (serverMembership) {
    return serverMembership === "join";
  }

  return localMembership === "join";
}

async function isJoinedOnServer(client: MatrixClient, roomId: string): Promise<boolean> {
  return (await getOwnMembershipOnServer(client, roomId)) === "join";
}

async function getOwnMembershipOnServer(
  client: MatrixClient,
  roomId: string,
): Promise<string | null> {
  const userId = typeof client.getUserId === "function" ? client.getUserId() : null;

  if (!userId) {
    return null;
  }

  try {
    const content = await client.getStateEvent(roomId, EventType.RoomMember, userId);
    return typeof content.membership === "string" ? content.membership : null;
  } catch {
    return null;
  }
}

function joinedRoomWaitError(roomId: string, status: string): Error {
  if (status === "Matrix Space") {
    return new Error(`Room ${roomId} is a Matrix Space, not a chat room.`);
  }

  return new Error(`Room ${roomId} is not joined by the current Matrix session (${status}).`);
}

export function getPendingDirectRoomInvites(
  client: MatrixClient,
  options: JoinedRoomOptions = {},
): PendingDirectRoomInvite[] {
  return client
    .getRooms()
    .filter((room) => room.getMyMembership() === "invite")
    .filter((room) => !isSpaceRoom(room))
    .filter((room) => !options.excludeRoomIds?.has(room.roomId))
    .map((room) => pendingDirectInviteSummary(room))
    .filter((room): room is PendingDirectRoomInvite => room !== null)
    .sort(compareRooms);
}

export function isSpaceRoom(room: Room): boolean {
  const createEvent = room.currentState.getStateEvents(EventType.RoomCreate, "");
  const content = createEvent?.getContent<Record<string, unknown>>() ?? {};

  return content[RoomCreateTypeField] === RoomType.Space;
}

export function roomSummary(room: Room): JoinedRoom {
  const lastActivityTs = room.getLastActiveTimestamp();

  return {
    roomId: room.roomId,
    name: resolveRoomName(room),
    ...(lastActivityTs > 0 ? { lastActivityTs } : {}),
  };
}

export function compareRooms(a: JoinedRoom, b: JoinedRoom): number {
  const activityDelta = (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0);

  if (activityDelta !== 0) {
    return activityDelta;
  }

  const nameDelta = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

  if (nameDelta !== 0) {
    return nameDelta;
  }

  return a.roomId.localeCompare(b.roomId);
}

function directRoomSummary(room: Room, userIds: string[]): JoinedDirectRoom {
  const summary = roomSummary(room);

  return {
    ...summary,
    name: resolveDirectRoomName(room, userIds),
    userIds,
  };
}

function pendingDirectInviteSummary(room: Room): PendingDirectRoomInvite | null {
  const inviterUserId = resolveDirectInviteInviter(room);

  if (!inviterUserId) {
    return null;
  }

  const summary = roomSummary(room);

  return {
    ...summary,
    name: resolveDirectRoomName(room, [inviterUserId]),
    inviterUserId,
  };
}

function resolveDirectInviteInviter(room: Room): string | null {
  const dmInviter = room.getDMInviter();

  if (isOtherUserId(dmInviter, room)) {
    return dmInviter;
  }

  if (!isLikelyOneToOneInvite(room)) {
    return null;
  }

  const inviteEvent = room.currentState.getStateEvents(
    EventType.RoomMember,
    room.myUserId,
  );
  const inviteSender = inviteEvent?.getSender();

  if (isOtherUserId(inviteSender, room)) {
    return inviteSender;
  }

  const guessedUserId = room.guessDMUserId();

  return isOtherUserId(guessedUserId, room) ? guessedUserId : null;
}

function isLikelyOneToOneInvite(room: Room): boolean {
  return room.getInvitedAndJoinedMemberCount() === 2;
}

function isOtherUserId(userId: string | undefined, room: Room): userId is string {
  return typeof userId === "string" && userId.length > 0 && userId !== room.myUserId;
}

function resolveRoomName(room: Room): string {
  const name = room.name.trim();

  if (name.length > 0 && name !== room.roomId) {
    return name;
  }

  return room.roomId;
}

function resolveDirectRoomName(room: Room, userIds: string[]): string {
  const name = resolveRoomName(room);

  if (name !== room.roomId) {
    return name;
  }

  const guessedUserId = room.guessDMUserId();

  if (guessedUserId && guessedUserId !== room.myUserId) {
    return guessedUserId;
  }

  return userIds[0] ?? room.roomId;
}

function getDirectRoomUsers(client: MatrixClient): Map<string, string[]> {
  const directEvent = client.getAccountData(EventType.Direct);
  const localContent = directEvent?.getContent<Record<string, unknown>>() ?? {};
  const roomUsers = new Map<string, Set<string>>();

  addDirectRoomUsers(roomUsers, localContent);

  return new Map(
    Array.from(roomUsers.entries()).map(([roomId, userIds]) => [
      roomId,
      Array.from(userIds).sort(),
    ]),
  );
}

function addDirectRoomUsers(
  roomUsers: Map<string, Set<string>>,
  content: Record<string, unknown>,
): void {
  for (const [userId, roomIds] of Object.entries(content)) {
    if (!Array.isArray(roomIds)) {
      continue;
    }

    for (const roomId of roomIds) {
      if (typeof roomId !== "string") {
        continue;
      }

      const users = roomUsers.get(roomId) ?? new Set<string>();
      users.add(userId);
      roomUsers.set(roomId, users);
    }
  }
}
