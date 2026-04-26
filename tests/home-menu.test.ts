import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";
import test from "node:test";

import { selectHomeAction } from "../src/ui/home-menu.js";

test("home menu renders refresh action", async () => {
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

  const result = await selectHomeAction(
    {
      directMessages: [],
      workspaces: [],
    },
    { input, output },
  );

  assert.deepEqual(result, { type: "quit" });
  assert.match(rendered, /Refresh/);
  assert.match(rendered, /r refreshes/);
});
