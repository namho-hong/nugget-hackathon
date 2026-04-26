import { join } from "node:path";

import {
  CmuxClient,
  findSurfacePane,
  findWorkspace,
  getWorkspaceSurfaces,
  type CmuxPaneSurfaceRef,
} from "./client.js";

export async function openThreadBesideCurrentSurface(
  roomId: string,
  threadRootEventId: string,
): Promise<void> {
  const cmux = new CmuxClient();
  const beforeTree = await cmux.tree({ all: true });
  const workspaceRef =
    process.env.CMUX_WORKSPACE_ID ??
    beforeTree.caller?.workspace_ref ??
    beforeTree.active?.workspace_ref;
  const surfaceRef =
    process.env.CMUX_SURFACE_ID ??
    beforeTree.caller?.surface_ref ??
    beforeTree.active?.surface_ref;

  if (!workspaceRef || !surfaceRef) {
    throw new Error(
      "Thread panes require cmux. Open this room from `nugget workspace <spaceId>` first.",
    );
  }

  const beforeWorkspace = findWorkspace(beforeTree, workspaceRef);

  if (!beforeWorkspace) {
    throw new Error(`cmux workspace ${workspaceRef} was not found.`);
  }

  const existing = getWorkspaceSurfaces(beforeWorkspace).find((surface) =>
    isThreadSurface(surface, roomId, threadRootEventId),
  );

  if (existing) {
    const pane = findSurfacePane(beforeWorkspace, existing.ref);

    if (pane && (await tryFocusPaneSurface(cmux, workspaceRef, pane))) {
      return;
    }
  }

  const beforeSurfaceRefs = new Set(
    getWorkspaceSurfaces(beforeWorkspace).map((surface) => surface.ref),
  );

  await cmux.newSplit("right", {
    surfaceRef,
    workspaceRef,
  });

  const afterTree = await cmux.tree({ all: true });
  const afterWorkspace = findWorkspace(afterTree, workspaceRef);

  if (!afterWorkspace) {
    throw new Error(`cmux workspace ${workspaceRef} was not found after split.`);
  }

  const newSurface = getWorkspaceSurfaces(afterWorkspace).find(
    (surface) => !beforeSurfaceRefs.has(surface.ref) && surface.type !== "browser",
  );

  if (!newSurface) {
    throw new Error("cmux split succeeded, but Nugget could not find the new thread surface.");
  }

  const pane = findSurfacePane(afterWorkspace, newSurface.ref);

  if (!pane) {
    throw new Error(`cmux surface ${newSurface.ref} has no containing pane.`);
  }

  const command =
    `CMUX_WORKSPACE_ID=${shellQuote(workspaceRef)} ` +
    `CMUX_SURFACE_ID=${shellQuote(newSurface.ref)} ` +
    `${shellQuote(defaultNuggetCommand())} thread ` +
    `${shellQuote(roomId)} ${shellQuote(threadRootEventId)}`;

  await cmux.respawnPane({
    command,
    surfaceRef: newSurface.ref,
    workspaceRef,
  });

  if (!(await tryFocusPaneSurface(cmux, workspaceRef, pane))) {
    throw new Error(`Could not focus new thread surface ${newSurface.ref}.`);
  }
}

function isThreadSurface(
  surface: { title?: string | null; command?: string | null },
  roomId: string,
  threadRootEventId: string,
): boolean {
  const haystack = `${surface.title ?? ""} ${surface.command ?? ""}`;

  return (
    haystack.includes("thread") &&
    haystack.includes(roomId) &&
    haystack.includes(threadRootEventId)
  );
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

async function tryFocusPaneSurface(
  cmux: CmuxClient,
  workspaceRef: string,
  target: CmuxPaneSurfaceRef,
): Promise<boolean> {
  try {
    await focusPaneSurface(cmux, workspaceRef, target);
    return true;
  } catch {
    return false;
  }
}

function defaultNuggetCommand(): string {
  return process.env.NUGGET_BIN ?? join(process.cwd(), "nugget");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
