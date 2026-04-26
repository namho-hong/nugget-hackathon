export type AgentName = "codex" | "claude" | "hermes";

export interface AgentContextMessage {
  body: string;
  eventId: string;
  senderId: string;
  senderLabel: string;
  threadRootEventId?: string;
  timestamp: number;
}

export interface ChatAgentRequest {
  agent: AgentName;
  isThreadView: boolean;
  latestEventId?: string;
  prompt: string;
  recentMessages: AgentContextMessage[];
  roomId: string;
  roomName: string;
  selectedEventId?: string;
  threadRootEventId?: string;
  triggerEventId: string;
}
