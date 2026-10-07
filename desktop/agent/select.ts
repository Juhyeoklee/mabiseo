import type { Agent } from "./agent.js";
import { ClaudeAgent } from "./claude.js";
import { OpenAiAgent } from "./openai.js";

export type Provider = "openai" | "claude";

export const providerFlags: Readonly<Record<string, Provider>> = { "--provider=openai": "openai", "--provider=claude": "claude" };

export function selectAgent(provider: Provider): Agent {
  return provider === "claude" ? new ClaudeAgent() : new OpenAiAgent();
}
