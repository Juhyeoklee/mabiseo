import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Json } from "./connector.js";

export interface Recording {
  file: string;
  command: string;
  body?: string;
  response: Json;
}

const header = "file\texit\tms\tbytes\tcommand\tbody";

export async function loadRecordings(dir: string): Promise<Recording[]> {
  const index = await readFile(join(dir, "index.tsv"), "utf8");
  const [first, ...rows] = index.trimEnd().split(/\r?\n/);
  if (first !== header) throw new Error(`index.tsv 머리가 다르다: ${first}`);
  return Promise.all(
    rows.map(async (row) => {
      const [file, , , , command, body] = row.split("\t");
      if (!file || !command) throw new Error(`index.tsv 행이 깨졌다: ${row}`);
      const response = await readJson(dir, file);
      return body ? { file, command, body, response } : { file, command, response };
    }),
  );
}

export async function readJson(dir: string, file: string): Promise<Json> {
  return JSON.parse(await readFile(join(dir, file), "utf8")) as Json;
}
