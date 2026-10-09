import { isRefused } from "../tools/tools.js";
import type { Session } from "./agent.js";
import { handlers, productionToolName } from "./handlers.js";
import { Plan } from "./plan.js";
import type { Tiers } from "./select.js";

export async function make(item: string, count: number, session: Session, tiers: Tiers): Promise<void> {
  const plan = new Plan(session.onEvent);
  const byName = new Map(handlers(session, plan).map((h) => [h.name, h]));
  const call = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    session.onEvent({ kind: "tool", name, input });
    const found = byName.get(name);
    const result = found ? await found.run(input) : { error: "unknown_tool", message: `${name}라는 도구는 없다` };
    session.onEvent({ kind: "tool_result", text: JSON.stringify(result) });
    return result;
  };
  const goal = `사용자가 제작 버튼으로 ${item} ${count}개를 맡겼다.`;

  let result = await call(productionToolName, { item, count });
  if (field(result, "error") === "no_recipe") {
    return tiers.high.ask(`${goal} 데스크탑 앱이 가공법을 몰라 계획을 세지 못했다: ${JSON.stringify(result)}`, session);
  }
  let last = productionToolName;
  let next = nextStep(result);
  while (next && !session.abort?.signal.aborted) {
    last = next.tool;
    result = await call(next.tool, next.input);
    const outcome = field(result, "result") ?? result;
    if (isRefused(outcome) || isRefused(field(outcome, "last"))) break;
    next = nextStep(result);
  }
  if (session.abort?.signal.aborted) return;
  if (field(result, "plan_done") !== undefined) return session.onEvent({ kind: "done", text: `${item} ${count}개를 만들었어요.`, turns: 0, costUsd: 0 });
  if (field(result, "error") === "user_denied") return session.onEvent({ kind: "done", text: "승인하지 않아 멈췄어요.", turns: 0, costUsd: 0 });
  const stuck = `${goal} 데스크탑 앱이 막혔다. 마지막으로 부른 ${last}의 결과: ${JSON.stringify(result)}.`;
  if (field(result, "plan_stopped") !== undefined) {
    return tiers.mid.ask(`${stuck} 같은 대기를 다시 부르지 않는다. 조회로 어디까지 했는지 확인해 사용자에게 알린다.`, session);
  }
  const remaining = plan.remaining();
  if (!Object.keys(remaining).length) return tiers.mid.ask(`${stuck} 계획을 세우기 전이다. 무엇이 막았는지 사용자에게 알린다.`, session);
  return tiers.mid.ask(
    `${stuck} 계획에서 남은 맡기기: ${JSON.stringify(remaining)}. ` +
      "조회로 무엇이 막았는지 확인한다. 막은 것이 풀렸으면 남은 맡기기를 propose_plan으로 승인받아 이어 가고, 아니면 무엇이 막았고 어디까지 했는지 사용자에게 알린다.",
    session,
  );
}

interface Next {
  tool: string;
  input: Record<string, unknown>;
}

function nextStep(result: unknown): Next | undefined {
  const next = field(result, "next_step");
  const tool = field(next, "tool");
  const input = field(next, "input");
  if (typeof tool !== "string" || typeof input !== "object" || input === null) return undefined;
  return { tool, input: { ...input } };
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined;
}
