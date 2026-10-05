import { z } from "zod";

const toolInput = z.record(z.string(), z.json());

export const phoneMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pair"), code: z.string() }),
  z.strictObject({ type: z.literal("ask"), id: z.string(), text: z.string() }),
  z.strictObject({ type: z.literal("approve"), id: z.string(), allow: z.boolean() }),
  z.strictObject({ type: z.literal("cancel"), id: z.string() }),
]);
export type PhoneMessage = z.infer<typeof phoneMessage>;

export const agentEvent = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("started"), model: z.string() }),
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({ kind: z.literal("tool"), name: z.string(), input: toolInput }),
  z.strictObject({ kind: z.literal("tool_result"), text: z.string() }),
  z.strictObject({ kind: z.literal("progress"), activity: z.string(), elapsedSeconds: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal("done"), text: z.string(), turns: z.int().nonnegative(), costUsd: z.number().nonnegative() }),
  z.strictObject({ kind: z.literal("failed"), reason: z.string() }),
]);
export type AgentEvent = z.infer<typeof agentEvent>;

export const connectorState = z.enum(["connected", "disconnected", "not_in_game"]);
export type ConnectorState = z.infer<typeof connectorState>;

export const desktopMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("paired"), pcName: z.string() }),
  z.strictObject({ type: z.literal("pair_failed"), reason: z.enum(["wrong_code"]) }),
  z.strictObject({ type: z.literal("status"), connector: connectorState, wings: z.int().nonnegative() }),
  z.strictObject({
    type: z.literal("approval_request"),
    id: z.string(),
    askId: z.string(),
    tool: z.string(),
    input: toolInput,
    wings: z.int().nonnegative(),
  }),
  z.strictObject({ type: z.literal("event"), id: z.string(), seq: z.int().nonnegative(), event: agentEvent }),
]);
export type DesktopMessage = z.infer<typeof desktopMessage>;
