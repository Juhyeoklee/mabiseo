import type { Json } from "../connector/connector.js";
import { recipes, type Recipe } from "../connector/recipes.js";
import type { ToolName } from "./catalog.js";
import { field, queueSlots, type Tools } from "./tools.js";

export interface ProductionStep {
  tool: ToolName;
  input: { displayName: string; count?: number };
}

export type Production = { steps: ProductionStep[] } | { error: string; message: string } | { refused: Json };

// 채집은 1회 최대 100개(공지 3541579)
const gatherPerCall = 100;

export async function planProduction(tools: Tools, item: string, count: number): Promise<Production> {
  const items = await tools.call("get_items");
  if (!Array.isArray(items)) return { refused: items };
  const gatherable = await tools.call("get_gatherable_items");
  const list = field(gatherable, "items");
  if (!Array.isArray(list)) return { refused: gatherable };
  return productionSteps(item, count, owned(items), list.map((g) => field(g, "DisplayName")).filter((n) => typeof n === "string"));
}

export function productionSteps(item: string, count: number, stock: ReadonlyMap<string, number>, gatherable: readonly string[]): Production {
  const recipe = recipeFor(item);
  if (!recipe) return { error: "no_recipe", message: `${item}의 가공법을 모른다. 아는 것: ${recipes.map((r) => r.item).join(", ")}` };
  const left = new Map(stock);
  const steps: ProductionStep[] = [];
  const missing = make(recipe, count, left, gatherable, steps);
  if (missing) return { error: "cannot_supply", message: `${missing}을 가공으로도 채집으로도 얻을 수 없다` };
  return { steps };
}

function make(recipe: Recipe, count: number, left: Map<string, number>, gatherable: readonly string[], steps: ProductionStep[]): string | undefined {
  const works = Math.ceil(count / recipe.produced);
  const missing = supply(recipe.ingredient, works * recipe.required, left, gatherable, steps);
  if (missing) return missing;
  for (let queued = 0; queued < works; queued += queueSlots) {
    const displayName = recipe.name;
    steps.push(
      { tool: "execute_altering", input: { displayName, count: Math.min(queueSlots, works - queued) } },
      { tool: "wait_altering", input: { displayName } },
      { tool: "complete_altering_work", input: { displayName } },
    );
  }
  left.set(recipe.item, (left.get(recipe.item) ?? 0) + works * recipe.produced - count);
  return undefined;
}

function supply(item: string, needed: number, left: Map<string, number>, gatherable: readonly string[], steps: ProductionStep[]): string | undefined {
  const owned = left.get(item) ?? 0;
  left.set(item, Math.max(0, owned - needed));
  if (owned >= needed) return undefined;
  const short = needed - owned;
  const recipe = recipeFor(item);
  if (recipe) return make(recipe, short, left, gatherable, steps);
  if (!gatherable.includes(item)) return item;
  const times = Math.ceil(short / gatherPerCall);
  for (let i = 0; i < times; i++) steps.push({ tool: "execute_gathering", input: { displayName: item } });
  left.set(item, times * gatherPerCall - short);
  return undefined;
}

function recipeFor(item: string): Recipe | undefined {
  return recipes.find((r) => r.item === item || r.name === item);
}

// 가공은 가방과 계정 창고의 재료를 함께 센다(#22 실물 관문의 등록 전후 수). 잠긴 묶음은 Owned 0이다(recordings/get_alterable_items.ingredient-locked.json).
// 캐릭터 창고는 실측이 없어 세지 않는다
const countedLocations: ReadonlySet<string> = new Set(["inventory", "account_storage"]);

function owned(items: readonly Json[]): Map<string, number> {
  const stock = new Map<string, number>();
  for (const entry of items) {
    const name = field(entry, "DisplayName");
    const count = field(entry, "Count");
    const location = field(entry, "Location");
    if (typeof location !== "string" || !countedLocations.has(location) || field(entry, "IsLocked") === true) continue;
    if (typeof name !== "string" || typeof count !== "number") continue;
    stock.set(name, (stock.get(name) ?? 0) + count);
  }
  return stock;
}
