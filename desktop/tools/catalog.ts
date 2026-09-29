export interface Param {
  name: string;
  type: "string" | "number";
  required: boolean;
  description: string;
}

export type Shape =
  | { body: "none"; params: readonly [] }
  | { body: "raw"; params: readonly [Param] }
  | { body: "json"; params: readonly Param[] };

export type ToolSpec = Shape & {
  name: string;
  kind: "query" | "execute";
  wings: 0 | 5;
  description: string;
};

const none: Shape = { body: "none", params: [] };
const raw = (what: string): Shape => ({
  body: "raw",
  params: [{ name: "filter", type: "string", required: false, description: `${what} 이름의 일부. 비우면 전부` }],
});
const json = (...params: Param[]): Shape => ({ body: "json", params });
const displayName = (from: string): Param => ({
  name: "displayName",
  type: "string",
  required: true,
  description: `${from}의 DisplayName과 정확히 같은 이름`,
});

const query = (name: string, description: string, shape: Shape = none): ToolSpec => ({
  name,
  kind: "query",
  wings: 0,
  description,
  ...shape,
});

const execute = (name: string, wings: 0 | 5, description: string, shape: Shape = none): ToolSpec => ({
  name,
  kind: "execute",
  wings,
  description,
  ...shape,
});

// 날개 5개는 recordings/capabilities.json의 Note에 「consumes 5 정령의 날개」라고 적힌 세 명령뿐이다
export const catalog = [
  query("capabilities", "CLI 명령 목록과 각 명령의 설명"),
  query("get_current_environment", "현재 위치 · 날씨 · 에린 시간 · 하우징 상태"),
  query("get_activity", "지금 하고 있는 행동"),
  query("get_my_info", "캐릭터 상태와 능력치"),
  query("get_quests", "진행 중인 퀘스트"),
  query("get_currencies", "재화. 정령의 날개 잔량도 여기"),
  query("get_near_npcs", "주변 NPC"),
  query("get_near_pcs", "주변 플레이어"),
  query("get_inventory", "가방 무게와 한도"),
  query("get_music_scores", "가진 악보"),
  query("get_instruments", "가진 악기"),
  query(
    "get_items",
    "가진 소모품 · 재료 · 음식과 개수",
    json(
      { name: "category", type: "string", required: false, description: "영문 Category 값의 일부. 예: Ingredient" },
      { name: "name", type: "string", required: false, description: "이름의 일부" },
    ),
  ),
  query("get_social_actions", "행동 · 표정 명령 목록"),
  query("get_daily_missions", "일일 미션"),
  query("get_weekly_missions", "주간 미션"),
  query("get_gatherable_items", "지금 채집할 수 있는 것과 도구 상태", raw("채집물")),
  query("get_alterable_items", "지금 가공 등록할 수 있는 것", raw("가공물")),
  query("get_altering_works", "등록한 가공의 남은 시간과 완료 여부"),
  query("get_craftable_items", "지금 제작할 수 있는 것", raw("제작물")),
  execute(
    "play_music_score",
    0,
    "악보 연주 시작",
    json({ name: "title", type: "string", required: true, description: "get_music_scores의 DisplayTitle" }),
  ),
  execute(
    "change_instrument",
    0,
    "악기 장착",
    json({ name: "name", type: "string", required: true, description: "get_instruments의 Name" }),
  ),
  execute("stop_action", 0, "진행 중인 행동 중단. 연주 · 채집 · 자동 낚시 · 운반"),
  execute("stand_up", 0, "앉기에서 일어나기"),
  execute("execute_gathering", 5, "이름의 것을 최대 100개 채집. 낚시 전용이면 자동 낚시 시작", json(displayName("get_gatherable_items"))),
  execute("execute_altering", 5, "가공 하나를 시설에 등록. 결과는 get_altering_works로 확인", json(displayName("get_alterable_items"))),
  execute("complete_altering_work", 0, "그 시설의 완료된 가공을 전부 수령", json(displayName("get_altering_works"))),
  execute(
    "execute_crafting",
    5,
    "제작. craftCount는 제작 횟수이지 산출 개수가 아니다",
    json(displayName("get_craftable_items"), {
      name: "craftCount",
      type: "number",
      required: false,
      description: "제작 횟수. 기본 1",
    }),
  ),
] as const satisfies readonly ToolSpec[];

export type ToolName = (typeof catalog)[number]["name"];

export function spec(name: ToolName): ToolSpec {
  return catalog.find((t) => t.name === name) as ToolSpec;
}

// 날개는 「rejected before starting」에서만 안 나간다(recordings/capabilities.json). 아래는 세 명령의 시작 전 거부 목록에만 있고
// 시작 후 오류 목록에는 없는 코드다. blocked · overweight · tool_broken · facility_not_found는 양쪽에 다 나와서 넣지 않는다
export const freeRejections: ReadonlySet<string> = new Set([
  "not_in_game",
  "not_enough_currency",
  "cost_payment_failed",
  "not_found",
  "no_route",
  "not_in_field",
  "not_available",
  "requires_user_interaction",
  "crafting_locked",
  "invalid_count",
  "insufficient_living_skill_level",
  "insufficient_facility_level",
  "insufficient_decor_score",
  "insufficient_transfer_cost",
  "not_enough_ingredient",
  "ingredient_locked",
  "tool_missing",
  "required_consumable_missing",
]);
