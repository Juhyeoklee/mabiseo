import { describe, expect, test } from "vitest";
import type { Job, ServerView, Task } from "../server/server.js";
import { accountAction, accountRow, appendLog, card, chips, clock, progressLines, rows, type Account, type Line, type Pairing } from "./view.js";

const pairing: Pairing = { pcName: "SOAP-PC", port: 7470, code: "482913" };
const idle: ServerView = { connector: "connected", wings: 10, phones: [], asking: false, task: undefined };
const chatgpt: Account = { service: "ChatGPT", state: { signedIn: false }, signingIn: false, canLogin: true, canLogout: true };
const signedIn: Account = { ...chatgpt, state: { signedIn: true, account: "me@example.com" } };

const metal = "금속 가공 시설";
const steel: Job["plan"] = {
  item: "강철괴",
  count: 9,
  steps: [
    { kind: "gather", item: "철 광석", count: 100, seconds: 138, wings: 5 },
    { kind: "register", item: "철괴", count: 3, seconds: 7, wings: 15, facility: metal },
    { kind: "wait", item: "철괴", count: 9, seconds: 90, wings: 0, facility: metal },
    { kind: "collect", item: "철괴", count: 9, seconds: 6, wings: 0, facility: metal },
    { kind: "register", item: "강철괴", count: 3, seconds: 7, wings: 15, facility: metal },
    { kind: "wait", item: "강철괴", count: 9, seconds: 900, wings: 0, facility: metal },
    { kind: "collect", item: "강철괴", count: 9, seconds: 6, wings: 0, facility: metal },
  ],
};

function task(job: Partial<Job> | undefined, end: Task["end"] = undefined): Task {
  return { text: "강철괴 9개 만들어줘", job: job && { planId: "r1", plan: steel, done: 0, remainingSeconds: 1154, ended: undefined, ...job }, end };
}

function valueOf(view: ServerView, label: string): string | undefined {
  return rows(view, pairing).find((row) => row.label === label)?.value;
}

describe("상태 창 줄", () => {
  test("게임에 연결돼 대기 중이고 폰이 없으면 여섯 줄이 정해진 순서로 나온다", () => {
    expect(rows(idle, pairing)).toEqual([
      { label: "게임", value: "연결됨" },
      { label: "요청", value: "대기" },
      { label: "날개 예산", value: "10개" },
      { label: "페어링 코드", value: "482913" },
      { label: "PC", value: "SOAP-PC · 포트 7470" },
      { label: "연결된 폰", value: "없음" },
    ]);
  });

  test("캐릭터 선택 화면이면 게임 줄이 게임 밖이라고 말한다", () => {
    expect(valueOf({ ...idle, connector: "not_in_game" }, "게임")).toBe("게임 밖 (로그인 · 캐릭터 선택 화면)");
  });

  test("게임이 꺼져 있으면 게임 줄이 꺼져 있다고 말한다", () => {
    expect(valueOf({ ...idle, connector: "disconnected" }, "게임")).toBe("게임이 꺼져 있음");
  });

  test("요청을 처리하는 중이면 요청 줄이 처리 중이다", () => {
    expect(valueOf({ ...idle, asking: true }, "요청")).toBe("처리 중");
  });

  test("연결된 폰이 둘이면 대수와 주소를 함께 보인다", () => {
    expect(valueOf({ ...idle, phones: ["192.168.0.5", "192.168.0.9"] }, "연결된 폰")).toBe(
      "2대 · 192.168.0.5, 192.168.0.9",
    );
  });
});

describe("상태 칩", () => {
  test("게임 · 폰 · AI · 날개 예산 · 페어링 코드가 이 순서로 나온다", () => {
    expect(chips({ ...idle, phones: ["192.168.0.5"] }, pairing, signedIn)).toEqual([
      { label: "게임", value: "연결됨", tone: "good" },
      { label: "폰", value: "1대", tone: "good" },
      { label: "AI", value: "ChatGPT", tone: "good" },
      { label: "날개 예산", value: "10개", tone: "caution" },
      { label: "페어링 코드", value: "482913", tone: "neutral" },
    ]);
  });

  test("게임이 꺼져 있고 폰이 없고 로그인 전이면 그 칩들이 경고로 바뀐다", () => {
    const [game, phone, ai] = chips({ ...idle, connector: "disconnected" }, pairing, chatgpt);
    expect(game).toEqual({ label: "게임", value: "게임이 꺼져 있음", tone: "bad" });
    expect(phone).toEqual({ label: "폰", value: "없음", tone: "bad" });
    expect(ai).toEqual({ label: "AI", value: "ChatGPT 로그인 필요", tone: "caution" });
  });
});

describe("진행 카드", () => {
  test("맡긴 일이 없으면 빈 카드다", () => {
    expect(card(undefined)).toEqual({ kind: "idle" });
  });

  test("계획 없는 요청은 요청 글과 처리 상태만 보인다", () => {
    expect(card(task(undefined))).toEqual({ kind: "request", title: "강철괴 9개 만들어줘", status: "처리 중" });
    expect(card(task(undefined, "cancelled"))).toMatchObject({ status: "중단했어요" });
  });

  test("도는 계획은 목표 · 남은 시간 · 단계 · 쓴 날개와 지금 단계를 보이고, 단계 목록에서 마친 것과 지금 것을 가른다", () => {
    const shown = card(task({ done: 4, remainingSeconds: 913 }));
    expect(shown).toMatchObject({
      kind: "plan",
      title: "강철괴 9개",
      status: "지금 강철괴 가공 3번 등록",
      running: true,
      fraction: 4 / 7,
      facts: [
        { label: "남은 시간", value: "약 16분" },
        { label: "단계", value: "4/7" },
        { label: "날개", value: "20/35" },
      ],
    });
    if (shown.kind !== "plan") throw new Error(shown.kind);
    expect(shown.steps.map((s) => [s.label, s.note, s.state])).toEqual([
      ["철 광석 100개 채집", "마침", "done"],
      ["철괴 가공 3번 등록", "마침", "done"],
      ["철괴 가공 기다리기", "마침", "done"],
      ["철괴 9개 받기", "마침", "done"],
      ["강철괴 가공 3번 등록", "지금", "now"],
      ["강철괴 가공 기다리기", "약 15분", "next"],
      ["강철괴 9개 받기", "6초", "next"],
    ]);
  });

  test("모든 단계를 마치면 다 됐다고 하고 남은 시간과 지금 단계가 없다", () => {
    const shown = card(task({ done: 7, remainingSeconds: 0, ended: "done" }, "done"));
    expect(shown).toMatchObject({ status: "다 됐어요", running: false, fraction: 1 });
    if (shown.kind !== "plan") throw new Error(shown.kind);
    expect(shown.facts.map((f) => f.label)).toEqual(["단계", "날개"]);
    expect(shown.steps.some((s) => s.state === "now")).toBe(false);
  });

  test("계획이 다른 계획으로 바뀌거나 대기에서 멈추면 요청이 아직 돌아도 계획은 끝난 것으로 보인다", () => {
    expect(card(task({ done: 2, ended: "replaced" }))).toMatchObject({ status: "계획이 새 계획으로 바뀌었어요", running: false });
    expect(card(task({ done: 2, ended: "stopped" }))).toMatchObject({ status: "가공 대기가 끝나지 않아 계획을 멈췄어요", running: false });
  });

  test("계획 도중 요청이 중단되면 몇 단계에서 멈췄는지 보인다", () => {
    expect(card(task({ done: 3 }, "cancelled"))).toMatchObject({ status: "중단했어요 · 3/7에서 멈춤", running: false });
  });
});

describe("읽히는 기록", () => {
  test("계획이 처음 보이면 목표 · 단계 수 · 날개 합계로 시작을 알린다", () => {
    expect(progressLines(task(undefined), task({ done: 0 }))).toEqual(["계획 시작: 강철괴 9개 · 7단계 · 날개 35"]);
  });

  test("같은 계획이 다시 승인되면 새 계획으로 보고 시작을 다시 알린다", () => {
    expect(progressLines(task({ done: 2 }), task({ planId: "r2", done: 0 }))).toEqual(["계획 시작: 강철괴 9개 · 7단계 · 날개 35"]);
  });

  test("마친 단계마다 사람이 읽는 한 줄이 붙고, 남은 시간만 바뀌면 붙지 않는다", () => {
    expect(progressLines(task({ done: 0 }), task({ done: 2 }))).toEqual(["철 광석 100개를 모았어요", "철괴 가공 3번을 등록했어요"]);
    expect(progressLines(task({ done: 2 }), task({ done: 4 }))).toEqual(["철괴 가공이 끝났어요", "철괴 9개를 받았어요"]);
    expect(progressLines(task({ done: 4, remainingSeconds: 913 }), task({ done: 4, remainingSeconds: 880 }))).toEqual([]);
  });

  test("계획이 끝나면 그 까닭을 한 번만 알린다", () => {
    const ended = task({ done: 2, ended: "replaced" });
    expect(progressLines(task({ done: 2 }), ended)).toEqual(["계획이 새 계획으로 바뀌었어요"]);
    expect(progressLines(ended, task({ done: 2, ended: "replaced" }, "done"))).toEqual([]);
  });

  test("계획이 없는 요청은 기록 줄을 만들지 않는다", () => {
    expect(progressLines(undefined, task(undefined))).toEqual([]);
  });

  test("시각은 두 자리로 채운다", () => {
    expect(clock(new Date(2026, 9, 5, 7, 3, 9))).toBe("07:03:09");
  });

  test("기록은 마지막 200줄만 남고, 붙여도 원래 배열은 그대로다", () => {
    let log: Line[] = [];
    for (let i = 1; i <= 201; i++) log = appendLog(log, { at: "00:00:00", text: `줄 ${i}` });
    expect(log).toHaveLength(200);
    expect(log[0]?.text).toBe("줄 2");
    const original: Line[] = [{ at: "00:00:00", text: "첫 줄" }];
    appendLog(original, { at: "00:00:01", text: "둘째 줄" });
    expect(original).toHaveLength(1);
  });
});

describe("AI 계정 줄과 버튼", () => {

  test("로그아웃 상태면 로그인이 필요하다고 보이고 로그인 버튼을 낸다", () => {
    expect(accountRow(chatgpt)).toEqual({ label: "AI", value: "ChatGPT · 로그인 필요" });
    expect(accountAction(chatgpt)).toEqual({ kind: "login", label: "ChatGPT 로그인" });
  });

  test("로그인 상태면 계정을 보이고 로그아웃 버튼을 낸다", () => {
    expect(accountRow(signedIn)).toEqual({ label: "AI", value: "ChatGPT · me@example.com" });
    expect(accountAction(signedIn)).toEqual({ kind: "logout", label: "로그아웃" });
  });

  test("로그인이 진행 중이면 브라우저에서 계속하라고 보이고 버튼을 숨긴다", () => {
    expect(accountRow({ ...chatgpt, signingIn: true })).toEqual({ label: "AI", value: "ChatGPT · 브라우저에서 로그인하는 중" });
    expect(accountAction({ ...chatgpt, signingIn: true })).toBeUndefined();
  });

  test("로그인을 지원하지 않는 공급자는 버튼이 없다", () => {
    const claude: Account = { service: "Claude", state: { signedIn: false }, signingIn: false, canLogin: false, canLogout: false };
    expect(accountRow(claude)).toEqual({ label: "AI", value: "Claude · 로그인 필요" });
    expect(accountAction(claude)).toBeUndefined();
    expect(accountAction({ ...claude, state: { signedIn: true, account: "API 키" } })).toBeUndefined();
  });
});
