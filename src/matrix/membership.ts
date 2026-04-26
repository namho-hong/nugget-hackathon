import {
  ClientEvent,
  EventType,
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
  options: { viaServers?: string[] } = {},
): Promise<string> {
  const target = roomIdOrAlias.trim();

  if (!isMatrixRoomIdOrAlias(target)) {
    throw new Error(`Invalid Matrix room ID or alias: ${roomIdOrAlias}`);
  }

  try {
    const room = await client.joinRoom(target, {
      ...(options.viaServers && options.viaServers.length > 0
        ? { viaServers: options.viaServers }
        : {}),
    });
    await waitForRoomMembership(client, room.roomId, "join");
    return room.roomId;
  } catch (error) {
    throw new Error(`Could not join room ${target}: ${formatError(error)}`);
  }
}

export function getInviteViaServers(
  room: Room | null | undefined,
  userIds: string[] = [],
): string[] {
  const servers = new Set<string>();

  addMatrixIdServer(servers, room?.roomId);

  if (room) {
    const inviteEvent = room.currentState.getStateEvents(
      EventType.RoomMember,
      room.myUserId,
    );

    addMatrixIdServer(servers, inviteEvent?.getSender());
    addMatrixIdServer(servers, room.getDMInviter());
  }

  for (const userId of userIds) {
    addMatrixIdServer(servers, userId);
  }

  return [...servers];
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
    await waitForRoomMembershipNot(client, target, membership);
  } catch (error) {
    throw new Error(`Could not leave room ${target}: ${formatError(error)}`);
  }

  try {
    await removeDirectRoomAccountData(client, target);
  } catch (error) {
    throw new Error(
      `Left room ${target}, but could not update direct chat metadata: ${formatError(error)}`,
    );
  }
}

export async function rejectRoomInvite(client: MatrixClient, roomId: string): Promise<void> {
  const target = roomId.trim();

  if (!isMatrixRoomId(target)) {
    throw new Error(`Invalid Matrix room ID: ${roomId}`);
  }

  const membership = getRoomMembership(client, target);

  if (membership === "missing") {
    throw new Error(`Invite ${target} is not visible in the synced client store.`);
  }

  if (membership !== "invite") {
    throw new Error(
      `Room ${target} cannot be rejected because current membership is ${membership}.`,
    );
  }

  try {
    await client.leave(target);
  } catch (error) {
    throw new Error(`Could not reject invite ${target}: ${formatError(error)}`);
  }

  await forgetRoomBestEffort(client, target);
  await waitForRoomMembershipNot(client, target, "invite", 5_000).catch(() => undefined);
}

export async function removeDirectRoomAccountData(
  client: MatrixClient,
  roomId: string,
): Promise<void> {
  const target = roomId.trim();

  if (!isMatrixRoomId(target)) {
    throw new Error(`Invalid Matrix room ID: ${roomId}`);
  }

  const directEvent = client.getAccountData(EventType.Direct);
  const currentContent = directEvent?.getContent<Record<string, unknown>>() ?? {};
  const nextContent: Record<string, string[]> = {};
  let removed = false;

  for (const [userId, roomIds] of Object.entries(currentContent)) {
    if (!Array.isArray(roomIds)) {
      continue;
    }

    const stringRoomIds = roomIds.filter(
      (candidateRoomId): candidateRoomId is string => typeof candidateRoomId === "string",
    );
    const filteredRoomIds = stringRoomIds.filter(
      (candidateRoomId) => candidateRoomId !== target,
    );

    if (filteredRoomIds.length !== stringRoomIds.length) {
      removed = true;
    }

    if (filteredRoomIds.length > 0) {
      nextContent[userId] = filteredRoomIds;
    }
  }

  if (!removed) {
    return;
  }

  await client.setAccountData(EventType.Direct, nextContent);
}

async function forgetRoomBestEffort(client: MatrixClient, roomId: string): Promise<void> {
  try {
    await client.forget(roomId);
  } catch {
    // Some homeservers only allow forgetting after the next sync observes the leave.
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
  return waitForRoomMembershipNot(client, roomId, "join", timeoutMs);
}

export async function waitForRoomMembershipNot(
  client: MatrixClient,
  roomId: string,
  membership: RoomMembershipState,
  timeoutMs = 30_000,
): Promise<void> {
  const currentMembership = (): RoomMembershipState => getRoomMembership(client, roomId);

  if (currentMembership() !== membership) {
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
          `Timed out waiting for room ${roomId} membership to stop being ${membership} after ${Math.round(
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

      if (lastMembership !== membership) {
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

function addMatrixIdServer(servers: Set<string>, matrixId: string | undefined): void {
  const server = getMatrixIdServer(matrixId);

  if (server) {
    servers.add(server);
  }
}

function getMatrixIdServer(matrixId: string | undefined): string | null {
  if (!matrixId || matrixId.length < 3) {
    return null;
  }

  if (!matrixId.startsWith("!") && !matrixId.startsWith("#") && !matrixId.startsWith("@")) {
    return null;
  }

  const serverSeparator = matrixId.indexOf(":");

  if (serverSeparator < 2 || serverSeparator === matrixId.length - 1) {
    return null;
  }

  return matrixId.slice(serverSeparator + 1);
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
