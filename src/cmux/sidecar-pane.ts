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
  const sourcePane = (workspace.panes ?? []).find((pane) => pane.ref === sourcePaneRef);

  if (sourcePane && isThreadAgentPane(sourcePane)) {
    return sourcePane;
  }

  return (
    (workspace.panes ?? []).find((pane) => {
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

function isThreadAgentSurface(surface: CmuxSurface): boolean {
  const haystack = `${surface.title ?? ""} ${surface.command ?? ""}`.toLowerCase();

  return (
    haystack.includes("nugget_thread_pane=1") ||
    haystack.includes("nugget_agent=") ||
    haystack.includes("nugget_agent_prompt_file=") ||
    /\bnugget\b.*\bthread\b/.test(haystack)
  );
}
