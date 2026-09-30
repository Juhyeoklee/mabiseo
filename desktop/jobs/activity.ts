import type { Json } from "../connector/connector.js";

// 중단할 수 있는 행동은 게임의 중단 버튼이 보이는 동안이고 그때 MainButtonState가 Stop이다.
// 낚시는 Fishing · FishingPull, 연주는 Performance.IsPlaying으로 드러난다.
// 출처: capabilities.json의 활동 조회 출력 예와 행동 중단 명령의 Note.
// 앉기는 SitState에 안 잡히고 행동 중단 대상도 아니라 활동으로 치지 않는다(capabilities.json의 일어서기 명령 Note).
// TODO(#17): 활동 중 상태의 실측 녹화가 없다. 실물에서 확인한다.
const activeButtons: readonly string[] = ["Stop", "Fishing", "FishingPull"];

export function isActive(activity: Json): boolean {
  if (!isObject(activity)) return false;
  const mode = activity.Mode;
  const performance = activity.Performance;
  const button = isObject(mode) ? mode.MainButtonState : undefined;
  if (typeof button === "string" && activeButtons.includes(button)) return true;
  return isObject(performance) && performance.IsPlaying === true;
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
