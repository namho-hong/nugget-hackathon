import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

import type { JoinedRoom } from "../matrix/index.js";
import { promptRequiredNavigation } from "./prompts.js";

interface SpaceRoomPickerIo {
  input: ReadStream;
  output: WriteStream;
}

type PickerAction =
  | { type: "open-room"; roomId: string }
  | { type: "invite-user" }
  | { type: "refresh" }
  | { type: "home" }
  | { type: "quit" };

export type SpaceRoomPickerResult = { type: "home" } | { type: "quit" };

interface PickerOption {
  label: string;
  action: PickerAction;
  disabled?: false;
}

interface DisabledPickerOption {
  label: string;
  disabled: true;
}

type AnyPickerOption = PickerOption | DisabledPickerOption;

export async function runSpaceRoomPicker(options: {
  title: string;
  loadRooms: () => Promise<readonly JoinedRoom[]> | readonly JoinedRoom[];
  onOpenRoom: (roomId: string) => Promise<void>;
  onInviteUser?: (userId: string) => Promise<void>;
  io?: SpaceRoomPickerIo;
}): Promise<SpaceRoomPickerResult> {
  const io = options.io ?? { input: process.stdin, output: process.stdout };
  const canInviteUser = options.onInviteUser !== undefined;

  if (!io.input.isTTY || !io.output.isTTY) {
    const rooms = await options.loadRooms();
    io.output.write(
      renderPicker(options.title, rooms, -1, io.output.columns ?? 80, "", canInviteUser),
    );
    return { type: "quit" };
  }

  let rooms = await options.loadRooms();
  let selectedIndex = 0;
  let notice = "";
  let ignoreInitialEnter = process.env.NUGGET_IGNORE_INITIAL_ENTER === "1";

  emitKeypressEvents(io.input);
  io.input.resume();
  io.input.setRawMode(true);
  io.output.write("\x1b[?25l");

  const render = (): void => {
    const selectableCount = selectableOptions(rooms, canInviteUser).length;
    selectedIndex = selectableCount === 0 ? 0 : selectedIndex % selectableCount;
    io.output.write(
      `\x1b[2J\x1b[H${renderPicker(
        options.title,
        rooms,
        selectedIndex,
        io.output.columns ?? 80,
        notice,
        canInviteUser,
      )}`,
    );
  };

  let resolveDone: ((result: SpaceRoomPickerResult) => void) | null = null;

  let cleanup = (result: SpaceRoomPickerResult): void => {
    io.input.off("keypress", onKeypress);
    io.input.setRawMode(false);
    io.output.write("\x1b[?25h\x1b[0m\n");
    resolveDone?.(result);
  };

  const refresh = async (): Promise<void> => {
    rooms = await options.loadRooms();
    render();
  };

  const finish = (result: SpaceRoomPickerResult): void => {
    cleanup(result);
  };

  const onKeypress = async (_text: string, key: KeypressEvent): Promise<void> => {
    if (key.ctrl && key.name === "c") {
      finish({ type: "quit" });
      return;
    }

    if (key.name === "escape" || key.name === "q") {
      finish({ type: "quit" });
      return;
    }

    const selectable = selectableOptions(rooms, canInviteUser);

    if (selectable.length === 0) {
      return;
    }

    if (key.name === "up" || key.name === "k") {
      selectedIndex = (selectedIndex - 1 + selectable.length) % selectable.length;
      render();
      return;
    }

    if (key.name === "down" || key.name === "j") {
      selectedIndex = (selectedIndex + 1) % selectable.length;
      render();
      return;
    }

    if (key.name === "r") {
      notice = "Refreshing rooms...";
      render();
      await refresh();
      notice = "";
      render();
      return;
    }

    if (key.name !== "return" && key.name !== "enter") {
      return;
    }

    if (ignoreInitialEnter) {
      ignoreInitialEnter = false;
      return;
    }

    const selected = selectable[selectedIndex];

    if (!selected) {
      return;
    }

    if (selected.action.type === "quit") {
      finish({ type: "quit" });
      return;
    }

    if (selected.action.type === "home") {
      finish({ type: "home" });
      return;
    }

    if (selected.action.type === "refresh") {
      notice = "Refreshing rooms...";
      render();
      await refresh();
      notice = "";
      render();
      return;
    }

    if (selected.action.type === "invite-user") {
      const result = await promptForInviteUserId(io, onKeypress);

      if (typeof result !== "string") {
        finish(result);
        return;
      }

      if (!isMatrixUserId(result)) {
        notice = `Invalid Matrix user ID: ${result}`;
        render();
        return;
      }

      notice = `Inviting ${result}...`;
      render();

      try {
        await options.onInviteUser?.(result);
        notice = `Invited ${result}.`;
      } catch (error) {
        notice = error instanceof Error ? error.message : String(error);
      }

      render();
      return;
    }

    notice = `Opening ${selected.label}...`;
    render();

    try {
      await options.onOpenRoom(selected.action.roomId);
      notice = `Opened ${selected.label}.`;
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }

    render();
  };

  io.input.on("keypress", onKeypress);
  render();

  return await new Promise<SpaceRoomPickerResult>((resolve) => {
    resolveDone = resolve;
  });
}

function renderPicker(
  title: string,
  rooms: readonly JoinedRoom[],
  selectedIndex: number,
  columns: number,
  notice = "",
  canInviteUser = false,
): string {
  const width = Math.max(20, columns);
  const lines = [title, ""];
  const options = pickerOptions(rooms, canInviteUser);
  let optionIndex = 0;

  for (const option of options) {
    const isSelected = !option.disabled && optionIndex === selectedIndex;
    const prefix = option.disabled ? "  " : isSelected ? "> " : "  ";

    if (!option.disabled) {
      optionIndex += 1;
    }

    lines.push(`${prefix}${truncate(option.label, width - 4)}`);
  }

  if (notice.length > 0) {
    lines.push("", truncate(notice, width));
  }

  lines.push("", "Enter selects, r refreshes, q quits.");
  return `${lines.join("\n")}\n`;
}

function selectableOptions(
  rooms: readonly JoinedRoom[],
  canInviteUser: boolean,
): PickerOption[] {
  return pickerOptions(rooms, canInviteUser).filter(
    (option): option is PickerOption => !option.disabled,
  );
}

function pickerOptions(
  rooms: readonly JoinedRoom[],
  canInviteUser: boolean,
): AnyPickerOption[] {
  const roomOptions: AnyPickerOption[] =
    rooms.length === 0
      ? [{ label: "No rooms in this workspace", disabled: true }]
      : rooms.map((room) => ({
          label: room.name,
          action: { type: "open-room", roomId: room.roomId },
        }));

  return [
    ...roomOptions,
    ...(canInviteUser
      ? [{ label: "Invite user", action: { type: "invite-user" } } satisfies PickerOption]
      : []),
    { label: "Refresh", action: { type: "refresh" } },
    { label: "Home", action: { type: "home" } },
    { label: "Quit", action: { type: "quit" } },
  ];
}

async function promptForInviteUserId(
  io: SpaceRoomPickerIo,
  onKeypress: (text: string, key: KeypressEvent) => Promise<void>,
): Promise<string | SpaceRoomPickerResult> {
  io.input.off("keypress", onKeypress);
  io.input.setRawMode(false);
  io.output.write("\x1b[?25h\x1b[0m\n");

  try {
    const result = await promptRequiredNavigation("Matrix user ID", io);

    if (result.type === "value") {
      return result.value.trim();
    }

    return result;
  } finally {
    io.input.on("keypress", onKeypress);
    io.input.setRawMode(true);
    io.output.write("\x1b[?25l");
  }
}

function isMatrixUserId(value: string): boolean {
  return /^@[^:\s]+:.+$/.test(value);
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
