import {
  EventType,
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
  return client
    .getRooms()
    .filter((room) => isJoinedRoom(room))
    .filter((room) => isSpaceRoom(room))
    .map((room) => roomSummary(room))
    .sort(compareRooms);
}

export async function getSpaceChildRoomIds(
  client: MatrixClient,
  spaces: readonly JoinedSpace[],
): Promise<SpaceChildRoomResult> {
  const roomIds = new Set<string>();

  for (const space of spaces) {
    const localSpace = client.getRoom(space.roomId);

    for (const event of localSpace?.currentState.getStateEvents(EventType.SpaceChild) ?? []) {
      const childRoomId = event.getStateKey();

      if (childRoomId) {
        roomIds.add(childRoomId);
      }
    }
  }

  return { roomIds, warnings: [] };
}

export function getJoinedSpaceRooms(client: MatrixClient, spaceId: string): JoinedRoom[] {
  const space = client.getRoom(spaceId);

  if (!space || !isJoinedRoom(space) || !isSpaceRoom(space)) {
    throw new Error(`Space ${spaceId} is not joined by the current Matrix session.`);
  }

  const roomIds = new Set<string>();

  for (const event of space.currentState.getStateEvents(EventType.SpaceChild)) {
    const roomId = event.getStateKey();

    if (roomId) {
      roomIds.add(roomId);
    }
  }

  return Array.from(roomIds)
    .map((roomId) => client.getRoom(roomId))
    .filter((room) => room !== null)
    .filter((room) => isJoinedRoom(room))
    .filter((room) => !isSpaceRoom(room))
    .map((room) => roomSummary(room))
    .sort(compareRooms);
}
