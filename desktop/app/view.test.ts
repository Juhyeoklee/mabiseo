import { describe, expect, test } from "vitest";
import type { ServerView } from "../server/server.js";
import { accountAction, accountRow, appendLog, rows, stamp, type Account, type Pairing } from "./view.js";

const pairing: Pairing = { pcName: "SOAP-PC", port: 7470, code: "482913" };
const idle: ServerView = { connector: "connected", wings: 10, phones: [], asking: false };

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

describe("로그", () => {
  test("로그 줄 앞에 두 자리로 채운 시각이 붙는다", () => {
    expect(stamp("폰 연결: 127.0.0.1", new Date(2026, 9, 5, 7, 3, 9))).toBe("07:03:09 폰 연결: 127.0.0.1");
  });

  test("로그는 마지막 200줄만 남는다", () => {
    let log: string[] = [];
    for (let i = 1; i <= 201; i++) log = appendLog(log, `줄 ${i}`);
    expect(log).toHaveLength(200);
    expect(log[0]).toBe("줄 2");
  });

  test("로그를 붙여도 원래 배열은 그대로다", () => {
    const original = ["첫 줄"];
    appendLog(original, "둘째 줄");
    expect(original).toEqual(["첫 줄"]);
  });
});

describe("AI 계정 줄과 버튼", () => {
  const chatgpt: Account = { service: "ChatGPT", state: { signedIn: false }, signingIn: false, canLogin: true, canLogout: true };
  const signedIn: Account = { ...chatgpt, state: { signedIn: true, account: "me@example.com" } };

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
