import { describe, expect, it } from "vitest";
import { allowedToolNames, shortName } from "./mcp.js";

describe("Claude에는 도구가 MCP 이름으로 보인다", () => {
  it("카탈로그와 계획 도구 30개가 mcp__mabiseo__ 접두사로 허용되고 이벤트에는 접두사 없는 이름이 나간다", () => {
    expect(allowedToolNames).toHaveLength(30);
    expect(allowedToolNames).toContain("mcp__mabiseo__get_currencies");
    expect(allowedToolNames).toContain("mcp__mabiseo__propose_plan");
    expect(allowedToolNames).toContain("mcp__mabiseo__plan_production");
    expect(shortName("mcp__mabiseo__get_currencies")).toBe("get_currencies");
  });
});
