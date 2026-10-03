import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Connector, Json } from "../connector/connector.js";
import { FakeConnector } from "../connector/fake.js";
import { catalog } from "../tools/catalog.js";
import { Tools } from "../tools/tools.js";
import { allowedToolNames, shortName, toolDefinitions } from "./mcp.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));

class Counting implements Connector {
  calls: [string, string | undefined][] = [];
  constructor(private readonly inner: Connector) {}
  async run(command: string, body: string | undefined, timeoutMs: number): Promise<Json> {
    this.calls.push([command, body]);
    return this.inner.run(command, body, timeoutMs);
  }
}

async function setup(decision: boolean, wings = 10) {
  const connector = new Counting(await FakeConnector.fromDirectory(dir));
  const asked: string[] = [];
  const definitions = toolDefinitions(new Tools(connector, wings), async (name) => {
    asked.push(name);
    return decision;
  });
  const call = async (name: string, input: Record<string, string | number | undefined> = {}) => {
    const definition = definitions.find((d) => d.name === name);
    if (!definition) throw new Error(name);
    const result = await definition.handler(input, undefined);
    const block = result.content[0];
    return JSON.parse(block?.type === "text" ? block.text : "null") as Json;
  };
  return { connector, asked, definitions, call };
}

describe("카탈로그가 SDK 도구로 바뀐다", () => {
  it("27개 도구가 같은 이름과 설명으로 나오고 모델에는 mcp__mabiseo__ 접두사로 보인다", async () => {
    const { definitions } = await setup(true);
    expect(definitions.map((d) => [d.name, d.description])).toEqual(catalog.map((t) => [t.name, t.description]));
    expect(definitions).toHaveLength(27);
    expect(allowedToolNames).toContain("mcp__mabiseo__get_currencies");
    expect(shortName("mcp__mabiseo__get_currencies")).toBe("get_currencies");
  });

  it("필수 파라미터가 빠지면 스키마가 거절하고 선택 파라미터는 비워도 된다", async () => {
    const { definitions } = await setup(true);
    const gathering = z.object(definitions.find((d) => d.name === "execute_gathering")!.inputSchema);
    expect(gathering.safeParse({}).success).toBe(false);
    expect(gathering.safeParse({ displayName: "통나무" }).success).toBe(true);
    const items = z.object(definitions.find((d) => d.name === "get_items")!.inputSchema);
    expect(items.safeParse({}).success).toBe(true);
  });

  it("number 파라미터에 문자열이 오면 스키마가 거절한다", async () => {
    const { definitions } = await setup(true);
    const crafting = z.object(definitions.find((d) => d.name === "execute_crafting")!.inputSchema);
    expect(crafting.safeParse({ displayName: "거미줄", craftCount: "둘" }).success).toBe(false);
    expect(crafting.safeParse({ displayName: "거미줄", craftCount: 2 }).success).toBe(true);
  });
});

describe("승인 게이트", () => {
  it("조회 도구는 승인을 묻지 않고 커넥터 응답을 텍스트로 돌려준다", async () => {
    const { connector, asked, call } = await setup(false);
    expect(await call("get_currencies")).toEqual(await connector.run("get_currencies", undefined, 30_000));
    expect(asked).toEqual([]);
  });

  it("맡기기 도구는 승인이 거절되면 커넥터에 닿지 않고 거절을 값으로 돌려준다", async () => {
    const { connector, asked, call } = await setup(false);
    const result = await call("execute_gathering", { displayName: "통나무" });
    expect(result).toMatchObject({ error: "user_denied" });
    expect(asked).toEqual(["execute_gathering"]);
    expect(connector.calls).toEqual([]);
  });

  it("승인이 나면 커넥터에 닿는다", async () => {
    const { connector, call } = await setup(true);
    await call("execute_gathering", { displayName: "마비서없는아이템" });
    expect(connector.calls.filter(([c]) => c !== "get_currencies")).toEqual([["execute_gathering", '{"displayName":"마비서없는아이템"}']]);
  });

  it("승인이 나도 tools/의 날개 예산이 0이면 커넥터에 닿지 않는다", async () => {
    const { connector, call } = await setup(true, 0);
    expect(await call("execute_gathering", { displayName: "통나무" })).toMatchObject({ error: "wings_budget" });
    expect(connector.calls).toEqual([]);
  });
});
