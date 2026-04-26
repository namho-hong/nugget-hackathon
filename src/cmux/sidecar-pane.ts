import {
  CmuxClient,
  findSurfacePane,
  findWorkspace,
  type CmuxPane,
  type CmuxPaneSurfaceRef,
  type CmuxSurface,
  type CmuxWorkspace,
} from "./client.js";

export async function createThreadAgentSurface(
  cmux: CmuxClient,
  options: {
    sourcePaneRef: string;
    sourceSurfaceRef: string;
    workspace: CmuxWorkspace;
    workspaceRef: string;
  },
): Promise<CmuxPaneSurfaceRef> {
  const existingPane = findThreadAgentPane(options.workspace, options.sourcePaneRef);

  if (existingPane) {
    try {
      return await cmux.newSurface({
        paneRef: existingPane.ref,
        workspaceRef: options.workspaceRef,
      });
    } catch {
      // Stale pane refs should not block opening a fresh sidecar pane.
    }
  }

  const split = await cmux.newSplit("right", {
    surfaceRef: options.sourceSurfaceRef,
    workspaceRef: options.workspaceRef,
  });
  const afterWorkspace = findWorkspace(await cmux.tree({ all: true }), options.workspaceRef);

  if (!afterWorkspace) {
    throw new Error(`cmux workspace ${options.workspaceRef} was not found after split.`);
  }

  const pane = findSurfacePane(afterWorkspace, split.surfaceRef);

  if (!pane) {
    throw new Error(`cmux surface ${split.surfaceRef} has no containing pane.`);
  }

  return pane;
}

function findThreadAgentPane(
  workspace: CmuxWorkspace,
  sourcePaneRef: string,
): CmuxPane | null {
  const panes = workspace.panes ?? [];
  const sourcePane = panes.find((pane) => pane.ref === sourcePaneRef);

  if (sourcePane && isThreadAgentPane(sourcePane)) {
    return sourcePane;
  }

  if (sourcePane && isRightPaneForChatRoom(panes, sourcePane)) {
    return sourcePane;
  }

  if (sourcePane && isChatRoomPane(sourcePane)) {
    const rightPane = findNextPane(panes, sourcePane);

    if (rightPane && !isWorkspaceControllerPane(rightPane)) {
      return rightPane;
    }
  }

  return (
    panes.find((pane) => {
      if (pane.ref === sourcePaneRef) {
        return false;
      }

      return isThreadAgentPane(pane);
    }) ?? null
  );
}

function isThreadAgentPane(pane: CmuxPane): boolean {
  return (pane.surfaces ?? []).some(isThreadAgentSurface);
}

function isRightPaneForChatRoom(panes: readonly CmuxPane[], pane: CmuxPane): boolean {
  if (isChatRoomPane(pane)) {
    return false;
  }

  const leftPane = findPreviousPane(panes, pane);
  return Boolean(leftPane && isChatRoomPane(leftPane));
}

function isChatRoomPane(pane: CmuxPane): boolean {
  return (pane.surfaces ?? []).some((surface) => {
    const haystack = surfaceHaystack(surface);
    return (
      haystack.includes("nugget_dm_room=1") ||
      (haystack.includes("nugget") && /\broom\b/.test(haystack))
    );
  });
}

function isWorkspaceControllerPane(pane: CmuxPane): boolean {
  return (pane.surfaces ?? []).some((surface) =>
    surfaceHaystack(surface).includes("workspace-controller"),
  );
}

function isThreadAgentSurface(surface: CmuxSurface): boolean {
  const haystack = surfaceHaystack(surface);

  return (
    haystack.includes("nugget_thread_pane=1") ||
    haystack.includes("nugget_agent=") ||
    haystack.includes("nugget_agent_prompt_file=") ||
    /\bnugget\b.*\bthread\b/.test(haystack)
  );
}

function findPreviousPane(panes: readonly CmuxPane[], pane: CmuxPane): CmuxPane | null {
  const sortedPanes = sortPanes(panes);
  const index = sortedPanes.findIndex((candidate) => candidate.ref === pane.ref);

  return index > 0 ? sortedPanes[index - 1]! : null;
}

function findNextPane(panes: readonly CmuxPane[], pane: CmuxPane): CmuxPane | null {
  const sortedPanes = sortPanes(panes);
  const index = sortedPanes.findIndex((candidate) => candidate.ref === pane.ref);

  return index >= 0 && index < sortedPanes.length - 1 ? sortedPanes[index + 1]! : null;
}

function sortPanes(panes: readonly CmuxPane[]): CmuxPane[] {
  return panes
    .map((pane, fallbackIndex) => ({ fallbackIndex, pane }))
    .sort((a, b) => paneIndex(a.pane, a.fallbackIndex) - paneIndex(b.pane, b.fallbackIndex))
    .map((item) => item.pane);
}

function paneIndex(pane: CmuxPane, fallbackIndex: number): number {
  return typeof pane.index === "number" && Number.isFinite(pane.index)
    ? pane.index
    : fallbackIndex;
}

function surfaceHaystack(surface: CmuxSurface): string {
  return `${surface.title ?? ""} ${surface.command ?? ""}`.toLowerCase();
}
