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

export class SessionFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "SessionFileError";
  }
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

export function getNuggetConfigDir(): string {
  const appDirName = "nugget";

  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", appDirName);
  }

  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, appDirName);
  }

  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, appDirName);
}

export function getSessionPath(): string {
  return join(getNuggetConfigDir(), "session.json");
}

export async function loadSession(): Promise<MatrixSession | null> {
  let rawSession: string;
  const sessionPath = getSessionPath();

  try {
    rawSession = await readFile(sessionPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  try {
    const parsed = parseSession(JSON.parse(rawSession));

    if (!parsed) {
      throw new SessionFileError(
        `Saved Matrix session at ${sessionPath} is missing required fields. Run \`nugget logout\` to clear it, then \`nugget login\` again.`,
        sessionPath,
      );
    }

    return parsed;
  } catch (error) {
    if (error instanceof SessionFileError) {
      throw error;
    }

    throw new SessionFileError(
      `Saved Matrix session at ${sessionPath} is not valid JSON. Run \`nugget logout\` to clear it, then \`nugget login\` again.`,
      sessionPath,
    );
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
