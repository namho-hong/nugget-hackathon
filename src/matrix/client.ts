import {
  ClientEvent,
  createClient,
  type MatrixClient,
  SyncState,
} from "matrix-js-sdk";

import { loadSession, saveSession, type MatrixSession } from "../store/index.js";
import { refreshAccessToken } from "./login.js";

export function createMatrixClient(session: MatrixSession): MatrixClient {
  return createClient({
    accessToken: session.accessToken,
    baseUrl: session.baseUrl,
    ...(session.deviceId ? { deviceId: session.deviceId } : {}),
    ...(session.refreshToken
      ? {
          refreshToken: session.refreshToken,
          tokenRefreshFunction: async (refreshToken) => {
            const refreshed = await refreshAccessToken({ ...session, refreshToken });
            await saveSession(refreshed);

            return {
              accessToken: refreshed.accessToken,
              ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
            };
          },
        }
      : {}),
    userId: session.userId,
  });
}

export async function startAndSyncClient(
  client: MatrixClient,
  timeoutMs = 30_000,
): Promise<void> {
  const currentState = client.getSyncState();

  if (currentState === SyncState.Prepared || currentState === SyncState.Syncing) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Matrix sync to be ready."));
    }, timeoutMs);

    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      client.off(ClientEvent.Sync, onSync);
    };

    const onSync = (state: SyncState, _previousState: SyncState | null, data?: { error?: Error }): void => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        cleanup();
        resolve();
        return;
      }

      if (state === SyncState.Error) {
        cleanup();
        reject(data?.error ?? new Error("Matrix sync failed before becoming ready."));
      }
    };

    client.on(ClientEvent.Sync, onSync);

    client.startClient({ initialSyncLimit: 20 }).catch((error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}

export async function withMatrixClient<T>(
  fn: (client: MatrixClient, session: MatrixSession) => Promise<T>,
): Promise<T> {
  const session = await loadSession();

  if (!session) {
    throw new Error("Not logged in. Run `nugget login` first.");
  }

  try {
    return await runWithSession(session, fn);
  } catch (error) {
    if (!session.refreshToken || !isAuthError(error)) {
      throw error;
    }

    const refreshed = await refreshAccessToken(session);
    await saveSession(refreshed);
    return runWithSession(refreshed, fn);
  }
}

async function runWithSession<T>(
  session: MatrixSession,
  fn: (client: MatrixClient, session: MatrixSession) => Promise<T>,
): Promise<T> {
  const client = createMatrixClient(session);

  try {
    await startAndSyncClient(client);
    return await fn(client, session);
  } finally {
    client.stopClient();
  }
}

function isAuthError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  return (
    error.errcode === "M_UNKNOWN_TOKEN" ||
    error.httpStatus === 401 ||
    (isRecord(error.data) && error.data.errcode === "M_UNKNOWN_TOKEN")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
