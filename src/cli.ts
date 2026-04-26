#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getJoinedDirectRooms,
  getJoinedSpaces,
  getSpaceChildRoomIds,
  loginWithSso,
  withMatrixClient,
  type LoginAction,
} from "./matrix/index.js";
import { clearSession, loadSession, saveSession } from "./store/index.js";
import { selectHomeAction, type HomeAction } from "./ui/index.js";

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

  return {
    exitCode: 0,
    output: `Logged in as ${session.userId}\n`,
    stream: "stdout",
  };
}

async function handleDefaultHome(): Promise<CommandResult> {
  const session = await loadSession();

  if (!session) {
    process.stdout.write("No Matrix session found.\nStarting login...\n");
    return handleLogin([]);
  }

  process.stdout.write("Loading Matrix account state...\n");

  return withMatrixClient(async (client) => {
    const workspaces = getJoinedSpaces(client);
    const childRooms = await getSpaceChildRoomIds(client, workspaces);
    const directMessages = getJoinedDirectRooms(client, {
      excludeRoomIds: childRooms.roomIds,
    });
    const action = await selectHomeAction({
      directMessages,
      warnings: childRooms.warnings,
      workspaces,
    });

    return handleHomeAction(action);
  });
}

async function handleHomeAction(action: HomeAction): Promise<CommandResult> {
  if (action.type === "logout") {
    await clearSession();
    return {
      exitCode: 0,
      output: "Logged out. Local Matrix session cleared.\n",
      stream: "stdout",
    };
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
    return plannedAction("New workspace creation is planned in the next phase.\n");
  }

  return plannedAction("New DM creation is planned in the next phase.\n");
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
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
