import { join } from "node:path";

import {
  CmuxClient,
  findSurfacePane,
  findWorkspace,
  getWorkspaceSurfaces,
  getWorkspaces,
  type CmuxPaneSurfaceRef,
  type CmuxTree,
  type CmuxWorkspace,
} from "./client.js";

const PICKER_RESIZE_AMOUNT = 40;

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
        isRoomSurface(candidate.title ?? "", roomId),
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

    if (existing && (await this.tryFocus(existing))) {
      this.lastRoomSurfaceRef = existing.surfaceRef;
      return;
    }

    this.openedRooms.delete(roomId);

    const beforeTree = await this.cmux.tree({ all: true });
    const beforeWorkspace = requiredWorkspace(beforeTree, this.workspaceRef);
    const beforeSurfaceRefs = new Set(
      getWorkspaceSurfaces(beforeWorkspace).map((surface) => surface.ref),
    );
    const splitFromSurfaceRef = this.lastRoomSurfaceRef ?? this.pickerSurfaceRef;
    const direction = this.lastRoomSurfaceRef ? "down" : "right";

    await this.cmux.newSplit(direction, {
      surfaceRef: splitFromSurfaceRef,
      workspaceRef: this.workspaceRef,
    });

    const afterTree = await this.cmux.tree({ all: true });
    const afterWorkspace = requiredWorkspace(afterTree, this.workspaceRef);
    const newSurface = getWorkspaceSurfaces(afterWorkspace).find(
      (surface) => !beforeSurfaceRefs.has(surface.ref) && surface.type !== "browser",
    );

    if (!newSurface) {
      throw new Error("cmux split succeeded, but Nugget could not find the new surface.");
    }

    const paneRef = findSurfacePane(afterWorkspace, newSurface.ref)?.paneRef;

    if (!paneRef) {
      throw new Error(`cmux surface ${newSurface.ref} has no containing pane.`);
    }

    const command = `${shellQuote(this.nuggetCommand)} room ${shellQuote(roomId)}`;

    await this.cmux.respawnPane({
      command,
      surfaceRef: newSurface.ref,
      workspaceRef: this.workspaceRef,
    });

    const paneSurface = { paneRef, surfaceRef: newSurface.ref };
    this.openedRooms.set(roomId, paneSurface);
    this.lastRoomSurfaceRef = newSurface.ref;
    await this.tryFocus(paneSurface);

    if (direction === "right" && this.pickerPaneRef) {
      this.cmux
        .resizePane({
          amount: PICKER_RESIZE_AMOUNT,
          direction: "left",
          paneRef: this.pickerPaneRef,
          workspaceRef: this.workspaceRef,
        })
        .catch(() => {});
    }
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
}

export async function launchWorkspace(workspace: MatrixWorkspace): Promise<void> {
  const cmux = new CmuxClient();
  const description = workspaceDescription(workspace.roomId);
  let tree = await cmux.tree({ all: true });
  let cmuxWorkspace = findNuggetWorkspace(tree, workspace.roomId, workspace.name);

  if (!cmuxWorkspace) {
    await cmux.newWorkspace({
      cwd: process.cwd(),
      description,
      title: `nugget: ${workspace.name}`,
    });
    tree = await cmux.tree({ all: true });
    cmuxWorkspace = findNuggetWorkspace(tree, workspace.roomId, workspace.name);
  }

  if (!cmuxWorkspace) {
    throw new Error(`Could not create or find cmux workspace for ${workspace.name}.`);
  }

  const controllerSurface = await ensureWorkspaceController(
    cmux,
    cmuxWorkspace,
    workspace.roomId,
  );

  await cmux.selectWorkspace(cmuxWorkspace.ref);
  await cmux.focusPane({
    paneRef: controllerSurface.paneRef,
    workspaceRef: cmuxWorkspace.ref,
  });
  await cmux.focusSurface({
    surfaceRef: controllerSurface.surfaceRef,
    workspaceRef: cmuxWorkspace.ref,
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

function findNuggetWorkspace(
  tree: CmuxTree,
  spaceId: string,
  spaceName: string,
): CmuxWorkspace | null {
  const description = workspaceDescription(spaceId);
  const candidates = getWorkspaces(tree).filter((workspace) => {
    return (
      workspace.description === description ||
      workspace.title === `nugget: ${spaceName}` ||
      workspace.title?.includes(spaceId)
    );
  });

  return (
    candidates.sort((a, b) => workspaceScore(b, spaceId) - workspaceScore(a, spaceId))[0] ??
    null
  );
}

function workspaceScore(workspace: CmuxWorkspace, spaceId: string): number {
  const surfaceTitles = getWorkspaceSurfaces(workspace).map((surface) => surface.title ?? "");
  let score = 0;

  if (workspace.description === workspaceDescription(spaceId)) {
    score += 100;
  }

  if (surfaceTitles.some((title) => title.includes("workspace-controller"))) {
    score += 20;
  }

  if (surfaceTitles.some((title) => title.includes("nugget room"))) {
    score += 10;
  }

  if (workspace.active || workspace.selected) {
    score += 5;
  }

  score += workspace.panes?.length ?? 0;
  return score;
}

async function ensureWorkspaceController(
  cmux: CmuxClient,
  workspace: CmuxWorkspace,
  spaceId: string,
): Promise<CmuxPaneSurfaceRef> {
  const existing = getWorkspaceSurfaces(workspace).find((surface) =>
    (surface.title ?? "").includes("workspace-controller"),
  );
  const targetSurface = existing ?? firstTerminalSurface(workspace);

  if (!targetSurface) {
    throw new Error(`cmux workspace ${workspace.ref} has no terminal surface.`);
  }

  const paneRef = findSurfacePane(workspace, targetSurface.ref)?.paneRef;

  if (!paneRef) {
    throw new Error(`cmux surface ${targetSurface.ref} has no containing pane.`);
  }

  const command =
    `CMUX_WORKSPACE_ID=${shellQuote(workspace.ref)} ` +
    `CMUX_SURFACE_ID=${shellQuote(targetSurface.ref)} ` +
    `${shellQuote(defaultNuggetCommand())} workspace-controller ${shellQuote(spaceId)}`;

  await cmux.respawnPane({
    command,
    surfaceRef: targetSurface.ref,
    workspaceRef: workspace.ref,
  });

  return { paneRef, surfaceRef: targetSurface.ref };
}

function firstTerminalSurface(workspace: CmuxWorkspace) {
  return getWorkspaceSurfaces(workspace).find((surface) => surface.type !== "browser");
}

function requiredWorkspace(tree: CmuxTree, workspaceRef: string): CmuxWorkspace {
  const workspace = findWorkspace(tree, workspaceRef);

  if (!workspace) {
    throw new Error(`cmux workspace ${workspaceRef} was not found.`);
  }

  return workspace;
}

function isRoomSurface(title: string, roomId: string): boolean {
  return title.includes(roomId) && title.includes("room");
}

function workspaceDescription(spaceId: string): string {
  return `nugget-space:${spaceId}`;
}

function defaultNuggetCommand(): string {
  return process.env.NUGGET_BIN ?? join(process.cwd(), "nugget");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
