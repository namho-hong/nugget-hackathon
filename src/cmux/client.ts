import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CMUX_CALLER_ENV = new Set([
  "CMUX_PANEL_ID",
  "CMUX_PANE_ID",
  "CMUX_SURFACE_ID",
  "CMUX_TAB_ID",
  "CMUX_WORKSPACE_ID",
]);

export interface CmuxSurface {
  ref: string;
  title?: string | null;
  command?: string | null;
  pane_ref?: string | null;
  type?: string | null;
}

export interface CmuxSplitResult {
  surfaceRef: string;
  workspaceRef: string;
}

export interface CmuxSurfaceResult {
  paneRef: string;
  surfaceRef: string;
  workspaceRef: string;
}

export interface CmuxPane {
  ref: string;
  surfaces?: CmuxSurface[];
  selected_surface_ref?: string | null;
}

export interface CmuxWorkspace {
  ref: string;
  title?: string | null;
  description?: string | null;
  panes?: CmuxPane[];
  active?: boolean;
  selected?: boolean;
}

export interface CmuxTree {
  active?: {
    workspace_ref?: string;
    pane_ref?: string;
    surface_ref?: string;
  };
  caller?: {
    workspace_ref?: string;
    pane_ref?: string;
    surface_ref?: string;
  };
  windows?: Array<{
    workspaces?: CmuxWorkspace[];
  }>;
}

export interface CmuxPaneSurfaceRef {
  paneRef: string;
  surfaceRef: string;
}

export class CmuxClient {
  private readonly binary = process.env.NUGGET_CMUX_BIN ?? process.env.CMUX_BIN ?? "cmux";

  async tree(options: { all?: boolean } = {}): Promise<CmuxTree> {
    const output = await this.run(["tree", "--json", ...(options.all ? ["--all"] : [])]);
    const parsed = JSON.parse(output) as unknown;

    if (!isRecord(parsed)) {
      throw new Error("cmux tree returned non-object JSON.");
    }

    return parsed as CmuxTree;
  }

  async newWorkspace(options: {
    title: string;
    description: string;
    cwd: string;
  }): Promise<void> {
    await this.run([
      "new-workspace",
      "--name",
      options.title,
      "--description",
      options.description,
      "--cwd",
      options.cwd,
    ]);
  }

  async newSplit(
    direction: "left" | "right" | "up" | "down",
    options: { workspaceRef: string; surfaceRef: string },
  ): Promise<CmuxSplitResult> {
    const output = await this.run([
      "new-split",
      direction,
      "--workspace",
      options.workspaceRef,
      "--surface",
      options.surfaceRef,
    ]);

    return {
      surfaceRef: requireRef(output, "surface"),
      workspaceRef: requireRef(output, "workspace"),
    };
  }

  async newSurface(options: {
    paneRef: string;
    workspaceRef: string;
  }): Promise<CmuxSurfaceResult> {
    const output = await this.run([
      "new-surface",
      "--workspace",
      options.workspaceRef,
      "--pane",
      options.paneRef,
    ]);

    return {
      paneRef: requireRef(output, "pane"),
      surfaceRef: requireRef(output, "surface"),
      workspaceRef: requireRef(output, "workspace"),
    };
  }

  async respawnPane(options: {
    workspaceRef: string;
    surfaceRef: string;
    command: string;
  }): Promise<void> {
    const command = options.command.endsWith("\n")
      ? options.command
      : `${options.command}\n`;

    await this.run([
      "respawn-pane",
      "--workspace",
      options.workspaceRef,
      "--surface",
      options.surfaceRef,
      "--command",
      command,
    ]);
  }

  async focusPane(options: { workspaceRef: string; paneRef: string }): Promise<void> {
    await this.run([
      "focus-pane",
      "--workspace",
      options.workspaceRef,
      "--pane",
      options.paneRef,
    ]);
  }

  async focusSurface(options: { workspaceRef: string; surfaceRef: string }): Promise<void> {
    await this.run([
      "rpc",
      "surface.focus",
      JSON.stringify({
        surface_id: options.surfaceRef,
        workspace_id: options.workspaceRef,
      }),
    ]);
  }

  async selectWorkspace(workspaceRef: string): Promise<void> {
    await this.setAppFocusActive();
    await this.run(["select-workspace", "--workspace", workspaceRef]);
  }

  async readScreen(options: {
    workspaceRef: string;
    surfaceRef: string;
    lines?: number;
  }): Promise<string> {
    return await this.run([
      "read-screen",
      "--workspace",
      options.workspaceRef,
      "--surface",
      options.surfaceRef,
      "--lines",
      String(options.lines ?? 24),
    ]);
  }

  async resizePane(options: {
    workspaceRef: string;
    paneRef: string;
    direction: "left";
    amount: number;
  }): Promise<void> {
    await this.run([
      "resize-pane",
      "--workspace",
      options.workspaceRef,
      "--pane",
      options.paneRef,
      "-L",
      "--amount",
      String(options.amount),
    ]);
  }

  async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.binary, args, {
        encoding: "utf8",
        env: cmuxControlEnv(),
        maxBuffer: 10 * 1024 * 1024,
      });

      return stdout;
    } catch (error) {
      if (isExecError(error)) {
        const stderr = error.stderr.trim();
        const message = stderr.length > 0 ? stderr : error.message;
        throw new Error(`cmux ${args.join(" ")} failed: ${message}`);
      }

      throw error;
    }
  }

  private async setAppFocusActive(): Promise<void> {
    try {
      await this.run(["set-app-focus", "active"]);
    } catch {
      // Older cmux builds may not support app focus overrides.
    }
  }
}

function cmuxControlEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!CMUX_CALLER_ENV.has(key) && value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

export function getWorkspaces(tree: CmuxTree): CmuxWorkspace[] {
  return (tree.windows ?? []).flatMap((window) => window.workspaces ?? []);
}

export function getWorkspaceSurfaces(workspace: CmuxWorkspace): CmuxSurface[] {
  return (workspace.panes ?? []).flatMap((pane) => pane.surfaces ?? []);
}

export function findWorkspace(tree: CmuxTree, workspaceRef: string): CmuxWorkspace | null {
  return getWorkspaces(tree).find((workspace) => workspace.ref === workspaceRef) ?? null;
}

export function findSurfacePane(
  workspace: CmuxWorkspace,
  surfaceRef: string,
): CmuxPaneSurfaceRef | null {
  for (const pane of workspace.panes ?? []) {
    if ((pane.surfaces ?? []).some((surface) => surface.ref === surfaceRef)) {
      return { paneRef: pane.ref, surfaceRef };
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRef(output: string, prefix: string): string {
  const match = output.match(new RegExp(`\\b${prefix}:\\d+\\b`));

  if (!match) {
    throw new Error(`Unable to parse ${prefix} ref from cmux output: ${output}`);
  }

  return match[0];
}

function isExecError(
  error: unknown,
): error is Error & { stderr: string; stdout: string } {
  return error instanceof Error && "stderr" in error && "stdout" in error;
}
