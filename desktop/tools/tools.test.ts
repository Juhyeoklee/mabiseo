import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connector, Json } from "../connector/connector.js";
import { FakeConnector } from "../connector/fake.js";
import { readJson } from "../connector/recordings.js";
import { Workshop } from "../connector/workshop.js";
import type { Progress } from "../jobs/jobs.js";
import { Tools } from "./tools.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));
const unknownItem = { displayName: "마비서없는아이템" };
const notFound = { error: "not_found", message: expect.any(String) };
const idle = (await readJson(dir, "get_activity.json")) as { [key: string]: Json; Mode: { [key: string]: Json } };
const fishing: Json = { ...idle, Mode: { ...idle.Mode, MainButtonState: "Fishing" } };
const executes = (calls: string[]): string[] => calls.filter((c) => c !== "get_activity" && c !== "get_currencies");

afterEach(() => {
  vi.useRealTimers();
});

class Counting implements Connector {
  calls: [string, string | undefined][] = [];
  constructor(private readonly inner: Connector) {}
  timeouts: number[] = [];
  async run(command: string, body: string | undefined, timeoutMs: number): Promise<Json> {
    this.calls.push([command, body]);
    this.timeouts.push(timeoutMs);
    return this.inner.run(command, body, timeoutMs);
  }
}

const accepted: Connector = { run: async () => ({ result: "completed", gained: 10, target: 10 }) };

class Slow implements Connector {
  calls: string[] = [];
  private pending: ((value: Json) => void)[] = [];
  run(command: string): Promise<Json> {
    this.calls.push(command);
    if (command === "get_activity" || command === "get_currencies") return Promise.resolve(idle);
    return new Promise((resolve) => this.pending.push(resolve));
  }
  finish(value: Json): void {
    this.pending.shift()?.(value);
  }
}

const started = (slow: Slow): Promise<void> => vi.waitFor(() => expect(slow.calls).toContain("execute_gathering"));

const popupBlocked: Json = { error: "blocked", kind: "popup", message: "" };
const wingsOf = (amount: number): Json => [{ DisplayName: "정령의 날개", Amount: amount }];

function refusing(respond: () => Json, amounts: number[]): Connector {
  let last: number | undefined;
  return {
    run: async (command) => {
      if (command !== "get_currencies") return respond();
      last = amounts.shift() ?? last;
      return last === undefined ? { error: "unreadable", message: "" } : wingsOf(last);
    },
  };
}

function fishingConnector() {
  const state = { fishing: true };
  const connector = new Counting({
    run: async (command) => {
      if (command === "execute_gathering") return { result: "started" };
      if (command === "get_activity") return state.fishing ? fishing : idle;
      if (command === "stop_action") state.fishing = false;
      return { message: "" };
    },
  });
  return { connector, state };
}

async function fakeTools(wings: number) {
  const connector = new Counting(await FakeConnector.fromDirectory(dir));
  return { connector, tools: new Tools(connector, wings) };
}

describe("조회 도구는 가짜 커넥터의 녹화를 그대로 돌려준다", () => {
  it("본문 없는 조회", async () => {
    const { tools, connector } = await fakeTools(0);
    expect(await tools.call("get_my_info")).toEqual(await connector.run("get_my_info", undefined, 30_000));
    expect(connector.calls.at(-1)).toEqual(["get_my_info", undefined]);
  });

  it("json 본문은 준 필드만 CLI 본문으로 만든다", async () => {
    const { tools, connector } = await fakeTools(0);
    await tools.call("get_items", { category: "Ingredient" });
    expect(connector.calls.at(-1)).toEqual(["get_items", '{"category":"Ingredient"}']);
    await tools.call("get_items");
    expect(connector.calls.at(-1)).toEqual(["get_items", undefined]);
  });

  it("raw 본문은 필터 문자열 그대로이고 비우면 본문이 없다", async () => {
    const { tools, connector } = await fakeTools(0);
    await tools.call("get_gatherable_items", { filter: "통나무" });
    expect(connector.calls.at(-1)).toEqual(["get_gatherable_items", "통나무"]);
    await tools.call("get_gatherable_items", { filter: "" });
    expect(connector.calls.at(-1)).toEqual(["get_gatherable_items", undefined]);
  });
});

describe("커넥터에 넘기는 시간 한도", () => {
  it("조회는 1분 안에 끊고, 맡기기는 채집 100개의 상한 15분을 넘도록 기다린다", async () => {
    const { tools, connector } = await fakeTools(10);
    await tools.call("get_activity");
    await tools.call("stand_up");
    const [query, execute] = connector.timeouts;
    expect(query).toBeLessThanOrEqual(60_000);
    expect(execute).toBeGreaterThanOrEqual(15 * 60_000);
  });
});

describe("날개 예산", () => {
  it("예산 0에서 채집 도구는 커넥터를 부르지 않고 값으로 거절한다", async () => {
    const { tools, connector } = await fakeTools(0);
    expect(await tools.call("execute_gathering", unknownItem)).toMatchObject({ error: "wings_budget" });
    expect(connector.calls).toEqual([]);
  });

  it("예산 0에서도 날개를 쓰지 않는 맡기기(stand_up)는 커넥터에 닿는다", async () => {
    const { tools, connector } = await fakeTools(0);
    expect(await tools.call("stand_up")).toEqual({ error: "not_sitting", message: expect.any(String) });
    expect(connector.calls).toHaveLength(1);
  });

  it("거부된 호출은 날개를 쓰지 않았으므로 예산이 줄지 않는다", async () => {
    const { tools } = await fakeTools(5);
    expect(await tools.call("execute_gathering", unknownItem)).toEqual(notFound);
    expect(tools.wings).toBe(5);
  });

  it("받아들여진 호출은 5개를 깎고, 바닥나면 다음 호출은 커넥터에 닿지 않는다", async () => {
    const connector = new Counting(accepted);
    const tools = new Tools(connector, 5);
    await tools.call("execute_gathering", { displayName: "통나무" });
    expect(tools.wings).toBe(0);
    expect(await tools.call("execute_gathering", { displayName: "통나무" })).toMatchObject({ error: "wings_budget" });
    expect(executes(connector.calls.map(([c]) => c))).toEqual(["execute_gathering"]);
  });

  it("시작된 뒤에만 나오는 timeout · canceled는 실제 날개 수가 그대로로 읽혀도 쓴 것으로 센다", async () => {
    const errors = ["timeout", "canceled"];
    const tools = new Tools(refusing(() => ({ error: errors.shift() ?? "", message: "" }), [100]), 10);
    await tools.call("execute_altering", { displayName: "거미줄" });
    await tools.call("execute_crafting", { displayName: "거미줄" });
    expect(tools.wings).toBe(0);
  });

  it("시작 전과 후 양쪽에 나오는 blocked는 실제 날개 수를 못 읽으면 쓴 것으로 센다", async () => {
    const tools = new Tools({ run: async () => popupBlocked }, 10);
    await tools.call("execute_crafting", { displayName: "거미줄" });
    expect(tools.wings).toBe(5);
  });

  it("게임이 응답에 적은 cost가 있으면 도구의 정가가 아니라 그만큼만 깎는다", async () => {
    const tools = new Tools(refusing(() => ({ result: "completed", cost: "정령의 날개 3 spent, 97 left." }), [100]), 10);
    await tools.call("execute_gathering", { displayName: "통나무" });
    expect(tools.wings).toBe(7);
  });

  it("실물 채집의 완료 응답은 cost대로 5개를 깎는다", async () => {
    const completed = await readJson(dir, "gathering/execute_gathering.json");
    const tools = new Tools(refusing(() => completed, []), 10);
    await tools.call("execute_gathering", { displayName: "통나무" });
    expect(tools.wings).toBe(5);
  });

  it("다른 창이 덮어 중간에 막힌 실물 채집 응답은 cost대로 5개를 깎는다", async () => {
    const blocked = await readJson(dir, "modal/execute_gathering.json");
    const tools = new Tools(refusing(() => blocked, [100]), 10);
    expect(await tools.call("execute_gathering", { displayName: "통나무" })).toMatchObject({ error: "blocked", kind: "unknown_modal", gained: 56 });
    expect(tools.wings).toBe(5);
  });

  it("가공 대기열이 가득 차 막힌 실물 가공 등록 응답도 cost대로 5개를 깎는다", async () => {
    const blocked = await readJson(dir, "queue-full/execute_altering.json");
    const tools = new Tools(refusing(() => blocked, [100]), 10);
    expect(await tools.call("execute_altering", { displayName: "철괴(철 광석)" })).toMatchObject({ registered: 0, last: { error: "blocked", kind: "unknown_modal" } });
    expect(tools.wings).toBe(5);
  });

  it("부활 대기의 blocked처럼 시작 전에 거부돼 실제 날개가 그대로면 예산이 줄지 않는다", async () => {
    const currencies = await readJson(dir, "get_currencies.json");
    const blocked = await readJson(dir, "reviving/execute_gathering.json");
    const tools = new Tools({ run: async (command) => (command === "get_currencies" ? currencies : blocked) }, 5);
    expect(await tools.call("execute_gathering", { displayName: "통나무" })).toMatchObject({ error: "blocked", kind: "dead" });
    expect(tools.wings).toBe(5);
  });

  it("곧바로 돌아온 blocked에서 실제 날개가 줄었으면 정가가 아니라 그 차이만큼 깎는다", async () => {
    const tools = new Tools(refusing(() => popupBlocked, [100, 97]), 10);
    await tools.call("execute_crafting", { displayName: "거미줄" });
    expect(tools.wings).toBe(7);
  });

  it("곧바로 돌아온 blocked에서 호출 전 날개만 읽히고 그 뒤는 못 읽으면 쓴 것으로 센다", async () => {
    let reads = 0;
    const tools = new Tools(
      {
        run: async (command) => {
          if (command !== "get_currencies") return popupBlocked;
          reads += 1;
          return reads === 1 ? wingsOf(100) : { error: "unreadable", message: "" };
        },
      },
      10,
    );
    await tools.call("execute_crafting", { displayName: "거미줄" });
    expect(tools.wings).toBe(5);
  });

  it("곧바로 돌아온 blocked에서 실제 날개가 오히려 늘어 있으면 예산을 늘리지 않고 그대로 둔다", async () => {
    const tools = new Tools(refusing(() => popupBlocked, [100, 105]), 10);
    await tools.call("execute_crafting", { displayName: "거미줄" });
    expect(tools.wings).toBe(10);
  });

  it("오래 걸려 돌아온 blocked는 실제 날개가 그대로로 읽혀도 쓴 것으로 센다. 그 사이 늘어난 날개가 쓴 양을 가릴 수 있다", async () => {
    vi.useFakeTimers();
    const tools = new Tools(
      refusing(() => {
        vi.setSystemTime(Date.now() + 60_000);
        return popupBlocked;
      }, [100]),
      10,
    );
    await tools.call("execute_crafting", { displayName: "거미줄" });
    expect(tools.wings).toBe(5);
  });

  it("거부 뒤의 날개 조회가 끝나기 전에 들어온 맡기기는 busy로 거절된다. 예산이 아직 안 깎였다", async () => {
    let release: (value: Json) => void = () => {};
    const calls: string[] = [];
    const tools = new Tools(
      {
        run: (command) => {
          calls.push(command);
          if (command !== "get_currencies") return Promise.resolve(popupBlocked);
          if (calls.filter((c) => c === "get_currencies").length === 1) return Promise.resolve(wingsOf(100));
          return new Promise((resolve) => (release = resolve));
        },
      },
      5,
    );
    const first = tools.call("execute_crafting", { displayName: "거미줄" });
    await vi.waitFor(() => expect(calls.filter((c) => c === "get_currencies")).toHaveLength(2));
    expect(await tools.call("execute_gathering", { displayName: "통나무" })).toMatchObject({ error: "busy" });
    release(wingsOf(95));
    await first;
    expect(tools.wings).toBe(0);
  });

  it("거부 뒤의 날개 조회는 재거부 차단을 풀지 않는다", async () => {
    const connector = new Counting(refusing(() => popupBlocked, [100]));
    const tools = new Tools(connector, 10);
    await tools.call("execute_crafting", { displayName: "거미줄" });
    expect(await tools.call("execute_crafting", { displayName: "거미줄" })).toMatchObject({ error: "repeated_rejection" });
    expect(executes(connector.calls.map(([c]) => c))).toEqual(["execute_crafting"]);
  });

  it("게임이 꺼져 있으면 날개가 나가지 않았으므로 예산이 줄지 않는다", async () => {
    const tools = new Tools(await FakeConnector.fromDirectory(dir, "offline"), 10);
    await tools.call("execute_gathering", unknownItem);
    expect(tools.wings).toBe(10);
  });
});

describe("맡기기는 한 번에 하나다", () => {
  it("실행 중인 맡기기가 있으면 다음 맡기기는 커넥터에 닿지 않고 busy로 거절된다", async () => {
    const slow = new Slow();
    const tools = new Tools(slow, 10);
    const first = tools.call("execute_gathering", { displayName: "통나무" });
    expect(await tools.call("stand_up")).toMatchObject({ error: "busy" });
    await started(slow);
    expect(executes(slow.calls)).toEqual(["execute_gathering"]);
    slow.finish({ result: "completed" });
    await first;
    const second = tools.call("stand_up");
    slow.finish({ message: "" });
    await second;
    expect(executes(slow.calls)).toEqual(["execute_gathering", "stand_up"]);
  });

  it("맡기기가 도는 동안 조회는 된다", async () => {
    const slow = new Slow();
    const tools = new Tools(slow, 10);
    const first = tools.call("execute_gathering", { displayName: "통나무" });
    const query = tools.call("get_activity");
    expect(slow.calls).toContain("get_activity");
    await query;
    slow.finish({ result: "completed" });
    await first;
  });

  it("맡기기가 도는 동안 stop_action은 busy를 통과해 커넥터에 닿는다", async () => {
    const slow = new Slow();
    const tools = new Tools(slow, 10);
    const first = tools.call("execute_gathering", { displayName: "통나무" });
    await started(slow);
    const stop = tools.call("stop_action");
    expect(slow.calls).toContain("stop_action");
    slow.finish({ result: "stopped" });
    slow.finish({ message: "" });
    expect(await stop).toEqual({ message: "" });
    await first;
    const next = tools.call("stand_up");
    expect(slow.calls.at(-1)).toBe("stand_up");
    slow.finish({ message: "" });
    await next;
  });

  it("started로 돌아온 낚시는 get_activity가 활동 중인 동안 다음 맡기기를 busy로 거절하고 idle이 되면 받는다", async () => {
    vi.useFakeTimers();
    const { connector, state } = fishingConnector();
    const tools = new Tools(connector, 10);
    expect(await tools.call("execute_gathering", { displayName: "통나무" })).toEqual({ result: "started" });
    expect(await tools.call("stand_up")).toMatchObject({ error: "busy" });
    expect(connector.calls.map(([c]) => c)).not.toContain("stand_up");
    state.fishing = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await tools.call("stand_up")).toEqual({ message: "" });
    expect(connector.calls.map(([c]) => c)).toContain("stand_up");
  });

  it("진행은 도구 이름과 경과 시간을 싣고 watch로 흐른다", async () => {
    vi.useFakeTimers();
    const slow = new Slow();
    const tools = new Tools(slow, 10);
    const progress: Progress[] = [];
    tools.watch((p) => progress.push(p));
    const first = tools.call("execute_gathering", { displayName: "통나무" });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(progress).toEqual([
      { activity: "execute_gathering", elapsedSeconds: 20 },
      { activity: "execute_gathering", elapsedSeconds: 40 },
    ]);
    slow.finish({ result: "completed" });
    await first;
  });
});

describe("cancel은 stop_action이다", () => {
  it("활동이 없으면 cancel은 커넥터를 부르지 않고 undefined다", async () => {
    const { tools, connector } = await fakeTools(10);
    expect(await tools.cancel()).toBeUndefined();
    expect(connector.calls).toEqual([]);
  });

  it("cancel은 붙든 활동에 stop_action을 부르고 idle이 되면 다음 주기를 기다리지 않고 푼다", async () => {
    vi.useFakeTimers();
    const { connector } = fishingConnector();
    const tools = new Tools(connector, 10);
    expect(await tools.call("execute_gathering", { displayName: "통나무" })).toEqual({ result: "started" });
    expect(await tools.cancel()).toEqual({ message: "" });
    expect(connector.calls.map(([c]) => c)).toContain("stop_action");
    expect(await tools.call("stand_up")).toEqual({ message: "" });
    expect(connector.calls.map(([c]) => c)).toContain("stand_up");
  });

  it("stop_action의 거부도 재거부 차단에 잡힌다", async () => {
    const { tools } = await fakeTools(10);
    expect(await tools.call("stop_action")).toMatchObject({ error: "invalid_state" });
    expect(await tools.call("stop_action")).toMatchObject({ error: "repeated_rejection" });
  });
});

describe("폴링은 보호 장치를 건드리지 않는다", () => {
  it("폴링은 재거부 차단을 풀지 않는다", async () => {
    const connector = new Counting({
      run: async (command) => {
        if (command === "execute_gathering") return { error: "not_found", message: "" };
        if (command === "get_activity") return idle;
        return { message: "" };
      },
    });
    const tools = new Tools(connector, 10);
    expect(await tools.call("execute_gathering", unknownItem)).toMatchObject({ error: "not_found" });
    expect(await tools.call("stand_up")).toEqual({ message: "" });
    expect(connector.calls.map(([c]) => c)).toContain("get_activity");
    expect(await tools.call("execute_gathering", unknownItem)).toMatchObject({ error: "repeated_rejection" });
  });
});

describe("거부 재호출 차단", () => {
  it("같은 거부를 조회 없이 다시 부르면 커넥터에 닿지 않는다", async () => {
    const { tools, connector } = await fakeTools(10);
    expect(await tools.call("execute_gathering", unknownItem)).toEqual(notFound);
    expect(await tools.call("execute_gathering", unknownItem)).toMatchObject({ error: "repeated_rejection" });
    expect(executes(connector.calls.map(([c]) => c))).toEqual(["execute_gathering"]);
  });

  it("조회로 새 정보를 얻은 뒤에는 같은 호출이 다시 커넥터에 닿는다", async () => {
    const { tools, connector } = await fakeTools(10);
    await tools.call("execute_gathering", unknownItem);
    await tools.call("get_gatherable_items");
    expect(await tools.call("execute_gathering", unknownItem)).toEqual(notFound);
    expect(executes(connector.calls.map(([c]) => c))).toEqual(["execute_gathering", "get_gatherable_items", "execute_gathering"]);
  });

  it("본문이 다르면 다른 호출이라 막지 않는다", async () => {
    const { tools, connector } = await fakeTools(10);
    await tools.call("execute_gathering", unknownItem);
    await tools.call("execute_gathering", { displayName: "통나무" });
    expect(executes(connector.calls.map(([c]) => c))).toEqual(["execute_gathering", "execute_gathering"]);
  });

  it("다른 맡기기의 거부는 서로 막지 않는다", async () => {
    const { tools, connector } = await fakeTools(10);
    await tools.call("stand_up");
    await tools.call("stop_action");
    expect(connector.calls).toHaveLength(2);
  });

  it("조회는 거부돼도 막지 않는다. 캐릭터 선택 화면에서 상태를 계속 물을 수 있어야 한다", async () => {
    const connector = new Counting(await FakeConnector.fromDirectory(dir, "login"));
    const tools = new Tools(connector, 0);
    await tools.call("get_my_info");
    await tools.call("get_my_info");
    expect(connector.calls).toHaveLength(2);
  });
});

describe("게임의 거부는 예외가 아니라 도구 결과다", () => {
  it("앉아 있지 않을 때 stand_up의 not_sitting이 그대로 돌아온다", async () => {
    const { tools } = await fakeTools(0);
    await expect(tools.call("stand_up")).resolves.toEqual({ error: "not_sitting", message: expect.any(String) });
  });

  it("게임이 꺼져 있으면 끊김 값이 그대로 돌아온다", async () => {
    const tools = new Tools(await FakeConnector.fromDirectory(dir, "offline"), 10);
    const disconnected = { pipe: "disconnected", reason: "game_off" };
    await expect(tools.call("get_my_info")).resolves.toEqual(disconnected);
    await expect(tools.call("execute_gathering", unknownItem)).resolves.toEqual(disconnected);
  });

  it("게임 꺼짐도 거부라서 조회 없이 같은 맡기기를 다시 부르면 커넥터에 닿지 않는다", async () => {
    const connector = new Counting(await FakeConnector.fromDirectory(dir, "offline"));
    const tools = new Tools(connector, 10);
    await tools.call("execute_gathering", unknownItem);
    expect(await tools.call("execute_gathering", unknownItem)).toMatchObject({ error: "repeated_rejection" });
    expect(executes(connector.calls.map(([c]) => c))).toEqual(["execute_gathering"]);
  });

  it("필수 입력이 빠지면 커넥터를 부르지 않고 값으로 알린다", async () => {
    const { tools, connector } = await fakeTools(10);
    expect(await tools.call("execute_gathering")).toMatchObject({ error: "missing_param" });
    expect(connector.calls).toEqual([]);
  });
});

async function workshopTools(stock: Record<string, number>, wings: number) {
  const connector = new Counting(new Workshop(await FakeConnector.fromDirectory(dir), stock, 100));
  return { connector, tools: new Tools(connector, wings) };
}

const ironIngot = { displayName: "철괴(철 광석)" };

describe("가공 등록은 count번 되풀이된다", () => {
  it("count만큼 등록을 부르고 등록마다 날개 5개를 깎는다. count는 CLI 본문에 들어가지 않는다", async () => {
    const { connector, tools } = await workshopTools({ "철 광석": 30 }, 20);
    expect(await tools.call("execute_altering", { ...ironIngot, count: 3 })).toMatchObject({ registered: 3, requested: 3, last: { result: "started" } });
    expect(tools.wings).toBe(5);
    expect(connector.calls.filter(([c]) => c === "execute_altering")).toEqual(Array(3).fill(["execute_altering", '{"displayName":"철괴(철 광석)"}']));
  });

  it("count를 비우면 한 번 등록한다", async () => {
    const { tools } = await workshopTools({ "철 광석": 30 }, 20);
    expect(await tools.call("execute_altering", ironIngot)).toMatchObject({ registered: 1, requested: 1 });
  });

  it("중간에 거부되면 거기서 멈추고 등록된 수와 마지막 거부를 돌려준다", async () => {
    const { connector, tools } = await workshopTools({ "철 광석": 20 }, 20);
    expect(await tools.call("execute_altering", { ...ironIngot, count: 3 })).toMatchObject({
      registered: 2,
      requested: 3,
      last: { error: "not_enough_ingredient" },
    });
    expect(tools.wings).toBe(10);
    expect(executes(connector.calls.map(([c]) => c))).toHaveLength(3);
  });

  it("날개 예산이 중간에 바닥나면 커넥터를 더 부르지 않고 wings_budget에서 멈춘다", async () => {
    const { connector, tools } = await workshopTools({ "철 광석": 30 }, 10);
    expect(await tools.call("execute_altering", { ...ironIngot, count: 3 })).toMatchObject({ registered: 2, last: { error: "wings_budget" } });
    expect(executes(connector.calls.map(([c]) => c))).toHaveLength(2);
  });

  it("count가 시설 대기열 7칸을 넘거나 1보다 작거나 정수가 아니면 커넥터를 부르지 않는다", async () => {
    const { connector, tools } = await workshopTools({ "철 광석": 100 }, 100);
    for (const count of [8, 0, 1.5]) {
      expect(await tools.call("execute_altering", { ...ironIngot, count })).toMatchObject({ error: "invalid_count" });
    }
    expect(connector.calls).toEqual([]);
  });
});

describe("가공 완료 기다리기", () => {
  it("그 가공의 등록분이 모두 끝날 때까지 남은 시간만큼 자고 다시 보며, completed와 마지막 작업 목록을 돌려준다", async () => {
    vi.useFakeTimers();
    const { connector, tools } = await workshopTools({ "철 광석": 20 }, 20);
    await tools.call("execute_altering", { ...ironIngot, count: 2 });
    let result: Json | undefined;
    void tools.call("wait_altering", ironIngot).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result).toMatchObject({ completed: true, works: { completedCount: 2 } });
    expect(connector.calls.filter(([c]) => c === "get_altering_works")).toHaveLength(2);
    expect(connector.calls.map(([c]) => c)).not.toContain("wait_altering");
  });

  it("기다리는 동안 진행이 watch로 흐른다", async () => {
    vi.useFakeTimers();
    const { tools } = await workshopTools({ "철 광석": 20 }, 20);
    await tools.call("execute_altering", ironIngot);
    const seen: Progress[] = [];
    tools.watch((p) => seen.push(p));
    const waiting = tools.call("wait_altering", ironIngot);
    await vi.advanceTimersByTimeAsync(5_000);
    await waiting;
    expect(seen[0]).toEqual({ activity: "wait_altering", elapsedSeconds: 0 });
  });

  it("기다리는 동안 채집은 busy로 막히지 않는다. 가공 대기열은 캐릭터의 활동이 아니다", async () => {
    vi.useFakeTimers();
    const { tools } = await workshopTools({ "철 광석": 20 }, 20);
    await tools.call("execute_altering", ironIngot);
    const waiting = tools.call("wait_altering", ironIngot);
    expect(await tools.call("execute_gathering", { displayName: "철 광석" })).toMatchObject({ result: "completed" });
    await vi.advanceTimersByTimeAsync(5_000);
    await waiting;
  });

  it("1시간을 넘게 안 끝나면 completed: false와 남은 상태를 돌려준다", async () => {
    vi.useFakeTimers();
    const pending: Json = { completedCount: 0, works: [{ DisplayName: "강철괴", IsCompleted: false, RemainingSeconds: 99_999 }] };
    const tools = new Tools({ run: async () => pending }, 10);
    const waiting = tools.call("wait_altering", { displayName: "강철괴" });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(await waiting).toEqual({ completed: false, works: pending });
  });

  it("cancel은 진행 중인 기다림을 끊고, 끊긴 기다림은 completed: false를 돌려준다", async () => {
    vi.useFakeTimers();
    const { connector, tools } = await workshopTools({ "철 광석": 20 }, 20);
    await tools.call("execute_altering", ironIngot);
    const waiting = tools.call("wait_altering", ironIngot);
    await vi.advanceTimersByTimeAsync(0);
    expect(await tools.cancel()).toBeUndefined();
    expect(await waiting).toMatchObject({ completed: false });
    expect(connector.calls.filter(([c]) => c === "get_altering_works")).toHaveLength(2);
  });

  it("겹친 기다림도 cancel이 모두 끊는다", async () => {
    vi.useFakeTimers();
    const { tools } = await workshopTools({ "철 광석": 20 }, 20);
    await tools.call("execute_altering", { ...ironIngot, count: 2 });
    const first = tools.call("wait_altering", ironIngot);
    const second = tools.call("wait_altering", ironIngot);
    await vi.advanceTimersByTimeAsync(0);
    await tools.cancel();
    expect(await Promise.all([first, second])).toMatchObject([{ completed: false }, { completed: false }]);
  });

  it("작업 목록 조회가 거부되면 기다리지 않고 그 거부를 돌려준다", async () => {
    const gameOff = await readJson(dir, "game-off/get_my_info.json");
    const tools = new Tools({ run: async () => gameOff }, 10);
    expect(await tools.call("wait_altering", ironIngot)).toMatchObject({ pipe: "disconnected" });
  });
});
