import { catalog, type ToolSpec } from "../tools/catalog.js";
import type { ToolInput } from "../tools/tools.js";

export interface Step {
  tool: string;
  displayName: string;
  times: number;
}

export const plannable: readonly string[] = catalog
  .filter((spec: ToolSpec) => spec.kind === "execute" && spec.params.some((p) => p.name === "displayName"))
  .map((spec) => spec.name);

export class Plan {
  #left = new Map<string, number>();

  // 앞 계획의 남은 횟수를 잇지 않는다. 사용자가 본 것은 새 계획의 횟수뿐이다
  replace(steps: readonly Step[]): void {
    this.#left = totals(steps);
  }

  take(spec: ToolSpec, input: ToolInput): boolean {
    const key = stepKey(spec.name, String(input.displayName));
    const left = this.#left.get(key) ?? 0;
    const needed = calls(spec, input);
    if (needed > left) return false;
    this.#left.set(key, left - needed);
    return true;
  }

  settle(spec: ToolSpec, input: ToolInput, result: unknown): void {
    if (typeof result !== "object" || result === null || !("registered" in result) || !("requested" in result)) return;
    const { registered, requested } = result;
    if (typeof registered !== "number" || typeof requested !== "number") return;
    const key = stepKey(spec.name, String(input.displayName));
    this.#left.set(key, (this.#left.get(key) ?? 0) + requested - registered);
  }
}

export function totals(steps: readonly Step[]): Map<string, number> {
  const sums = new Map<string, number>();
  for (const step of steps) {
    const key = stepKey(step.tool, step.displayName);
    sums.set(key, (sums.get(key) ?? 0) + step.times);
  }
  return sums;
}

export function calls(spec: ToolSpec, input: ToolInput): number {
  const times = spec.repeat ? input[spec.repeat.name] : undefined;
  return typeof times === "number" ? times : 1;
}

function stepKey(tool: string, displayName: string): string {
  return `${tool} ${displayName}`;
}
