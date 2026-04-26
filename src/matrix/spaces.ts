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
