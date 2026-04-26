import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

import type { JoinedRoom } from "../matrix/index.js";
import { truncateDisplayText } from "../util/terminal.js";
import {
  renderPickerFooter,
  renderPickerHeader,
  renderPickerLine,
  renderPickerSectionTitle,
} from "./picker-rendering.js";

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
  tag: string;
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
    io.output.write(renderRoomPicker(rooms, -1, io.output.columns ?? 80, false));
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
      let closed = false;

      const render = (): void => {
        if (closed) {
          return;
        }

        io.output.write(
          `\x1b[2J\x1b[H${renderRoomPicker(
            rooms,
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

function renderRoomPicker(
  rooms: readonly JoinedRoom[],
  selectedIndex: number,
  columns: number,
  useAnsi: boolean,
): string {
  const width = Math.max(20, Math.min(columns, 96));
  const subtitle = `${rooms.length} joined room${rooms.length === 1 ? "" : "s"}`;
  const lines = [...renderPickerHeader("Open Room", subtitle, width, useAnsi), ""];

  lines.push(renderPickerSectionTitle("Rooms", width, useAnsi));
  pickerOptions(rooms).forEach((option, index) => {
    lines.push(
      renderPickerLine({
        label: truncate(option.label, Math.max(10, width - 4)),
        selected: index === selectedIndex,
        tag: option.tag,
        width,
        useAnsi,
      }),
    );
  });

  lines.push("", renderPickerFooter("Up/Down or j/k move  Enter selects  q quits", width, useAnsi));
  return `${lines.join("\n")}\n`;
}

function pickerOptions(rooms: readonly JoinedRoom[]): PickerOption[] {
  return [
    ...rooms.map((room) => ({
      label: `${room.name}  ${room.roomId}`,
      tag: "room",
      selection: { type: "open-room", roomId: room.roomId } satisfies JoinedRoomSelection,
    })),
    { label: "Home", tag: "home", selection: { type: "home" } },
    { label: "Quit", tag: "quit", selection: { type: "quit" } },
  ];
}

function truncate(value: string, maxLength: number): string {
  return truncateDisplayText(value, maxLength);
}

interface KeypressEvent {
  name?: string;
  ctrl?: boolean;
}
