import type { Connector, Json } from "../connector/connector.js";
import { Jobs, type Listener, type Progress } from "../jobs/jobs.js";
import { afterStartRejections, freeRejections, spec, type ToolName, type ToolSpec } from "./catalog.js";

export type ToolInput = Readonly<Record<string, string | number | undefined>>;

// 조회는 호출당 약 0.1초, 게임이 꺼져 있으면 약 5초 뒤 스스로 끝난다(recordings/index.tsv · recordings/game-off/index.tsv)
const queryTimeoutMs = 30_000;

// 맡기기는 CLI가 이동 · 작업 · 보상 수령까지 끝날 때까지 블록한다(recordings/capabilities.json의 Note). 채집 100개는 2~15분(공지 3541579)
const executeTimeoutMs = 30 * 60_000;

const progressIntervalMs = 20_000;

// 시설마다 7칸이고 수령 안 한 완료 건도 칸을 차지한다. 가득 찬 등록은 막히고도 날개 5가 빠진다(recordings/queue-full/)
export const queueSlots = 7;

const waitTimeoutMs = 60 * 60_000;

// 시작 전 거부는 0.1초 안에, 게임이 꺼져 있어도 약 5초 안에 돌아온다(recordings/reviving/index.tsv · recordings/game-off/index.tsv)
const quickRefusalMs = 10_000;

export class Tools {
  private rejected = new Set<string>();
  private readonly jobs: Jobs;
  private readonly listeners = new Set<Listener>();
  private readonly waits = new Set<AbortController>();

  constructor(
    private readonly connector: Connector,
    private wingsLeft: number,
  ) {
    this.jobs = new Jobs({
      // 폴링을 call로 돌리면 조회가 재거부 차단을 풀어 주기마다 같은 거부 호출이 다시 통한다
      poll: () => connector.run("get_activity", undefined, queryTimeoutMs),
      started: (response) => !isRefused(response),
      intervalMs: progressIntervalMs,
    });
  }

  get wings(): number {
    return this.wingsLeft;
  }

  watch(listener: Listener): () => void {
    const unwatch = this.jobs.watch(listener);
    this.listeners.add(listener);
    return () => {
      unwatch();
      this.listeners.delete(listener);
    };
  }

  async cancel(): Promise<Json | undefined> {
    for (const wait of this.waits) wait.abort();
    if (!this.jobs.current) return undefined;
    return this.call("stop_action");
  }

  async call(name: ToolName, input: ToolInput = {}): Promise<Json> {
    const tool = spec(name);
    const missing = tool.params.find((p) => p.required && input[p.name] === undefined);
    if (missing) return { error: "missing_param", message: `${name}에는 ${missing.name}이 필요하다` };

    if (tool.kind === "wait") return this.waitAltering(String(input.displayName));

    const body = encode(tool, input);
    const key = body ? `${name} ${body}` : name;
    if (tool.kind === "query") {
      const response = await this.connector.run(name, body, queryTimeoutMs);
      this.rejected.clear();
      return response;
    }
    if (!tool.repeat) return this.execute(name, tool, input, body, key);

    const times = input[tool.repeat.name] ?? 1;
    if (typeof times !== "number" || !Number.isInteger(times) || times < 1 || times > queueSlots) {
      return { error: "invalid_count", message: `${tool.repeat.name}는 1부터 ${queueSlots}까지의 정수다` };
    }
    let registered = 0;
    let last: Json = null;
    while (registered < times) {
      last = await this.execute(name, tool, input, body, key);
      if (isRefused(last)) break;
      registered += 1;
    }
    return { registered, requested: times, last };
  }

  private async execute(name: ToolName, tool: ToolSpec, input: ToolInput, body: string | undefined, key: string): Promise<Json> {
    const current = this.jobs.current;
    if (current && name !== "stop_action") {
      return { error: "busy", message: `${current.name}이 끝나기 전에는 다른 맡기기를 부르지 않는다. 새 활동이 앞 활동을 취소한다` };
    }
    if (this.rejected.has(key)) {
      return { error: "repeated_rejection", message: `방금 거부된 호출이다. 조회로 상태를 확인한 뒤에 다시 부른다: ${key}` };
    }
    if (tool.wings > this.wingsLeft) {
      return { error: "wings_budget", message: `이 세션의 날개 예산이 ${this.wingsLeft}개 남아 ${name}(${tool.wings}개)을 부를 수 없다` };
    }

    let response: Json;
    let guarded: Json | undefined;
    if (name === "stop_action") {
      response = await this.connector.run(name, body, executeTimeoutMs);
      await this.jobs.recheck();
    } else {
      // 대기열 · 날개 조회와 차감은 jobs가 활동을 붙든 동안에 끝낸다. 붙들기 밖에서 기다리면 그 틈에 다른 맡기기가 busy · 칸 · 예산 검사를 옛 값으로 지난다
      response = await this.jobs.run(name, async () => {
        guarded = name === "execute_altering" ? await this.queueFull(String(input.displayName)) : undefined;
        if (guarded !== undefined) return guarded;
        const before = tool.wings > 0 ? await this.wingsInGame() : undefined;
        const calledAt = Date.now();
        const result = await this.connector.run(name, body, executeTimeoutMs);
        if (tool.wings > 0) this.wingsLeft -= await this.spent(tool, result, before, Date.now() - calledAt);
        return result;
      });
    }
    // 대기열 거절은 CLI에 닿지 않고 매번 새로 센다. 차단에 넣으면 수령한 뒤의 재등록이 막힌다
    if (isRefused(response) && guarded === undefined) this.rejected.add(key);
    return response;
  }

  // 가공 대기열은 캐릭터의 활동이 아니다. jobs로 붙들면 기다리는 동안의 채집이 busy로 막힌다
  private async waitAltering(displayName: string): Promise<Json> {
    const startedAt = Date.now();
    const waiting = new AbortController();
    this.waits.add(waiting);
    try {
      for (;;) {
        const works = await this.connector.run("get_altering_works", undefined, queryTimeoutMs);
        this.rejected.clear();
        if (isRefused(works)) return works;
        const remaining = remainingSeconds(works, displayName);
        if (remaining === undefined) return { completed: true, works };
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= waitTimeoutMs || waiting.signal.aborted) return { completed: false, works };
        const progress: Progress = { activity: "wait_altering", elapsedSeconds: Math.round(elapsedMs / 1000) };
        for (const listener of [...this.listeners]) listener(progress);
        await sleep(Math.min(Math.max(remaining * 1000, 1000), progressIntervalMs, waitTimeoutMs - elapsedMs), waiting.signal);
      }
    } finally {
      this.waits.delete(waiting);
    }
  }

  // get_alterable_items에는 시설이 없어서(recordings/get_alterable_items.json) 대기열에 같은 가공이 있을 때만 시설을 안다. 없으면 막지 않는다
  private async queueFull(displayName: string): Promise<Json | undefined> {
    const works = await this.connector.run("get_altering_works", undefined, queryTimeoutMs);
    if (isRefused(works)) return works;
    const list = field(works, "works");
    if (!Array.isArray(list)) return undefined;
    const same = list.find((w) => field(w, "DisplayName") === displayName);
    const facilityName = same === undefined ? undefined : field(same, "FacilityName");
    if (typeof facilityName !== "string") return undefined;
    if (list.filter((w) => field(w, "FacilityName") === facilityName).length < queueSlots) return undefined;
    return {
      error: "queue_full",
      message: `${facilityName}의 ${queueSlots}칸이 다 찼다. complete_altering_work로 완료분을 수령해 칸을 비운 뒤에 등록한다`,
    };
  }

  // blocked처럼 시작 전과 후 양쪽에 나오는 거부는 코드만으로 못 가른다(recordings/reviving/execute_gathering.json은 시작 전 거부였다).
  // 오래 걸린 호출의 전후 차이는 믿지 않는다. 그 사이 날개가 늘면 쓴 양이 가려진다. 근거가 없으면 쓴 것으로 센다. 덜 세는 쪽이 예산을 뚫는다
  private async spent(tool: ToolSpec, response: Json, before: number | undefined, elapsedMs: number): Promise<number> {
    const stated = statedCost(response);
    if (stated !== undefined) return stated;
    if (isFree(response)) return 0;
    if (!isRefused(response) || isAfterStart(response) || elapsedMs > quickRefusalMs || before === undefined) return tool.wings;
    const after = await this.wingsInGame();
    return after === undefined ? tool.wings : Math.max(0, before - after);
  }

  // call로 돌리면 조회가 재거부 차단을 푼다
  private async wingsInGame(): Promise<number | undefined> {
    try {
      const currencies = await this.connector.run("get_currencies", undefined, queryTimeoutMs);
      if (!Array.isArray(currencies)) return undefined;
      const amount = currencies.map((c) => (field(c, "DisplayName") === wingsName ? field(c, "Amount") : undefined)).find((a) => a !== undefined);
      return typeof amount === "number" ? amount : undefined;
    } catch {
      return undefined;
    }
  }
}

const wingsName = "정령의 날개";
const statedCostPattern = new RegExp(`${wingsName} (\\d+) spent`);

function statedCost(response: Json): number | undefined {
  const cost = field(response, "cost");
  const match = typeof cost === "string" ? statedCostPattern.exec(cost) : null;
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function remainingSeconds(works: Json, displayName: string): number | undefined {
  const list = field(works, "works");
  if (!Array.isArray(list)) return undefined;
  const pending = list.filter((w) => field(w, "DisplayName") === displayName && field(w, "IsCompleted") !== true);
  if (!pending.length) return undefined;
  return Math.max(...pending.map((w) => {
    const seconds = field(w, "RemainingSeconds");
    return typeof seconds === "number" ? seconds : 0;
  }));
}

function encode(tool: ToolSpec, input: ToolInput): string | undefined {
  if (tool.body === "none") return undefined;
  if (tool.body === "raw") {
    const value = input[tool.params[0].name];
    return value === undefined || value === "" ? undefined : String(value);
  }
  const given: Record<string, string | number> = {};
  for (const p of tool.params) {
    const value = input[p.name];
    if (value !== undefined) given[p.name] = value;
  }
  return Object.keys(given).length ? JSON.stringify(given) : undefined;
}

export function field(response: Json, name: string): Json | undefined {
  return typeof response === "object" && response !== null && !Array.isArray(response) ? response[name] : undefined;
}

export function isRefused(response: unknown): boolean {
  if (typeof response !== "object" || response === null) return false;
  return ("error" in response && typeof response.error === "string") || ("pipe" in response && response.pipe === "disconnected");
}

// 거부 모양은 시작 전과 시작 후가 같다(execute_gathering.unknown-name.json · capabilities.json의 timeout · canceled).
// 시작 전 거부로만 확인된 코드가 아니면 시작 후 끊긴 것으로 보고 쓴 것으로 센다
function isAfterStart(response: Json): boolean {
  const error = field(response, "error");
  return typeof error === "string" && afterStartRejections.has(error);
}

function isFree(response: Json): boolean {
  const error = field(response, "error");
  return field(response, "pipe") === "disconnected" || (typeof error === "string" && freeRejections.has(error));
}
