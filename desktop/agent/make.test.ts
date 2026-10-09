import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connector, Json } from "../connector/connector.js";
import { FakeConnector } from "../connector/fake.js";
import { Workshop } from "../connector/workshop.js";
import { Tools } from "../tools/tools.js";
import type { Agent, AgentEvent, Session } from "./agent.js";
import { make } from "./make.js";
import type { Tiers } from "./select.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));

class Recording implements Agent {
  readonly auth = { service: "fake", state: async () => ({ signedIn: false as const }), credential: async () => undefined };
  readonly prompts: string[] = [];
  async ask(prompt: string, session: Session): Promise<void> {
    this.prompts.push(prompt);
    session.onEvent({ kind: "done", text: "모델이 받았다", turns: 1, costUsd: 0 });
  }
}

class Blocking implements Connector {
  constructor(
    private readonly inner: Connector,
    private readonly blocked: string,
  ) {}
  async run(command: string, body: string | undefined, timeoutMs: number): Promise<Json> {
    if (command === "execute_altering" && body?.includes(this.blocked)) {
      return { error: "blocked", kind: "unknown_modal", message: "A blocking UI is covering the screen, so the action cannot continue." };
    }
    return this.inner.run(command, body, timeoutMs);
  }
}

class Endless implements Connector {
  constructor(private readonly inner: Connector) {}
  async run(command: string, body: string | undefined, timeoutMs: number): Promise<Json> {
    if (command !== "get_altering_works") return this.inner.run(command, body, timeoutMs);
    return { works: [{ DisplayName: "철괴(철 광석)", FacilityName: "금속 가공 시설", State: "InProgress", IsCompleted: false, RemainingSeconds: 600 }] };
  }
}

async function run(connector: Connector, item: string, count: number, options: { wings?: number; allow?: boolean; abortOnApproval?: boolean } = {}) {
  const tiers = { mid: new Recording(), high: new Recording() } satisfies Tiers;
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  const session: Session = {
    tools: new Tools(connector, options.wings ?? 500),
    approve: async () => {
      if (options.abortOnApproval) abort.abort();
      return options.allow ?? true;
    },
    onEvent: (event) => events.push(event),
    onUsage: () => {},
    abort,
  };
  let settled = false;
  const pending = make(item, count, session, tiers).finally(() => (settled = true));
  while (!settled) await vi.advanceTimersByTimeAsync(60_000);
  await pending;
  return { tiers, events };
}

const workshop = async (stock: Record<string, number>) => new Workshop(await FakeConnector.fromDirectory(dir), stock, 1000);

describe("제작 버튼은 계획을 코드가 돌리고 막혔을 때만 모델을 부른다", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("철 광석 12개로 강철괴 100개를 만드는 일은 모델을 한 번도 부르지 않고 채집 · 등록 · 대기 · 수령을 다 해 끝난다", async () => {
    vi.useFakeTimers();
    const shop = await workshop({ "철 광석": 12 });
    const { tiers, events } = await run(shop, "강철괴", 100);

    expect(tiers.mid.prompts).toEqual([]);
    expect(tiers.high.prompts).toEqual([]);
    expect(events.filter((e) => e.kind === "plan_ended")).toEqual([{ kind: "plan_ended", reason: "done" }]);
    expect(events.at(-1)).toEqual({ kind: "done", text: "강철괴 100개를 만들었어요.", turns: 0, costUsd: 0 });
    const steel = await shop.run("get_items", JSON.stringify({ name: "강철괴" }), 0);
    expect(steel).toMatchObject([{ DisplayName: "강철괴", Count: 102 }]);
  });

  it("도구를 부를 때마다 도구 이름과 결과를 event로 남긴다", async () => {
    vi.useFakeTimers();
    const { events } = await run(await workshop({ "철 광석": 12 }), "철괴", 3);
    expect(events.filter((e) => e.kind === "tool").map((e) => e.kind === "tool" && e.name)).toEqual([
      "plan_production",
      "execute_altering",
      "wait_altering",
      "complete_altering_work",
    ]);
    expect(events.filter((e) => e.kind === "tool_result")).toHaveLength(4);
  });

  it("가공법을 모르는 품목은 고성능 모델에 맡긴다", async () => {
    vi.useFakeTimers();
    const { tiers, events } = await run(await workshop({}), "목재", 10);
    expect(tiers.mid.prompts).toEqual([]);
    expect(tiers.high.prompts).toEqual([expect.stringContaining("목재 10개")]);
    expect(tiers.high.prompts[0]).toContain("no_recipe");
    expect(events.at(-1)).toMatchObject({ kind: "done", text: "모델이 받았다" });
  });

  it("게임이 꺼져 계획을 세지 못하면 중간 모델에 그 응답을 넘긴다", async () => {
    vi.useFakeTimers();
    const { tiers } = await run(await FakeConnector.fromDirectory(dir, "offline"), "강철괴", 100);
    expect(tiers.high.prompts).toEqual([]);
    expect(tiers.mid.prompts).toEqual([expect.stringContaining("disconnected")]);
    expect(tiers.mid.prompts[0]).not.toContain("남은 맡기기");
  });

  it("계획 중간에 등록이 막히면 그 자리에서 멈추고 막힌 응답과 남은 맡기기 횟수를 중간 모델에 넘긴다", async () => {
    vi.useFakeTimers();
    const { tiers, events } = await run(new Blocking(await workshop({ "철 광석": 12 }), "강철괴"), "강철괴", 3);
    expect(events.filter((e) => e.kind === "tool").map((e) => e.kind === "tool" && e.name)).toEqual([
      "plan_production",
      "execute_altering",
      "wait_altering",
      "complete_altering_work",
      "execute_gathering",
      "execute_altering",
    ]);
    expect(tiers.mid.prompts).toHaveLength(1);
    expect(tiers.mid.prompts[0]).toContain("unknown_modal");
    expect(tiers.mid.prompts[0]).toContain(JSON.stringify({ "execute_altering 강철괴": 1, "complete_altering_work 강철괴": 1 }));
  });

  it("가공 대기가 끝나지 않아 계획이 멈추면 같은 대기를 다시 부르지 말라며 중간 모델에 넘긴다", async () => {
    vi.useFakeTimers();
    const { tiers } = await run(new Endless(await workshop({ "철 광석": 12 })), "철괴", 3);
    expect(tiers.mid.prompts).toHaveLength(1);
    expect(tiers.mid.prompts[0]).toContain("plan_stopped");
    expect(tiers.mid.prompts[0]).toContain("같은 대기를 다시 부르지 않는다");
    expect(tiers.mid.prompts[0]).not.toContain("이어 가고");
  });

  it("날개 예산이 계획에 모자라면 시작하지 않고 중간 모델에 넘긴다", async () => {
    vi.useFakeTimers();
    const { tiers, events } = await run(await workshop({ "철 광석": 12 }), "강철괴", 100, { wings: 20 });
    expect(tiers.mid.prompts).toEqual([expect.stringContaining("wings_budget")]);
    expect(events.filter((e) => e.kind === "tool")).toHaveLength(1);
  });

  it("사용자가 계획을 승인하지 않으면 모델을 부르지 않고 끝난다", async () => {
    vi.useFakeTimers();
    const { tiers, events } = await run(await workshop({ "철 광석": 12 }), "강철괴", 3, { allow: false });
    expect(tiers.mid.prompts).toEqual([]);
    expect(tiers.high.prompts).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "done", text: "승인하지 않아 멈췄어요.", turns: 0, costUsd: 0 });
  });

  it("취소되면 모델을 부르지 않고 끝 event도 내지 않는다", async () => {
    vi.useFakeTimers();
    const { tiers, events } = await run(await workshop({ "철 광석": 12 }), "강철괴", 3, { allow: false, abortOnApproval: true });
    expect(tiers.mid.prompts).toEqual([]);
    expect(events.some((e) => e.kind === "done" || e.kind === "failed")).toBe(false);
  });
});
