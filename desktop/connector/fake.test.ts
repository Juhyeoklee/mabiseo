import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeConnector } from "./fake.js";
import { loadRecordings } from "./recordings.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));

describe("가짜 커넥터", () => {
  it("녹화된 명령·본문 조합마다 그 파일의 JSON을 그대로 돌려준다", async () => {
    const fake = await FakeConnector.fromDirectory(dir);
    const recordings = await loadRecordings(dir);
    expect(recordings.length).toBeGreaterThan(0);
    for (const r of recordings) {
      const expected: unknown = JSON.parse(await readFile(join(dir, r.file), "utf8"));
      expect(await fake.run(r.command, r.body)).toEqual(expected);
    }
  });

  it("빈 본문은 본문 없음과 같다", async () => {
    const fake = await FakeConnector.fromDirectory(dir);
    expect(await fake.run("get_items", "")).toEqual(await fake.run("get_items"));
  });

  it("본문이 다르면 다른 녹화를 돌려준다", async () => {
    const fake = await FakeConnector.fromDirectory(dir);
    expect(await fake.run("get_gatherable_items", "통나무")).not.toEqual(await fake.run("get_gatherable_items"));
  });

  it("status는 파이프가 연결됐다고 답한다", async () => {
    const fake = await FakeConnector.fromDirectory(dir);
    expect(await fake.run("status")).toEqual({ pipe: "connected" });
  });

  it("녹화가 없는 조합은 던지지 않고 not_recorded 값을 돌려준다", async () => {
    const fake = await FakeConnector.fromDirectory(dir);
    expect(await fake.run("get_gatherable_items", "버섯")).toMatchObject({
      status: "rejected",
      body: { error: "not_recorded" },
    });
  });

  it("offline이면 status가 game_off로 끊겼다고 답한다", async () => {
    const fake = await FakeConnector.fromDirectory(dir, "offline");
    expect(await fake.run("status")).toEqual({ pipe: "disconnected", reason: "game_off" });
  });

  it("offline이면 조회 명령도 끊김 값을 돌려준다", async () => {
    const fake = await FakeConnector.fromDirectory(dir, "offline");
    expect(await fake.run("get_my_info")).toEqual({ pipe: "disconnected", reason: "game_off" });
  });
});
