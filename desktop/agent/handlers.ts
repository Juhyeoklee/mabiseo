import { z } from "zod";
import { catalog, spec as specOf, type Param, type ToolSpec } from "../tools/catalog.js";
import { planProduction, type Outline } from "../tools/production.js";
import type { ToolInput } from "../tools/tools.js";
import type { Session } from "./agent.js";
import { calls, Plan, plannable, toPlanSteps, totals, type Step } from "./plan.js";

export const planToolName = "propose_plan";

export const productionToolName = "plan_production";

export const toolNames: readonly string[] = [...catalog.map((spec) => spec.name), planToolName, productionToolName];

export type Approve = (tool: string, input: ToolInput, wings: number, plan?: Outline) => Promise<boolean>;

export type Shape = Record<string, z.ZodType>;

export interface Handler {
  name: string;
  description: string;
  shape: Shape;
  run(input: unknown): Promise<unknown>;
}

const planShape = {
  steps: z
    .array(
      z.object({
        tool: z.enum(plannable).describe("맡기기 도구 이름"),
        displayName: z.string().describe("그 도구에 넘길 displayName"),
        times: z.int().positive().describe("호출 수. 가공 등록은 count를 합친 등록 수"),
      }),
    )
    .min(1),
};

const productionShape = {
  item: z.string().describe("만들 것의 이름. 예: 강철괴"),
  count: z.int().positive().describe("만들 개수"),
};

const productionDescription =
  "가공으로 무언가를 만드는 일은 이 도구로 시작한다. 가진 재료와 채집할 수 있는 것을 조회해 채집 · 가공 등록 · 대기 · 수령 단계를 거꾸로 세고, 사용자 승인을 한 번 받는다. 승인되면 이후 도구 결과마다 next_step이 붙는다. next_step의 tool을 그 input 그대로 부르고, next_step이 null이 될 때까지 사용자에게 넘기지 않는다";

const planDescription =
  "날개를 쓰는 맡기기를 여러 번 부르는 일은 먼저 계획을 내고 사용자 승인을 한 번 받는다. 승인된 계획 안의 호출은 다시 묻지 않고, 계획 밖이거나 횟수를 넘는 호출은 따로 묻는다. 수령처럼 날개를 쓰지 않는 맡기기도 계획에 넣는다. 새 계획은 앞 계획을 대신한다";

export type HandlerSession = Pick<Session, "tools" | "approve" | "onEvent">;

export function handlers({ tools, approve, onEvent }: HandlerSession): Handler[] {
  const plan = new Plan((done, remainingSeconds) => onEvent({ kind: "plan_step", done, remainingSeconds }));
  return [
    ...catalog.map((spec) =>
      handler(spec.name, spec.description, shape(spec), async (input: ToolInput) => {
        const planned = spec.kind === "execute" && plan.take(spec, input);
        const approved = spec.kind !== "execute" || planned || (await approve(spec.name, input, spec.wings * calls(spec, input)));
        if (!approved) return { error: "user_denied", message: `사용자가 ${spec.name}을 승인하지 않았다. 다시 시도하지 말고 사용자에게 알린다` };
        const unwatch = tools.watch((progress) => plan.tick(progress.activity, progress.elapsedSeconds));
        const result = await tools.call(spec.name, input).finally(unwatch);
        if (planned) plan.settle(spec, input, result);
        return plan.follow(spec.name, input, result);
      }),
    ),
    handler(planToolName, planDescription, planShape, async ({ steps }) => {
      const approval = await approvePlan(steps, tools.wings, approve);
      if ("approved" in approval) plan.replace(steps);
      return approval;
    }),
    handler(productionToolName, productionDescription, productionShape, async ({ item, count }) => {
      const production = await planProduction(tools, item, count);
      if ("refused" in production) return production.refused;
      if ("error" in production) return production;
      const approval = await approvePlan(production.steps.flatMap(toPlanSteps), tools.wings, approve, production.outline);
      if (!("approved" in approval)) return approval;
      plan.guide(item, production.steps, production.outline);
      return { ...approval, steps: production.steps, next_step: production.steps[0] };
    }),
  ];
}

function handler<S extends Shape>(name: string, description: string, fields: S, run: (input: z.infer<z.ZodObject<S>>) => Promise<unknown>): Handler {
  const schema = z.object(fields);
  return {
    name,
    description,
    shape: fields,
    run: async (input) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return { error: "invalid_input", message: `${name}의 입력이 스키마와 맞지 않는다: ${z.prettifyError(parsed.error)}` };
      return run(parsed.data);
    },
  };
}

async function approvePlan(steps: readonly Step[], budget: number, approve: Approve, outline?: Outline) {
  const counts = totals(steps);
  const wings = steps.reduce((sum, step) => sum + specOf(step.tool).wings * step.times, 0);
  if (wings > budget) {
    return { error: "wings_budget", message: `계획에 날개 ${wings}개가 들지만 이 세션의 예산은 ${budget}개다. 계획을 줄이거나 사용자에게 알린다` };
  }
  if (!(await approve(planToolName, Object.fromEntries(counts), wings, outline))) {
    return { error: "user_denied", message: "사용자가 계획을 승인하지 않았다. 다시 시도하지 말고 사용자에게 알린다" };
  }
  return { approved: true as const, wings };
}

function shape(spec: ToolSpec): Record<string, z.ZodString | z.ZodNumber | z.ZodOptional<z.ZodString> | z.ZodOptional<z.ZodNumber>> {
  return Object.fromEntries([...spec.params, ...(spec.repeat ? [spec.repeat] : [])].map((p) => [p.name, field(p)]));
}

function field(p: Param) {
  const base = (p.type === "number" ? z.number() : z.string()).describe(p.description);
  return p.required ? base : base.optional();
}
