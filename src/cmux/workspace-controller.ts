import { join } from "node:path";

import {
  CmuxClient,
  findSurfacePane,
  findWorkspace,
  getWorkspaceSurfaces,
  getWorkspaces,
  type CmuxPane,
  type CmuxPaneSurfaceRef,
  type CmuxSurface,
  type CmuxTree,
  type CmuxWorkspace,
} from "./client.js";

const DEFAULT_WORKSPACE_COLUMNS = 120;
const EVEN_SPLIT_RATIO = 0.5;
const ROOM_PANE_RATIO = 0.8;
const NUGGET_WORKSPACE_PREFIX = "🟨 nugget:";

export interface MatrixWorkspace {
  roomId: string;
  name: string;
}

export class WorkspaceController {
  private readonly openedRooms = new Map<string, CmuxPaneSurfaceRef>();
  private lastRoomSurfaceRef: string | null = null;
  private pickerPaneRef: string | null = null;

  constructor(
    private readonly cmux: CmuxClient,
    private readonly workspaceRef: string,
    private readonly pickerSurfaceRef: string,
    private readonly nuggetCommand = defaultNuggetCommand(),
  ) {}

  async hydrateOpenRooms(roomIds: readonly string[]): Promise<void> {
    const tree = await this.cmux.tree({ all: true });
    const workspace = requiredWorkspace(tree, this.workspaceRef);
    const pickerPane = findSurfacePane(workspace, this.pickerSurfaceRef);

    this.pickerPaneRef = pickerPane?.paneRef ?? null;

    for (const roomId of roomIds) {
      const surface = getWorkspaceSurfaces(workspace).find((candidate) =>
        isRoomSurface(candidate, roomId),
      );

      if (!surface) {
        continue;
      }

      const paneRef = findSurfacePane(workspace, surface.ref)?.paneRef;

      if (!paneRef) {
        continue;
      }

      this.openedRooms.set(roomId, { paneRef, surfaceRef: surface.ref });
      this.lastRoomSurfaceRef = surface.ref;
    }
  }

  async openRoom(roomId: string): Promise<void> {
    const existing = this.openedRooms.get(roomId);

    if (existing) {
      const respawnSucceeded = await this.tryRespawnRoom(roomId, existing.surfaceRef);
      const focusSucceeded = respawnSucceeded ? await this.tryFocus(existing) : false;

      if (shouldReuseRoomSurface(respawnSucceeded, focusSucceeded)) {
        this.lastRoomSurfaceRef = existing.surfaceRef;
        return;
      }
    }

    this.openedRooms.delete(roomId);

    const beforeTree = await this.cmux.tree({ all: true });
    const beforeWorkspace = requiredWorkspace(beforeTree, this.workspaceRef);
    const targetPane = findReusableRoomPane(
      beforeWorkspace,
      this.pickerPaneRef,
      this.lastRoomSurfaceRef,
    );
    const resizeAmount = targetPane
      ? null
      : roomPaneResizeAmount(process.stdout.columns);
    const paneSurface = targetPane
      ? await this.cmux.newSurface({
          paneRef: targetPane.ref,
          workspaceRef: this.workspaceRef,
        })
      : await this.createRoomPane();

    await this.respawnRoom(roomId, paneSurface.surfaceRef);

    this.openedRooms.set(roomId, paneSurface);
    this.lastRoomSurfaceRef = paneSurface.surfaceRef;
    await this.tryFocus(paneSurface);

    if (!targetPane && this.pickerPaneRef) {
      this.cmux
        .resizePane({
          amount: resizeAmount ?? roomPaneResizeAmount(process.stdout.columns),
          direction: "left",
          paneRef: this.pickerPaneRef,
          workspaceRef: this.workspaceRef,
        })
        .catch(() => {});
    }
  }

  getRoomNotificationTarget(roomId: string): { surfaceRef: string; workspaceRef: string } {
    return {
      surfaceRef: this.openedRooms.get(roomId)?.surfaceRef ?? this.pickerSurfaceRef,
      workspaceRef: this.workspaceRef,
    };
  }

  private async createRoomPane(): Promise<CmuxPaneSurfaceRef> {
    const split = await this.cmux.newSplit("right", {
      surfaceRef: this.pickerSurfaceRef,
      workspaceRef: this.workspaceRef,
    });
    const workspace = findWorkspace(await this.cmux.tree({ all: true }), this.workspaceRef);

    if (!workspace) {
      throw new Error(`cmux workspace ${this.workspaceRef} was not found after split.`);
    }

    const paneSurface = findSurfacePane(workspace, split.surfaceRef);

    if (!paneSurface) {
      throw new Error(`cmux surface ${split.surfaceRef} has no containing pane.`);
    }

    return paneSurface;
  }

  private async tryFocus(target: CmuxPaneSurfaceRef): Promise<boolean> {
    try {
      await this.cmux.focusPane({
        paneRef: target.paneRef,
        workspaceRef: this.workspaceRef,
      });
      await this.cmux.focusSurface({
        surfaceRef: target.surfaceRef,
        workspaceRef: this.workspaceRef,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async tryRespawnRoom(roomId: string, surfaceRef: string): Promise<boolean> {
    try {
      await this.respawnRoom(roomId, surfaceRef);
      return true;
    } catch {
      return false;
    }
  }

  private async respawnRoom(roomId: string, surfaceRef: string): Promise<void> {
    await this.cmux.respawnPane({
      command:
        `CMUX_WORKSPACE_ID=${shellQuote(this.workspaceRef)} ` +
        `CMUX_SURFACE_ID=${shellQuote(surfaceRef)} ` +
        `${shellQuote(this.nuggetCommand)} room ${shellQuote(roomId)}`,
      surfaceRef,
      workspaceRef: this.workspaceRef,
    });
  }
}

export async function launchWorkspace(workspace: MatrixWorkspace): Promise<void> {
  await renameCurrentWorkspace(workspaceTitle(workspace.name));
}

export async function renameCurrentWorkspace(title: string): Promise<void> {
  const cmux = new CmuxClient();
  const tree = await cmux.tree({ all: true, preserveCallerEnv: true });
  const workspaceRef =
    tree.caller?.workspace_ref ??
    tree.active?.workspace_ref ??
    process.env.CMUX_WORKSPACE_ID;

  if (!workspaceRef) {
    return;
  }

  await cmux.renameWorkspace({
    title,
    workspaceRef,
  });
}

export function getRequiredCmuxContext(): CmuxPaneSurfaceRef & { workspaceRef: string } {
  const workspaceRef = process.env.CMUX_WORKSPACE_ID;
  const surfaceRef = process.env.CMUX_SURFACE_ID;

  if (!workspaceRef || !surfaceRef) {
    throw new Error(
      "workspace-controller must run inside cmux with CMUX_WORKSPACE_ID and CMUX_SURFACE_ID.",
    );
  }

  return {
    paneRef: process.env.CMUX_PANE_ID ?? "",
    surfaceRef,
    workspaceRef,
  };
}

export function findNuggetWorkspace(
  tree: CmuxTree,
  spaceId: string,
  spaceName: string,
): CmuxWorkspace | null {
  const description = workspaceDescription(spaceId);
  const candidates = getWorkspaces(tree).filter((workspace) => {
    return (
      workspace.description === description ||
      workspace.title === workspaceTitle(spaceName) ||
      workspace.title === legacyWorkspaceTitle(spaceName) ||
      workspace.title?.includes(spaceId)
    );
  });

  return (
    candidates.sort((a, b) => workspaceScore(b, spaceId) - workspaceScore(a, spaceId))[0] ??
    null
  );
}

export function workspaceScore(workspace: CmuxWorkspace, spaceId: string): number {
  let score = 0;

  if (workspace.description === workspaceDescription(spaceId)) {
    score += 1000;
  }

  if (findWorkspaceControllerSurface(workspace, spaceId)) {
    score += 100;
  } else if (findWorkspaceControllerSurface(workspace)) {
    score += 50;
  }

  if (hasNuggetRoomSurface(workspace)) {
    score += 25;
  }

  if (workspace.active || workspace.selected) {
    score += 10;
  }

  score += workspace.panes?.length ?? 0;
  return score;
}

function requiredWorkspace(tree: CmuxTree, workspaceRef: string): CmuxWorkspace {
  const workspace = findWorkspace(tree, workspaceRef);

  if (!workspace) {
    throw new Error(`cmux workspace ${workspaceRef} was not found.`);
  }

  return workspace;
}

function isRoomSurface(surface: CmuxSurface, roomId: string): boolean {
  const haystack = surfaceHaystack(surface);
  return haystack.includes(roomId) && /\broom\b/.test(haystack);
}

function isAnyRoomSurface(surface: CmuxSurface): boolean {
  return /\broom\b/.test(surfaceHaystack(surface));
}

function surfaceHaystack(surface: CmuxSurface): string {
  return `${surface.title ?? ""} ${surface.command ?? ""}`;
}

export function findReusableRoomPane(
  workspace: CmuxWorkspace,
  pickerPaneRef: string | null,
  preferredSurfaceRef: string | null = null,
): CmuxPane | null {
  if (preferredSurfaceRef) {
    const preferredPane = (workspace.panes ?? []).find(
      (pane) =>
        pane.ref !== pickerPaneRef &&
        (pane.surfaces ?? []).some((surface) => surface.ref === preferredSurfaceRef),
    );

    if (preferredPane) {
      return preferredPane;
    }
  }

  return (
    (workspace.panes ?? []).find((pane) => {
      if (pane.ref === pickerPaneRef) {
        return false;
      }

      return (pane.surfaces ?? []).some((surface) => isAnyRoomSurface(surface));
    }) ?? null
  );
}

export function findWorkspaceControllerSurface(
  workspace: CmuxWorkspace,
  spaceId?: string,
): { ref: string; type?: string | null } | null {
  return (
    getWorkspaceSurfaces(workspace).find((surface) => {
      const title = surface.title ?? "";
      return title.includes("workspace-controller") && (!spaceId || title.includes(spaceId));
    }) ?? null
  );
}

function hasNuggetRoomSurface(workspace: CmuxWorkspace): boolean {
  return getWorkspaceSurfaces(workspace).some((surface) => {
    const haystack = surfaceHaystack(surface);
    return haystack.includes("nugget") && /\broom\b/.test(haystack);
  });
}

export function shouldReuseRoomSurface(
  respawnSucceeded: boolean,
  focusSucceeded: boolean,
): boolean {
  return respawnSucceeded && focusSucceeded;
}

export function roomPaneResizeAmount(columns: number | undefined): number {
  const sourceColumns =
    typeof columns === "number" && Number.isFinite(columns) && columns > 0
      ? columns
      : DEFAULT_WORKSPACE_COLUMNS;

  return Math.max(
    1,
    Math.round(sourceColumns * (ROOM_PANE_RATIO - EVEN_SPLIT_RATIO)),
  );
}

export function workspaceDescription(spaceId: string): string {
  return `nugget-space:${spaceId}`;
}

export function workspaceTitle(spaceName: string): string {
  return `${NUGGET_WORKSPACE_PREFIX} ${spaceName}`;
}

function legacyWorkspaceTitle(spaceName: string): string {
  return `nugget: ${spaceName}`;
}

function defaultNuggetCommand(): string {
  return process.env.NUGGET_BIN ?? join(process.cwd(), "nugget");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
