import {
  EventType,
  type MatrixClient,
} from "matrix-js-sdk";
import type { Room } from "matrix-js-sdk";

import {
  compareRooms,
  getRoomDisplayName,
  isJoinedRoom,
  isSpaceRoom,
  roomSummary,
  type JoinedRoom,
} from "./rooms.js";
import { getRoomMembership, type RoomMembershipState } from "./membership.js";

export interface JoinedSpace extends JoinedRoom {}

export interface PendingSpaceInvite extends JoinedRoom {
  inviterUserId: string;
}

export type SpaceRoomStatus = "joined" | "invited" | "joinable" | "inaccessible";

export interface SpaceRoom extends JoinedRoom {
  status: SpaceRoomStatus;
  viaServers: string[];
}

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

export function getPendingSpaceInvites(client: MatrixClient): PendingSpaceInvite[] {
  return client
    .getRooms()
    .filter((room) => room.getMyMembership() === "invite")
    .filter((room) => isSpaceRoom(room))
    .map((room) => pendingSpaceInviteSummary(room))
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

export async function getSpaceRooms(client: MatrixClient, spaceId: string): Promise<SpaceRoom[]> {
  const space = client.getRoom(spaceId);

  if (!space || !isJoinedRoom(space) || !isSpaceRoom(space)) {
    throw new Error(`Space ${spaceId} is not joined by the current Matrix session.`);
  }

  const childRooms = getSpaceChildRoomsFromState(space);
  const hierarchyRooms = await getHierarchyRooms(client, spaceId);

  return childRooms
    .map((child) => {
      const room = client.getRoom(child.roomId);

      if (room && isSpaceRoom(room)) {
        return null;
      }

      const hierarchyRoom = hierarchyRooms.get(child.roomId);
      const name =
        room !== null
          ? getRoomDisplayName(room)
          : hierarchyRoom?.name ?? hierarchyRoom?.canonical_alias ?? child.roomId;
      const membership = getRoomMembership(client, child.roomId);
      const status = resolveSpaceRoomStatus(membership, hierarchyRoom);

      const lastActivityTs = room?.getLastActiveTimestamp() ?? 0;

      return {
        ...(lastActivityTs > 0 ? { lastActivityTs } : {}),
        name,
        roomId: child.roomId,
        status,
        viaServers: child.viaServers.length > 0 ? child.viaServers : hierarchyRoom?.viaServers ?? [],
      } satisfies SpaceRoom;
    })
    .filter((room): room is SpaceRoom => room !== null)
    .sort(compareRooms);
}

function pendingSpaceInviteSummary(room: Room): PendingSpaceInvite {
  const summary = roomSummary(room);
  const inviteEvent = room.currentState.getStateEvents(
    EventType.RoomMember,
    room.myUserId,
  );
  const inviterUserId = inviteEvent?.getSender() ?? "unknown";

  return {
    ...summary,
    inviterUserId,
  };
}

interface SpaceChildRoom {
  roomId: string;
  viaServers: string[];
}

interface HierarchyRoom {
  name?: string;
  canonical_alias?: string;
  join_rule?: string;
  room_type?: string;
  viaServers: string[];
  world_readable?: boolean;
  guest_can_join?: boolean;
}

function getSpaceChildRoomsFromState(space: Room): SpaceChildRoom[] {
  return space.currentState
    .getStateEvents(EventType.SpaceChild)
    .map((event) => {
      const roomId = event.getStateKey();

      if (!roomId) {
        return null;
      }

      return {
        roomId,
        viaServers: getViaServers(event.getContent<Record<string, unknown>>()),
      };
    })
    .filter((room): room is SpaceChildRoom => room !== null);
}

async function getHierarchyRooms(
  client: MatrixClient,
  spaceId: string,
): Promise<Map<string, HierarchyRoom>> {
  try {
    const response = await client.getRoomHierarchy(spaceId, 200, 1);
    return new Map(
      response.rooms.map((room) => [
        room.room_id,
        {
          ...(room.canonical_alias ? { canonical_alias: room.canonical_alias } : {}),
          ...(room.guest_can_join === undefined
            ? {}
            : { guest_can_join: room.guest_can_join }),
          ...(room.join_rule ? { join_rule: room.join_rule } : {}),
          ...(room.name ? { name: room.name } : {}),
          ...(room.room_type ? { room_type: room.room_type } : {}),
          viaServers: room.children_state.flatMap((child) =>
            getViaServers(child.content as Record<string, unknown>),
          ),
          ...(room.world_readable === undefined
            ? {}
            : { world_readable: room.world_readable }),
        },
      ]),
    );
  } catch {
    return new Map();
  }
}

function resolveSpaceRoomStatus(
  membership: RoomMembershipState,
  hierarchyRoom: HierarchyRoom | undefined,
): SpaceRoomStatus {
  if (membership === "join") {
    return "joined";
  }

  if (membership === "invite") {
    return "invited";
  }

  if (membership === "leave" || membership === "knock" || membership === "unknown") {
    return "joinable";
  }

  if (hierarchyRoom && isJoinableHierarchyRoom(hierarchyRoom)) {
    return "joinable";
  }

  return "inaccessible";
}

function isJoinableHierarchyRoom(room: HierarchyRoom): boolean {
  return (
    room.join_rule === "public" ||
    room.join_rule === "restricted" ||
    room.world_readable === true ||
    room.guest_can_join === true
  );
}

function getViaServers(content: Record<string, unknown>): string[] {
  const via = content.via;

  if (!Array.isArray(via)) {
    return [];
  }

  return via.filter((server): server is string => typeof server === "string");
}
