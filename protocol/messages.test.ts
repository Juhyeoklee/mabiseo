import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { agentEvent, desktopMessage, phoneMessage } from "./messages.js";

const fixtures = new URL("./fixtures/", import.meta.url);

function list(dir: string): string[] {
  return readdirSync(new URL(`${dir}/`, fixtures))
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function read(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(new URL(`${dir}/${file}`, fixtures), "utf8"));
}

const suites: [string, z.ZodType][] = [
  ["phone", phoneMessage],
  ["desktop", desktopMessage],
];

describe.each(suites)("%s 픽스처", (dir, schema) => {
  it.each(list(dir))("%s를 파싱하고 다시 직렬화하면 원본과 같다", (file) => {
    const original = read(dir, file);
    expect(JSON.parse(JSON.stringify(schema.parse(original)))).toEqual(original);
  });
});

it("메시지 종류마다 픽스처가 정확히 하나 있다", () => {
  const expected = [
    ...phoneMessage.options.map((o) => `phone/${o.shape.type.value}.json`),
    ...desktopMessage.options.filter((o) => o.shape.type.value !== "event").map((o) => `desktop/${o.shape.type.value}.json`),
    ...agentEvent.options.map((o) => `desktop/event.${o.shape.kind.value}.json`),
  ].sort();
  const actual = [...list("phone").map((f) => `phone/${f}`), ...list("desktop").map((f) => `desktop/${f}`)].sort();
  expect(actual).toEqual(expected);
});

it("모르는 필드가 있는 메시지는 거부한다", () => {
  expect(phoneMessage.safeParse({ type: "cancel", id: "a1", force: true }).success).toBe(false);
});

it("모르는 type은 거부한다", () => {
  expect(desktopMessage.safeParse({ type: "popup", id: "a1" }).success).toBe(false);
});
