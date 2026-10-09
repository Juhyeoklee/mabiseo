import { describe, expect, it } from "vitest";
import type { Outline, ProductionStep } from "../tools/production.js";
import { Plan } from "./plan.js";

const metal = { item: "철괴", facility: "금속 가공 시설" };
const steps: ProductionStep[] = [
  { tool: "wait_altering", input: { displayName: "철괴(철 광석)" } },
  { tool: "complete_altering_work", input: { displayName: "철괴(철 광석)" } },
];
const outline: Outline = {
  item: "철괴",
  count: 9,
  steps: [
    { kind: "wait", count: 9, seconds: 90, wings: 0, ...metal },
    { kind: "collect", count: 9, seconds: 6, wings: 0, ...metal },
  ],
};

function guided() {
  const reports: [number, number][] = [];
  const plan = new Plan((event) => {
    if (event.kind === "plan_step") reports.push([event.done, event.remainingSeconds]);
  });
  plan.guide("철괴", steps, outline);
  return { plan, reports };
}

describe("계획의 남은 예상 시간", () => {
  it("지금 단계의 활동 틱이 오면 지금 단계의 예상에서 지난 초를 빼고 남은 단계를 더한다", () => {
    const { plan, reports } = guided();
    plan.tick("wait_altering", 30);
    expect(reports).toEqual([
      [0, 96],
      [0, 66],
    ]);
  });

  it("지난 초가 지금 단계의 예상을 넘으면 지금 단계는 0으로 센다", () => {
    const { plan, reports } = guided();
    plan.tick("wait_altering", 500);
    expect(reports.at(-1)).toEqual([0, 6]);
  });

  it("지금 단계가 아닌 활동의 틱은 알리지 않는다", () => {
    const { plan, reports } = guided();
    plan.tick("execute_gathering", 30);
    expect(reports).toEqual([[0, 96]]);
  });
});
