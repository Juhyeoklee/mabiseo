import { fileURLToPath } from "node:url";
import type { Report } from "./server/server.js";
import { parseArgs, start, usage } from "./start.js";

const recordings = fileURLToPath(new URL("../recordings/", import.meta.url));

const report: Report = {
  log: (line) => console.log(`[로그] ${line}`),
  view: (v) => console.log(`[상태] 게임 ${v.connector} · 날개 ${v.wings} · 폰 ${v.phones.length} · ${v.asking ? "처리 중" : "대기"}`),
};

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const { server, pcName, stop } = await start(args, recordings, report);
  console.log(`[대기] ${pcName} · 포트 ${server.port} · 페어링 코드 ${args.code}${args.trace ? ` · 추적 ${args.trace}` : ""}`);
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`[오류] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
