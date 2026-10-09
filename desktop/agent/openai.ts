import { z } from "zod";
import { maxTurns, signedOutReason, systemPrompt, type Agent, type Auth, type Session, type Usage } from "./agent.js";
import { ChatGptAuth } from "./chatgpt.js";
import { handlers, type Handler } from "./handlers.js";

const responsesUrl = "https://api.openai.com/v1/responses";

export const models = { mid: "gpt-5.6-luna", high: "gpt-5.6-terra" } as const;

type Item = Record<string, unknown>;

interface FunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface OpenAiAgentOptions {
  auth?: Auth;
  fetch?: typeof fetch;
  model?: string;
}

export class OpenAiAgent implements Agent {
  readonly auth: Auth;
  private readonly fetch: typeof fetch;
  private readonly model: string;

  constructor(options: OpenAiAgentOptions = {}) {
    this.auth = options.auth ?? new ChatGptAuth();
    this.fetch = options.fetch ?? fetch;
    this.model = options.model ?? models.mid;
  }

  async ask(prompt: string, session: Session): Promise<void> {
    if (!(await this.auth.credential())) return session.onEvent({ kind: "failed", reason: signedOutReason });
    const list = handlers(session);
    const byName = new Map(list.map((h) => [h.name, h]));
    const tools = list.map(functionTool);
    const input: Item[] = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
    session.onEvent({ kind: "started", model: this.model });
    const unwatch = session.tools.watch((progress) => session.onEvent({ kind: "progress", ...progress }));
    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
        const { output, usage } = await this.respond(input, tools, session.abort?.signal);
        if (usage) session.onUsage(usage);
        // store:false라 앞 응답을 id로 잇지 못한다. 출력 항목을 id 없이 입력에 쌓아 다시 보낸다
        input.push(...output.map(({ id: _id, status: _status, ...item }) => item));
        const said = output.flatMap(messageText);
        for (const text of said) session.onEvent({ kind: "text", text });
        const calls = output.filter(isFunctionCall);
        if (!calls.length) return session.onEvent({ kind: "done", text: said.join("\n"), turns: turn, costUsd: 0 });
        // 한 응답에 여러 호출이 와도 차례로 부른다. 승인 요청이 겹치면 폰이 둘을 한꺼번에 받는다
        for (const call of calls) {
          if (session.abort?.signal.aborted) return;
          const args = parseArguments(call.arguments);
          session.onEvent({ kind: "tool", name: call.name, input: args });
          const result = JSON.stringify(await run(byName.get(call.name), call.name, args));
          session.onEvent({ kind: "tool_result", text: result });
          input.push({ type: "function_call_output", call_id: call.call_id, output: result });
        }
      }
      session.onEvent({ kind: "failed", reason: "error_max_turns" });
    } finally {
      unwatch();
    }
  }

  private async respond(input: Item[], tools: Item[], signal: AbortSignal | undefined): Promise<{ output: Item[]; usage: Usage | undefined }> {
    const token = await this.auth.credential();
    if (!token) throw new Error(signedOutReason);
    const response = await this.fetch(responsesUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // Sign in with ChatGPT 토큰은 store:false · stream:true가 없으면 400이다
      body: JSON.stringify({
        model: this.model,
        instructions: systemPrompt,
        input,
        tools,
        tool_choice: "auto",
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      }),
      ...(signal && { signal }),
    });
    if (!response.ok || !response.body) throw new Error(`OpenAI 응답 실패: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    // lite 응답이라 response.completed의 output이 비어 온다. 항목은 output_item.done으로만 모인다
    const output: Item[] = [];
    for await (const event of serverEvents(response.body)) {
      if (event["type"] === "response.output_item.done") output.push(event["item"] as Item);
      else if (event["type"] === "response.completed") return { output, usage: usageOf(event["response"]) };
      else if (event["type"] === "response.failed" || event["type"] === "response.incomplete" || event["type"] === "error") {
        throw new Error(`OpenAI 응답 실패: ${JSON.stringify(event).slice(0, 300)}`);
      }
    }
    throw new Error("OpenAI 응답이 완료 없이 끊겼다");
  }
}

function usageOf(response: unknown): Usage | undefined {
  const parsed = responseUsage.safeParse(response);
  if (!parsed.success) return undefined;
  const { input_tokens, input_tokens_details, output_tokens } = parsed.data.usage;
  return { input: input_tokens, cached: input_tokens_details?.cached_tokens ?? 0, output: output_tokens };
}

const responseUsage = z.object({
  usage: z.object({
    input_tokens: z.int().nonnegative(),
    input_tokens_details: z.object({ cached_tokens: z.int().nonnegative() }).optional(),
    output_tokens: z.int().nonnegative(),
  }),
});

function functionTool(h: Handler): Item {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(z.object(h.shape));
  return { type: "function", name: h.name, description: h.description, parameters, strict: false };
}

async function run(h: Handler | undefined, name: string, args: unknown): Promise<unknown> {
  if (!h) return { error: "unknown_tool", message: `${name}라는 도구는 없다` };
  return h.run(args);
}

function parseArguments(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isFunctionCall(item: Item): item is Item & FunctionCall {
  return item["type"] === "function_call" && typeof item["call_id"] === "string" && typeof item["name"] === "string";
}

function messageText(item: Item): string[] {
  if (item["type"] !== "message" || !Array.isArray(item["content"])) return [];
  const text = item["content"]
    .map((part: unknown) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
  return text ? [text] : [];
}

async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      buffer = buffer.slice(end + 2);
      if (data && data !== "[DONE]") yield JSON.parse(data) as Record<string, unknown>;
    }
  }
}
