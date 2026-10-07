import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { maxTurns, signedOutReason, systemPrompt, type Agent, type AgentEvent, type Auth, type AuthState, type Session } from "./agent.js";
import { allowedToolNames, mcpServer, serverName, shortName } from "./mcp.js";

const model = "claude-sonnet-5-5";

export class ApiKeyAuth implements Auth {
  readonly service = "Claude";

  async state(): Promise<AuthState> {
    return (await this.credential()) ? { signedIn: true, account: "API 키" } : { signedIn: false };
  }

  async credential(): Promise<string | undefined> {
    return process.env.ANTHROPIC_API_KEY || undefined;
  }
}

export class ClaudeAgent implements Agent {
  readonly auth = new ApiKeyAuth();

  async ask(prompt: string, session: Session): Promise<void> {
    const key = await this.auth.credential();
    if (!key) return session.onEvent({ kind: "failed", reason: signedOutReason });
    const stream = query({
      prompt,
      options: {
        systemPrompt,
        model,
        tools: [],
        mcpServers: { [serverName]: mcpServer(session.tools, session.approve) },
        allowedTools: [...allowedToolNames],
        permissionMode: "default",
        settingSources: [],
        persistSession: false,
        maxTurns,
        env: { ...process.env, ANTHROPIC_API_KEY: key },
        ...(session.abort && { abortController: session.abort }),
      },
    });
    const unwatch = session.tools.watch((progress) => session.onEvent({ kind: "progress", ...progress }));
    try {
      for await (const message of stream) {
        for (const event of events(message)) session.onEvent(event);
      }
    } finally {
      unwatch();
    }
  }
}

function events(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case "system":
      return message.subtype === "init" ? [{ kind: "started", model: message.model }] : [];
    case "assistant":
      return message.message.content.flatMap((block): AgentEvent[] => {
        if (block.type === "text") return [{ kind: "text", text: block.text }];
        if (block.type === "tool_use") return [{ kind: "tool", name: shortName(block.name), input: block.input }];
        return [];
      });
    case "user": {
      const content = message.message.content;
      if (typeof content === "string") return [];
      return content.flatMap((block): AgentEvent[] =>
        block.type === "tool_result" ? [{ kind: "tool_result", text: resultText(block.content) }] : [],
      );
    }
    case "result":
      if (message.subtype !== "success") return [{ kind: "failed", reason: message.subtype }];
      if (message.is_error) return [{ kind: "failed", reason: message.result }];
      return [{ kind: "done", text: message.result, turns: message.num_turns, costUsd: message.total_cost_usd }];
    default:
      return [];
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
    .join("");
}
