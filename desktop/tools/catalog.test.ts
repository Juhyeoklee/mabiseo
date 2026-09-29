import { describe, expect, it } from "vitest";
import { catalog } from "./catalog.js";

describe("도구 목록", () => {
  it("조회 19개와 맡기기 8개다", () => {
    expect(catalog.filter((t) => t.kind === "query")).toHaveLength(19);
    expect(catalog.filter((t) => t.kind === "execute")).toHaveLength(8);
  });

  it("채팅은 도구가 아니다. 승인 없이 즉시 전송되기 때문이다", () => {
    expect(catalog.map((t) => t.name)).not.toContain("write_chat");
  });

  it("날개를 쓰는 도구는 채집 · 가공 등록 · 제작 셋이고 호출당 5개다", () => {
    const wings = catalog.filter((t) => t.wings > 0).map((t) => [t.name, t.wings]);
    expect(wings).toEqual([
      ["execute_gathering", 5],
      ["execute_altering", 5],
      ["execute_crafting", 5],
    ]);
  });

  it("조회 도구는 날개를 쓰지 않는다", () => {
    expect(catalog.filter((t) => t.kind === "query").every((t) => t.wings === 0)).toBe(true);
  });

  it("이름이 겹치지 않는다", () => {
    expect(new Set(catalog.map((t) => t.name)).size).toBe(catalog.length);
  });
});
