import { join } from "node:path";
import type { Connector, FailMode, Json } from "./connector.js";
import { loadRecordings, readJson } from "./recordings.js";

export const situationDirs: Readonly<Record<FailMode, string>> = {
  login: "char-select",
  offline: "game-off",
};

export class FakeConnector implements Connector {
  static async fromDirectory(dir: string, fail?: FailMode): Promise<FakeConnector> {
    const source = fail ? join(dir, situationDirs[fail]) : dir;
    const responses = new Map<string, Json>();
    for (const r of await loadRecordings(source)) responses.set(key(r.command, r.body), r.response);
    if (!fail) responses.set(key("status"), await readJson(dir, "status.connected.json"));
    return new FakeConnector(responses);
  }

  private constructor(private readonly responses: ReadonlyMap<string, Json>) {}

  async run(command: string, body?: string): Promise<Json> {
    return this.responses.get(key(command, body)) ?? notRecorded(command, body);
  }
}

function key(command: string, body?: string): string {
  return body ? `${command} ${body}` : command;
}

function notRecorded(command: string, body?: string): Json {
  return { status: "rejected", body: { error: "not_recorded", message: `녹화가 없다: ${key(command, body)}` } };
}
