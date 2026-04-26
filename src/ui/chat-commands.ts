import { isMatrixUserId } from "../matrix/membership.js";
import type { AgentName } from "../agent/types.js";

export type { AgentName };

export type AgentMentionParseResult =
  | { type: "agent"; agent: AgentName; prompt: string; emptyPrompt: boolean }
  | { type: "not-agent" };

export type SlashCommandParseResult =
  | { type: "help" }
  | { type: "home" }
  | { type: "quit" }
  | { type: "leave" }
  | { type: "select" }
  | { type: "invite"; userId: string; validUserId: boolean; emptyUserId: boolean }
  | { type: "ask"; agent: AgentName | null; prompt: string; emptyPrompt: boolean }
  | { type: "empty" }
  | { type: "unknown"; command: string };

const AGENT_ALIASES: ReadonlyMap<string, AgentName> = new Map([
  ["codex", "codex"],
  ["코덱스", "codex"],
  ["claude", "claude"],
  ["클로드", "claude"],
  ["hermes", "hermes"],
  ["에르메스", "hermes"],
]);

export function parseAgentMention(input: string): AgentMentionParseResult {
  const match = input.match(/^@([^\s,，:]+)(?:[\s,，:]+(.*))?$/u);

  if (!match) {
    return { type: "not-agent" };
  }

  const alias = match[1]?.toLowerCase();
  const agent = alias ? AGENT_ALIASES.get(alias) : undefined;

  if (!agent) {
    return { type: "not-agent" };
  }

  const prompt = (match[2] ?? "").trim();

  return {
    agent,
    emptyPrompt: prompt.length === 0,
    prompt,
    type: "agent",
  };
}

export function parseSlashCommand(input: string): SlashCommandParseResult {
  const text = input.trim();

  if (text === "/") {
    return { type: "empty" };
  }

  if (!text.startsWith("/")) {
    return { type: "unknown", command: "" };
  }

  const [command = "", ...restParts] = text.slice(1).split(/\s+/u);
  const rest = restParts.join(" ").trim();

  switch (command) {
    case "help":
      return { type: "help" };
    case "home":
      return { type: "home" };
    case "quit":
    case "exit":
      return { type: "quit" };
    case "leave":
      return { type: "leave" };
    case "select":
      return { type: "select" };
    case "invite": {
      return {
        emptyUserId: rest.length === 0,
        type: "invite",
        userId: rest,
        validUserId: rest.length > 0 && isMatrixUserId(rest),
      };
    }
    case "ask": {
      const [agentToken = "", ...promptParts] = rest.split(/\s+/u);
      const agent = AGENT_ALIASES.get(agentToken.toLowerCase()) ?? null;
      const prompt = promptParts.join(" ").trim();

      return {
        agent,
        emptyPrompt: prompt.length === 0,
        prompt,
        type: "ask",
      };
    }
    case "":
      return { type: "empty" };
    default:
      return { command: `/${command}`, type: "unknown" };
  }
}
