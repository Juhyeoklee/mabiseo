import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Json } from "./connector.js";
import { FakeConnector } from "./fake.js";
import { readJson } from "./recordings.js";
import { Workshop } from "./workshop.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));
const ironIngot = JSON.stringify({ displayName: "철괴(철 광석)" });
const steelIngot = JSON.stringify({ displayName: "강철괴" });

async function workshop(stock: Record<string, number>, wings = 100) {
  const clock = { now: 0 };
  const shop = new Workshop(await FakeConnector.fromDirectory(dir), stock, wings, () => clock.now);
  const run = (command: string, body?: string): Promise<Json> => shop.run(command, body, 30_000);
  return { clock, run };
}

describe("가짜 작업장은 재료 · 대기열 · 날개를 기억한다", () => {
  it("재료가 모자라면 가공 목록에 모자란 재료와 가진 수가 나오고 등록은 날개 없이 거절된다", async () => {
    const { run } = await workshop({ "철 광석": 12 });
    expect(await run("get_alterable_items", "강철괴")).toEqual({
      items: [
        {
          DisplayName: "강철괴",
          Alterable: false,
          ProducedPerWork: 3,
          Reason: "not_enough_ingredient",
          MissingIngredients: [
            { DisplayName: "철괴", Required: 3, Owned: 0 },
            { DisplayName: "석탄", Required: 4, Owned: 0 },
          ],
        },
      ],
    });
    expect(await run("execute_altering", steelIngot)).toMatchObject({ error: "not_enough_ingredient" });
    expect(await run("get_currencies")).toContainEqual(expect.objectContaining({ DisplayName: "정령의 날개", Amount: 100 }));
  });

  it("재료가 여럿이면 모자란 재료만 목록에 나오고, 다 갖춰 등록하면 재료마다 줄어든다", async () => {
    const { run } = await workshop({ 철괴: 3, 석탄: 2 });
    expect(await run("get_alterable_items", "강철괴")).toMatchObject({ items: [{ MissingIngredients: [{ DisplayName: "석탄", Required: 4, Owned: 2 }] }] });
    await run("execute_gathering", JSON.stringify({ displayName: "석탄" }));
    expect(await run("execute_altering", steelIngot)).toMatchObject({ result: "started" });
    expect(await run("get_items", JSON.stringify({ name: "철괴" }))).toEqual([]);
    expect(await run("get_items", JSON.stringify({ name: "석탄" }))).toEqual([expect.objectContaining({ DisplayName: "석탄", Count: 98 })]);
  });

  it("가공 목록의 필터는 재료 이름에도 걸린다", async () => {
    const { run } = await workshop({});
    const names = (await run("get_alterable_items", "철 광석")) as { items: { DisplayName: string }[] };
    expect(names.items.map((i) => i.DisplayName)).toEqual(["철괴(철 광석)"]);
  });

  it("채집하면 100개가 늘고 cost에 적힌 대로 날개 5개가 빠진다", async () => {
    const { run } = await workshop({ "철 광석": 12 });
    expect(await run("execute_gathering", JSON.stringify({ displayName: "철 광석" }))).toMatchObject({
      result: "completed",
      gained: 100,
      cost: "정령의 날개 5 spent, 95 left.",
    });
    expect(await run("get_items", JSON.stringify({ name: "철 광석" }))).toEqual([
      expect.objectContaining({ DisplayName: "철 광석", Category: "Ingredient", Count: 112 }),
    ]);
  });

  it("녹화의 채집 목록에 없는 이름은 날개 없이 not_found다", async () => {
    const { run } = await workshop({});
    expect(await run("execute_gathering", JSON.stringify({ displayName: "마비서없는아이템" }))).toMatchObject({ error: "not_found" });
    expect(await run("get_currencies")).toContainEqual(expect.objectContaining({ DisplayName: "정령의 날개", Amount: 100 }));
  });

  it("등록하면 재료가 줄고, 한 시설의 가공은 차례로 하나씩 진행된다", async () => {
    const { clock, run } = await workshop({ "철 광석": 20 });
    expect(await run("execute_altering", ironIngot)).toMatchObject({ result: "started", cost: "정령의 날개 5 spent, 95 left." });
    await run("execute_altering", ironIngot);
    expect(await run("get_items", JSON.stringify({ name: "철 광석" }))).toEqual([]);
    expect(await run("get_altering_works")).toEqual({
      completedCount: 0,
      works: [
        { DisplayName: "철괴(철 광석)", FacilityName: "금속 가공 시설", State: "InProgress", IsCompleted: false, RemainingSeconds: 30 },
        { DisplayName: "철괴(철 광석)", FacilityName: "금속 가공 시설", State: "NotStarted", IsCompleted: false, RemainingSeconds: 60 },
      ],
    });
    clock.now = 30_000;
    expect(await run("get_altering_works")).toMatchObject({ completedCount: 1, works: [{ State: "Completed" }, { State: "InProgress", RemainingSeconds: 30 }] });
  });

  it("그 가공이 아직 진행 중이면 수령은 not_completed_yet이고, 다 끝나면 시설의 완료분을 모두 받아 가진 수에 더한다", async () => {
    const { clock, run } = await workshop({ "철 광석": 20, 석탄: 4 });
    await run("execute_altering", ironIngot);
    await run("execute_altering", ironIngot);
    clock.now = 30_000;
    expect(await run("complete_altering_work", ironIngot)).toMatchObject({ error: "not_completed_yet" });
    clock.now = 60_000;
    expect(await run("complete_altering_work", ironIngot)).toMatchObject({ collected: 2, rewards: [{ Name: "철괴", Amount: 6 }] });
    expect(await run("get_altering_works")).toEqual({ completedCount: 0, works: [] });
    expect(await run("get_alterable_items", "강철괴")).toEqual({ items: [{ DisplayName: "강철괴", Alterable: true, ProducedPerWork: 3 }] });
  });

  it("수령하지 않은 완료분도 칸을 차지해 7칸이 차면 등록이 막히고도 날개 5개가 빠진다", async () => {
    const { clock, run } = await workshop({ "철 광석": 80 });
    for (let i = 0; i < 7; i += 1) await run("execute_altering", ironIngot);
    clock.now = 210_000;
    const recorded = (await readJson(dir, "queue-full/execute_altering.json")) as Record<string, Json>;
    expect(await run("execute_altering", ironIngot)).toEqual({ ...recorded, cost: "정령의 날개 5 spent, 60 left." });
  });

  it("등록 성공과 수령은 녹화와 같은 모양으로 답하고, 등록의 cost만 작업장의 날개를 따른다", async () => {
    const { clock, run } = await workshop({ "철 광석": 10 });
    const started = (await readJson(dir, "execute_altering.started.json")) as Record<string, Json>;
    expect(await run("execute_altering", ironIngot)).toEqual({ ...started, cost: "정령의 날개 5 spent, 95 left." });
    clock.now = 30_000;
    expect(await run("complete_altering_work", ironIngot)).toEqual(await readJson(dir, "complete_altering_work.json"));
  });

  it("작업장이 다루지 않는 명령은 녹화를 그대로 돌려준다", async () => {
    const { run } = await workshop({});
    expect(await run("get_my_info")).toEqual(await readJson(dir, "get_my_info.json"));
  });
});
