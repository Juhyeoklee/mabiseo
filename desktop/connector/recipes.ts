export interface Recipe {
  name: string;
  item: string;
  facility: string;
  ingredient: string;
  required: number;
  produced: number;
  seconds: number;
}

// 재료 · 산출은 recordings/get_alterable_items.json · complete_altering_work.json대로다. 철 광석 수와 가공 시간은
// 녹화 판에서 등록 전후 가진 수의 차이와 등록 직후의 RemainingSeconds로 쟀다
export const recipes: readonly Recipe[] = [
  { name: "철괴(철 광석)", item: "철괴", facility: "금속 가공 시설", ingredient: "철 광석", required: 10, produced: 3, seconds: 30 },
  { name: "강철괴", item: "강철괴", facility: "금속 가공 시설", ingredient: "철괴", required: 3, produced: 3, seconds: 300 },
];
