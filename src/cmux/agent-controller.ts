import {
  getAgentCommand,
  shellQuote,
} from "../agent/commands.js";
import {
  writeAgentPromptFile,
  type AgentPromptContext,
} from "../agent/prompt.js";
import type { ChatAgentRequest } from "../agent/types.js";
import {
  CmuxClient,
  findSurfacePane,
  findWorkspace,
  type CmuxPaneSurfaceRef,
  type CmuxTree,
} from "./client.js";
import { createThreadAgentSurface } from "./sidecar-pane.js";

export async function openAgentBesideCurrentSurface(
  request: ChatAgentRequest,
): Promise<void> {
  const cmux = new CmuxClient();
  const tree = await cmux.tree({ all: true, preserveCallerEnv: true });
  const context = currentCmuxContext(tree);

  if (!context) {
    throw new Error(
      "Agent panes require cmux. Open this room from `nugget workspace <spaceId>` first.",
    );
  }

  const workspace = findWorkspace(tree, context.workspaceRef);

  if (!workspace) {
    throw new Error(`cmux workspace ${context.workspaceRef} was not found.`);
  }

  const sourcePane = findSurfacePane(workspace, context.surfaceRef);

  if (!sourcePane) {
    throw new Error(`cmux surface ${context.surfaceRef} has no containing pane.`);
  }

  const target = await createThreadAgentSurface(cmux, {
    sourcePaneRef: sourcePane.paneRef,
    sourceSurfaceRef: context.surfaceRef,
    workspace,
    workspaceRef: context.workspaceRef,
  });
  const promptContext: AgentPromptContext = {
    agentPaneRef: target.paneRef,
    agentSurfaceRef: target.surfaceRef,
    sourcePaneRef: sourcePane.paneRef,
    sourceSurfaceRef: context.surfaceRef,
    workspaceRef: context.workspaceRef,
    ...(workspace.description !== undefined ? { workspaceDescription: workspace.description } : {}),
    ...(workspace.title !== undefined ? { workspaceTitle: workspace.title } : {}),
  };
  const promptFile = await writeAgentPromptFile(request, promptContext);

  await cmux.respawnPane({
    command: buildAgentPaneCommand(request, promptContext, promptFile),
    surfaceRef: target.surfaceRef,
    workspaceRef: context.workspaceRef,
  });

  if (!(await tryFocusPaneSurface(cmux, context.workspaceRef, target))) {
    throw new Error(`Could not focus agent surface ${target.surfaceRef}.`);
  }
}

function buildAgentPaneCommand(
  request: ChatAgentRequest,
  context: AgentPromptContext,
  promptFile: string,
): string {
  const envValues: Array<[string, string]> = [
    ["CMUX_WORKSPACE_ID", context.workspaceRef],
    ["CMUX_SURFACE_ID", context.agentSurfaceRef],
    ["NUGGET_AGENT", request.agent],
    ["NUGGET_AGENT_PROMPT_FILE", promptFile],
    ["NUGGET_AGENT_ROOM_ID", request.roomId],
    ["NUGGET_AGENT_SOURCE_PANE_ID", context.sourcePaneRef],
    ["NUGGET_AGENT_SOURCE_SURFACE_ID", context.sourceSurfaceRef],
    ["NUGGET_AGENT_WORKSPACE_ID", context.workspaceRef],
  ];
  const env = envValues
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");

  return `${env} ${getAgentCommand(request.agent, promptFile)}`;
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

function currentCmuxContext(
  tree: CmuxTree,
): { surfaceRef: string; workspaceRef: string } | null {
  const candidates = [
    tree.caller
      ? {
          surfaceRef: tree.caller.surface_ref,
          workspaceRef: tree.caller.workspace_ref,
        }
      : null,
    tree.active
      ? {
          surfaceRef: tree.active.surface_ref,
          workspaceRef: tree.active.workspace_ref,
        }
      : null,
    {
      surfaceRef: process.env.CMUX_SURFACE_ID,
      workspaceRef: process.env.CMUX_WORKSPACE_ID,
    },
  ];

  for (const candidate of candidates) {
    if (candidate?.workspaceRef && candidate.surfaceRef) {
      return {
        surfaceRef: candidate.surfaceRef,
        workspaceRef: candidate.workspaceRef,
      };
    }
  }

  return null;
}
