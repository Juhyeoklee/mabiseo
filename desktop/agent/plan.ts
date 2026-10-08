import { catalog, type ToolSpec } from "../tools/catalog.js";
import type { Outline, ProductionStep } from "../tools/production.js";
import type { ToolInput } from "../tools/tools.js";

export interface Step {
  tool: string;
  displayName: string;
  times: number;
}

export const plannable: readonly string[] = catalog
  .filter((spec: ToolSpec) => spec.kind === "execute" && spec.params.some((p) => p.name === "displayName"))
  .map((spec) => spec.name);

export type Report = (done: number, remainingSeconds: number) => void;

export class Plan {
  #left = new Map<string, number>();
  #guide: ProductionStep[] = [];
  #seconds: number[] = [];
  #total = 0;
  #target: string | undefined;

  constructor(private readonly report: Report) {}

  // 앞 계획의 남은 횟수를 잇지 않는다. 사용자가 본 것은 새 계획의 횟수뿐이다
  replace(steps: readonly Step[]): void {
    this.#left = totals(steps);
    this.#guide = [];
    this.#seconds = [];
    this.#target = undefined;
  }

  guide(target: string, steps: readonly ProductionStep[], outline: Outline): void {
    this.replace(steps.flatMap(toPlanSteps));
    this.#guide = steps.map((step) => ({ ...step, input: { ...step.input } }));
    this.#seconds = outline.steps.map((step) => step.seconds);
    this.#total = steps.length;
    this.#target = target;
    this.#report(0);
  }

  tick(activity: string, elapsedSeconds: number): void {
    if (this.#target === undefined || this.#guide[0]?.tool !== activity) return;
    this.#report(elapsedSeconds);
  }

  #report(elapsedSeconds: number): void {
    const [current = 0, ...rest] = this.#seconds;
    const remaining = Math.max(0, current - elapsedSeconds) + rest.reduce((sum, s) => sum + s, 0);
    this.report(this.#total - this.#guide.length, remaining);
  }

  follow(name: string, input: ToolInput, result: unknown): unknown {
    const target = this.#target;
    if (target === undefined) return result;
    const before = this.#guide.length;
    const stalled = this.#advance(name, input, result);
    if (this.#guide.length !== before) this.#report(0);
    const next = this.#guide[0];
    if (next && !stalled) return { result, next_step: next };
    this.#guide = [];
    this.#seconds = [];
    this.#target = undefined;
    if (stalled) return { result, next_step: null, plan_stopped: `${target} 계획의 대기가 끝나지 않았다. 같은 대기를 되풀이하지 말고 사용자에게 알린다` };
    return { result, next_step: null, plan_done: `${target} 계획의 단계를 모두 마쳤다. 가진 수를 조회해 사용자에게 알린다` };
  }

  // 대기가 끝나지 않고 돌아온 것이면 true. 1시간 상한이나 취소라 같은 대기를 다시 지시하면 사용자가 모른 채 또 1시간을 기다린다
  #advance(name: string, input: ToolInput, result: unknown): boolean {
    const step = this.#guide[0];
    if (!step || step.tool !== name || step.input.displayName !== input.displayName) return false;
    if (typeof result !== "object" || result === null || "error" in result || "pipe" in result) return false;
    if ("completed" in result && result.completed !== true) return true;
    if ("registered" in result && typeof result.registered === "number") {
      const left = (step.input.count ?? 1) - result.registered;
      if (left > 0) {
        step.input.count = left;
        return false;
      }
    }
    this.#guide.shift();
    this.#seconds.shift();
    return false;
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

export function toPlanSteps(step: ProductionStep): Step[] {
  return plannable.includes(step.tool) ? [{ tool: step.tool, displayName: step.input.displayName, times: step.input.count ?? 1 }] : [];
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
