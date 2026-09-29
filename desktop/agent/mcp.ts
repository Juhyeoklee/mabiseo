import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { catalog, type Param, type ToolName, type ToolSpec } from "../tools/catalog.js";
import type { ToolInput, Tools } from "../tools/tools.js";

export const serverName = "mabiseo";

export type Approve = (name: ToolName, input: ToolInput) => Promise<boolean>;

type Field = z.ZodString | z.ZodNumber | z.ZodOptional<z.ZodString> | z.ZodOptional<z.ZodNumber>;
type Shape = Record<string, Field>;

export function toolDefinitions(tools: Tools, approve: Approve): SdkMcpToolDefinition<Shape>[] {
  return catalog.map((spec) =>
    tool(spec.name, spec.description, shape(spec), async (input) => {
      const result =
        spec.kind === "execute" && !(await approve(spec.name, input))
          ? { error: "user_denied", message: `사용자가 ${spec.name}을 승인하지 않았다. 다시 시도하지 말고 사용자에게 알린다` }
          : await tools.call(spec.name, input);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }),
  );
}

export function mcpServer(tools: Tools, approve: Approve): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: serverName, version: "0", tools: toolDefinitions(tools, approve) });
}

export const allowedToolNames: readonly string[] = catalog.map((spec) => `mcp__${serverName}__${spec.name}`);

export function shortName(mcpToolName: string): string {
  return mcpToolName.replace(`mcp__${serverName}__`, "");
}

function shape(spec: ToolSpec): Shape {
  const fields: Shape = {};
  for (const p of spec.params) fields[p.name] = field(p);
  return fields;
}

function field(p: Param): Field {
  const base = (p.type === "number" ? z.number() : z.string()).describe(p.description);
  return p.required ? base : base.optional();
}
