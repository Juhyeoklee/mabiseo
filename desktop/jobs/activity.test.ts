import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Json } from "../connector/connector.js";
import { readJson } from "../connector/recordings.js";
import { isActive } from "./activity.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));

type Recorded = { [key: string]: Json } & {
  Mode: { [key: string]: Json };
  Performance: { [key: string]: Json };
};

async function recordedIdle(): Promise<Recorded> {
  return (await readJson(dir, "get_activity.json")) as Recorded;
}

describe("활동 판정", () => {
  it("녹화된 idle 상태는 활동이 아니다", async () => {
    expect(isActive(await recordedIdle())).toBe(false);
  });

  it("Stop · Fishing · FishingPull 버튼이 보이거나 연주 중이면 활동이다", async () => {
    for (const button of ["Stop", "Fishing", "FishingPull"]) {
      const state = await recordedIdle();
      state.Mode.MainButtonState = button;
      expect(isActive(state), button).toBe(true);
    }
    const playing = await recordedIdle();
    playing.Performance.IsPlaying = true;
    expect(isActive(playing)).toBe(true);
  });

  it("실물 채집은 이동 중과 채집 중이 활동이고 끝난 직후는 아니다", async () => {
    expect(isActive(await readJson(dir, "gathering/get_activity.json"))).toBe(true);
    expect(isActive(await readJson(dir, "gathering/get_activity.at-spot.json"))).toBe(true);
    expect(isActive(await readJson(dir, "gathering/get_activity.done.json"))).toBe(false);
  });

  it("끊김 값과 거부 값은 활동이 아니다", () => {
    expect(isActive({ pipe: "disconnected", reason: "game_off" })).toBe(false);
    expect(isActive({ error: "not_in_game", message: "" })).toBe(false);
    expect(isActive(null)).toBe(false);
    expect(isActive([])).toBe(false);
  });
});
