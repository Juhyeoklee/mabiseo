import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Connector, Json } from "./connector.js";

const header = "file\texit\tms\tbytes\tcommand\tbody\n";

export class TracingConnector implements Connector {
  private seq = 0;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly inner: Connector,
    private readonly dir: string,
  ) {}

  async run(command: string, body: string | undefined, timeoutMs: number): Promise<Json> {
    const n = ++this.seq;
    const started = Date.now();
    let response: Json;
    try {
      response = await this.inner.run(command, body, timeoutMs);
    } catch (error) {
      await this.quietly(() => this.note(n, command, body, Date.now() - started, error instanceof Error ? error.message : String(error)));
      throw error;
    }
    await this.quietly(() => this.record(n, command, body, Date.now() - started, response));
    return response;
  }

  // 추적 쓰기가 던지면 성공한 맡기기가 예외로 바뀌어 tools/의 예산 차감과 jobs/의 활동 붙들기가 건너뛰어진다
  private async quietly(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      console.error(`[추적] 쓰기 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async record(n: number, command: string, body: string | undefined, ms: number, response: Json): Promise<void> {
    await this.prepare();
    const file = `${String(n).padStart(3, "0")}-${command}.json`;
    const text = JSON.stringify(response, null, 2) + "\n";
    await writeFile(join(this.dir, file), text, "utf8");
    await appendFile(join(this.dir, "index.tsv"), `${file}\t0\t${ms}\t${Buffer.byteLength(text)}\t${command}\t${body ?? ""}\n`, "utf8");
  }

  private async note(n: number, command: string, body: string | undefined, ms: number, message: string): Promise<void> {
    await this.prepare();
    const file = `${String(n).padStart(3, "0")}-${command}.error.txt`;
    await writeFile(join(this.dir, file), `${command} ${body ?? ""}\n${ms}ms\n${message}\n`, "utf8");
  }

  private prepare(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => writeFile(join(this.dir, "index.tsv"), header, "utf8"));
    return this.ready;
  }
}
