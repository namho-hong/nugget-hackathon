import { EventType, type MatrixClient } from "matrix-js-sdk";

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

export function getJoinedSpaces(client: MatrixClient): JoinedSpace[] {
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
