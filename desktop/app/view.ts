import type { ServerView } from "../server/server.js";

export interface Row {
  label: string;
  value: string;
}

export interface Pairing {
  pcName: string;
  port: number;
  code: string;
}

const LOG_LIMIT = 200;

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

export function stamp(line: string, at: Date): string {
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  return `${time} ${line}`;
}

export function appendLog(log: readonly string[], line: string): string[] {
  return [...log, line].slice(-LOG_LIMIT);
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
