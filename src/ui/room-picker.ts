import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

import type { JoinedRoom } from "../matrix/index.js";

interface RoomPickerIo {
  input: ReadStream;
  output: WriteStream;
}

export async function selectJoinedRoom(
  rooms: readonly JoinedRoom[],
  io: RoomPickerIo = { input: process.stdin, output: process.stdout },
): Promise<string | null> {
  if (rooms.length === 0) {
    io.output.write("No joined Matrix rooms found.\n");
    return null;
  }

  if (!io.input.isTTY || !io.output.isTTY) {
    io.output.write(renderRoomPicker(rooms, -1, io.output.columns ?? 80));
    return null;
  }

  let selectedIndex = 0;

  emitKeypressEvents(io.input);
  io.input.setRawMode(true);
  io.output.write("\x1b[?25l");

  try {
    return await new Promise<string | null>((resolve) => {
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

      const finish = (roomId: string | null): void => {
        cleanup();
        io.output.write("\n");
        resolve(roomId);
      };

      const onKeypress = (_text: string, key: KeypressEvent): void => {
        if (key.ctrl && key.name === "c") {
          finish(null);
          return;
        }

        if (key.name === "escape" || key.name === "q") {
          finish(null);
          return;
        }

        if (key.name === "up" || key.name === "k") {
          selectedIndex = (selectedIndex - 1 + rooms.length) % rooms.length;
          render();
          return;
        }

        if (key.name === "down" || key.name === "j") {
          selectedIndex = (selectedIndex + 1) % rooms.length;
          render();
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          const selectedRoom = rooms[selectedIndex];

          if (selectedRoom) {
            finish(selectedRoom.roomId);
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

  rooms.forEach((room, index) => {
    const prefix = index === selectedIndex ? "> " : "  ";
    const label = `${room.name}  ${room.roomId}`;
    lines.push(`${prefix}${truncate(label, width - 4)}`);
  });

  lines.push("", "Enter opens, Esc quits.");
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
