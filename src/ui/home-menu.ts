import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

export interface HomeWorkspace {
  roomId: string;
  name: string;
  lastActivityTs?: number;
}

export interface HomeDirectMessage {
  roomId: string;
  name: string;
  userIds: string[];
  lastActivityTs?: number;
}

export type HomeAction =
  | { type: "open-workspace"; spaceId: string }
  | { type: "view-all-workspaces" }
  | { type: "create-workspace" }
  | { type: "open-dm"; roomId: string }
  | { type: "create-dm" }
  | { type: "logout" }
  | { type: "quit" };

export interface SelectHomeActionInput {
  workspaces: HomeWorkspace[];
  directMessages: HomeDirectMessage[];
  warnings?: string[];
}

interface PickerIo {
  input: ReadStream;
  output: WriteStream;
}

interface PickerOption {
  label: string;
  action: HomeAction;
  disabled?: false;
}

interface DisabledPickerOption {
  label: string;
  disabled: true;
}

type AnyPickerOption = PickerOption | DisabledPickerOption;

interface PickerSection {
  title: string;
  options: AnyPickerOption[];
}

export async function selectHomeAction(
  home: SelectHomeActionInput,
  io: PickerIo = { input: process.stdin, output: process.stdout },
): Promise<HomeAction> {
  const sections = homeSections(home);
  const action = await selectAction("Nugget", sections, io);

  if (action.type !== "view-all-workspaces") {
    return action;
  }

  if (home.workspaces.length === 0) {
    return action;
  }

  return selectWorkspaceAction(home.workspaces, io);
}

export async function selectWorkspaceAction(
  workspaces: readonly HomeWorkspace[],
  io: PickerIo = { input: process.stdin, output: process.stdout },
): Promise<HomeAction> {
  const sortedWorkspaces = [...workspaces].sort((a, b) => {
    const nameDelta = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return nameDelta === 0 ? a.roomId.localeCompare(b.roomId) : nameDelta;
  });

  const options: AnyPickerOption[] =
    sortedWorkspaces.length === 0
      ? [{ label: "No workspaces", disabled: true }]
      : sortedWorkspaces.map((workspace) => ({
          label: workspace.name,
          action: { type: "open-workspace", spaceId: workspace.roomId },
        }));

  return selectAction(
    "Workspaces",
    [
      {
        title: "All Workspaces",
        options,
      },
      {
        title: "Actions",
        options: [{ label: "Quit", action: { type: "quit" } }],
      },
    ],
    io,
  );
}

function homeSections(home: SelectHomeActionInput): PickerSection[] {
  const workspaceOptions: AnyPickerOption[] =
    home.workspaces.length === 0
      ? [{ label: "No workspaces", disabled: true }]
      : [
          ...home.workspaces.slice(0, 5).map((workspace) => ({
            label: workspace.name,
            action: { type: "open-workspace", spaceId: workspace.roomId } satisfies HomeAction,
          })),
          { label: "View all...", action: { type: "view-all-workspaces" } },
        ];

  const dmOptions: AnyPickerOption[] =
    home.directMessages.length === 0
      ? [{ label: "No DMs", disabled: true }]
      : home.directMessages.slice(0, 5).map((directMessage) => ({
          label: directMessage.name,
          action: { type: "open-dm", roomId: directMessage.roomId } satisfies HomeAction,
        }));

  const sections: PickerSection[] = [
    {
      title: "Recent Workspaces",
      options: workspaceOptions,
    },
    {
      title: "DMs",
      options: dmOptions,
    },
    {
      title: "Actions",
      options: [
        { label: "+ New workspace", action: { type: "create-workspace" } },
        { label: "+ New DM", action: { type: "create-dm" } },
        { label: "Logout", action: { type: "logout" } },
        { label: "Quit", action: { type: "quit" } },
      ],
    },
  ];

  if (home.warnings && home.warnings.length > 0) {
    sections.push({
      title: "Warnings",
      options: home.warnings.slice(0, 3).map((warning) => ({
        label: warning,
        disabled: true,
      })),
    });
  }

  return sections;
}

async function selectAction(
  title: string,
  sections: PickerSection[],
  io: PickerIo,
): Promise<HomeAction> {
  const selectableOptions = sections
    .flatMap((section) => section.options)
    .filter((option): option is PickerOption => !option.disabled);

  if (!io.input.isTTY || !io.output.isTTY) {
    io.output.write(renderMenu(title, sections, -1, io.output.columns ?? 80));
    return { type: "quit" };
  }

  if (selectableOptions.length === 0) {
    return { type: "quit" };
  }

  let selectedIndex = 0;

  emitKeypressEvents(io.input);
  io.input.setRawMode(true);
  io.output.write("\x1b[?25l");

  try {
    return await new Promise<HomeAction>((resolve) => {
      const render = (): void => {
        io.output.write(
          `\x1b[2J\x1b[H${renderMenu(title, sections, selectedIndex, io.output.columns ?? 80)}`,
        );
      };

      const cleanup = (): void => {
        io.input.off("keypress", onKeypress);
        io.input.setRawMode(false);
        io.output.write("\x1b[?25h\x1b[0m");
      };

      const finish = (action: HomeAction): void => {
        cleanup();
        io.output.write("\n");
        resolve(action);
      };

      const onKeypress = (_text: string, key: KeypressEvent): void => {
        if (key.ctrl && key.name === "c") {
          finish({ type: "quit" });
          return;
        }

        if (key.name === "up" || key.name === "k") {
          selectedIndex =
            (selectedIndex - 1 + selectableOptions.length) % selectableOptions.length;
          render();
          return;
        }

        if (key.name === "down" || key.name === "j") {
          selectedIndex = (selectedIndex + 1) % selectableOptions.length;
          render();
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          const selectedOption = selectableOptions[selectedIndex];

          if (selectedOption) {
            finish(selectedOption.action);
          }
        }
      };

      io.input.on("keypress", onKeypress);
      render();
    });
  } finally {
    if (io.input.isRaw) {
      io.input.setRawMode(false);
    }

    io.output.write("\x1b[?25h\x1b[0m");
  }
}

function renderMenu(
  title: string,
  sections: readonly PickerSection[],
  selectedIndex: number,
  columns: number,
): string {
  const lines = [title, ""];
  let optionIndex = 0;

  for (const section of sections) {
    lines.push(section.title);

    for (const option of section.options) {
      const isSelected = !option.disabled && optionIndex === selectedIndex;
      const prefix = option.disabled ? "  " : isSelected ? "> " : "  ";

      if (!option.disabled) {
        optionIndex += 1;
      }

      lines.push(`${prefix}${truncate(option.label, Math.max(10, columns - 4))}`);
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

interface KeypressEvent {
  name?: string;
  ctrl?: boolean;
}
