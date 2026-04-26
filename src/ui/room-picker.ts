import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

import type { JoinedRoom } from "../matrix/index.js";

interface RoomPickerIo {
  input: ReadStream;
  output: WriteStream;
}

export type JoinedRoomSelection =
  | { type: "open-room"; roomId: string }
  | { type: "home" }
  | { type: "quit" };

interface PickerOption {
  label: string;
  selection: JoinedRoomSelection;
}

export async function selectJoinedRoom(
  rooms: readonly JoinedRoom[],
  io: RoomPickerIo = { input: process.stdin, output: process.stdout },
): Promise<JoinedRoomSelection> {
  if (rooms.length === 0) {
    io.output.write("No joined Matrix rooms found.\n");
    return { type: "quit" };
  }

  if (!io.input.isTTY || !io.output.isTTY) {
    io.output.write(renderRoomPicker(rooms, -1, io.output.columns ?? 80));
    return { type: "quit" };
  }

  const options = pickerOptions(rooms);
  let selectedIndex = 0;

  emitKeypressEvents(io.input);
  io.input.resume();
  io.input.setRawMode(true);
  io.output.write("\x1b[?25l");

  try {
    return await new Promise<JoinedRoomSelection>((resolve) => {
      const render = (): void => {
        io.output.write(
          `\x1b[2J\x1b[H${renderRoomPicker(rooms, selectedIndex, io.output.columns ?? 80)}`,
        );
      };

      const cleanup = (): void => {
        io.input.off("keypress", onKeypress);
        io.input.setRawMode(false);
        io.output.write("\x1b[?25h\x1b[0m");
      };

      const finish = (selection: JoinedRoomSelection): void => {
        cleanup();
        io.output.write("\n");
        resolve(selection);
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
          selectedIndex = (selectedIndex - 1 + options.length) % options.length;
          render();
          return;
        }

        if (key.name === "down" || key.name === "j") {
          selectedIndex = (selectedIndex + 1) % options.length;
          render();
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          const selectedOption = options[selectedIndex];

          if (selectedOption) {
            finish(selectedOption.selection);
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

function renderRoomPicker(
  rooms: readonly JoinedRoom[],
  selectedIndex: number,
  columns: number,
): string {
  const width = Math.max(20, columns);
  const lines = ["Open Room", ""];

  pickerOptions(rooms).forEach((option, index) => {
    const prefix = index === selectedIndex ? "> " : "  ";
    lines.push(`${prefix}${truncate(option.label, width - 4)}`);
  });

  lines.push("", "Enter selects, Esc quits.");
  return `${lines.join("\n")}\n`;
}

function pickerOptions(rooms: readonly JoinedRoom[]): PickerOption[] {
  return [
    ...rooms.map((room) => ({
      label: `${room.name}  ${room.roomId}`,
      selection: { type: "open-room", roomId: room.roomId } satisfies JoinedRoomSelection,
    })),
    { label: "Home", selection: { type: "home" } },
    { label: "Quit", selection: { type: "quit" } },
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
