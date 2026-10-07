import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeConnector } from "./fake.js";
import { loadRecordings } from "./recordings.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));
const unknownItem = '{"displayName":"마비서없는아이템"}';

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
      error: "not_recorded",
    });
  });
});

describe("게임의 거부는 예외가 아니라 값이다", () => {
  it("앉아 있지 않을 때 stand_up은 not_sitting으로 거부된다", async () => {
    const fake = await FakeConnector.fromDirectory(dir);
    expect(await fake.run("stand_up")).toEqual({ error: "not_sitting", message: expect.any(String) });
  });

  it("진행 중인 행동이 없을 때 stop_action은 invalid_state로 거부된다", async () => {
    const fake = await FakeConnector.fromDirectory(dir);
    expect(await fake.run("stop_action")).toEqual({ error: "invalid_state", message: expect.any(String) });
  });

  it("없는 이름의 execute_gathering은 날개를 쓰기 전에 not_found로 막힌다", async () => {
    const fake = await FakeConnector.fromDirectory(dir);
    expect(await fake.run("execute_gathering", unknownItem)).toEqual({
      error: "not_found",
      message: expect.any(String),
    });
  });

  it("write_chat은 확인 창 없이 즉시 전송됐다고 답한다", async () => {
    const fake = await FakeConnector.fromDirectory(dir);
    expect(await fake.run("write_chat", "마비서 테스트")).toEqual({ message: expect.any(String) });
    expect(await fake.run("write_chat", "마비서 테스트")).not.toHaveProperty("error");
  });
});

describe("--fail=login: 캐릭터 선택 화면", () => {
  it("status는 연결됐다고 답해서 status만으로는 게임 안인지 모른다", async () => {
    const fake = await FakeConnector.fromDirectory(dir, "login");
    expect(await fake.run("status")).toEqual({ pipe: "connected" });
  });

  it("조회와 실행 명령 모두 not_in_game으로 거부된다", async () => {
    const fake = await FakeConnector.fromDirectory(dir, "login");
    const rejected = { error: "not_in_game", message: expect.any(String) };
    expect(await fake.run("get_my_info")).toEqual(rejected);
    expect(await fake.run("stand_up")).toEqual(rejected);
    expect(await fake.run("execute_gathering", unknownItem)).toEqual(rejected);
  });

  it("그 상황에 녹화가 없는 명령도 not_in_game으로 거부된다", async () => {
    const fake = await FakeConnector.fromDirectory(dir, "login");
    expect(await fake.run("get_activity")).toEqual({ error: "not_in_game", message: expect.any(String) });
  });
});

describe("--fail=offline: 게임 꺼짐", () => {
  it("status가 game_off로 끊겼다고 답한다", async () => {
    const fake = await FakeConnector.fromDirectory(dir, "offline");
    expect(await fake.run("status")).toEqual({ pipe: "disconnected", reason: "game_off" });
  });

  it("조회와 실행 명령 모두 같은 끊김 값을 돌려준다", async () => {
    const fake = await FakeConnector.fromDirectory(dir, "offline");
    const disconnected = { pipe: "disconnected", reason: "game_off" };
    expect(await fake.run("get_my_info")).toEqual(disconnected);
    expect(await fake.run("stand_up")).toEqual(disconnected);
    expect(await fake.run("execute_gathering", unknownItem)).toEqual(disconnected);
  });

  it("그 상황에 녹화가 없는 명령도 같은 끊김 값을 돌려준다", async () => {
    const fake = await FakeConnector.fromDirectory(dir, "offline");
    expect(await fake.run("get_activity")).toEqual({ pipe: "disconnected", reason: "game_off" });
  });

  it("상황 녹화의 응답이 서로 다르면 지어낼 값을 고를 수 없어 읽을 때 던진다", async () => {
    const root = await mkdtemp(join(tmpdir(), "mabiseo-"));
    const offline = join(root, "game-off");
    await mkdir(offline);
    await writeFile(join(offline, "index.tsv"), "file\texit\tms\tbytes\tcommand\tbody\na.json\t5\t0\t0\tget_my_info\t\nb.json\t5\t0\t0\tstand_up\t\n");
    await writeFile(join(offline, "a.json"), '{"pipe":"disconnected","reason":"game_off"}');
    await writeFile(join(offline, "b.json"), '{"error":"not_in_game","message":""}');
    await expect(FakeConnector.fromDirectory(root, "offline")).rejects.toThrow();
  });
});
