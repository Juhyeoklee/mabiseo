import type { Json } from "../connector/connector.js";
import { recipes, type Recipe } from "../connector/recipes.js";
import { spec, type ToolName } from "./catalog.js";
import { field, queueSlots, type Tools } from "./tools.js";

export interface ProductionStep {
  tool: ToolName;
  input: { displayName: string; count?: number };
}

export interface OutlineStep {
  kind: "gather" | "register" | "wait" | "collect";
  item: string;
  count: number;
  seconds: number;
  wings: number;
  facility?: string;
}

export interface Outline {
  item: string;
  count: number;
  steps: OutlineStep[];
}

export type Production = { steps: ProductionStep[]; outline: Outline } | { error: string; message: string } | { refused: Json };

// 채집은 1회 최대 100개(공지 3541579)
const gatherPerCall = 100;

// 걸린 시간. 채집 138초(recordings/gathering/index.tsv의 execute_gathering.json) · 등록 7초(execute_altering.started.json) · 수령 6초(complete_altering_work.json)
const gatherSeconds = 138;
const registerSeconds = 7;
const collectSeconds = 6;

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
  const planned: Planned[] = [];
  const missing = make(recipe, count, left, gatherable, planned);
  if (missing) return { error: "cannot_supply", message: `${missing}을 가공으로도 채집으로도 얻을 수 없다` };
  return { steps: planned.map((p) => p.step), outline: { item, count, steps: planned.map((p) => p.outline) } };
}

interface Planned {
  step: ProductionStep;
  outline: OutlineStep;
}

function make(recipe: Recipe, count: number, left: Map<string, number>, gatherable: readonly string[], planned: Planned[]): string | undefined {
  const works = Math.ceil(count / recipe.produced);
  const missing = supply(recipe.ingredient, works * recipe.required, left, gatherable, planned);
  if (missing) return missing;
  const displayName = recipe.name;
  const made = { item: recipe.item, facility: recipe.facility, wings: 0 };
  for (let queued = 0; queued < works; queued += queueSlots) {
    const batch = Math.min(queueSlots, works - queued);
    const products = batch * recipe.produced;
    planned.push(
      {
        step: { tool: "execute_altering", input: { displayName, count: batch } },
        outline: { kind: "register", count: batch, seconds: registerSeconds, ...made, wings: spec("execute_altering").wings * batch },
      },
      { step: { tool: "wait_altering", input: { displayName } }, outline: { kind: "wait", count: products, seconds: batch * recipe.seconds, ...made } },
      { step: { tool: "complete_altering_work", input: { displayName } }, outline: { kind: "collect", count: products, seconds: collectSeconds, ...made } },
    );
  }
  left.set(recipe.item, (left.get(recipe.item) ?? 0) + works * recipe.produced - count);
  return undefined;
}

function supply(item: string, needed: number, left: Map<string, number>, gatherable: readonly string[], planned: Planned[]): string | undefined {
  const owned = left.get(item) ?? 0;
  left.set(item, Math.max(0, owned - needed));
  if (owned >= needed) return undefined;
  const short = needed - owned;
  const recipe = recipeFor(item);
  if (recipe) return make(recipe, short, left, gatherable, planned);
  if (!gatherable.includes(item)) return item;
  const times = Math.ceil(short / gatherPerCall);
  for (let i = 0; i < times; i++) {
    planned.push({
      step: { tool: "execute_gathering", input: { displayName: item } },
      outline: { kind: "gather", item, count: gatherPerCall, seconds: gatherSeconds, wings: spec("execute_gathering").wings },
    });
  }
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
