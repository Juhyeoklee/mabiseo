import { join } from "node:path";
import type { Connector, FailMode, Json } from "./connector.js";
import { loadRecordings, readJson, type Recording } from "./recordings.js";

export const situationDirs: Readonly<Record<FailMode, string>> = {
  login: "char-select",
  offline: "game-off",
};

export class FakeConnector implements Connector {
  static async fromDirectory(dir: string, fail?: FailMode): Promise<FakeConnector> {
    const source = fail ? join(dir, situationDirs[fail]) : dir;
    const recordings = await loadRecordings(source);
    const responses = new Map<string, Json>();
    for (const r of recordings) responses.set(key(r.command, r.body), r.response);
    if (!fail) responses.set(key("status"), await readJson(dir, "status.connected.json"));
    return new FakeConnector(responses, fail ? situationResponse(source, recordings) : undefined);
  }

  private constructor(
    private readonly responses: ReadonlyMap<string, Json>,
    private readonly situation?: Json,
  ) {}

  async run(command: string, body?: string): Promise<Json> {
    return this.responses.get(key(command, body)) ?? this.situation ?? notRecorded(command, body);
  }
}

// 상황 모드의 실물은 status 말고는 어느 명령이든 같은 값을 낸다(recordings/game-off/ · char-select/)
function situationResponse(source: string, recordings: readonly Recording[]): Json {
  const answers = new Set(recordings.filter((r) => r.command !== "status").map((r) => JSON.stringify(r.response)));
  const [only] = answers;
  if (answers.size !== 1 || only === undefined) throw new Error(`상황 녹화의 응답이 하나가 아니다: ${source}`);
  return JSON.parse(only) as Json;
}

function key(command: string, body?: string): string {
  return body ? `${command} ${body}` : command;
}

// 실물 CLI의 거부는 평평한 {error, message}다(execute_gathering.unknown-name.json). 감싸면 tools/가 거부로 못 본다
function notRecorded(command: string, body?: string): Json {
  return { error: "not_recorded", message: `녹화가 없다: ${key(command, body)}` };
}
