import type { Agent } from "./agent.js";
import { ChatGptAuth } from "./chatgpt.js";
import { ClaudeAgent } from "./claude.js";
import { models, OpenAiAgent } from "./openai.js";

export type Provider = "openai" | "claude";

export const providerFlags: Readonly<Record<string, Provider>> = { "--provider=openai": "openai", "--provider=claude": "claude" };

export interface Tiers {
  mid: Agent;
  high: Agent;
}

export function selectAgents(provider: Provider): Tiers {
  if (provider === "claude") {
    const claude = new ClaudeAgent();
    return { mid: claude, high: claude };
  }
  const auth = new ChatGptAuth();
  return { mid: new OpenAiAgent({ auth, model: models.mid }), high: new OpenAiAgent({ auth, model: models.high }) };
}
