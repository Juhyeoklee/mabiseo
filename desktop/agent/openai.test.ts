import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeConnector } from "../connector/fake.js";
import { Tools } from "../tools/tools.js";
import { signedOutReason, type AgentEvent, type Auth } from "./agent.js";
import type { Approve } from "./handlers.js";
import { OpenAiAgent } from "./openai.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));

type Item = Record<string, unknown>;

interface Sent {
  authorization: string | null;
  body: { input: Item[]; tools: Item[]; store: boolean; stream: boolean };
}

function sse(items: Item[]): string {
  const events = [...items.map((item) => ({ type: "response.output_item.done", item })), { type: "response.completed", response: { output: [] } }];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const call = (name: string, args: object, id = name): Item => ({ type: "function_call", id: `fc_${id}`, status: "completed", call_id: `call_${id}`, name, arguments: JSON.stringify(args) });
const say = (text: string): Item => ({ type: "message", id: "msg", status: "completed", role: "assistant", content: [{ type: "output_text", text }] });

function scripted(responses: string[]) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    sent.push({ authorization: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) as Sent["body"] });
    const next = responses.shift();
    if (next === undefined) throw new Error("준비한 응답이 없다");
    return new Response(next, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  return { fetch, sent };
}

function auth(signedIn: boolean): Auth {
  let issued = 0;
  return {
    service: "ChatGPT",
    state: async () => ({ signedIn: false }),
    credential: async () => (signedIn ? `token-${++issued}` : undefined),
  };
}

async function ask(responses: string[], options: { signedIn?: boolean; approve?: Approve; wings?: number } = {}) {
  const { fetch, sent } = scripted(responses);
  const agent = new OpenAiAgent({ auth: auth(options.signedIn ?? true), fetch });
  const events: AgentEvent[] = [];
  const tools = new Tools(await FakeConnector.fromDirectory(dir), options.wings ?? 10);
  await agent.ask("날개 몇 개야", { tools, approve: options.approve ?? (async () => true), onEvent: (e) => events.push(e) });
  return { events, sent };
}

describe("OpenAI 구현은 Responses 스트림으로 도구를 돌린다", () => {
  it("함수 호출을 도구로 부르고 결과를 입력에 쌓아 다음 응답을 받은 뒤 done으로 끝난다", async () => {
    const recorded = await (await FakeConnector.fromDirectory(dir)).run("get_currencies");
    const { events, sent } = await ask([sse([call("get_currencies", {})]), sse([say("날개는 1000개다")])]);

    expect(events.map((e) => e.kind)).toEqual(["started", "tool", "tool_result", "text", "done"]);
    expect(events[1]).toEqual({ kind: "tool", name: "get_currencies", input: {} });
    expect(JSON.parse((events[2] as { text: string }).text)).toEqual(recorded);
    expect(events[4]).toEqual({ kind: "done", text: "날개는 1000개다", turns: 2, costUsd: 0 });

    expect(sent).toHaveLength(2);
    expect(sent[1]?.body.input.slice(1)).toEqual([
      { type: "function_call", call_id: "call_get_currencies", name: "get_currencies", arguments: "{}" },
      { type: "function_call_output", call_id: "call_get_currencies", output: JSON.stringify(recorded) },
    ]);
  });

  it("요청은 store:false · stream:true로 가고 카탈로그와 계획 도구 29개를 함수로 싣는다", async () => {
    const { sent } = await ask([sse([say("끝")])]);
    const body = sent[0]!.body;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(29);
    expect(body.tools.find((t) => t["name"] === "execute_gathering")).toMatchObject({
      type: "function",
      parameters: { type: "object", required: ["displayName"], properties: { displayName: { type: "string" } } },
    });
  });

  it("요청마다 자격을 새로 받아 Authorization에 싣는다", async () => {
    const { sent } = await ask([sse([call("get_currencies", {})]), sse([say("끝")])]);
    const [first, second] = sent.map((s) => s.authorization);
    expect(first).toMatch(/^Bearer token-\d+$/);
    expect(second).toMatch(/^Bearer token-\d+$/);
    expect(second).not.toBe(first);
  });

  it("한 응답에 맡기기 호출이 둘 오면 앞 호출의 승인이 끝난 뒤에 다음 승인을 묻는다", async () => {
    const order: string[] = [];
    const approve: Approve = async (tool, input) => {
      order.push(`묻기 ${tool} ${input.displayName}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`답 ${tool} ${input.displayName}`);
      return false;
    };
    const both = sse([call("execute_gathering", { displayName: "통나무" }, "a"), call("execute_gathering", { displayName: "돌" }, "b")]);
    const { events } = await ask([both, sse([say("거절됐다")])], { approve });
    expect(order).toEqual(["묻기 execute_gathering 통나무", "답 execute_gathering 통나무", "묻기 execute_gathering 돌", "답 execute_gathering 돌"]);
    expect(events.filter((e) => e.kind === "tool_result").map((e) => JSON.parse((e as { text: string }).text).error)).toEqual(["user_denied", "user_denied"]);
  });

  it("모르는 도구 이름은 unknown_tool을 결과로 돌려주고 루프를 잇는다", async () => {
    const { events } = await ask([sse([call("buy_item", {})]), sse([say("그 도구는 없다")])]);
    expect(events.find((e) => e.kind === "tool_result")).toMatchObject({ text: expect.stringContaining("unknown_tool") });
    expect(events.at(-1)).toMatchObject({ kind: "done" });
  });

  it("로그인이 안 됐으면 요청을 보내지 않고 로그인이 필요하다며 실패로 끝난다", async () => {
    const { events, sent } = await ask([], { signedIn: false });
    expect(events).toEqual([{ kind: "failed", reason: signedOutReason }]);
    expect(sent).toEqual([]);
  });

  it("응답 스트림이 response.failed로 끝나면 던진다", async () => {
    const failed = `data: ${JSON.stringify({ type: "response.failed", response: { error: { code: "server_error" } } })}\n\n`;
    await expect(ask([failed])).rejects.toThrow("server_error");
  });
});
