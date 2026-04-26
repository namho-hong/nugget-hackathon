import {
  EventType,
  RoomCreateTypeField,
  RoomType,
  type MatrixClient,
} from "matrix-js-sdk";

import {
  compareRooms,
  isJoinedRoom,
  isSpaceRoom,
  roomSummary,
  type JoinedRoom,
} from "./rooms.js";

export interface JoinedSpace extends JoinedRoom {}

export interface SpaceChildRoomResult {
  roomIds: Set<string>;
  warnings: string[];
}

export async function getJoinedSpaces(client: MatrixClient): Promise<JoinedSpace[]> {
  const spaces = client
    .getRooms()
    .filter((room) => isJoinedRoom(room))
    .filter((room) => isSpaceRoom(room))
    .map((room) => roomSummary(room));

  const knownRoomIds = new Set(spaces.map((space) => space.roomId));
  const joinedRoomIds = await getJoinedRoomIds(client);

  for (const roomId of joinedRoomIds) {
    if (knownRoomIds.has(roomId)) {
      continue;
    }

    const space = await joinedSpaceFromServer(client, roomId);

    if (space) {
      spaces.push(space);
    }
  }

  return spaces.sort(compareRooms);
}

export async function getSpaceChildRoomIds(
  client: MatrixClient,
  spaces: readonly JoinedSpace[],
): Promise<SpaceChildRoomResult> {
  const roomIds = new Set<string>();
  const warnings: string[] = [];

  for (const space of spaces) {
    const localSpace = client.getRoom(space.roomId);

    if (localSpace) {
      for (const event of localSpace.currentState.getStateEvents(EventType.SpaceChild)) {
        const childRoomId = event.getStateKey();

        if (childRoomId) {
          roomIds.add(childRoomId);
        }
      }
    }

    try {
      const hierarchy = await client.getRoomHierarchy(space.roomId, 100, 1, false);

      for (const hierarchyRoom of hierarchy.rooms) {
        if (hierarchyRoom.room_id !== space.roomId) {
          roomIds.add(hierarchyRoom.room_id);
        }
      }
    } catch (error) {
      warnings.push(
        `Could not load Space hierarchy for ${space.name}: ${formatError(error)}`,
      );
    }
  }

  return { roomIds, warnings };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getJoinedRoomIds(client: MatrixClient): Promise<Set<string>> {
  const response = await client.getJoinedRooms();
  return new Set(response.joined_rooms);
}

async function joinedSpaceFromServer(
  client: MatrixClient,
  roomId: string,
): Promise<JoinedSpace | null> {
  try {
    const createContent = await client.getStateEvent(roomId, EventType.RoomCreate, "");

    if (createContent[RoomCreateTypeField] !== RoomType.Space) {
      return null;
    }

    const name = await getRoomNameFromServer(client, roomId);

    return {
      roomId,
      name: name ?? roomId,
    };
  } catch {
    return null;
  }
}

async function getRoomNameFromServer(
  client: MatrixClient,
  roomId: string,
): Promise<string | null> {
  try {
    const content = await client.getStateEvent(roomId, EventType.RoomName, "");
    const name = content.name;

    return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  }
}
