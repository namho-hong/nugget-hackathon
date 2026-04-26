#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDirectRoom,
  createRoom,
  createSpace,
  getJoinedDirectRooms,
  getJoinedSpaces,
  getSpaceChildRoomIds,
  loginWithSso,
  withMatrixClient,
  type LoginAction,
} from "./matrix/index.js";
import { clearSession, loadSession, saveSession } from "./store/index.js";
import { promptRequired, selectHomeAction, type HomeAction } from "./ui/index.js";

type CommandResult = {
  exitCode: number;
  output: string;
  stream: "stdout" | "stderr";
};

const HELP_TEXT = `Nugget

Usage:
  nugget [command]

Commands:
  home              Show the Matrix home menu.
  help              Show this help.
  version           Show the local package version.
  login [action]    Start Matrix SSO. Action: login or register.
  logout            Clear the local Matrix session.
  whoami            Show the saved Matrix session identity.
  create-workspace [name]
                    Create a private Matrix Space.
  create-room [name] [spaceId]
                    Create a private Matrix room, optionally linked to a Space.
  create-dm [userId]
                    Create a direct room and invite a Matrix user.

Planned:
  workspace
  workspace-controller
  open
  room
  thread
  send
`;

function readPackageVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(currentDir, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };

  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

async function run(argv: string[]): Promise<CommandResult> {
  const args = argv.slice(2);
  const command = (args[0] === "--" ? args[1] : args[0]) ?? "home";

  if (command === "--help" || command === "-h" || command === "help") {
    return {
      exitCode: 0,
      output: HELP_TEXT,
      stream: "stdout",
    };
  }

  if (command === "--version" || command === "-v" || command === "version") {
    return {
      exitCode: 0,
      output: `${readPackageVersion()}\n`,
      stream: "stdout",
    };
  }

  if (command === "login") {
    return handleLogin(args.slice(1));
  }

  if (command === "home") {
    return handleDefaultHome();
  }

  if (command === "logout") {
    await clearSession();
    return {
      exitCode: 0,
      output: "Logged out. Local Matrix session cleared.\n",
      stream: "stdout",
    };
  }

  if (command === "whoami" || command === "session") {
    return handleWhoami();
  }

  if (command === "create-workspace") {
    return handleCreateWorkspaceCommand(args.slice(1));
  }

  if (command === "create-room") {
    return handleCreateRoomCommand(args.slice(1));
  }

  if (command === "create-dm") {
    return handleCreateDmCommand(args.slice(1));
  }

  return {
    exitCode: 1,
    output: `Unknown command: ${command}\n\n${HELP_TEXT}`,
    stream: "stderr",
  };
}

async function handleLogin(args: string[]): Promise<CommandResult> {
  const action = parseLoginAction(args[0]);

  if (!action) {
    return {
      exitCode: 1,
      output: "Usage: nugget login [login|register]\n",
      stream: "stderr",
    };
  }

  process.stdout.write(`Starting Matrix ${action} SSO...\n`);
  const session = await loginWithSso(action, {
    onLoginUrl: (url) => {
      process.stdout.write(`If the browser does not open, visit:\n${url}\n`);
    },
  });

  await saveSession(session);
  process.stdout.write(`Logged in as ${session.userId}\n`);

  return handleDefaultHome();
}

async function handleDefaultHome(): Promise<CommandResult> {
  const session = await loadSession();

  if (!session) {
    process.stdout.write("No Matrix session found.\nStarting login...\n");
    return handleLogin([]);
  }

  process.stdout.write("Loading Matrix account state...\n");
  const action = await selectHomeActionFromMatrix();

  return handleHomeAction(action);
}

async function selectHomeActionFromMatrix(): Promise<HomeAction> {
  return withMatrixClient(async (client) => {
    const workspaces = await getJoinedSpaces(client);
    const childRooms = await getSpaceChildRoomIds(client, workspaces);
    const directMessages = await getJoinedDirectRooms(client, {
      excludeRoomIds: childRooms.roomIds,
    });
    return selectHomeAction({
      directMessages,
      warnings: childRooms.warnings,
      workspaces,
    });
  });
}

async function handleHomeAction(action: HomeAction): Promise<CommandResult> {
  if (action.type === "logout") {
    await clearSession();
    process.stdout.write("Logged out. Local Matrix session cleared.\nStarting login...\n");
    return handleLogin([]);
  }

  if (action.type === "quit") {
    return {
      exitCode: 0,
      output: "",
      stream: "stdout",
    };
  }

  if (action.type === "view-all-workspaces") {
    return {
      exitCode: 1,
      output: "No joined Matrix Spaces found.\n",
      stream: "stderr",
    };
  }

  if (action.type === "open-workspace") {
    return plannedAction(
      `Workspace opening is planned in the next phase. Selected Space: ${action.spaceId}\n`,
    );
  }

  if (action.type === "open-dm") {
    return plannedAction(
      `DM chat is planned in the next phase. Selected room: ${action.roomId}\n`,
    );
  }

  if (action.type === "create-workspace") {
    const name = await promptRequired("Workspace name");
    return handleCreateWorkspace(name);
  }

  const userId = await promptRequired("Matrix user ID");
  return handleCreateDm(userId);
}

function plannedAction(output: string): CommandResult {
  return {
    exitCode: 1,
    output,
    stream: "stderr",
  };
}

async function handleWhoami(): Promise<CommandResult> {
  const session = await loadSession();

  if (!session) {
    return {
      exitCode: 1,
      output: "Not logged in. Run `nugget login` first.\n",
      stream: "stderr",
    };
  }

  return {
    exitCode: 0,
    output: `${session.userId}\n${session.baseUrl}\n`,
    stream: "stdout",
  };
}

async function handleCreateWorkspaceCommand(args: string[]): Promise<CommandResult> {
  const name = args.length > 0 ? args.join(" ") : await promptRequired("Workspace name");
  return handleCreateWorkspace(name);
}

async function handleCreateRoomCommand(args: string[]): Promise<CommandResult> {
  const parsed = parseCreateRoomArgs(args);
  const name = parsed.name ?? (await promptRequired("Room name"));

  return handleCreateMatrixRoom(name, parsed.spaceId);
}

async function handleCreateDmCommand(args: string[]): Promise<CommandResult> {
  const userId = args[0] ?? (await promptRequired("Matrix user ID"));
  return handleCreateDm(userId);
}

async function handleCreateWorkspace(name: string): Promise<CommandResult> {
  const created = await withMatrixClient(async (client) => createSpace(client, name));

  return {
    exitCode: 0,
    output:
      `Created workspace: ${created.name}\n` +
      `Space ID: ${created.roomId}\n\n` +
      "Workspace opening is planned in the cmux workspace phase.\n",
    stream: "stdout",
  };
}

async function handleCreateMatrixRoom(
  name: string,
  spaceId: string | undefined,
): Promise<CommandResult> {
  const created = await withMatrixClient(async (client) =>
    createRoom(client, {
      name,
      ...(spaceId ? { spaceId } : {}),
    }),
  );

  return {
    exitCode: 0,
    output:
      `Created room: ${created.name}\n` +
      `Room ID: ${created.roomId}\n` +
      `${spaceId ? `Linked Space ID: ${spaceId}\n` : ""}\n` +
      "Room opening is planned in the cmux workspace phase.\n",
    stream: "stdout",
  };
}

async function handleCreateDm(userId: string): Promise<CommandResult> {
  const created = await withMatrixClient(async (client) => createDirectRoom(client, userId));

  return {
    exitCode: 0,
    output:
      `Created DM with: ${created.name}\n` +
      `Room ID: ${created.roomId}\n\n` +
      "DM chat opening is planned in the chat phase.\n",
    stream: "stdout",
  };
}

function parseCreateRoomArgs(args: string[]): { name?: string; spaceId?: string } {
  if (args.length === 0) {
    return {};
  }

  const lastArg = args.at(-1);

  if (args.length > 1 && lastArg?.startsWith("!")) {
    return {
      name: args.slice(0, -1).join(" "),
      spaceId: lastArg,
    };
  }

  return {
    name: args.join(" "),
  };
}

function parseLoginAction(value: string | undefined): LoginAction | null {
  if (value === undefined || value === "login" || value === "--login") {
    return "login";
  }

  if (
    value === "register" ||
    value === "signup" ||
    value === "sign-up" ||
    value === "--register"
  ) {
    return "register";
  }

  return null;
}

try {
  const result = await run(process.argv);
  process[result.stream].write(result.output);
  process.exit(result.exitCode);
} catch (error) {
  process.stderr.write(`${formatError(error)}\n`);
  process.exit(1);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
