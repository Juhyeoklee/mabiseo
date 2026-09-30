import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealConnector } from "./real.js";
import { readJson } from "./recordings.js";

const recordings = fileURLToPath(new URL("../../recordings/", import.meta.url));

const stub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const recordings = ${JSON.stringify(recordings)};
const [command, body] = process.argv.slice(2);
const out = (value, code = 0) => { process.stdout.write(JSON.stringify(value) + "\\n"); process.exitCode = code; };
const replay = (dir, file) => {
  const row = fs.readFileSync(path.join(recordings, dir, "index.tsv"), "utf8").split("\\n").map((r) => r.split("\\t")).find((r) => r[0] === file);
  process.stdout.write(fs.readFileSync(path.join(recordings, dir, file)));
  process.exitCode = Number(row[1]);
};
switch (command) {
  case "get_my_info": replay("", "get_my_info.json"); break;
  case "status": replay("game-off", "status.json"); break;
  case "echo": out({ body }); break;
  case "garbage": process.stdout.write("Unhandled exception: pipe broken\\n"); process.exitCode = 1; break;
  case "crash": process.stderr.write("boom"); process.exitCode = 1; break;
  case "hang": setTimeout(() => {}, 60_000); break;
  case "big": out({ items: Array.from({ length: 60_000 }, (_, i) => ({ id: i, name: "아이템 " + i })) }); break;
}
`;

let dir: string;
let cli: string;
const run = (command: string, body?: string, timeoutMs = 5_000) => new RealConnector(cli).run(command, body, timeoutMs);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mabiseo-cli-"));
  cli = join(dir, "cli.js");
  await writeFile(cli, stub, "utf8");
  await chmod(cli, 0o755);
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("실물 커넥터는 CLI를 1회 스폰해 stdout의 JSON을 값으로 돌려준다", () => {
  it("녹화된 get_my_info의 원시 바이트가 한글 그대로 값이 된다", async () => {
    const expected = await readJson(recordings, "get_my_info.json");
    expect(JSON.stringify(expected)).toMatch(/[가-힣]/);
    expect(await run("get_my_info")).toEqual(expected);
  });

  it("본문은 두 번째 인자로 그대로 간다. 한글과 따옴표가 든 JSON도", async () => {
    const body = '{"displayName":"새록 버섯"}';
    expect(await run("echo", body)).toEqual({ body });
  });

  it("본문이 없으면 명령 하나만 준다", async () => {
    expect(await run("echo")).toEqual({});
  });

  it("게임이 꺼진 녹화(종료 코드 5)의 끊김 응답은 예외가 아니라 값이다", async () => {
    const index = await readFile(join(recordings, "game-off", "index.tsv"), "utf8");
    expect(index).toMatch(/^status\.json\t5\t/m);
    const response = await run("status");
    expect(response).toEqual(await readJson(join(recordings, "game-off"), "status.json"));
    expect(response).toMatchObject({ pipe: "disconnected" });
  });

  it("1MB를 넘는 응답도 잘리지 않는다", async () => {
    const response = await run("big");
    expect(response).toMatchObject({ items: expect.any(Array) });
    expect(JSON.stringify(response).length).toBeGreaterThan(1024 * 1024);
  });
});

describe("CLI 실행 자체의 실패만 던진다", () => {
  it("출력이 JSON이 아니면 종료 코드와 출력 머리를 담아 던진다", async () => {
    await expect(run("garbage")).rejects.toThrow(/종료 코드 1.*pipe broken/);
  });

  it("출력 없이 stderr만 있으면 stderr를 담아 던진다", async () => {
    await expect(run("crash")).rejects.toThrow(/boom/);
  });

  it("시간 안에 끝나지 않으면 끊고 던진다", async () => {
    await expect(run("hang", undefined, 300)).rejects.toThrow(/300ms/);
  });

  it("CLI 파일이 없으면 던진다", async () => {
    await expect(new RealConnector(join(dir, "없다.exe")).run("status", undefined, 5_000)).rejects.toThrow(/ENOENT/);
  });
});
