import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connector, Json } from "../connector/connector.js";
import { FakeConnector } from "../connector/fake.js";
import { Workshop } from "../connector/workshop.js";
import type { Outline } from "../tools/production.js";
import { Tools } from "../tools/tools.js";
import type { AgentEvent } from "./agent.js";
import { handlers } from "./handlers.js";

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
  const outlines: (Outline | undefined)[] = [];
  const events: AgentEvent[] = [];
  const decisions = { next: decision };
  const approve = async (tool: string, input: unknown, cost: number, outline?: Outline) => {
    requests.push({ tool, input, wings: cost });
    outlines.push(outline);
    return decisions.next;
  };
  const tools = new Tools(connector, wings);
  const list = handlers({ tools, approve, onEvent: (event) => events.push(event) });
  const call = async (name: string, input: unknown = {}) => {
    const found = list.find((h) => h.name === name);
    if (!found) throw new Error(name);
    return (await found.run(input)) as Json;
  };
  const propose = (steps: { tool: string; displayName: string; times: number }[]) => call("propose_plan", { steps });
  const asked = (): string[] => requests.map((r) => r.tool);
  return { connector, tools, asked, requests, outlines, events, list, call, propose, decisions };
}

describe("카탈로그가 공급자와 무관한 도구가 된다", () => {
  it("조회 · 맡기기 도구 28개와 계획 도구 둘이 겹치지 않는 이름과 빈 칸 없는 설명으로 나오고 계획 도구가 맨 뒤다", async () => {
    const { list } = await setup(true);
    const names = list.map((h) => h.name);
    expect(names).toHaveLength(30);
    expect(new Set(names).size).toBe(30);
    expect(names).toEqual(expect.arrayContaining(["get_currencies", "execute_gathering", "wait_altering"]));
    expect(names.slice(-2)).toEqual(["propose_plan", "plan_production"]);
    expect(list.every((h) => h.description.length > 0)).toBe(true);
  });

  it("필수 파라미터가 빠지면 커넥터에 닿지 않고 invalid_input을 값으로 돌려준다. 선택 파라미터는 비워도 된다", async () => {
    const { connector, asked, call } = await setup(true);
    expect(await call("execute_gathering", {})).toMatchObject({ error: "invalid_input" });
    expect(asked()).toEqual([]);
    expect(connector.calls).toEqual([]);
    expect(await call("get_items", {})).not.toMatchObject({ error: "invalid_input" });
  });

  it("number 파라미터에 문자열이 오면 커넥터에 닿지 않고 invalid_input을 값으로 돌려준다", async () => {
    const { connector, call } = await setup(true);
    expect(await call("execute_crafting", { displayName: "거미줄", craftCount: "둘" })).toMatchObject({ error: "invalid_input" });
    expect(connector.calls).toEqual([]);
  });

  it("계획의 단계가 비거나 맡기기가 아닌 도구를 담으면 승인을 묻지 않고 invalid_input을 돌려준다", async () => {
    const { asked, propose } = await setup(true, 50);
    expect(await propose([])).toMatchObject({ error: "invalid_input" });
    expect(await propose([{ tool: "get_items", displayName: "철 광석", times: 1 }])).toMatchObject({ error: "invalid_input" });
    expect(asked()).toEqual([]);
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

describe("가공 계획을 세우고 단계별로 지시한다", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  interface Next {
    tool: string;
    input: Record<string, string | number>;
  }

  const produce = (call: (name: string, input?: unknown) => Promise<Json>) => call("plan_production", { item: "강철괴", count: 9 }) as Promise<Json & { next_step: Next }>;

  async function follow(call: (name: string, input?: unknown) => Promise<Json>, first: Next) {
    const called: Next[] = [];
    let next: Next | null = first;
    let last: Json = null;
    while (next) {
      called.push(next);
      let settled = false;
      const pending = call(next.tool, next.input).finally(() => (settled = true));
      for (let ms = 0; !settled && ms < 20 * 60_000; ms += 10_000) await vi.advanceTimersByTimeAsync(10_000);
      last = await pending;
      next = (last as { next_step: Next | null }).next_step;
    }
    return { called, last };
  }

  it("가진 재료로 단계를 세어 날개 합계와 함께 한 번 승인받고 첫 단계를 next_step으로 준다", async () => {
    const { requests, call } = await setup(true, 50, true);
    expect(await produce(call)).toMatchObject({
      approved: true,
      wings: 30,
      next_step: { tool: "execute_altering", input: { displayName: "철괴(철 광석)", count: 3 } },
    });
    expect(requests).toEqual([
      {
        tool: "propose_plan",
        input: {
          "execute_altering 철괴(철 광석)": 3,
          "complete_altering_work 철괴(철 광석)": 1,
          "execute_altering 강철괴": 3,
          "complete_altering_work 강철괴": 1,
        },
        wings: 30,
      },
    ]);
  });

  it("승인 요청에 단계마다 종류 · 만드는 것 · 수 · 예상 초 · 날개 · 시설을 싣는다", async () => {
    const { outlines, call } = await setup(true, 50, true);
    await produce(call);
    const metal = "금속 가공 시설";
    expect(outlines).toEqual([
      {
        item: "강철괴",
        count: 9,
        steps: [
          { kind: "register", item: "철괴", count: 3, seconds: 7, wings: 15, facility: metal },
          { kind: "wait", item: "철괴", count: 9, seconds: 90, wings: 0, facility: metal },
          { kind: "collect", item: "철괴", count: 9, seconds: 6, wings: 0, facility: metal },
          { kind: "register", item: "강철괴", count: 3, seconds: 7, wings: 15, facility: metal },
          { kind: "wait", item: "강철괴", count: 9, seconds: 900, wings: 0, facility: metal },
          { kind: "collect", item: "강철괴", count: 9, seconds: 6, wings: 0, facility: metal },
        ],
      },
    ]);
  });

  it("propose_plan 승인 요청에는 단계 모양을 싣지 않는다", async () => {
    const { outlines, propose } = await setup(true, 50, true);
    await propose([{ tool: "execute_gathering", displayName: "철 광석", times: 1 }]);
    expect(outlines).toEqual([undefined]);
  });

  it("승인되면 0단계와 전체 예상 시간을 알리고, 단계를 마칠 때마다 마친 수와 남은 예상 시간을 알린다", async () => {
    vi.useFakeTimers();
    const { events, call } = await setup(true, 50, true);
    await follow(call, (await produce(call)).next_step);
    const steps = events.flatMap((e) => (e.kind === "plan_step" ? [e] : []));
    const firsts = steps.filter((e, i) => i === 0 || steps[i - 1]?.done !== e.done);
    expect(firsts.map((e) => [e.done, e.remainingSeconds])).toEqual([
      [0, 1016],
      [1, 1009],
      [2, 919],
      [3, 913],
      [4, 906],
      [5, 6],
      [6, 0],
    ]);
  });

  it("거절된 계획은 단계 진행을 알리지 않는다", async () => {
    const { events, call } = await setup(false, 50, true);
    await produce(call);
    expect(events).toEqual([]);
  });

  it("next_step대로 부르면 다시 묻지 않고 강철괴까지 가고, 마지막 결과에 next_step null과 plan_done이 붙는다", async () => {
    vi.useFakeTimers();
    const { asked, call } = await setup(true, 50, true);
    const { called, last } = await follow(call, (await produce(call)).next_step);
    expect(called.map((n) => `${n.tool} ${n.input.displayName}`)).toEqual([
      "execute_altering 철괴(철 광석)",
      "wait_altering 철괴(철 광석)",
      "complete_altering_work 철괴(철 광석)",
      "execute_altering 강철괴",
      "wait_altering 강철괴",
      "complete_altering_work 강철괴",
    ]);
    expect(last).toMatchObject({ next_step: null, plan_done: expect.any(String) });
    expect(await call("get_items", { name: "강철괴" })).toEqual([expect.objectContaining({ DisplayName: "강철괴", Count: 9 })]);
    expect(asked()).toEqual(["propose_plan"]);
  });

  it("계획 중 다른 조회를 불러도 결과에 지금 단계가 next_step으로 붙는다", async () => {
    const { call } = await setup(true, 50, true);
    const { next_step } = await produce(call);
    expect(await call("get_currencies")).toMatchObject({ result: expect.any(Array), next_step });
  });

  it("등록을 나눠 부르면 남은 등록 수가 next_step에 남는다", async () => {
    const { call } = await setup(true, 50, true);
    await produce(call);
    await call("execute_altering", { displayName: "철괴(철 광석)", count: 1 });
    await call("execute_altering", { displayName: "철괴(철 광석)", count: 1 });
    expect(await call("get_currencies")).toMatchObject({ next_step: { tool: "execute_altering", input: { displayName: "철괴(철 광석)", count: 1 } } });
  });

  it("대기가 끝나지 않고 돌아오면 같은 대기를 다시 지시하지 않고 next_step null과 plan_stopped로 단계 지시를 멈춘다", async () => {
    vi.useFakeTimers();
    const { call, tools } = await setup(true, 50, true);
    await produce(call);
    await call("execute_altering", { displayName: "철괴(철 광석)", count: 3 });
    const waiting = call("wait_altering", { displayName: "철괴(철 광석)" });
    await vi.advanceTimersByTimeAsync(0);
    await tools.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting).toMatchObject({ result: { completed: false }, next_step: null, plan_stopped: expect.any(String) });
    expect(await call("get_currencies")).not.toHaveProperty("next_step");
  });

  it("거부된 단계는 넘어가지 않는다", async () => {
    const { call } = await setup(true, 50, true);
    const { next_step } = await produce(call);
    expect(await call("complete_altering_work", { displayName: "철괴(철 광석)" })).toMatchObject({ result: { error: "no_altering" }, next_step });
  });

  it("거절된 계획은 next_step을 붙이지 않는다", async () => {
    const { call } = await setup(false, 50, true);
    expect(await produce(call)).toMatchObject({ error: "user_denied" });
    expect(await call("get_currencies")).not.toHaveProperty("next_step");
  });

  it("새 propose_plan은 단계 지시를 끝낸다", async () => {
    const { call, propose } = await setup(true, 50, true);
    await produce(call);
    await propose([{ tool: "execute_gathering", displayName: "철 광석", times: 1 }]);
    expect(await call("get_currencies")).not.toHaveProperty("next_step");
  });

  it("가공법을 모르면 승인을 묻지 않고 no_recipe를 돌려준다", async () => {
    const { asked, call } = await setup(true, 50, true);
    expect(await call("plan_production", { item: "목재", count: 3 })).toMatchObject({ error: "no_recipe" });
    expect(asked()).toEqual([]);
  });

  it("계획의 날개가 세션 예산을 넘으면 묻지 않고 wings_budget으로 돌려준다", async () => {
    const { asked, call } = await setup(true, 25, true);
    expect(await produce(call)).toMatchObject({ error: "wings_budget" });
    expect(asked()).toEqual([]);
  });
});
