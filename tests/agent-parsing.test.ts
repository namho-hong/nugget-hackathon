import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentMention } from "../src/ui/chat-commands.js";

test("parses supported English agent mentions", () => {
  assert.deepEqual(parseAgentMention("@codex summarize"), {
    agent: "codex",
    emptyPrompt: false,
    prompt: "summarize",
    type: "agent",
  });
  assert.deepEqual(parseAgentMention("@claude, summarize"), {
    agent: "claude",
    emptyPrompt: false,
    prompt: "summarize",
    type: "agent",
  });
  assert.deepEqual(parseAgentMention("@claude， summarize"), {
    agent: "claude",
    emptyPrompt: false,
    prompt: "summarize",
    type: "agent",
  });
  assert.deepEqual(parseAgentMention("@hermes: summarize"), {
    agent: "hermes",
    emptyPrompt: false,
    prompt: "summarize",
    type: "agent",
  });
});

test("parses supported Korean agent aliases", () => {
  assert.deepEqual(parseAgentMention("@코덱스 요약해줘"), {
    agent: "codex",
    emptyPrompt: false,
    prompt: "요약해줘",
    type: "agent",
  });
  assert.deepEqual(parseAgentMention("@클로드, 확인해줘"), {
    agent: "claude",
    emptyPrompt: false,
    prompt: "확인해줘",
    type: "agent",
  });
  assert.deepEqual(parseAgentMention("@에르메스: 조사해줘"), {
    agent: "hermes",
    emptyPrompt: false,
    prompt: "조사해줘",
    type: "agent",
  });
});

test("distinguishes empty and unsupported mentions", () => {
  assert.deepEqual(parseAgentMention("@codex"), {
    agent: "codex",
    emptyPrompt: true,
    prompt: "",
    type: "agent",
  });
  assert.deepEqual(parseAgentMention("@unknown summarize"), { type: "not-agent" });
  assert.deepEqual(parseAgentMention("@room please read this"), { type: "not-agent" });
});
