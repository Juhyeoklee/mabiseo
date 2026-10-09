import type { Job, ServerView, Task } from "../server/server.js";

export interface Row {
  label: string;
  value: string;
}

export interface Pairing {
  pcName: string;
  port: number;
  code: string;
}

export interface Account {
  service: string;
  state: { signedIn: true; account: string } | { signedIn: false };
  signingIn: boolean;
  canLogin: boolean;
  canLogout: boolean;
}

export type Action = { kind: "login" | "logout"; label: string };

export interface Chip {
  label: string;
  value: string;
  tone: "good" | "caution" | "bad" | "neutral";
}

export interface Line {
  at: string;
  text: string;
}

export type Card =
  | { kind: "idle" }
  | { kind: "request"; title: string; status: string }
  | {
      kind: "plan";
      title: string;
      status: string;
      running: boolean;
      fraction: number;
      facts: Row[];
      steps: { label: string; note: string; state: "done" | "now" | "next" }[];
    };

export interface Screen {
  chips: Chip[];
  rows: Row[];
  action: Action | undefined;
  card: Card;
  asking: boolean;
  log: Line[];
}

type PlanStep = Job["plan"]["steps"][number];

const LOG_LIMIT = 200;

export function accountRow(account: Account): Row {
  if (account.signingIn) return { label: "AI", value: `${account.service} · 브라우저에서 로그인하는 중` };
  return { label: "AI", value: `${account.service} · ${account.state.signedIn ? account.state.account : "로그인 필요"}` };
}

export function accountAction(account: Account): Action | undefined {
  if (account.signingIn) return undefined;
  if (!account.state.signedIn && account.canLogin) return { kind: "login", label: `${account.service} 로그인` };
  if (account.state.signedIn && account.canLogout) return { kind: "logout", label: "로그아웃" };
  return undefined;
}

export function rows(view: ServerView, pairing: Pairing): Row[] {
  return [
    { label: "게임", value: game(view.connector) },
    { label: "요청", value: view.asking ? "처리 중" : "대기" },
    { label: "날개 예산", value: `${view.wings}개` },
    { label: "페어링 코드", value: pairing.code },
    { label: "PC", value: `${pairing.pcName} · 포트 ${pairing.port}` },
    { label: "연결된 폰", value: phones(view.phones) },
  ];
}

export function chips(view: ServerView, pairing: Pairing, account: Account): Chip[] {
  return [
    { label: "게임", value: game(view.connector), tone: view.connector === "connected" ? "good" : "bad" },
    { label: "폰", value: view.phones.length === 0 ? "없음" : `${view.phones.length}대`, tone: view.phones.length === 0 ? "bad" : "good" },
    { label: "AI", value: account.state.signedIn ? account.service : `${account.service} 로그인 필요`, tone: account.state.signedIn ? "good" : "caution" },
    { label: "날개 예산", value: `${view.wings}개`, tone: "caution" },
    { label: "페어링 코드", value: pairing.code, tone: "neutral" },
  ];
}

export function card(task: Task | undefined): Card {
  if (!task) return { kind: "idle" };
  const job = task.job;
  if (!job) return { kind: "request", title: task.text, status: requestStatus(task) };
  const total = job.plan.steps.length;
  const running = !job.ended && !task.end && job.done < total;
  const used = job.plan.steps.slice(0, job.done).reduce((sum, step) => sum + step.wings, 0);
  const wings = job.plan.steps.reduce((sum, step) => sum + step.wings, 0);
  return {
    kind: "plan",
    title: `${job.plan.item} ${job.plan.count}개`,
    status: planStatus(task, job),
    running,
    fraction: job.done / total,
    facts: [
      ...(running ? [{ label: "남은 시간", value: about(job.remainingSeconds) }] : []),
      { label: "단계", value: `${job.done}/${total}` },
      { label: "날개", value: `${used}/${wings}` },
    ],
    steps: job.plan.steps.map((step, index) => ({
      label: stepLabel(step),
      note: index < job.done ? "마침" : index === job.done && running ? "지금" : about(step.seconds),
      state: index < job.done ? "done" : index === job.done && running ? "now" : "next",
    })),
  };
}

export function progressLines(before: Task | undefined, after: Task | undefined): string[] {
  const job = after?.job;
  if (!job) return [];
  const previous = before?.job?.planId === job.planId ? before.job : undefined;
  const lines: string[] = [];
  if (!previous) {
    const wings = job.plan.steps.reduce((sum, step) => sum + step.wings, 0);
    lines.push(`계획 시작: ${job.plan.item} ${job.plan.count}개 · ${job.plan.steps.length}단계 · 날개 ${wings}`);
  }
  lines.push(...job.plan.steps.slice(previous?.done ?? 0, job.done).map(finished));
  if (job.ended && !previous?.ended) lines.push(endLine(job.ended));
  return lines;
}

export function clock(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function appendLog(log: readonly Line[], line: Line): Line[] {
  return [...log, line].slice(-LOG_LIMIT);
}

function requestStatus(task: Task): string {
  switch (task.end) {
    case undefined:
      return "처리 중";
    case "done":
      return "끝났어요";
    case "failed":
      return "실패로 끝났어요";
    case "cancelled":
      return "중단했어요";
    default: {
      const unreachable: never = task.end;
      return unreachable;
    }
  }
}

function planStatus(task: Task, job: Job): string {
  const current = job.plan.steps[job.done];
  if (!current) return "다 됐어요";
  if (job.ended) return endLine(job.ended);
  if (task.end) return `${requestStatus(task)} · ${job.done}/${job.plan.steps.length}에서 멈춤`;
  return `지금 ${stepLabel(current)}`;
}

function endLine(reason: NonNullable<Job["ended"]>): string {
  switch (reason) {
    case "done":
      return "계획을 다 마쳤어요";
    case "stopped":
      return "가공 대기가 끝나지 않아 계획을 멈췄어요";
    case "replaced":
      return "계획이 새 계획으로 바뀌었어요";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

function stepLabel(step: PlanStep): string {
  switch (step.kind) {
    case "gather":
      return `${step.item} ${step.count}개 채집`;
    case "register":
      return `${step.item} 가공 ${step.count}번 등록`;
    case "wait":
      return `${step.item} 가공 기다리기`;
    case "collect":
      return `${step.item} ${step.count}개 받기`;
    default: {
      const unreachable: never = step.kind;
      return unreachable;
    }
  }
}

function finished(step: PlanStep): string {
  switch (step.kind) {
    case "gather":
      return `${step.item} ${step.count}개를 모았어요`;
    case "register":
      return `${step.item} 가공 ${step.count}번을 등록했어요`;
    case "wait":
      return `${step.item} 가공이 끝났어요`;
    case "collect":
      return `${step.item} ${step.count}개를 받았어요`;
    default: {
      const unreachable: never = step.kind;
      return unreachable;
    }
  }
}

function about(seconds: number): string {
  return seconds < 60 ? `${seconds}초` : `약 ${Math.ceil(seconds / 60)}분`;
}

function game(connector: ServerView["connector"]): string {
  switch (connector) {
    case "connected":
      return "연결됨";
    case "not_in_game":
      return "게임 밖 (로그인 · 캐릭터 선택 화면)";
    case "disconnected":
      return "게임이 꺼져 있음";
    default: {
      const unreachable: never = connector;
      return unreachable;
    }
  }
}

function phones(addresses: string[]): string {
  if (addresses.length === 0) return "없음";
  return `${addresses.length}대 · ${addresses.join(", ")}`;
}
