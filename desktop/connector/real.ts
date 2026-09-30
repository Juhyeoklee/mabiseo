import { execFile } from "node:child_process";
import type { Connector, Json } from "./connector.js";

// M0 녹화 전부가 이 경로의 CLI로 실측됐다(scripts/win-record)
export const defaultCliPath = "C:\\Nexon\\MabinogiMobile\\MabinogiMobile_CLI.exe";

// 가장 큰 조회 응답은 get_craftable_items의 504KB(recordings/index.tsv). Node 기본 1MB는 여유가 좁다
const maxStdoutBytes = 16 * 1024 * 1024;

export class RealConnector implements Connector {
  constructor(private readonly cli: string) {}

  async run(command: string, body: string | undefined, timeoutMs: number): Promise<Json> {
    const args = body ? [command, body] : [command];
    const finished = await execute(this.cli, args, timeoutMs);
    if (finished.timedOut) throw new Error(`${command}이 ${timeoutMs}ms 안에 끝나지 않아 끊었다`);
    try {
      return JSON.parse(finished.stdout) as Json;
    } catch {
      const detail = finished.stderr.trim() || finished.stdout.trim().slice(0, 200) || "출력 없음";
      throw new Error(`${command}의 출력이 JSON이 아니다(종료 코드 ${finished.exitCode}): ${detail}`);
    }
  }
}

interface Finished {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function execute(file: string, args: string[], timeout: number): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const options = { encoding: "utf8" as const, timeout, maxBuffer: maxStdoutBytes, windowsHide: true };
    execFile(file, args, options, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr, exitCode: 0, timedOut: false });
      if (typeof error.code === "string") return reject(error);
      resolve({ stdout, stderr, exitCode: typeof error.code === "number" ? error.code : null, timedOut: error.killed === true });
    });
  });
}
