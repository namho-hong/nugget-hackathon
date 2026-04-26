import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { platform } from "node:os";
import { createClient, SSOAction } from "matrix-js-sdk";
import type { IRefreshTokenResponse, LoginResponse } from "matrix-js-sdk";

import type { MatrixSession } from "../store/index.js";
import { silentMatrixLogger, withSuppressedMatrixConsole } from "./logger.js";

export const DEFAULT_BASE_URL = "https://matrix-client.matrix.org";

export type LoginAction = "login" | "register";

export interface LoginTokenListener {
  loginToken: Promise<string>;
  redirectUrl: string;
  close: () => Promise<void>;
}

export interface LoginWithSsoOptions {
  onLoginUrl?: (url: string) => void;
}

function matrixAction(action: LoginAction): SSOAction {
  return action === "register" ? SSOAction.REGISTER : SSOAction.LOGIN;
}

export async function loginWithSso(
  action: LoginAction = "login",
  options: LoginWithSsoOptions = {},
): Promise<MatrixSession> {
  const listener = await waitForLoginToken();
  const client = createClient({ baseUrl: DEFAULT_BASE_URL, logger: silentMatrixLogger });
  const loginUrl = client.getSsoLoginUrl(listener.redirectUrl, "sso", undefined, matrixAction(action));
  options.onLoginUrl?.(loginUrl);

  try {
    await openBrowser(loginUrl);
  } catch (error) {
    await listener.close();
    throw new Error(
      `Could not open a browser automatically. Open this URL manually:\n${loginUrl}\n\n${errorMessage(error)}`,
    );
  }

  try {
    const loginToken = await listener.loginToken;
    return await exchangeLoginToken(loginToken);
  } finally {
    await listener.close();
  }
}

export async function waitForLoginToken(callbackPort = 0): Promise<LoginTokenListener> {
  let resolveToken!: (loginToken: string) => void;
  let rejectToken!: (error: Error) => void;
  let settled = false;

  const loginToken = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = createServer((request, response) => {
    handleLoginCallback(request, response, {
      reject: rejectToken,
      resolve: resolveToken,
      settled: () => settled,
      setSettled: () => {
        settled = true;
      },
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not determine Matrix login callback port.");
  }

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectToken(new Error("Timed out waiting for Matrix login callback."));
    }
  }, 5 * 60 * 1000);

  timeout.unref();

  return {
    loginToken,
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    close: async () => {
      clearTimeout(timeout);
      await closeServer(server);
    },
  };
}

export async function exchangeLoginToken(loginToken: string): Promise<MatrixSession> {
  return withSuppressedMatrixConsole(async () => {
    const client = createClient({ baseUrl: DEFAULT_BASE_URL, logger: silentMatrixLogger });
    const response = await client.loginRequest({
      initial_device_display_name: "Nugget",
      refresh_token: true,
      token: loginToken,
      type: "m.login.token",
    });

    return sessionFromLoginResponse(response, DEFAULT_BASE_URL);
  });
}

export async function refreshAccessToken(session: MatrixSession): Promise<MatrixSession> {
  if (!session.refreshToken) {
    throw new Error("Session has no refresh token.");
  }

  const { refreshToken } = session;
  const client = createClient({
    accessToken: session.accessToken,
    baseUrl: session.baseUrl,
    logger: silentMatrixLogger,
    refreshToken,
    userId: session.userId,
    ...(session.deviceId ? { deviceId: session.deviceId } : {}),
  });

  return withSuppressedMatrixConsole(async () => {
    const response = await client.refreshToken(refreshToken);
    return sessionFromRefreshResponse(response, session);
  });
}

function handleLoginCallback(
  request: IncomingMessage,
  response: ServerResponse,
  callbacks: {
    reject: (error: Error) => void;
    resolve: (loginToken: string) => void;
    settled: () => boolean;
    setSettled: () => void;
  },
): void {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const loginToken = requestUrl.searchParams.get("loginToken");

  if (callbacks.settled()) {
    response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
    response.end("Matrix login callback already handled.\n");
    return;
  }

  callbacks.setSettled();

  if (!loginToken) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Missing Matrix loginToken. Return to Nugget and try login again.\n");
    callbacks.reject(new Error("Matrix login callback did not include loginToken."));
    return;
  }

  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("Matrix login complete. You can return to Nugget.\n");
  callbacks.resolve(loginToken);
}

async function openBrowser(url: string): Promise<void> {
  const command = browserCommand(url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function browserCommand(url: string): { command: string; args: string[] } {
  if (platform() === "darwin") {
    return { command: "open", args: [url] };
  }

  if (platform() === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

function sessionFromLoginResponse(response: LoginResponse, baseUrl: string): MatrixSession {
  return {
    accessToken: response.access_token,
    baseUrl,
    ...(response.device_id ? { deviceId: response.device_id } : {}),
    ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
    userId: response.user_id,
  };
}

function sessionFromRefreshResponse(
  response: IRefreshTokenResponse,
  session: MatrixSession,
): MatrixSession {
  return {
    ...session,
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
  };
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
