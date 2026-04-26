import assert from "node:assert/strict";
import test from "node:test";

import {
  fitDisplayText,
  getDisplayWidth,
  sanitizeForTerminal,
  truncateDisplayText,
} from "../src/util/terminal.js";

test("sanitizes control characters and terminal escape sequences", () => {
  assert.equal(
    sanitizeForTerminal("hello\x1b[31m red\x1b[0m\r\nnext\x00"),
    "hello red next",
  );
});

test("measures and truncates CJK/full-width display text", () => {
  assert.equal(getDisplayWidth("abc"), 3);
  assert.equal(getDisplayWidth("요약"), 4);
  assert.equal(truncateDisplayText("요약해주세요", 5), "요...");
  assert.equal(fitDisplayText("ok", 4), "ok  ");
});
