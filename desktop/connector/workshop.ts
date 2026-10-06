import type { Connector, Json } from "./connector.js";

interface Recipe {
  name: string;
  item: string;
  facility: string;
  ingredient: string;
  required: number;
  produced: number;
  seconds: number;
}

interface Work {
  recipe: Recipe;
  doneAt: number;
}

// 강철괴의 재료 · 산출 · 시설은 recordings/get_alterable_items.json · get_altering_works.json대로다.
// 철괴(철 광석)의 철 광석 수와 가공 시간은 녹화가 없어 지어낸 값이다
const recipes: readonly Recipe[] = [
  { name: "철괴(철 광석)", item: "철괴", facility: "금속 가공 시설", ingredient: "철 광석", required: 10, produced: 3, seconds: 4 },
  { name: "강철괴", item: "강철괴", facility: "금속 가공 시설", ingredient: "철괴", required: 3, produced: 3, seconds: 6 },
];

const queueSlots = 7;
const wingsPerCall = 5;
const gatherTarget = 100;
const wingsName = "정령의 날개";

// 등록 성공과 수령 응답은 녹화가 없어 recordings/capabilities.json의 OutputExample대로 지었다
export class Workshop implements Connector {
  private readonly stock: Map<string, number>;
  private works: Work[] = [];

  constructor(
    private readonly recorded: Connector,
    stock: Readonly<Record<string, number>>,
    private wings: number,
    private readonly now: () => number = Date.now,
  ) {
    this.stock = new Map(Object.entries(stock));
  }

  async run(command: string, body: string | undefined, timeoutMs: number): Promise<Json> {
    switch (command) {
      case "get_currencies":
        return this.currencies(await this.recorded.run(command, body, timeoutMs));
      case "get_items":
        return this.items(parse(body));
      case "get_gatherable_items":
        return this.gatherable(body, timeoutMs);
      case "execute_gathering":
        return this.gather(String(parse(body).displayName), timeoutMs);
      case "get_alterable_items":
        return { items: recipes.filter((r) => matches(body, r.name, r.ingredient)).map((r) => this.alterable(r)) };
      case "execute_altering":
        return this.alter(String(parse(body).displayName));
      case "get_altering_works":
        return this.queue();
      case "complete_altering_work":
        return this.collect(String(parse(body).displayName));
      default:
        return this.recorded.run(command, body, timeoutMs);
    }
  }

  private currencies(recorded: Json): Json {
    if (!Array.isArray(recorded)) return recorded;
    return recorded.map((c) => (isObject(c) && c.DisplayName === wingsName ? { ...c, Amount: this.wings } : c));
  }

  private items(filter: Record<string, Json>): Json {
    const name = typeof filter.name === "string" ? filter.name : undefined;
    const category = typeof filter.category === "string" ? filter.category : undefined;
    return [...this.stock]
      .filter(([item, count]) => count > 0 && matches(name, item) && matches(category, "Ingredient"))
      .map(([item, count]) => ({ Location: "inventory", DisplayName: item, Category: "Ingredient", CategoryDisplayName: "재료", Count: count, IsLocked: false }));
  }

  private async gatherableNames(timeoutMs: number): Promise<string[]> {
    const all = await this.recorded.run("get_gatherable_items", undefined, timeoutMs);
    const items = isObject(all) && Array.isArray(all.items) ? all.items : [];
    return items.flatMap((i) => (isObject(i) && typeof i.DisplayName === "string" ? [i.DisplayName] : []));
  }

  private async gatherable(filter: string | undefined, timeoutMs: number): Promise<Json> {
    const names = (await this.gatherableNames(timeoutMs)).filter((n) => matches(filter, n));
    return { items: names.map((n) => ({ DisplayName: n, ToolOk: true })) };
  }

  private async gather(displayName: string, timeoutMs: number): Promise<Json> {
    if (!(await this.gatherableNames(timeoutMs)).includes(displayName)) return rejected("not_found", `No gatherable item named ${displayName}.`);
    this.add(displayName, gatherTarget);
    return { result: "completed", message: "Gathering completed; the target amount was gained.", gained: gatherTarget, target: gatherTarget, cost: this.pay() };
  }

  private alterable(recipe: Recipe): Json {
    const owned = this.stock.get(recipe.ingredient) ?? 0;
    if (owned >= recipe.required) return { DisplayName: recipe.name, Alterable: true, ProducedPerWork: recipe.produced };
    return {
      DisplayName: recipe.name,
      Alterable: false,
      ProducedPerWork: recipe.produced,
      Reason: "not_enough_ingredient",
      MissingIngredients: [{ DisplayName: recipe.ingredient, Required: recipe.required, Owned: owned }],
    };
  }

  private alter(displayName: string): Json {
    const recipe = recipes.find((r) => r.name === displayName);
    if (!recipe) return rejected("not_found", `No altering recipe named ${displayName}.`);
    if ((this.stock.get(recipe.ingredient) ?? 0) < recipe.required) return rejected("not_enough_ingredient", "Not enough ingredients.");
    const queued = this.works.filter((w) => w.recipe.facility === recipe.facility);
    if (queued.length >= queueSlots) {
      return {
        error: "blocked",
        kind: "unknown_modal",
        message: "A blocking UI is covering the screen, so the action cannot continue. Tell the user, and retry after it is cleared.",
        cost: this.pay(),
      };
    }
    this.add(recipe.ingredient, -recipe.required);
    const startAt = Math.max(this.now(), ...queued.map((w) => w.doneAt));
    this.works.push({ recipe, doneAt: startAt + recipe.seconds * 1000 });
    return { result: "started", message: "Altering work queued.", cost: this.pay() };
  }

  private queue(): Json {
    const now = this.now();
    const running = new Set<string>();
    const works = this.works.map((w) => {
      const done = w.doneAt <= now;
      const state = done ? "Completed" : running.has(w.recipe.facility) ? "NotStarted" : "InProgress";
      if (!done) running.add(w.recipe.facility);
      return {
        DisplayName: w.recipe.name,
        FacilityName: w.recipe.facility,
        State: state,
        IsCompleted: done,
        RemainingSeconds: done ? 0 : Math.ceil((w.doneAt - now) / 1000),
      };
    });
    return { completedCount: works.filter((w) => w.IsCompleted).length, works };
  }

  private collect(displayName: string): Json {
    const recipe = recipes.find((r) => r.name === displayName);
    if (!recipe) return rejected("not_found", `No altering recipe named ${displayName}.`);
    if (!this.works.length) return rejected("no_altering", "There is no altering work.");
    const now = this.now();
    if (this.works.some((w) => w.recipe === recipe && w.doneAt > now)) return rejected("not_completed_yet", `${displayName} is still in progress.`);
    const done = this.works.filter((w) => w.recipe.facility === recipe.facility && w.doneAt <= now);
    if (!done.length) return rejected("no_completed_work_at_facility", "No completed work at the facility.");
    this.works = this.works.filter((w) => !done.includes(w));
    const rewards = new Map<string, number>();
    for (const w of done) rewards.set(w.recipe.item, (rewards.get(w.recipe.item) ?? 0) + w.recipe.produced);
    for (const [item, count] of rewards) this.add(item, count);
    return {
      collected: done.length,
      rewards: [...rewards].map(([item, count]) => ({ DisplayName: item, Count: count })),
      criticalRewards: [],
      message: "Collected all completed altering works at the facility.",
    };
  }

  private add(item: string, count: number): void {
    this.stock.set(item, (this.stock.get(item) ?? 0) + count);
  }

  private pay(): string {
    this.wings -= wingsPerCall;
    return `${wingsName} ${wingsPerCall} spent, ${this.wings} left.`;
  }
}

function parse(body: string | undefined): Record<string, Json> {
  if (!body) return {};
  const value: Json = JSON.parse(body);
  return isObject(value) ? value : {};
}

function isObject(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matches(filter: string | undefined, ...names: string[]): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return names.some((n) => n.toLowerCase().includes(needle));
}

function rejected(error: string, message: string): Json {
  return { error, message };
}
