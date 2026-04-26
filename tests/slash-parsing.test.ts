import assert from "node:assert/strict";
import test from "node:test";

import { parseSlashCommand } from "../src/ui/chat-commands.js";

test("parses implemented slash commands", () => {
  assert.deepEqual(parseSlashCommand("/help"), { type: "help" });
  assert.deepEqual(parseSlashCommand("/leave"), { type: "leave" });
  assert.deepEqual(parseSlashCommand("/select"), { type: "select" });
  assert.deepEqual(parseSlashCommand("/home"), { type: "home" });
  assert.deepEqual(parseSlashCommand("/quit"), { type: "quit" });
  assert.deepEqual(parseSlashCommand("/exit"), { type: "quit" });
});

test("parses invite command and Matrix user validation", () => {
  assert.deepEqual(parseSlashCommand("/invite @user:server"), {
    emptyUserId: false,
    type: "invite",
    userId: "@user:server",
    validUserId: true,
  });
  assert.deepEqual(parseSlashCommand("/invite"), {
    emptyUserId: true,
    type: "invite",
    userId: "",
    validUserId: false,
  });
  assert.deepEqual(parseSlashCommand("/invite user:server"), {
    emptyUserId: false,
    type: "invite",
    userId: "user:server",
    validUserId: false,
  });
});

test("parses ask command syntax without requiring agent CLIs", () => {
  assert.deepEqual(parseSlashCommand("/ask codex summarize"), {
    agent: "codex",
    emptyPrompt: false,
    prompt: "summarize",
    type: "ask",
  });
  assert.deepEqual(parseSlashCommand("/ask claude summarize"), {
    agent: "claude",
    emptyPrompt: false,
    prompt: "summarize",
    type: "ask",
  });
  assert.deepEqual(parseSlashCommand("/ask hermes summarize"), {
    agent: "hermes",
    emptyPrompt: false,
    prompt: "summarize",
    type: "ask",
  });
  assert.deepEqual(parseSlashCommand("/ask codex"), {
    agent: "codex",
    emptyPrompt: true,
    prompt: "",
    type: "ask",
  });
  assert.deepEqual(parseSlashCommand("/ask unknown summarize"), {
    agent: null,
    emptyPrompt: false,
    prompt: "summarize",
    type: "ask",
  });
});

test("parses empty and unknown slash commands", () => {
  assert.deepEqual(parseSlashCommand("/"), { type: "empty" });
  assert.deepEqual(parseSlashCommand("/does-not-exist now"), {
    command: "/does-not-exist",
    type: "unknown",
  });
});
