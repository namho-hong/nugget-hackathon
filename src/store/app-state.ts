import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getNuggetConfigDir } from "./session.js";

const APP_STATE_VERSION = 1;
const MAX_RECENTS = 20;
const MAX_DISMISSED_INVITES = 100;

export interface NuggetAppState {
  version: 1;
  recentWorkspaces: RecentWorkspace[];
  recentDms: RecentDm[];
  dismissedInviteRoomIds: string[];
  lastOpenedAt?: number;
}

export interface RecentWorkspace {
  spaceId: string;
  name?: string;
  openedAt: number;
}

export interface RecentDm {
  roomId: string;
  name?: string;
  openedAt: number;
}

export interface AppStateLoadResult {
  path: string;
  state: NuggetAppState;
  warnings: string[];
}

export function getAppStatePath(): string {
  return join(getNuggetConfigDir(), "state.json");
}

export async function loadAppState(): Promise<AppStateLoadResult> {
  const path = getAppStatePath();
  let rawState: string;

  try {
    rawState = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { path, state: emptyAppState(), warnings: [] };
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(rawState) as unknown;
    const state = parseAppState(parsed);

    if (!state) {
      return {
        path,
        state: emptyAppState(),
        warnings: [
          `Ignoring unsupported Nugget app state at ${path}. Run \`nugget reset-state\` to clear it.`,
        ],
      };
    }

    return { path, state, warnings: [] };
  } catch {
    return {
      path,
      state: emptyAppState(),
      warnings: [
        `Ignoring malformed Nugget app state at ${path}. Run \`nugget reset-state\` to clear it.`,
      ],
    };
  }
}

export async function saveAppState(state: NuggetAppState): Promise<void> {
  const path = getAppStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalizeAppState(state), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearAppState(): Promise<void> {
  await rm(getAppStatePath(), { force: true });
}

export async function recordRecentWorkspace(workspace: {
  spaceId: string;
  name?: string;
  openedAt?: number;
}): Promise<void> {
  const { state } = await loadAppState();
  const openedAt = workspace.openedAt ?? Date.now();

  await saveAppState({
    ...state,
    lastOpenedAt: openedAt,
    recentWorkspaces: upsertRecent(
      state.recentWorkspaces,
      { openedAt, spaceId: workspace.spaceId, ...(workspace.name ? { name: workspace.name } : {}) },
      (item) => item.spaceId,
    ),
  });
}

export async function recordRecentDm(dm: {
  roomId: string;
  name?: string;
  openedAt?: number;
}): Promise<void> {
  const { state } = await loadAppState();
  const openedAt = dm.openedAt ?? Date.now();

  await saveAppState({
    ...state,
    lastOpenedAt: openedAt,
    recentDms: upsertRecent(
      state.recentDms,
      { openedAt, roomId: dm.roomId, ...(dm.name ? { name: dm.name } : {}) },
      (item) => item.roomId,
    ),
  });
}

export async function forgetRecentDm(roomId: string): Promise<void> {
  const { state } = await loadAppState();
  const nextState = forgetRecentDmFromState(state, roomId);

  if (nextState === state) {
    return;
  }

  await saveAppState(nextState);
}

export async function dismissInviteRoom(roomId: string): Promise<void> {
  const { state } = await loadAppState();
  const nextState = dismissInviteRoomFromState(state, roomId);

  if (nextState === state) {
    return;
  }

  await saveAppState(nextState);
}

export function dismissInviteRoomFromState(
  state: NuggetAppState,
  roomId: string,
): NuggetAppState {
  const target = roomId.trim();

  if (target.length === 0 || state.dismissedInviteRoomIds.includes(target)) {
    return state;
  }

  return {
    ...(state.lastOpenedAt === undefined ? {} : { lastOpenedAt: state.lastOpenedAt }),
    dismissedInviteRoomIds: normalizeStringIds(
      [target, ...state.dismissedInviteRoomIds],
      MAX_DISMISSED_INVITES,
    ),
    recentDms: state.recentDms,
    recentWorkspaces: state.recentWorkspaces,
    version: state.version,
  };
}

export function forgetRecentDmFromState(
  state: NuggetAppState,
  roomId: string,
): NuggetAppState {
  const recentDms = state.recentDms.filter((recent) => recent.roomId !== roomId);

  if (recentDms.length === state.recentDms.length) {
    return state;
  }

  return {
    ...(state.lastOpenedAt === undefined ? {} : { lastOpenedAt: state.lastOpenedAt }),
    dismissedInviteRoomIds: state.dismissedInviteRoomIds,
    recentDms,
    recentWorkspaces: state.recentWorkspaces,
    version: state.version,
  };
}

export function emptyAppState(): NuggetAppState {
  return {
    dismissedInviteRoomIds: [],
    recentDms: [],
    recentWorkspaces: [],
    version: APP_STATE_VERSION,
  };
}

export function parseAppState(value: unknown): NuggetAppState | null {
  if (!isRecord(value) || value.version !== APP_STATE_VERSION) {
    return null;
  }

  return normalizeAppState({
    ...(typeof value.lastOpenedAt === "number" && Number.isFinite(value.lastOpenedAt)
      ? { lastOpenedAt: value.lastOpenedAt }
      : {}),
    dismissedInviteRoomIds: parseStringIds(value.dismissedInviteRoomIds, MAX_DISMISSED_INVITES),
    recentDms: parseRecentDms(value.recentDms),
    recentWorkspaces: parseRecentWorkspaces(value.recentWorkspaces),
    version: APP_STATE_VERSION,
  });
}

function normalizeAppState(state: NuggetAppState): NuggetAppState {
  return {
    ...(state.lastOpenedAt === undefined ? {} : { lastOpenedAt: state.lastOpenedAt }),
    dismissedInviteRoomIds: normalizeStringIds(
      state.dismissedInviteRoomIds,
      MAX_DISMISSED_INVITES,
    ),
    recentDms: normalizeRecents(state.recentDms, (item) => item.roomId),
    recentWorkspaces: normalizeRecents(state.recentWorkspaces, (item) => item.spaceId),
    version: APP_STATE_VERSION,
  };
}

function parseRecentWorkspaces(value: unknown): RecentWorkspace[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): RecentWorkspace | null => {
      if (!isRecord(item) || typeof item.spaceId !== "string") {
        return null;
      }

      const openedAt = parseOpenedAt(item.openedAt);

      if (openedAt === null) {
        return null;
      }

      return {
        openedAt,
        spaceId: item.spaceId,
        ...(typeof item.name === "string" ? { name: item.name } : {}),
      };
    })
    .filter((item): item is RecentWorkspace => item !== null);
}

function parseStringIds(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return normalizeStringIds(value, maxItems);
}

function parseRecentDms(value: unknown): RecentDm[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): RecentDm | null => {
      if (!isRecord(item) || typeof item.roomId !== "string") {
        return null;
      }

      const openedAt = parseOpenedAt(item.openedAt);

      if (openedAt === null) {
        return null;
      }

      return {
        openedAt,
        roomId: item.roomId,
        ...(typeof item.name === "string" ? { name: item.name } : {}),
      };
    })
    .filter((item): item is RecentDm => item !== null);
}

function parseOpenedAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function upsertRecent<T extends { openedAt: number }>(
  items: readonly T[],
  next: T,
  getId: (item: T) => string,
): T[] {
  const nextId = getId(next);

  return normalizeRecents(
    [next, ...items.filter((item) => getId(item) !== nextId)],
    getId,
  );
}

function normalizeRecents<T extends { openedAt: number }>(
  items: readonly T[],
  getId: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const normalized: T[] = [];

  for (const item of [...items].sort((a, b) => b.openedAt - a.openedAt)) {
    const id = getId(item);

    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push(item);

    if (normalized.length >= MAX_RECENTS) {
      break;
    }
  }

  return normalized;
}

function normalizeStringIds(items: readonly unknown[], maxItems: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of items) {
    if (typeof item !== "string") {
      continue;
    }

    const id = item.trim();

    if (id.length === 0 || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push(id);

    if (normalized.length >= maxItems) {
      break;
    }
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
