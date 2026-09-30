import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connector, Json } from "../connector/connector.js";
import { FakeConnector } from "../connector/fake.js";
import { readJson } from "../connector/recordings.js";
import type { Progress } from "../jobs/jobs.js";
import { Tools } from "./tools.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));
const unknownItem = { displayName: "마비서없는아이템" };
const notFound = { error: "not_found", message: expect.any(String) };
const idle = (await readJson(dir, "get_activity.json")) as { [key: string]: Json; Mode: { [key: string]: Json } };
const fishing: Json = { ...idle, Mode: { ...idle.Mode, MainButtonState: "Fishing" } };
const executes = (calls: string[]): string[] => calls.filter((c) => c !== "get_activity");

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
    if (command === "get_activity") return Promise.resolve(idle);
    return new Promise((resolve) => this.pending.push(resolve));
  }
  finish(value: Json): void {
    this.pending.shift()?.(value);
  }
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

  it("시작된 뒤 끊긴 가공 · 제작(timeout · canceled)은 거부와 같은 두 키로 와도 쓴 것으로 센다", async () => {
    const errors = ["timeout", "canceled"];
    const tools = new Tools({ run: async () => ({ error: errors.shift() ?? "", message: "" }) }, 10);
    await tools.call("execute_altering", { displayName: "거미줄" });
    await tools.call("execute_crafting", { displayName: "거미줄" });
    expect(tools.wings).toBe(0);
  });

  it("시작 전과 후 양쪽에 나오는 blocked는 쓴 것으로 센다", async () => {
    const tools = new Tools({ run: async () => ({ error: "blocked", kind: "popup", message: "" }) }, 10);
    await tools.call("execute_crafting", { displayName: "거미줄" });
    expect(tools.wings).toBe(5);
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
    expect(slow.calls).toHaveLength(1);
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
    slow.finish({ result: "completed" });
    await Promise.all([first, query]);
  });

  it("맡기기가 도는 동안 stop_action은 busy를 통과해 커넥터에 닿는다", async () => {
    const slow = new Slow();
    const tools = new Tools(slow, 10);
    const first = tools.call("execute_gathering", { displayName: "통나무" });
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
    expect(connector.calls).toHaveLength(1);
  });

  it("조회로 새 정보를 얻은 뒤에는 같은 호출이 다시 커넥터에 닿는다", async () => {
    const { tools, connector } = await fakeTools(10);
    await tools.call("execute_gathering", unknownItem);
    await tools.call("get_gatherable_items");
    expect(await tools.call("execute_gathering", unknownItem)).toEqual(notFound);
    expect(connector.calls.map(([c]) => c)).toEqual(["execute_gathering", "get_gatherable_items", "execute_gathering"]);
  });

  it("본문이 다르면 다른 호출이라 막지 않는다", async () => {
    const { tools, connector } = await fakeTools(10);
    await tools.call("execute_gathering", unknownItem);
    await tools.call("execute_gathering", { displayName: "통나무" });
    expect(connector.calls).toHaveLength(2);
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
    expect(connector.calls).toHaveLength(1);
  });

  it("필수 입력이 빠지면 커넥터를 부르지 않고 값으로 알린다", async () => {
    const { tools, connector } = await fakeTools(10);
    expect(await tools.call("execute_gathering")).toMatchObject({ error: "missing_param" });
    expect(connector.calls).toEqual([]);
  });
});
