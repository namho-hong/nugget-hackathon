import {
  ClientEvent,
  RoomEvent,
  SyncState,
  type MatrixClient,
} from "matrix-js-sdk";
import type { Room } from "matrix-js-sdk";

import { formatErrorMessage } from "../util/errors.js";
import { waitForRoomMembership } from "./client.js";

export type RoomMembershipState =
  | "join"
  | "invite"
  | "leave"
  | "ban"
  | "knock"
  | "missing"
  | "unknown";

export async function joinRoom(
  client: MatrixClient,
  roomIdOrAlias: string,
): Promise<string> {
  const target = roomIdOrAlias.trim();

  if (!isMatrixRoomIdOrAlias(target)) {
    throw new Error(`Invalid Matrix room ID or alias: ${roomIdOrAlias}`);
  }

  try {
    const room = await client.joinRoom(target);
    await waitForRoomMembership(client, room.roomId, "join");
    return room.roomId;
  } catch (error) {
    throw new Error(`Could not join room ${target}: ${formatError(error)}`);
  }
}

export async function leaveRoom(client: MatrixClient, roomId: string): Promise<void> {
  const target = roomId.trim();

  if (!isMatrixRoomId(target)) {
    throw new Error(`Invalid Matrix room ID: ${roomId}`);
  }

  const membership = getRoomMembership(client, target);

  if (membership === "missing") {
    throw new Error(`Room ${target} is not visible in the synced client store.`);
  }

  if (membership !== "join" && membership !== "invite" && membership !== "knock") {
    throw new Error(`Room ${target} cannot be left because current membership is ${membership}.`);
  }

  try {
    await client.leave(target);
    await waitForRoomNotJoined(client, target);
  } catch (error) {
    throw new Error(`Could not leave room ${target}: ${formatError(error)}`);
  }
}

export async function inviteToRoom(
  client: MatrixClient,
  roomId: string,
  userId: string,
): Promise<void> {
  const targetRoomId = roomId.trim();
  const targetUserId = userId.trim();

  if (!isMatrixRoomId(targetRoomId)) {
    throw new Error(`Invalid Matrix room ID: ${roomId}`);
  }

  if (!isMatrixUserId(targetUserId)) {
    throw new Error(`Invalid Matrix user ID: ${userId}`);
  }

  try {
    await client.invite(targetRoomId, targetUserId);
  } catch (error) {
    throw new Error(
      `Could not invite ${targetUserId} to room ${targetRoomId}: ${formatError(error)}`,
    );
  }
}

export function getRoomMembership(
  client: MatrixClient,
  roomId: string,
): RoomMembershipState {
  const membership = client.getRoom(roomId)?.getMyMembership();

  if (isRoomMembershipState(membership)) {
    return membership;
  }

  return membership === undefined ? "missing" : "unknown";
}

export async function waitForRoomNotJoined(
  client: MatrixClient,
  roomId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const currentMembership = (): RoomMembershipState => getRoomMembership(client, roomId);

  if (currentMembership() !== "join") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let lastMembership = currentMembership();
    let lastState = client.getSyncState() ?? "none";
    let lastError: Error | undefined;
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for room ${roomId} to stop being joined after ${Math.round(
            timeoutMs / 1000,
          )}s. Last membership: ${lastMembership}; last sync state: ${lastState}${
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
      lastMembership = currentMembership();

      if (lastMembership !== "join") {
        cleanup();
        resolve();
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
      if (room.roomId !== roomId) {
        return;
      }

      lastMembership = isRoomMembershipState(nextMembership) ? nextMembership : "unknown";
      check();
    };

    client.on(ClientEvent.Sync, onSync);
    client.on(RoomEvent.MyMembership, onMembership);
    check();
  });
}

export function isMatrixUserId(value: string): boolean {
  return /^@[^:\s]+:.+$/.test(value);
}

function isMatrixRoomId(value: string): boolean {
  return /^![^:\s]+:.+$/.test(value);
}

function isMatrixRoomAlias(value: string): boolean {
  return /^#[^:\s]+:.+$/.test(value);
}

function isMatrixRoomIdOrAlias(value: string): boolean {
  return isMatrixRoomId(value) || isMatrixRoomAlias(value);
}

function isRoomMembershipState(
  value: unknown,
): value is Exclude<RoomMembershipState, "missing" | "unknown"> {
  return (
    value === "join" ||
    value === "invite" ||
    value === "leave" ||
    value === "ban" ||
    value === "knock"
  );
}

function formatError(error: unknown): string {
  return formatErrorMessage(error);
}
