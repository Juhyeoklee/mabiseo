import { describe, expect, it } from "vitest";
import type { Connector, Json } from "../connector/connector.js";
import { planProduction, productionSteps } from "./production.js";
import { Tools } from "./tools.js";

const ore = ["철 광석"];
const iron = "철괴(철 광석)";
const steel = "강철괴";

const gather = { tool: "execute_gathering", input: { displayName: "철 광석" } };
const altering = (displayName: string, count: number) => [
  { tool: "execute_altering", input: { displayName, count } },
  { tool: "wait_altering", input: { displayName } },
  { tool: "complete_altering_work", input: { displayName } },
];

describe("가공 계획은 목표에서 재료를 거꾸로 센다", () => {
  it("철 광석 12개로 강철괴 9개를 만들려면 채집 1번 뒤 철괴 3번 · 강철괴 3번을 등록하고 각각 기다려 수령한다", () => {
    expect(productionSteps(steel, 9, new Map([["철 광석", 12]]), ore)).toEqual({
      steps: [gather, ...altering(iron, 3), ...altering(steel, 3)],
    });
  });

  it("가진 중간 재료를 먼저 쓰고 모자란 만큼만 가공한다", () => {
    expect(productionSteps(steel, 9, new Map([["철괴", 6], ["철 광석", 12]]), ore)).toEqual({
      steps: [...altering(iron, 1), ...altering(steel, 3)],
    });
  });

  it("산출이 목표를 넘으면 등록 수를 올림한다", () => {
    expect(productionSteps(steel, 4, new Map([["철 광석", 20]]), ore)).toEqual({
      steps: [...altering(iron, 2), ...altering(steel, 2)],
    });
  });

  it("등록이 7칸을 넘으면 7씩 나눠 그 사이에 기다려 수령한다", () => {
    expect(productionSteps(steel, 24, new Map(), ore)).toEqual({
      steps: [gather, ...altering(iron, 7), ...altering(iron, 1), ...altering(steel, 7), ...altering(steel, 1)],
    });
  });

  it("채집 1번은 100개라 그보다 많이 모자라면 채집을 여러 번 넣는다", () => {
    expect(productionSteps("철괴", 60, new Map(), ore)).toEqual({ steps: [gather, gather, ...altering(iron, 7), ...altering(iron, 7), ...altering(iron, 6)] });
  });

  it("가공 이름으로 불러도 같은 계획이 나온다", () => {
    expect(productionSteps(iron, 3, new Map([["철 광석", 10]]), ore)).toEqual({ steps: altering(iron, 1) });
  });

  it("가공법을 모르는 목표는 no_recipe, 가공도 채집도 안 되는 재료는 cannot_supply를 값으로 돌려준다", () => {
    expect(productionSteps("목재", 3, new Map(), ore)).toMatchObject({ error: "no_recipe" });
    expect(productionSteps(steel, 9, new Map(), [])).toMatchObject({ error: "cannot_supply", message: expect.stringContaining("철 광석") });
  });
});

class Stub implements Connector {
  constructor(private readonly responses: Readonly<Record<string, Json>>) {}
  async run(command: string): Promise<Json> {
    return this.responses[command] ?? { error: "not_recorded" };
  }
}

describe("가공 계획은 게임에서 가진 수와 채집 목록을 읽는다", () => {
  const gatherable = { items: [{ DisplayName: "철 광석", ToolOk: true }] };

  it("계정 창고의 재료는 가진 수로 세고, 잠긴 묶음과 캐릭터 창고의 재료는 세지 않는다", async () => {
    const items = [
      { Location: "inventory", DisplayName: "철 광석", Category: "Ingredient", Count: 30, IsLocked: false },
      { Location: "account_storage", DisplayName: "철괴", Category: "Ingredient", Count: 3, IsLocked: false },
      { Location: "inventory", DisplayName: "철괴", Category: "Ingredient", Count: 3, IsLocked: true },
      { Location: "character_storage", DisplayName: "철괴", Category: "Ingredient", Count: 3, IsLocked: false },
    ];
    const tools = new Tools(new Stub({ get_items: items, get_gatherable_items: gatherable }), 0);
    expect(await planProduction(tools, steel, 9)).toEqual({ steps: [...altering(iron, 2), ...altering(steel, 3)] });
  });

  it("조회가 거부되면 계획 없이 그 거부를 돌려준다", async () => {
    const offline = { error: "game_off", message: "The game is not running." };
    const tools = new Tools(new Stub({ get_items: offline, get_gatherable_items: gatherable }), 0);
    expect(await planProduction(tools, steel, 9)).toEqual({ refused: offline });
  });
});
