import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

import type { JoinedRoom } from "../matrix/index.js";

interface SpaceRoomPickerIo {
  input: ReadStream;
  output: WriteStream;
}

type PickerAction =
  | { type: "open-room"; roomId: string }
  | { type: "refresh" }
  | { type: "quit" };

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
  io?: SpaceRoomPickerIo;
}): Promise<void> {
  const io = options.io ?? { input: process.stdin, output: process.stdout };

  if (!io.input.isTTY || !io.output.isTTY) {
    const rooms = await options.loadRooms();
    io.output.write(renderPicker(options.title, rooms, -1, io.output.columns ?? 80));
    return;
  }

  let rooms = await options.loadRooms();
  let selectedIndex = 0;
  let notice = "";

  emitKeypressEvents(io.input);
  io.input.setRawMode(true);
  io.output.write("\x1b[?25l");

  const render = (): void => {
    const selectableCount = selectableOptions(rooms).length;
    selectedIndex = selectableCount === 0 ? 0 : selectedIndex % selectableCount;
    io.output.write(
      `\x1b[2J\x1b[H${renderPicker(
        options.title,
        rooms,
        selectedIndex,
        io.output.columns ?? 80,
        notice,
      )}`,
    );
  };

  let resolveDone: (() => void) | null = null;

  let cleanup = (): void => {
    io.input.off("keypress", onKeypress);
    io.input.setRawMode(false);
    io.output.write("\x1b[?25h\x1b[0m\n");
    resolveDone?.();
  };

  const refresh = async (): Promise<void> => {
    rooms = await options.loadRooms();
    render();
  };

  const finish = (): void => {
    cleanup();
  };

  const onKeypress = async (_text: string, key: KeypressEvent): Promise<void> => {
    if (key.ctrl && key.name === "c") {
      finish();
      return;
    }

    if (key.name === "escape" || key.name === "q") {
      finish();
      return;
    }

    const selectable = selectableOptions(rooms);

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

    const selected = selectable[selectedIndex];

    if (!selected) {
      return;
    }

    if (selected.action.type === "quit") {
      finish();
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

  await new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
}

function renderPicker(
  title: string,
  rooms: readonly JoinedRoom[],
  selectedIndex: number,
  columns: number,
  notice = "",
): string {
  const width = Math.max(20, columns);
  const lines = [title, ""];
  const options = pickerOptions(rooms);
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

  lines.push("", "Enter opens, r refreshes, q quits.");
  return `${lines.join("\n")}\n`;
}

function selectableOptions(rooms: readonly JoinedRoom[]): PickerOption[] {
  return pickerOptions(rooms).filter((option): option is PickerOption => !option.disabled);
}

function pickerOptions(rooms: readonly JoinedRoom[]): AnyPickerOption[] {
  const roomOptions: AnyPickerOption[] =
    rooms.length === 0
      ? [{ label: "No rooms in this workspace", disabled: true }]
      : rooms.map((room) => ({
          label: room.name,
          action: { type: "open-room", roomId: room.roomId },
        }));

  return [
    ...roomOptions,
    { label: "Refresh", action: { type: "refresh" } },
    { label: "Quit", action: { type: "quit" } },
  ];
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
