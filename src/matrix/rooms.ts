import {
  EventType,
  RoomCreateTypeField,
  RoomType,
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

export function getJoinedDirectRooms(
  client: MatrixClient,
  options: JoinedRoomOptions = {},
): JoinedDirectRoom[] {
  const directRoomUsers = getDirectRoomUsers(client);

  return Array.from(directRoomUsers.entries())
    .map(([roomId, userIds]) => {
      const room = client.getRoom(roomId);

      if (
        !room ||
        !isJoinedRoom(room) ||
        isSpaceRoom(room) ||
        options.excludeRoomIds?.has(roomId)
      ) {
        return null;
      }

      return directRoomSummary(room, userIds);
    })
    .filter((room): room is JoinedDirectRoom => room !== null)
    .sort(compareRooms);
}

export function isJoinedRoom(room: Room): boolean {
  return room.getMyMembership() === "join";
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
  const content = directEvent?.getContent<Record<string, unknown>>() ?? {};
  const roomUsers = new Map<string, Set<string>>();

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

  return new Map(
    Array.from(roomUsers.entries()).map(([roomId, userIds]) => [
      roomId,
      Array.from(userIds).sort(),
    ]),
  );
}
