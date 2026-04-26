import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

import { truncateDisplayText } from "../util/terminal.js";
import {
  renderPickerFooter,
  renderPickerHeader,
  renderPickerLine,
  renderPickerSectionTitle,
} from "./picker-rendering.js";

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

export interface HomePendingDirectInvite {
  roomId: string;
  name: string;
  inviterUserId: string;
  lastActivityTs?: number;
}

export interface HomePendingWorkspaceInvite {
  roomId: string;
  name: string;
  inviterUserId: string;
  lastActivityTs?: number;
}

export type HomeAction =
  | { type: "open-workspace"; spaceId: string }
  | { type: "view-all-workspaces" }
  | { type: "create-workspace" }
  | { type: "open-dm"; roomId: string }
  | { type: "review-workspace-invite"; spaceId: string }
  | { type: "accept-workspace-invite"; spaceId: string }
  | { type: "reject-workspace-invite"; spaceId: string }
  | { type: "review-dm-invite"; roomId: string }
  | { type: "accept-dm-invite"; roomId: string }
  | { type: "reject-dm-invite"; roomId: string }
  | { type: "create-dm" }
  | { type: "home" }
  | { type: "logout" }
  | { type: "quit" };

export interface SelectHomeActionInput {
  accountUserId?: string;
  workspaces: HomeWorkspace[];
  directMessages: HomeDirectMessage[];
  openDirectRoomIds?: ReadonlySet<string>;
  pendingWorkspaceInvites?: HomePendingWorkspaceInvite[];
  pendingDirectInvites?: HomePendingDirectInvite[];
  warnings?: string[];
}

interface PickerIo {
  input: ReadStream;
  output: WriteStream;
}

interface PickerOption {
  label: string;
  action: HomeAction;
  tag?: string;
  disabled?: false;
}

interface DisabledPickerOption {
  label: string;
  tag?: string;
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
  const action = await selectAction("Nugget", sections, io, homeSubtitle(home));

  if (action.type === "review-dm-invite") {
    const invite = home.pendingDirectInvites?.find((item) => item.roomId === action.roomId);

    if (!invite) {
      return { type: "quit" };
    }

    return selectPendingDirectInviteAction(invite, io);
  }

  if (action.type === "review-workspace-invite") {
    const invite = home.pendingWorkspaceInvites?.find(
      (item) => item.roomId === action.spaceId,
    );

    if (!invite) {
      return { type: "quit" };
    }

    return selectPendingWorkspaceInviteAction(invite, io);
  }

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
          tag: "space",
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
        options: [
          { label: "Home", action: { type: "home" } },
          { label: "Quit", action: { type: "quit" } },
        ],
      },
    ],
    io,
    `${sortedWorkspaces.length} total`,
  );
}

function homeSections(home: SelectHomeActionInput): PickerSection[] {
  const pendingDirectInvites = home.pendingDirectInvites ?? [];
  const pendingWorkspaceInvites = home.pendingWorkspaceInvites ?? [];
  const workspaceOptions: AnyPickerOption[] =
    home.workspaces.length === 0
      ? [{ label: "No workspaces", disabled: true }]
      : [
          ...home.workspaces.slice(0, 5).map((workspace) => ({
            label: workspace.name,
            tag: "space",
            action: { type: "open-workspace", spaceId: workspace.roomId } satisfies HomeAction,
          })),
          { label: "View all workspaces", tag: "more", action: { type: "view-all-workspaces" } },
        ];

  const openDirectRoomIds = home.openDirectRoomIds ?? new Set<string>();
  const dmOptions: AnyPickerOption[] =
    home.directMessages.length === 0
      ? [{ label: "No DMs yet", tag: "empty", disabled: true }]
      : home.directMessages.slice(0, 5).map((directMessage) => ({
          label: directMessage.name,
          tag: openDirectRoomIds.has(directMessage.roomId) ? "open" : "dm",
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
  ];

  if (pendingDirectInvites.length > 0) {
    sections.push({
      title: "Pending DM Invites",
      options: pendingDirectInvites.slice(0, 5).map((invite) => ({
        label: `${invite.name} from ${invite.inviterUserId}`,
        tag: "invite",
        action: { type: "review-dm-invite", roomId: invite.roomId } satisfies HomeAction,
      })),
    });
  }

  if (pendingWorkspaceInvites.length > 0) {
    sections.push({
      title: "Pending Workspace Invites",
      options: pendingWorkspaceInvites.slice(0, 5).map((invite) => ({
        label: `${invite.name} from ${invite.inviterUserId}`,
        tag: "invite",
        action: {
          type: "review-workspace-invite",
          spaceId: invite.roomId,
        } satisfies HomeAction,
      })),
    });
  }

  sections.push({
    title: "Actions",
    options: [
      { label: "New workspace", tag: "new", action: { type: "create-workspace" } },
      { label: "New DM", tag: "new", action: { type: "create-dm" } },
      { label: "Logout", tag: "acct", action: { type: "logout" } },
      { label: "Quit", tag: "quit", action: { type: "quit" } },
    ],
  });

  if (home.warnings && home.warnings.length > 0) {
    sections.push({
      title: "Warnings",
      options: home.warnings.slice(0, 3).map((warning) => ({
        label: warning,
        tag: "warn",
        disabled: true,
      })),
    });
  }

  return sections;
}

function homeSubtitle(home: SelectHomeActionInput): string {
  const counts = [
    `${home.workspaces.length} workspace${home.workspaces.length === 1 ? "" : "s"}`,
    `${home.directMessages.length} DM${home.directMessages.length === 1 ? "" : "s"}`,
  ];
  const pendingCount =
    (home.pendingDirectInvites?.length ?? 0) + (home.pendingWorkspaceInvites?.length ?? 0);

  if (pendingCount > 0) {
    counts.push(`${pendingCount} invite${pendingCount === 1 ? "" : "s"}`);
  }

  return home.accountUserId
    ? `${home.accountUserId}  |  ${counts.join("  |  ")}`
    : counts.join("  |  ");
}

function selectPendingDirectInviteAction(
  invite: HomePendingDirectInvite,
  io: PickerIo,
): Promise<HomeAction> {
  return selectAction(
    `DM Invite: ${invite.name}`,
    [
      {
        title: "Invite",
        options: [
          { label: `From ${invite.inviterUserId}`, tag: "from", disabled: true },
          { label: invite.roomId, tag: "room", disabled: true },
        ],
      },
      {
        title: "Actions",
        options: [
          {
            label: "Accept",
            tag: "yes",
            action: { type: "accept-dm-invite", roomId: invite.roomId },
          },
          {
            label: "Reject",
            tag: "no",
            action: { type: "reject-dm-invite", roomId: invite.roomId },
          },
          { label: "Home", tag: "home", action: { type: "home" } },
          { label: "Quit", tag: "quit", action: { type: "quit" } },
        ],
      },
    ],
    io,
    invite.roomId,
  );
}

function selectPendingWorkspaceInviteAction(
  invite: HomePendingWorkspaceInvite,
  io: PickerIo,
): Promise<HomeAction> {
  return selectAction(
    `Workspace Invite: ${invite.name}`,
    [
      {
        title: "Invite",
        options: [
          { label: `From ${invite.inviterUserId}`, tag: "from", disabled: true },
          { label: invite.roomId, tag: "space", disabled: true },
        ],
      },
      {
        title: "Actions",
        options: [
          {
            label: "Accept",
            tag: "yes",
            action: { type: "accept-workspace-invite", spaceId: invite.roomId },
          },
          {
            label: "Reject",
            tag: "no",
            action: { type: "reject-workspace-invite", spaceId: invite.roomId },
          },
          { label: "Home", tag: "home", action: { type: "home" } },
          { label: "Quit", tag: "quit", action: { type: "quit" } },
        ],
      },
    ],
    io,
    invite.roomId,
  );
}

async function selectAction(
  title: string,
  sections: PickerSection[],
  io: PickerIo,
  subtitle = "",
): Promise<HomeAction> {
  const selectableOptions = sections
    .flatMap((section) => section.options)
    .filter((option): option is PickerOption => !option.disabled);

  if (!io.input.isTTY || !io.output.isTTY) {
    io.output.write(renderMenu(title, subtitle, sections, -1, io.output.columns ?? 80, false));
    return { type: "quit" };
  }

  if (selectableOptions.length === 0) {
    return { type: "quit" };
  }

  let selectedIndex = 0;

  emitKeypressEvents(io.input);
  io.input.resume();
  io.input.setRawMode(true);
  io.output.write("\x1b[?25l");

  try {
    return await new Promise<HomeAction>((resolve) => {
      let closed = false;

      const render = (): void => {
        if (closed) {
          return;
        }

        io.output.write(
          `\x1b[2J\x1b[H${renderMenu(
            title,
            subtitle,
            sections,
            selectedIndex,
            io.output.columns ?? 80,
            true,
          )}`,
        );
      };

      const cleanup = (): void => {
        if (closed) {
          return;
        }

        closed = true;
        io.input.off("keypress", onKeypress);
        io.output.off("resize", render);

        if (io.input.isRaw) {
          io.input.setRawMode(false);
        }

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

        if (key.name === "escape" || key.name === "q") {
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
      io.output.on("resize", render);
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
  subtitle: string,
  sections: readonly PickerSection[],
  selectedIndex: number,
  columns: number,
  useAnsi: boolean,
): string {
  const width = Math.max(20, Math.min(columns, 96));
  const lines = [...renderPickerHeader(title, subtitle, width, useAnsi), ""];
  let optionIndex = 0;

  for (const section of sections) {
    lines.push(renderPickerSectionTitle(section.title, width, useAnsi));

    for (const option of section.options) {
      const isSelected = !option.disabled && optionIndex === selectedIndex;

      if (!option.disabled) {
        optionIndex += 1;
      }

      lines.push(
        renderPickerLine({
          label: truncate(option.label, Math.max(10, width - 4)),
          selected: isSelected,
          disabled: option.disabled,
          tag: option.tag,
          width,
          useAnsi,
        }),
      );
    }

    lines.push("");
  }

  lines.push(renderPickerFooter("Up/Down or j/k move  Enter selects  q quits", width, useAnsi));
  return `${lines.join("\n")}\n`;
}

function truncate(value: string, maxLength: number): string {
  return truncateDisplayText(value, maxLength);
}

interface KeypressEvent {
  name?: string;
  ctrl?: boolean;
}
