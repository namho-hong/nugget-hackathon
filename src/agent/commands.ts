import type { AgentName } from "./types.js";

const AGENT_COMMAND_ENV: Record<AgentName, string> = {
  claude: "NUGGET_CLAUDE_COMMAND",
  codex: "NUGGET_CODEX_COMMAND",
  hermes: "NUGGET_HERMES_COMMAND",
};

export function getAgentCommand(agent: AgentName, promptFile: string): string {
  const promptFileExpr = shellQuote(promptFile);
  const promptExpr = `"$(cat ${promptFileExpr})"`;
  const override = process.env[AGENT_COMMAND_ENV[agent]]?.trim();

  if (override) {
    const withPromptFile = override.replaceAll("{prompt_file}", promptFileExpr);
    const withPrompt = withPromptFile.replaceAll("{prompt}", promptExpr);

    return withPrompt === override ? `${override} ${promptExpr}` : withPrompt;
  }

  switch (agent) {
    case "codex":
      return `codex --no-alt-screen ${promptExpr}`;
    case "claude":
      return `claude ${promptExpr}`;
    case "hermes":
      return `hermes ${promptExpr}`;
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
