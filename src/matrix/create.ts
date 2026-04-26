import {
  ClientEvent,
  EventType,
  Preset,
  RoomType,
  Visibility,
  type MatrixClient,
} from "matrix-js-sdk";

import { formatErrorMessage } from "../util/errors.js";
import { findJoinedDirectRoomForUser } from "./rooms.js";

export interface CreatedRoom {
  roomId: string;
  name: string;
}

export interface CreateRoomOptions {
  name: string;
  spaceId?: string;
}

export interface LinkRoomToSpaceOptions {
  suggested?: boolean;
  childVia?: string[];
  parentVia?: string[];
}

export async function createSpace(
  client: MatrixClient,
  name: string,
): Promise<CreatedRoom> {
  const cleanName = validateRoomName(name, "workspace name");

  let response: { room_id: string };

  try {
    response = await client.createRoom({
      creation_content: { type: RoomType.Space },
      name: cleanName,
      preset: Preset.PrivateChat,
      visibility: Visibility.Private,
    });
  } catch (error) {
    throw new Error(`Could not create Matrix Space "${cleanName}": ${formatError(error)}`);
  }

  await waitForRoom(client, response.room_id, {
    description: `created Space ${response.room_id}`,
  });

  return { name: cleanName, roomId: response.room_id };
}

export async function createRoom(
  client: MatrixClient,
  options: CreateRoomOptions,
): Promise<CreatedRoom> {
  const cleanName = validateRoomName(options.name, "room name");

  let response: { room_id: string };

  try {
    response = await client.createRoom({
      name: cleanName,
      preset: Preset.PrivateChat,
      visibility: Visibility.Private,
    });
  } catch (error) {
    const spaceContext = options.spaceId ? ` for Space ${options.spaceId}` : "";
    throw new Error(
      `Could not create Matrix room "${cleanName}"${spaceContext}: ${formatError(error)}`,
    );
  }

  const createdRoom = { name: cleanName, roomId: response.room_id };

  await waitForRoom(client, createdRoom.roomId, {
    description: `created room ${createdRoom.roomId}`,
  });

  if (options.spaceId) {
    try {
      await linkRoomToSpace(client, options.spaceId, createdRoom.roomId);
    } catch (error) {
      throw new Error(
        `Created room ${createdRoom.roomId}, but could not link it to Space ${options.spaceId}: ${formatError(error)}`,
      );
    }
  }

  return createdRoom;
}

export async function createDirectRoom(
  client: MatrixClient,
  userId: string,
): Promise<CreatedRoom> {
  const targetUserId = validateUserId(userId);
  const existingRoom = findJoinedDirectRoomForUser(client, targetUserId);

  if (existingRoom && (await isJoinedOnServer(client, existingRoom.roomId))) {
    await ensureDirectRoomInvite(client, existingRoom.roomId, targetUserId);
    return { name: existingRoom.name, roomId: existingRoom.roomId };
  }

  let response: { room_id: string };

  try {
    response = await client.createRoom({
      invite: [targetUserId],
      is_direct: true,
      preset: Preset.PrivateChat,
      visibility: Visibility.Private,
    });
  } catch (error) {
    throw new Error(`Could not create DM and invite ${targetUserId}: ${formatError(error)}`);
  }

  const roomId = response.room_id;

  try {
    await addDirectRoomAccountData(client, targetUserId, roomId);
  } catch (error) {
    throw new Error(
      `Created DM room ${roomId} and invited ${targetUserId}, but could not update m.direct account data: ${formatError(error)}`,
    );
  }

  await waitForRoom(client, roomId, {
    description: `created DM room ${roomId}`,
  });

  return { name: targetUserId, roomId };
}

export async function linkRoomToSpace(
  client: MatrixClient,
  spaceId: string,
  roomId: string,
  options: LinkRoomToSpaceOptions = {},
): Promise<void> {
  const childVia = options.childVia ?? [deriveVia(roomId)];
  const parentVia = options.parentVia ?? [deriveVia(spaceId)];

  if (!hasStateEvent(client, spaceId, EventType.SpaceChild, roomId)) {
    try {
      await client.sendStateEvent(
        spaceId,
        EventType.SpaceChild,
        {
          suggested: options.suggested ?? true,
          via: childVia,
        },
        roomId,
      );
    } catch (error) {
      throw new Error(
        `Could not link room ${roomId} to Space ${spaceId} with m.space.child: ${formatError(error)}`,
      );
    }
  }

  if (!hasStateEvent(client, roomId, EventType.SpaceParent, spaceId)) {
    try {
      await client.sendStateEvent(
        roomId,
        EventType.SpaceParent,
        {
          canonical: true,
          via: parentVia,
        },
        spaceId,
      );
    } catch (error) {
      throw new Error(
        `Wrote or found m.space.child on ${spaceId}, but could not write m.space.parent on ${roomId}: ${formatError(error)}`,
      );
    }
  }
}

export function deriveVia(roomIdOrUserId: string): string {
  const separatorIndex = roomIdOrUserId.indexOf(":");

  if (separatorIndex < 0 || separatorIndex === roomIdOrUserId.length - 1) {
    throw new Error(`Could not derive Matrix server name from ${roomIdOrUserId}.`);
  }

  return roomIdOrUserId.slice(separatorIndex + 1);
}

export async function addDirectRoomAccountData(
  client: MatrixClient,
  userId: string,
  roomId: string,
): Promise<void> {
  const directEvent = client.getAccountData(EventType.Direct);
  const currentContent = directEvent?.getContent<Record<string, unknown>>() ?? {};
  const nextContent: Record<string, string[]> = {};

  for (const [existingUserId, roomIds] of Object.entries(currentContent)) {
    if (!Array.isArray(roomIds)) {
      continue;
    }

    nextContent[existingUserId] = roomIds.filter(
      (existingRoomId): existingRoomId is string => typeof existingRoomId === "string",
    );
  }

  const existingRoomIds = nextContent[userId] ?? [];
  nextContent[userId] = [
    roomId,
    ...existingRoomIds.filter((existingRoomId) => existingRoomId !== roomId),
  ];

  await client.setAccountData(EventType.Direct, nextContent);
}

function hasStateEvent(
  client: MatrixClient,
  roomId: string,
  eventType: EventType,
  stateKey: string,
): boolean {
  return client.getRoom(roomId)?.currentState.getStateEvents(eventType, stateKey) != null;
}

async function isJoinedOnServer(client: MatrixClient, roomId: string): Promise<boolean> {
  const userId = client.getUserId();

  if (!userId) {
    return false;
  }

  try {
    const content = await client.getStateEvent(roomId, EventType.RoomMember, userId);
    return content.membership === "join";
  } catch {
    return false;
  }
}

async function ensureDirectRoomInvite(
  client: MatrixClient,
  roomId: string,
  targetUserId: string,
): Promise<void> {
  const membership = await getMemberMembership(client, roomId, targetUserId);

  if (membership === "join" || membership === "invite") {
    return;
  }

  try {
    await client.invite(roomId, targetUserId);
  } catch (error) {
    throw new Error(
      `Found existing DM room ${roomId}, but could not invite ${targetUserId}: ${formatError(error)}`,
    );
  }
}

async function getMemberMembership(
  client: MatrixClient,
  roomId: string,
  userId: string,
): Promise<string | null> {
  const localMembership = client.getRoom(roomId)?.getMember(userId)?.membership;

  if (typeof localMembership === "string") {
    return localMembership;
  }

  try {
    const content = await client.getStateEvent(roomId, EventType.RoomMember, userId);
    return typeof content.membership === "string" ? content.membership : null;
  } catch {
    return null;
  }
}

async function waitForRoom(
  client: MatrixClient,
  roomId: string,
  options: { description: string; timeoutMs?: number } = { description: "room" },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  if (client.getRoom(roomId)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${options.description} to appear in local Matrix sync.`,
        ),
      );
    }, timeoutMs);

    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      client.off(ClientEvent.Room, onRoom);
    };

    const onRoom = (room: { roomId: string }): void => {
      if (room.roomId !== roomId) {
        return;
      }

      cleanup();
      resolve();
    };

    client.on(ClientEvent.Room, onRoom);
  });
}

function validateRoomName(name: string, label: string): string {
  const cleanName = name.trim();

  if (cleanName.length === 0) {
    throw new Error(`A ${label} is required.`);
  }

  return cleanName;
}

function validateUserId(userId: string): string {
  const cleanUserId = userId.trim();

  if (!/^@[^:\s]+:.+$/.test(cleanUserId)) {
    throw new Error(`Invalid Matrix user ID: ${userId}`);
  }

  return cleanUserId;
}

function formatError(error: unknown): string {
  return formatErrorMessage(error);
}
