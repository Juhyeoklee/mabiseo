import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { handlers, toolNames, type HandlerSession } from "./handlers.js";

export const serverName = "mabiseo";

export function mcpServer(session: HandlerSession): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: serverName,
    version: "0",
    tools: handlers(session).map((h) =>
      tool(h.name, h.description, h.shape, async (input) => ({ content: [{ type: "text" as const, text: JSON.stringify(await h.run(input)) }] })),
    ),
  });
}

export const allowedToolNames: readonly string[] = toolNames.map((name) => `mcp__${serverName}__${name}`);

export function shortName(mcpToolName: string): string {
  return mcpToolName.replace(`mcp__${serverName}__`, "");
}
