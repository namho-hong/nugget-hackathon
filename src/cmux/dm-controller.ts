import { join } from "node:path";

import {
  CmuxClient,
  findSurfacePane,
  findWorkspace,
  getWorkspaceSurfaces,
  type CmuxPane,
  type CmuxPaneSurfaceRef,
  type CmuxSurface,
  type CmuxWorkspace,
} from "./client.js";

export async function openDirectRoomBesideCurrentSurface(
  roomId: string,
  options: { knownDirectRoomIds?: ReadonlySet<string> } = {},
): Promise<boolean> {
  if (!hasCmuxContextEnv()) {
    return false;
  }

  const cmux = new CmuxClient();
  const tree = await cmux.tree({ all: true, preserveCallerEnv: true });
  const context = currentCmuxContext(tree);

  if (!context) {
    return false;
  }

  const workspace = findWorkspace(tree, context.workspaceRef);

  if (!workspace) {
    throw new Error(`cmux workspace ${context.workspaceRef} was not found.`);
  }

  const existing = findDirectRoomSurface(workspace, roomId);

  if (existing) {
    const existingPane = findSurfacePane(workspace, existing.ref);

    if (existingPane) {
      await focusPaneSurface(cmux, context.workspaceRef, existingPane);
      return true;
    }
  }

  const sourcePaneRef =
    context.paneRef ?? findSurfacePane(workspace, context.surfaceRef)?.paneRef ?? null;
  const targetPane = findDirectRoomPane(
    workspace,
    sourcePaneRef,
    options.knownDirectRoomIds ?? new Set([roomId]),
  );

  const targetSurface = targetPane
    ? await cmux.newSurface({
        paneRef: targetPane.ref,
        workspaceRef: context.workspaceRef,
      })
    : await createDirectRoomPane(cmux, context.workspaceRef, context.surfaceRef);

  await respawnDirectRoom(cmux, context.workspaceRef, targetSurface.surfaceRef, roomId);
  await focusPaneSurface(cmux, context.workspaceRef, {
    paneRef: targetSurface.paneRef,
    surfaceRef: targetSurface.surfaceRef,
  });

  return true;
}

export async function getOpenDirectRoomIds(
  directRoomIds: ReadonlySet<string>,
): Promise<Set<string>> {
  if (directRoomIds.size === 0 || !hasCmuxContextEnv()) {
    return new Set();
  }

  const cmux = new CmuxClient();
  let tree;

  try {
    tree = await cmux.tree({ all: true, preserveCallerEnv: true });
  } catch {
    return new Set();
  }

  const context = currentCmuxContext(tree);

  if (!context) {
    return new Set();
  }

  const workspace = findWorkspace(tree, context.workspaceRef);

  if (!workspace) {
    return new Set();
  }

  const openRoomIds = new Set<string>();

  for (const surface of getWorkspaceSurfaces(workspace)) {
    for (const roomId of directRoomIds) {
      if (isDirectRoomSurface(surface, roomId)) {
        openRoomIds.add(roomId);
      }
    }
  }

  return openRoomIds;
}

async function createDirectRoomPane(
  cmux: CmuxClient,
  workspaceRef: string,
  surfaceRef: string,
): Promise<CmuxPaneSurfaceRef> {
  const split = await cmux.newSplit("right", {
    surfaceRef,
    workspaceRef,
  });
  const workspace = findWorkspace(await cmux.tree({ all: true }), workspaceRef);

  if (!workspace) {
    throw new Error(`cmux workspace ${workspaceRef} was not found after split.`);
  }

  const pane = findSurfacePane(workspace, split.surfaceRef);

  if (!pane) {
    throw new Error(`cmux surface ${split.surfaceRef} has no containing pane.`);
  }

  return pane;
}

function findDirectRoomPane(
  workspace: CmuxWorkspace,
  sourcePaneRef: string | null,
  knownDirectRoomIds: ReadonlySet<string>,
): CmuxPane | null {
  return (
    (workspace.panes ?? []).find((pane) => {
      if (pane.ref === sourcePaneRef) {
        return false;
      }

      return (pane.surfaces ?? []).some((surface) =>
        isAnyDirectRoomSurface(surface, knownDirectRoomIds),
      );
    }) ?? null
  );
}

function findDirectRoomSurface(
  workspace: CmuxWorkspace,
  roomId: string,
): CmuxSurface | null {
  return (
    getWorkspaceSurfaces(workspace).find((surface) =>
      isDirectRoomSurface(surface, roomId),
    ) ?? null
  );
}

function isAnyDirectRoomSurface(
  surface: CmuxSurface,
  knownDirectRoomIds: ReadonlySet<string>,
): boolean {
  const haystack = surfaceHaystack(surface);

  if (haystack.includes("NUGGET_DM_ROOM=1")) {
    return true;
  }

  for (const roomId of knownDirectRoomIds) {
    if (isDirectRoomSurface(surface, roomId)) {
      return true;
    }
  }

  return false;
}

function isDirectRoomSurface(surface: CmuxSurface, roomId: string): boolean {
  const haystack = surfaceHaystack(surface);

  return haystack.includes(roomId) && /\broom\b/.test(haystack);
}

function surfaceHaystack(surface: CmuxSurface): string {
  return `${surface.title ?? ""} ${surface.command ?? ""}`;
}

async function respawnDirectRoom(
  cmux: CmuxClient,
  workspaceRef: string,
  surfaceRef: string,
  roomId: string,
): Promise<void> {
  const command =
    `CMUX_WORKSPACE_ID=${shellQuote(workspaceRef)} ` +
    `CMUX_SURFACE_ID=${shellQuote(surfaceRef)} ` +
    "NUGGET_DM_ROOM=1 " +
    `NUGGET_DM_ROOM_ID=${shellQuote(roomId)} ` +
    `${shellQuote(defaultNuggetCommand())} room ${shellQuote(roomId)}`;

  await cmux.respawnPane({
    command,
    surfaceRef,
    workspaceRef,
  });
}

async function focusPaneSurface(
  cmux: CmuxClient,
  workspaceRef: string,
  target: CmuxPaneSurfaceRef,
): Promise<void> {
  await cmux.focusPane({
    paneRef: target.paneRef,
    workspaceRef,
  });
  await cmux.focusSurface({
    surfaceRef: target.surfaceRef,
    workspaceRef,
  });
}

function currentCmuxContext(tree: {
  active?: { workspace_ref?: string; pane_ref?: string; surface_ref?: string };
  caller?: { workspace_ref?: string; pane_ref?: string; surface_ref?: string };
}): { workspaceRef: string; paneRef: string | null; surfaceRef: string } | null {
  const workspaceRef =
    process.env.CMUX_WORKSPACE_ID ??
    tree.caller?.workspace_ref ??
    tree.active?.workspace_ref;
  const surfaceRef =
    process.env.CMUX_SURFACE_ID ??
    tree.caller?.surface_ref ??
    tree.active?.surface_ref;
  const paneRef =
    process.env.CMUX_PANE_ID ?? tree.caller?.pane_ref ?? tree.active?.pane_ref ?? null;

  if (!workspaceRef || !surfaceRef) {
    return null;
  }

  return { paneRef, surfaceRef, workspaceRef };
}

function defaultNuggetCommand(): string {
  return process.env.NUGGET_BIN ?? join(process.cwd(), "nugget");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hasCmuxContextEnv(): boolean {
  return Boolean(
    process.env.CMUX_WORKSPACE_ID ||
      process.env.CMUX_SURFACE_ID ||
      process.env.CMUX_PANE_ID,
  );
}
