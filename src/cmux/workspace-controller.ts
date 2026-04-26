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

    if (existing) {
      if (
        (await this.tryRespawnRoom(roomId, existing.surfaceRef)) &&
        (await this.tryFocus(existing))
      ) {
        this.lastRoomSurfaceRef = existing.surfaceRef;
        return;
      }
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

    await this.respawnRoom(roomId, newSurface.ref);

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

async function ensureWorkspaceController(
  cmux: CmuxClient,
  workspace: CmuxWorkspace,
  spaceId: string,
): Promise<CmuxPaneSurfaceRef> {
  const existing = findWorkspaceControllerSurface(workspace, spaceId);
  const targetSurface = existing ?? (await createPickerSurface(cmux, workspace));

  if (!targetSurface) {
    throw new Error(`cmux workspace ${workspace.ref} has no surface for the workspace picker.`);
  }

  let paneRef = findSurfacePane(workspace, targetSurface.ref)?.paneRef;

  if (!paneRef) {
    const refreshedWorkspace = findWorkspace(
      await cmux.tree({ all: true }),
      workspace.ref,
    );
    paneRef = refreshedWorkspace
      ? findSurfacePane(refreshedWorkspace, targetSurface.ref)?.paneRef
      : undefined;
  }

  if (!paneRef) {
    throw new Error(`cmux surface ${targetSurface.ref} has no containing pane.`);
  }

  if (
    existing &&
    (await isWorkspacePickerVisible(cmux, workspace.ref, targetSurface.ref))
  ) {
    return { paneRef, surfaceRef: targetSurface.ref };
  }

  const command =
    `CMUX_WORKSPACE_ID=${shellQuote(workspace.ref)} ` +
    `CMUX_SURFACE_ID=${shellQuote(targetSurface.ref)} ` +
    "NUGGET_IGNORE_INITIAL_ENTER=1 " +
    `${shellQuote(defaultNuggetCommand())} workspace-controller ${shellQuote(spaceId)}`;

  await cmux.respawnPane({
    command,
    surfaceRef: targetSurface.ref,
    workspaceRef: workspace.ref,
  });

  return { paneRef, surfaceRef: targetSurface.ref };
}

async function createPickerSurface(
  cmux: CmuxClient,
  workspace: CmuxWorkspace,
): Promise<{ ref: string; type?: string | null } | null> {
  const firstSurface = firstTerminalSurface(workspace);

  if (!firstSurface) {
    return null;
  }

  if (!hasNuggetRoomSurface(workspace) && !findWorkspaceControllerSurface(workspace)) {
    return firstSurface;
  }

  const split = await cmux.newSplit("left", {
    surfaceRef: firstSurface.ref,
    workspaceRef: workspace.ref,
  });

  return { ref: split.surfaceRef };
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

function findWorkspaceControllerSurface(
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
    const title = surface.title ?? "";
    return title.includes("nugget") && /\broom\b/.test(title);
  });
}

async function isWorkspacePickerVisible(
  cmux: CmuxClient,
  workspaceRef: string,
  surfaceRef: string,
): Promise<boolean> {
  try {
    const screen = await cmux.readScreen({ workspaceRef, surfaceRef, lines: 24 });
    return screen.includes("Workspace:") && screen.includes("Enter opens");
  } catch {
    return false;
  }
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
