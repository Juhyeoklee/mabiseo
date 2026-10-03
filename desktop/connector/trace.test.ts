import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, Json } from "./connector.js";
import { loadRecordings } from "./recordings.js";
import { TracingConnector } from "./trace.js";

const stub: Connector = {
  async run(command, body) {
    if (command === "crash") throw new Error("깨졌다");
    return { command, body: body ?? null, name: "통나무" };
  },
};

describe("TracingConnector", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), "trace-")), "nested");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("응답을 그대로 돌려주고 recordings/ 모양으로 남긴다", async () => {
    const connector = new TracingConnector(stub, dir);
    const first = await connector.run("get_activity", undefined, 1000);
    await connector.run("execute_gathering", '{"name":"통나무"}', 1000);
    expect(first).toEqual({ command: "get_activity", body: null, name: "통나무" });

    const recordings = await loadRecordings(dir);
    expect(recordings.map((r) => [r.file, r.command, r.body])).toEqual([
      ["001-get_activity.json", "get_activity", undefined],
      ["002-execute_gathering.json", "execute_gathering", '{"name":"통나무"}'],
    ]);
    expect(recordings[1]?.response).toEqual({ command: "execute_gathering", body: '{"name":"통나무"}', name: "통나무" });
    expect(await readFile(join(dir, "001-get_activity.json"), "utf8")).toContain("통나무");
  });

  it("동시에 부른 호출도 파일과 index 행을 하나씩 남긴다", async () => {
    const connector = new TracingConnector(stub, dir);
    await Promise.all(["get_my_info", "get_activity", "get_currencies"].map((command) => connector.run(command, undefined, 1000)));
    const recordings = await loadRecordings(dir);
    expect(recordings.map((r) => r.file).sort()).toEqual(["001-get_my_info.json", "002-get_activity.json", "003-get_currencies.json"]);
  });

  it("추적 쓰기가 실패해도 응답은 그대로 돌려주고, 던진 호출은 원래 오류로 던진다", async () => {
    const blocker = join(dir, "..", "file");
    await writeFile(blocker, "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const connector = new TracingConnector(stub, join(blocker, "under-a-file"));
    expect(await connector.run("get_activity", undefined, 1000)).toMatchObject({ command: "get_activity" });
    await expect(connector.run("crash", undefined, 1000)).rejects.toThrow("깨졌다");
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it("던진 호출은 다시 던지고 오류 파일만 남긴다", async () => {
    const connector = new TracingConnector(stub, dir);
    await expect(connector.run("crash", undefined, 1000)).rejects.toThrow("깨졌다");
    expect(await readdir(dir)).toEqual(["001-crash.error.txt", "index.tsv"]);
    expect(await readFile(join(dir, "001-crash.error.txt"), "utf8")).toContain("깨졌다");
    expect(await loadRecordings(dir)).toEqual([]);
  });
});
