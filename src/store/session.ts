import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

export interface MatrixSession {
  baseUrl: string;
  accessToken: string;
  refreshToken?: string;
  deviceId?: string;
  userId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSession(value: unknown): MatrixSession | null {
  if (!isRecord(value)) {
    return null;
  }

  const { accessToken, baseUrl, deviceId, refreshToken, userId } = value;

  if (
    typeof accessToken !== "string" ||
    typeof baseUrl !== "string" ||
    typeof userId !== "string"
  ) {
    return null;
  }

  if (deviceId !== undefined && typeof deviceId !== "string") {
    return null;
  }

  if (refreshToken !== undefined && typeof refreshToken !== "string") {
    return null;
  }

  return {
    accessToken,
    baseUrl,
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    userId,
  };
}

export function getSessionPath(): string {
  const appDirName = "nugget";

  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", appDirName, "session.json");
  }

  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, appDirName, "session.json");
  }

  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, appDirName, "session.json");
}

export async function loadSession(): Promise<MatrixSession | null> {
  let rawSession: string;

  try {
    rawSession = await readFile(getSessionPath(), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  try {
    return parseSession(JSON.parse(rawSession));
  } catch {
    return null;
  }
}

export async function saveSession(session: MatrixSession): Promise<void> {
  const sessionPath = getSessionPath();
  await mkdir(dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearSession(): Promise<void> {
  await rm(getSessionPath(), { force: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
