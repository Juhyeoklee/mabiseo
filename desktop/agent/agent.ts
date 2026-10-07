import type { Tools } from "../tools/tools.js";
import type { Approve } from "./handlers.js";

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

export type AuthState = { signedIn: true; account: string } | { signedIn: false };

export interface Auth {
  readonly service: string;
  state(): Promise<AuthState>;
  credential(): Promise<string | undefined>;
  login?(open: (url: string) => Promise<void>): Promise<AuthState>;
  logout?(): Promise<AuthState>;
}

export interface Agent {
  readonly auth: Auth;
  ask(prompt: string, session: Session): Promise<void>;
}

export const signedOutReason = "PC에서 로그인이 필요해요";

export const maxTurns = 40;

export const systemPrompt = `너는 마비노기 모바일 플레이어의 비서다. 도구로 게임 상태를 조회하고 캐릭터에게 일을 맡긴다.

- 조회 도구(get_*, capabilities)는 자유롭게 부른다.
- 캐릭터에게 일을 맡기는 도구는 부르면 도구가 실행 전에 사용자 승인을 직접 받는다. 글로 되묻지 말고 도구를 부른다. 결과에 user_denied가 오면 같은 호출을 다시 시도하지 않고 사용자에게 알린다.
- 도구 결과의 error 필드는 게임이나 보호 장치의 거부다. message에 지시가 있으면 그것을 따르고, 없으면 같은 호출을 반복하지 않고 사용자에게 전한다.
- 활동은 한 번에 하나다. 새 활동은 진행 중인 활동을 취소하므로, 먼저 get_activity로 확인한다.
- 가공으로 무언가를 만드는 일은 plan_production을 먼저 부른다. 승인되면 도구 결과의 next_step을 차례로 그대로 부르고, next_step이 null이 되면 결과를 알린다.
- plan_production이 가공법을 모르는 일과 제작은 조회로 레시피와 가진 수를 보고 모자란 재료를 거꾸로 센 뒤, 필요한 맡기기 전부를 propose_plan으로 한 번에 승인받고 시작한다.
- 가공은 대기열에 등록만 하고 바로 끝난다. 시설마다 7칸이고 수령하지 않은 완료분도 칸을 차지하므로, 등록 전에 get_altering_works로 빈 칸을 센다. 완료는 wait_altering으로 기다린 뒤 수령한다. 가공이 도는 동안 다음 재료를 채집할 수 있다.
- 답은 한국어로 짧고 담백하게 쓴다. 감탄이나 사과를 넣지 않는다.`;
