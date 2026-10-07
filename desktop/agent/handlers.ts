import { z } from "zod";
import { catalog, spec as specOf, type Param, type ToolSpec } from "../tools/catalog.js";
import type { ToolInput, Tools } from "../tools/tools.js";
import { calls, Plan, plannable, totals, type Step } from "./plan.js";

export const planToolName = "propose_plan";

export const toolNames: readonly string[] = [...catalog.map((spec) => spec.name), planToolName];

export type Approve = (tool: string, input: ToolInput, wings: number) => Promise<boolean>;

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

const planDescription =
  "날개를 쓰는 맡기기를 여러 번 부르는 일은 먼저 계획을 내고 사용자 승인을 한 번 받는다. 승인된 계획 안의 호출은 다시 묻지 않고, 계획 밖이거나 횟수를 넘는 호출은 따로 묻는다. 수령처럼 날개를 쓰지 않는 맡기기도 계획에 넣는다. 새 계획은 앞 계획을 대신한다";

export function handlers(tools: Tools, approve: Approve): Handler[] {
  const plan = new Plan();
  return [
    ...catalog.map((spec) =>
      handler(spec.name, spec.description, shape(spec), async (input: ToolInput) => {
        const planned = spec.kind === "execute" && plan.take(spec, input);
        const approved = spec.kind !== "execute" || planned || (await approve(spec.name, input, spec.wings * calls(spec, input)));
        if (!approved) return { error: "user_denied", message: `사용자가 ${spec.name}을 승인하지 않았다. 다시 시도하지 말고 사용자에게 알린다` };
        const result = await tools.call(spec.name, input);
        if (planned) plan.settle(spec, input, result);
        return result;
      }),
    ),
    handler(planToolName, planDescription, planShape, ({ steps }) => propose(steps, plan, tools, approve)),
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

async function propose(steps: readonly Step[], plan: Plan, tools: Tools, approve: Approve) {
  const counts = totals(steps);
  const wings = steps.reduce((sum, step) => sum + specOf(step.tool).wings * step.times, 0);
  if (wings > tools.wings) {
    return { error: "wings_budget", message: `계획에 날개 ${wings}개가 들지만 이 세션의 예산은 ${tools.wings}개다. 계획을 줄이거나 사용자에게 알린다` };
  }
  if (!(await approve(planToolName, Object.fromEntries(counts), wings))) {
    return { error: "user_denied", message: "사용자가 계획을 승인하지 않았다. 다시 시도하지 말고 사용자에게 알린다" };
  }
  plan.replace(steps);
  return { approved: true, wings };
}

function shape(spec: ToolSpec): Record<string, z.ZodString | z.ZodNumber | z.ZodOptional<z.ZodString> | z.ZodOptional<z.ZodNumber>> {
  return Object.fromEntries([...spec.params, ...(spec.repeat ? [spec.repeat] : [])].map((p) => [p.name, field(p)]));
}

function field(p: Param) {
  const base = (p.type === "number" ? z.number() : z.string()).describe(p.description);
  return p.required ? base : base.optional();
}
