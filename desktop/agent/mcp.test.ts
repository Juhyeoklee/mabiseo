import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Connector, Json } from "../connector/connector.js";
import { FakeConnector } from "../connector/fake.js";
import { Workshop } from "../connector/workshop.js";
import { catalog } from "../tools/catalog.js";
import { Tools } from "../tools/tools.js";
import { allowedToolNames, planDefinition, shortName, toolDefinitions } from "./mcp.js";
import { Plan } from "./plan.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));

class Counting implements Connector {
  calls: [string, string | undefined][] = [];
  constructor(private readonly inner: Connector) {}
  async run(command: string, body: string | undefined, timeoutMs: number): Promise<Json> {
    this.calls.push([command, body]);
    return this.inner.run(command, body, timeoutMs);
  }
}

interface Asked {
  tool: string;
  input: unknown;
  wings: number;
}

async function setup(decision: boolean, wings = 10, workshop = false) {
  const recorded = await FakeConnector.fromDirectory(dir);
  const connector = new Counting(workshop ? new Workshop(recorded, { "철 광석": 40 }, 100) : recorded);
  const requests: Asked[] = [];
  const decisions = { next: decision };
  const approve = async (tool: string, input: unknown, cost: number) => {
    requests.push({ tool, input, wings: cost });
    return decisions.next;
  };
  const tools = new Tools(connector, wings);
  const plan = new Plan();
  const definitions = toolDefinitions(tools, approve, plan);
  const proposal = planDefinition(tools, approve, plan);
  const call = async (name: string, input: Record<string, string | number | undefined> = {}) => {
    const definition = definitions.find((d) => d.name === name);
    if (!definition) throw new Error(name);
    return parse(await definition.handler(input, undefined));
  };
  const propose = async (steps: { tool: string; displayName: string; times: number }[]) => parse(await proposal.handler({ steps }, undefined));
  const asked = (): string[] => requests.map((r) => r.tool);
  return { connector, asked, requests, definitions, call, propose, decisions };
}

function parse(result: { content: { type: string; text?: string }[] }): Json {
  const block = result.content[0];
  return JSON.parse(block?.type === "text" && block.text ? block.text : "null") as Json;
}

describe("카탈로그가 SDK 도구로 바뀐다", () => {
  it("카탈로그 28개 도구가 같은 이름과 설명으로 나오고 모델에는 계획 도구와 함께 mcp__mabiseo__ 접두사로 보인다", async () => {
    const { definitions } = await setup(true);
    expect(definitions.map((d) => [d.name, d.description])).toEqual(catalog.map((t) => [t.name, t.description]));
    expect(definitions).toHaveLength(28);
    expect(allowedToolNames).toHaveLength(29);
    expect(allowedToolNames).toContain("mcp__mabiseo__get_currencies");
    expect(allowedToolNames).toContain("mcp__mabiseo__propose_plan");
    expect(shortName("mcp__mabiseo__get_currencies")).toBe("get_currencies");
  });

  it("필수 파라미터가 빠지면 스키마가 거절하고 선택 파라미터는 비워도 된다", async () => {
    const { definitions } = await setup(true);
    const gathering = z.object(definitions.find((d) => d.name === "execute_gathering")!.inputSchema);
    expect(gathering.safeParse({}).success).toBe(false);
    expect(gathering.safeParse({ displayName: "통나무" }).success).toBe(true);
    const items = z.object(definitions.find((d) => d.name === "get_items")!.inputSchema);
    expect(items.safeParse({}).success).toBe(true);
  });

  it("number 파라미터에 문자열이 오면 스키마가 거절한다", async () => {
    const { definitions } = await setup(true);
    const crafting = z.object(definitions.find((d) => d.name === "execute_crafting")!.inputSchema);
    expect(crafting.safeParse({ displayName: "거미줄", craftCount: "둘" }).success).toBe(false);
    expect(crafting.safeParse({ displayName: "거미줄", craftCount: 2 }).success).toBe(true);
  });
});

describe("승인 게이트", () => {
  it("조회 도구는 승인을 묻지 않고 커넥터 응답을 텍스트로 돌려준다", async () => {
    const { connector, asked, call } = await setup(false);
    expect(await call("get_currencies")).toEqual(await connector.run("get_currencies", undefined, 30_000));
    expect(asked()).toEqual([]);
  });

  it("맡기기 도구는 승인이 거절되면 커넥터에 닿지 않고 거절을 값으로 돌려준다", async () => {
    const { connector, asked, call } = await setup(false);
    const result = await call("execute_gathering", { displayName: "통나무" });
    expect(result).toMatchObject({ error: "user_denied" });
    expect(asked()).toEqual(["execute_gathering"]);
    expect(connector.calls).toEqual([]);
  });

  it("승인이 나면 커넥터에 닿는다", async () => {
    const { connector, call } = await setup(true);
    await call("execute_gathering", { displayName: "마비서없는아이템" });
    expect(connector.calls.filter(([c]) => c !== "get_currencies")).toEqual([["execute_gathering", '{"displayName":"마비서없는아이템"}']]);
  });

  it("승인이 나도 tools/의 날개 예산이 0이면 커넥터에 닿지 않는다", async () => {
    const { connector, call } = await setup(true, 0);
    expect(await call("execute_gathering", { displayName: "통나무" })).toMatchObject({ error: "wings_budget" });
    expect(connector.calls).toEqual([]);
  });
});

describe("계획 승인", () => {
  const gather = { tool: "execute_gathering", displayName: "철 광석", times: 1 };
  const alter = { tool: "execute_altering", displayName: "철괴(철 광석)", times: 3 };
  const collect = { tool: "complete_altering_work", displayName: "철괴(철 광석)", times: 1 };

  it("승인 요청은 단계별 호출 수와 날개 합계를 한 번에 싣는다. 날개를 쓰지 않는 수령은 합계에 들지 않는다", async () => {
    const { requests, propose } = await setup(true, 50, true);
    expect(await propose([gather, alter, collect])).toEqual({ approved: true, wings: 20 });
    expect(requests).toEqual([
      {
        tool: "propose_plan",
        input: { "execute_gathering 철 광석": 1, "execute_altering 철괴(철 광석)": 3, "complete_altering_work 철괴(철 광석)": 1 },
        wings: 20,
      },
    ]);
  });

  it("계획이 승인되면 계획 안의 맡기기는 다시 묻지 않고 커넥터에 닿는다", async () => {
    const { asked, call, propose } = await setup(true, 50, true);
    await propose([gather, alter]);
    expect(await call("execute_gathering", { displayName: "철 광석" })).toMatchObject({ result: "completed" });
    expect(await call("execute_altering", { displayName: "철괴(철 광석)", count: 2 })).toMatchObject({ registered: 2 });
    expect(await call("execute_altering", { displayName: "철괴(철 광석)" })).toMatchObject({ registered: 1 });
    expect(asked()).toEqual(["propose_plan"]);
  });

  it("되풀이 등록이 중간에 멈추면 등록되지 않은 수는 계획에 남아 다시 묻지 않는다", async () => {
    const { asked, call, propose } = await setup(true, 50, true);
    await propose([gather, { ...alter, times: 5 }]);
    expect(await call("execute_altering", { displayName: "철괴(철 광석)", count: 5 })).toMatchObject({ registered: 4, last: { error: "not_enough_ingredient" } });
    await call("execute_gathering", { displayName: "철 광석" });
    await call("get_items", { name: "철 광석" });
    expect(await call("execute_altering", { displayName: "철괴(철 광석)" })).toMatchObject({ registered: 1 });
    expect(asked()).toEqual(["propose_plan"]);
  });

  it("계획의 횟수를 넘거나 계획 밖인 맡기기는 따로 묻는다", async () => {
    const { asked, requests, call, propose, decisions } = await setup(true, 50, true);
    await propose([alter]);
    decisions.next = false;
    expect(await call("execute_altering", { displayName: "철괴(철 광석)", count: 4 })).toMatchObject({ error: "user_denied" });
    expect(await call("execute_gathering", { displayName: "철 광석" })).toMatchObject({ error: "user_denied" });
    expect(asked()).toEqual(["propose_plan", "execute_altering", "execute_gathering"]);
    expect(requests[1]).toMatchObject({ wings: 20 });
  });

  it("거절된 계획은 아무것도 승인하지 않는다", async () => {
    const { asked, call, propose, connector } = await setup(false, 50, true);
    expect(await propose([gather])).toMatchObject({ error: "user_denied" });
    expect(await call("execute_gathering", { displayName: "철 광석" })).toMatchObject({ error: "user_denied" });
    expect(asked()).toEqual(["propose_plan", "execute_gathering"]);
    expect(connector.calls).toEqual([]);
  });

  it("계획의 날개가 세션 예산을 넘으면 묻지 않고 wings_budget으로 돌려준다", async () => {
    const { asked, propose } = await setup(true, 15, true);
    expect(await propose([gather, alter])).toMatchObject({ error: "wings_budget" });
    expect(asked()).toEqual([]);
  });

  it("새 계획은 앞 계획의 남은 횟수를 잇지 않는다", async () => {
    const { asked, call, propose, decisions } = await setup(true, 50, true);
    await propose([alter]);
    await propose([gather]);
    decisions.next = false;
    expect(await call("execute_altering", { displayName: "철괴(철 광석)" })).toMatchObject({ error: "user_denied" });
    expect(asked()).toEqual(["propose_plan", "propose_plan", "execute_altering"]);
  });

  it("계획 없이 부른 등록은 count만큼의 날개를 승인 요청에 싣는다", async () => {
    const { requests, call } = await setup(false, 50, true);
    await call("execute_altering", { displayName: "철괴(철 광석)", count: 3 });
    expect(requests).toEqual([{ tool: "execute_altering", input: { displayName: "철괴(철 광석)", count: 3 }, wings: 15 }]);
  });
});
