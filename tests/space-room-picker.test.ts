import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";
import test from "node:test";

import { runSpaceRoomPicker } from "../src/ui/space-room-picker.js";

test("workspace picker renders leave workspace action when handler is available", async () => {
  const input = Object.assign(new EventEmitter(), {
    isTTY: false,
  }) as unknown as ReadStream;
  let rendered = "";
  const output = Object.assign(new EventEmitter(), {
    columns: 80,
    isTTY: false,
    write(chunk: string | Uint8Array): boolean {
      rendered += String(chunk);
      return true;
    },
  }) as unknown as WriteStream;

  const result = await runSpaceRoomPicker({
    io: { input, output },
    loadRooms: () => [],
    onLeaveWorkspace: async () => {},
    onOpenRoom: async () => {},
    title: "Workspace: Product",
  });

  assert.deepEqual(result, { type: "quit" });
  assert.match(rendered, /Leave workspace/);
});
