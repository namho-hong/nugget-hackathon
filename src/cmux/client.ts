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

export interface CmuxNotifyOptions {
  title: string;
  body: string;
  surfaceRef?: string | undefined;
  workspaceRef?: string | undefined;
}

export class CmuxClient {
  private readonly binary = process.env.NUGGET_CMUX_BIN ?? process.env.CMUX_BIN ?? "cmux";

  async tree(options: { all?: boolean; preserveCallerEnv?: boolean } = {}): Promise<CmuxTree> {
    const output = await this.run(
      ["tree", "--json", ...(options.all ? ["--all"] : [])],
      { preserveCallerEnv: options.preserveCallerEnv },
    );
    return parseCmuxTreeJson(output);
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

  async renameWorkspace(options: { workspaceRef: string; title: string }): Promise<void> {
    await this.run([
      "rename-workspace",
      "--workspace",
      options.workspaceRef,
      options.title,
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

  async notify(options: CmuxNotifyOptions): Promise<void> {
    const workspaceRef = options.workspaceRef ?? process.env.CMUX_WORKSPACE_ID;
    const surfaceRef = options.surfaceRef ?? process.env.CMUX_SURFACE_ID;

    if (!isRunningInCmux() && !workspaceRef && !surfaceRef) {
      return;
    }

    try {
      await this.run([
        "notify",
        "--title",
        sanitizeNotificationText(options.title, 80),
        "--body",
        sanitizeNotificationText(options.body, 240),
        ...(workspaceRef ? ["--workspace", workspaceRef] : []),
        ...(surfaceRef ? ["--surface", surfaceRef] : []),
      ]);
    } catch {
      // Notifications are best-effort; chat and picker flows must keep working
      // when cmux is missing, old, or temporarily unavailable.
    }
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

  async run(
    args: string[],
    options: { preserveCallerEnv?: boolean | undefined } = {},
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.binary, args, {
        encoding: "utf8",
        env: options.preserveCallerEnv ? process.env : cmuxControlEnv(),
        maxBuffer: 10 * 1024 * 1024,
      });

      return stdout;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(
          `cmux ${args.join(" ")} failed: ${error.message}. ${cmuxFallbackMessage(error)}`,
        );
      }

      if (isExecError(error)) {
        const stderr = error.stderr.trim();
        const message = stderr.length > 0 ? stderr : error.message;
        throw new Error(
          `cmux ${args.join(" ")} failed: ${message}. ${cmuxFallbackMessage(error)}`,
        );
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

function isRunningInCmux(): boolean {
  return Array.from(CMUX_CALLER_ENV).some((key) => process.env[key]);
}

function sanitizeNotificationText(value: string, maxLength: number): string {
  const clean = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length <= maxLength) {
    return clean;
  }

  if (maxLength <= 3) {
    return clean.slice(0, maxLength);
  }

  return `${clean.slice(0, maxLength - 3)}...`;
}

export function getWorkspaces(tree: CmuxTree): CmuxWorkspace[] {
  return (tree.windows ?? []).flatMap((window) => window.workspaces ?? []);
}

export function parseCmuxTreeJson(output: string): CmuxTree {
  const parsed = JSON.parse(output) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("cmux tree returned non-object JSON.");
  }

  return parsed as CmuxTree;
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
): error is Error & { code?: string; stderr: string; stdout: string } {
  return error instanceof Error && "stderr" in error && "stdout" in error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function cmuxFallbackMessage(error: { code?: string | undefined }): string {
  if (error.code === "ENOENT") {
    return "Install cmux or set NUGGET_CMUX_BIN/CMUX_BIN to a cmux executable; plain `nugget room <roomId>` still works without cmux.";
  }

  return "Check that cmux is running and retry, or open the room directly with `nugget room <roomId>`.";
}
