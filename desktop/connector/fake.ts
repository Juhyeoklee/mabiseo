import type { Connector, FailMode, Json } from "./connector.js";
import { loadRecordings, readJson } from "./recordings.js";

export class FakeConnector implements Connector {
  static async fromDirectory(dir: string, fail?: FailMode): Promise<FakeConnector> {
    const responses = new Map<string, Json>();
    for (const r of await loadRecordings(dir)) responses.set(key(r.command, r.body), r.response);
    responses.set(key("status"), await readJson(dir, "status.connected.json"));
    const offline = await readJson(dir, "status.disconnected-game_off.json");
    return new FakeConnector(responses, offline, fail);
  }

  private constructor(
    private readonly responses: ReadonlyMap<string, Json>,
    private readonly offline: Json,
    private readonly fail: FailMode | undefined,
  ) {}

  async run(command: string, body?: string): Promise<Json> {
    if (this.fail === "offline") return this.offline;
    return this.responses.get(key(command, body)) ?? notRecorded(command, body);
  }
}

function key(command: string, body?: string): string {
  return body ? `${command} ${body}` : command;
}

function notRecorded(command: string, body?: string): Json {
  return { status: "rejected", body: { error: "not_recorded", message: `녹화가 없다: ${key(command, body)}` } };
}
