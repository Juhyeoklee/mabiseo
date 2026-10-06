import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Tools } from "../tools/tools.js";
import { allowedToolNames, mcpServer, serverName, shortName, type Approve } from "./mcp.js";

export type AgentEvent =
  | { kind: "started"; model: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "tool_result"; text: string }
  | { kind: "progress"; activity: string; elapsedSeconds: number }
  | { kind: "done"; text: string; turns: number; costUsd: number }
  | { kind: "failed"; reason: string };

export interface Session {
  tools: Tools;
  approve: Approve;
  onEvent: (event: AgentEvent) => void;
  abort?: AbortController;
}

const systemPrompt = `너는 마비노기 모바일 플레이어의 비서다. 도구로 게임 상태를 조회하고 캐릭터에게 일을 맡긴다.

- 조회 도구(get_*, capabilities)는 자유롭게 부른다.
- 캐릭터에게 일을 맡기는 도구는 실행 전에 사용자 승인을 거친다. 결과에 user_denied가 오면 같은 호출을 다시 시도하지 않고 사용자에게 알린다.
- 도구 결과의 error 필드는 게임이나 보호 장치의 거부다. message에 지시가 있으면 그것을 따르고, 없으면 같은 호출을 반복하지 않고 사용자에게 전한다.
- 활동은 한 번에 하나다. 새 활동은 진행 중인 활동을 취소하므로, 먼저 get_activity로 확인한다.
- 재료를 모아 가공하거나 제작하는 일은 조회로 레시피와 가진 수를 보고 모자란 재료를 거꾸로 센 뒤, 필요한 맡기기 전부를 propose_plan으로 한 번에 승인받고 시작한다.
- 가공은 대기열에 등록만 하고 바로 끝난다. 시설마다 7칸이고 수령하지 않은 완료분도 칸을 차지하므로, 등록 전에 get_altering_works로 빈 칸을 센다. 완료는 wait_altering으로 기다린 뒤 수령한다. 가공이 도는 동안 다음 재료를 채집할 수 있다.
- 답은 한국어로 짧고 담백하게 쓴다. 감탄이나 사과를 넣지 않는다.`;

export async function ask(prompt: string, session: Session): Promise<void> {
  const stream = query({
    prompt,
    options: {
      systemPrompt,
      tools: [],
      mcpServers: { [serverName]: mcpServer(session.tools, session.approve) },
      allowedTools: [...allowedToolNames],
      permissionMode: "default",
      settingSources: [],
      persistSession: false,
      maxTurns: 40,
      ...(session.abort && { abortController: session.abort }),
    },
  });
  const unwatch = session.tools.watch((progress) => session.onEvent({ kind: "progress", ...progress }));
  try {
    for await (const message of stream) {
      for (const event of events(message)) session.onEvent(event);
    }
  } finally {
    unwatch();
  }
}

function events(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case "system":
      return message.subtype === "init" ? [{ kind: "started", model: message.model }] : [];
    case "assistant":
      return message.message.content.flatMap((block): AgentEvent[] => {
        if (block.type === "text") return [{ kind: "text", text: block.text }];
        if (block.type === "tool_use") return [{ kind: "tool", name: shortName(block.name), input: block.input }];
        return [];
      });
    case "user": {
      const content = message.message.content;
      if (typeof content === "string") return [];
      return content.flatMap((block): AgentEvent[] =>
        block.type === "tool_result" ? [{ kind: "tool_result", text: resultText(block.content) }] : [],
      );
    }
    case "result":
      if (message.subtype !== "success") return [{ kind: "failed", reason: message.subtype }];
      if (message.is_error) return [{ kind: "failed", reason: message.result }];
      return [{ kind: "done", text: message.result, turns: message.num_turns, costUsd: message.total_cost_usd }];
    default:
      return [];
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
    .join("");
}
