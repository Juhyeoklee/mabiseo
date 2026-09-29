import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Connector, Json } from "../connector/connector.js";
import { FakeConnector } from "../connector/fake.js";
import { Tools } from "./tools.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));
const unknownItem = { displayName: "마비서없는아이템" };
const notFound = { error: "not_found", message: expect.any(String) };

class Counting implements Connector {
  calls: [string, string | undefined][] = [];
  constructor(private readonly inner: Connector) {}
  async run(command: string, body?: string): Promise<Json> {
    this.calls.push([command, body]);
    return this.inner.run(command, body);
  }
}

const accepted: Connector = { run: async () => ({ result: "completed", gained: 10, target: 10 }) };

class Slow implements Connector {
  calls: string[] = [];
  private pending: ((value: Json) => void)[] = [];
  run(command: string): Promise<Json> {
    this.calls.push(command);
    return new Promise((resolve) => this.pending.push(resolve));
  }
  finish(value: Json): void {
    this.pending.shift()?.(value);
  }
}

async function fakeTools(wings: number) {
  const connector = new Counting(await FakeConnector.fromDirectory(dir));
  return { connector, tools: new Tools(connector, wings) };
}

describe("조회 도구는 가짜 커넥터의 녹화를 그대로 돌려준다", () => {
  it("본문 없는 조회", async () => {
    const { tools, connector } = await fakeTools(0);
    expect(await tools.call("get_my_info")).toEqual(await connector.run("get_my_info"));
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
    expect(connector.calls).toHaveLength(1);
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
    expect(slow.calls).toEqual(["execute_gathering", "stand_up"]);
  });

  it("맡기기가 도는 동안 조회는 된다", async () => {
    const slow = new Slow();
    const tools = new Tools(slow, 10);
    const first = tools.call("execute_gathering", { displayName: "통나무" });
    const query = tools.call("get_activity");
    expect(slow.calls).toEqual(["execute_gathering", "get_activity"]);
    slow.finish({ result: "completed" });
    slow.finish({ ActionType: "gathering" });
    await Promise.all([first, query]);
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
