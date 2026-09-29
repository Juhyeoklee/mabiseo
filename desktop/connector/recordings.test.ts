import { mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRecordings } from "./recordings.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));

describe("녹화 색인", () => {
  it("행마다 파일이 실재하고 JSON으로 읽힌다", async () => {
    await expect(loadRecordings(dir)).resolves.toBeInstanceOf(Array);
  });

  it("status를 뺀 녹화 파일 전부가 색인에 있다", async () => {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith("status."));
    const indexed = (await loadRecordings(dir)).map((r) => r.file);
    expect(indexed.sort()).toEqual(files.sort());
  });

  it("Windows 녹화기가 남기는 CRLF 색인도 같은 녹화로 읽힌다", async () => {
    const crlf = await mkdtemp(join(tmpdir(), "mabiseo-"));
    for (const f of await readdir(dir)) if (f.endsWith(".json")) await symlink(join(dir, f), join(crlf, f));
    await writeFile(join(crlf, "index.tsv"), (await readFile(join(dir, "index.tsv"), "utf8")).replace(/\n/g, "\r\n"));
    expect(await loadRecordings(crlf)).toEqual(await loadRecordings(dir));
  });

  it("본문이 있는 행은 command와 body가 나뉘고, 없는 행은 body가 없다", async () => {
    const recordings = await loadRecordings(dir);
    const ingredient = recordings.find((r) => r.file === "get_items.ingredient.json");
    expect(ingredient).toMatchObject({ command: "get_items", body: '{"category":"Ingredient"}' });
    const all = recordings.find((r) => r.file === "get_items.json");
    expect(all).toMatchObject({ command: "get_items" });
    expect(all).not.toHaveProperty("body");
  });
});
