import {
  ClientEvent,
  EventType,
  RoomEvent,
  SyncState,
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

export function getSpaceDisplayName(room: Room, fallbackName?: string): string {
  const explicitName = getExplicitRoomName(room);

  if (explicitName) {
    return explicitName;
  }

  const fallback = fallbackName?.trim();

  if (fallback) {
    return fallback;
  }

  return getRoomDisplayName(room);
}

export async function getSpaceStateName(
  client: MatrixClient,
  spaceId: string,
): Promise<string | null> {
  try {
    const content = await client.getStateEvent(spaceId, EventType.RoomName, "");

    if (!isRecord(content)) {
      return null;
    }

    return normalizeName(content.name);
  } catch {
    return null;
  }
}

export async function getJoinedSpaces(client: MatrixClient): Promise<JoinedSpace[]> {
  return client
    .getRooms()
    .filter((room) => isJoinedRoom(room))
    .filter((room) => isSpaceRoom(room))
    .map((room) => spaceSummary(room))
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

export async function waitForJoinedSpace(
  client: MatrixClient,
  spaceId: string,
  timeoutMs = 30_000,
): Promise<JoinedSpace> {
  type JoinedSpaceWaitState =
    | { kind: "ready"; room: Room; status: string }
    | { kind: "waiting"; status: string };

  const currentSpace = (): JoinedSpaceWaitState => {
    const room = client.getRoom(spaceId);

    if (!room) {
      return { kind: "waiting", status: "missing" };
    }

    const membership = room.getMyMembership() ?? "unknown";

    if (membership !== "join") {
      return { kind: "waiting", status: membership };
    }

    if (!isSpaceRoom(room)) {
      return { kind: "waiting", status: "join without Space state" };
    }

    return { kind: "ready", room, status: "ready" };
  };

  const initial = currentSpace();

  if (initial.kind === "ready") {
    return spaceSummary(initial.room);
  }

  return await new Promise<JoinedSpace>((resolve, reject) => {
    let lastStatus = initial.status;
    let lastState = client.getSyncState() ?? "none";
    let lastError: Error | undefined;
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for Space ${spaceId} to become a joined Space after ${Math.round(
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
      client.off(ClientEvent.Sync, onSync);
      client.off(RoomEvent.MyMembership, onMembership);
    };

    const check = (): void => {
      const next = currentSpace();
      lastStatus = next.status;

      if (next.kind === "ready") {
        cleanup();
        resolve(spaceSummary(next.room));
      }
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
      if (room.roomId !== spaceId) {
        return;
      }

      lastStatus = nextMembership;
      check();
    };

    client.on(ClientEvent.Sync, onSync);
    client.on(RoomEvent.MyMembership, onMembership);
    check();
  });
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

  const hierarchy = await getHierarchyRooms(client, spaceId);
  const childRooms = mergeSpaceChildRooms(
    getSpaceChildRoomsFromState(space),
    hierarchy.children,
  );
  const hierarchyRooms = hierarchy.rooms;

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
  const summary = spaceSummary(room);
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

function spaceSummary(room: Room): JoinedSpace {
  const summary = roomSummary(room);

  return {
    ...summary,
    name: getSpaceDisplayName(room),
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

interface HierarchyResult {
  rooms: Map<string, HierarchyRoom>;
  children: SpaceChildRoom[];
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
): Promise<HierarchyResult> {
  try {
    const response = await client.getRoomHierarchy(spaceId, 200, 1);
    const rooms = new Map(
      response.rooms.map((room) => [room.room_id, hierarchyRoomSummary(room)]),
    );
    const root = response.rooms.find((room) => room.room_id === spaceId);
    const children =
      root === undefined
        ? hierarchyFallbackChildren(response.rooms, spaceId)
        : root.children_state
            .map((child) => {
              const roomId = child.state_key;

              if (!roomId) {
                return null;
              }

              return {
                roomId,
                viaServers: getViaServers(child.content as Record<string, unknown>),
              };
            })
            .filter((child): child is SpaceChildRoom => child !== null);

    for (const child of children) {
      const room = rooms.get(child.roomId);

      if (room) {
        room.viaServers = mergeViaServers(room.viaServers, child.viaServers);
      }
    }

    return { children, rooms };
  } catch {
    return { children: [], rooms: new Map() };
  }
}

function hierarchyRoomSummary(room: {
  canonical_alias?: string;
  guest_can_join?: boolean;
  join_rule?: string;
  name?: string;
  room_type?: string;
  world_readable?: boolean;
}): HierarchyRoom {
  return {
    ...(room.canonical_alias ? { canonical_alias: room.canonical_alias } : {}),
    ...(room.guest_can_join === undefined
      ? {}
      : { guest_can_join: room.guest_can_join }),
    ...(room.join_rule ? { join_rule: room.join_rule } : {}),
    ...(room.name ? { name: room.name } : {}),
    ...(room.room_type ? { room_type: room.room_type } : {}),
    viaServers: [],
    ...(room.world_readable === undefined
      ? {}
      : { world_readable: room.world_readable }),
  };
}

function hierarchyFallbackChildren(
  rooms: Array<{ room_id: string; room_type?: string }>,
  spaceId: string,
): SpaceChildRoom[] {
  return rooms
    .filter((room) => room.room_id !== spaceId)
    .filter((room) => room.room_type !== "m.space")
    .map((room) => ({
      roomId: room.room_id,
      viaServers: [],
    }));
}

function mergeSpaceChildRooms(
  primary: readonly SpaceChildRoom[],
  secondary: readonly SpaceChildRoom[],
): SpaceChildRoom[] {
  const rooms = new Map<string, SpaceChildRoom>();

  for (const child of [...primary, ...secondary]) {
    const existing = rooms.get(child.roomId);

    if (!existing) {
      rooms.set(child.roomId, {
        roomId: child.roomId,
        viaServers: [...child.viaServers],
      });
      continue;
    }

    existing.viaServers = mergeViaServers(existing.viaServers, child.viaServers);
  }

  return Array.from(rooms.values());
}

function mergeViaServers(
  primary: readonly string[],
  secondary: readonly string[],
): string[] {
  return Array.from(new Set([...primary, ...secondary]));
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

function getExplicitRoomName(room: Room): string | null {
  const event = room.currentState.getStateEvents(EventType.RoomName, "");
  const content = event?.getContent<Record<string, unknown>>() ?? {};

  return normalizeName(content.name);
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const name = value.trim();

  return name.length > 0 ? name : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
