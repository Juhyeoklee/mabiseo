import type { Connector, Json } from "../connector/connector.js";
import { freeRejections, spec, type ToolName, type ToolSpec } from "./catalog.js";

export type ToolInput = Readonly<Record<string, string | number | undefined>>;

export class Tools {
  private rejected = new Set<string>();
  private running: string | undefined;

  constructor(
    private readonly connector: Connector,
    private wingsLeft: number,
  ) {}

  get wings(): number {
    return this.wingsLeft;
  }

  async call(name: ToolName, input: ToolInput = {}): Promise<Json> {
    const tool = spec(name);
    const missing = tool.params.find((p) => p.required && input[p.name] === undefined);
    if (missing) return { error: "missing_param", message: `${name}에는 ${missing.name}이 필요하다` };

    const body = encode(tool, input);
    const key = body ? `${name} ${body}` : name;
    if (tool.kind === "query") {
      const response = await this.connector.run(name, body);
      this.rejected.clear();
      return response;
    }

    if (this.running) {
      return { error: "busy", message: `${this.running}이 끝나기 전에는 다른 맡기기를 부르지 않는다. 새 활동이 앞 활동을 취소한다` };
    }
    if (this.rejected.has(key)) {
      return { error: "repeated_rejection", message: `방금 거부된 호출이다. 조회로 상태를 확인한 뒤에 다시 부른다: ${key}` };
    }
    if (tool.wings > this.wingsLeft) {
      return { error: "wings_budget", message: `이 세션의 날개 예산이 ${this.wingsLeft}개 남아 ${name}(${tool.wings}개)을 부를 수 없다` };
    }

    this.running = key;
    try {
      const response = await this.connector.run(name, body);
      if (isRefused(response)) this.rejected.add(key);
      if (!isFree(response)) this.wingsLeft -= tool.wings;
      return response;
    } finally {
      this.running = undefined;
    }
  }
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

function field(response: Json, name: string): Json | undefined {
  return typeof response === "object" && response !== null && !Array.isArray(response) ? response[name] : undefined;
}

function isRefused(response: Json): boolean {
  return typeof field(response, "error") === "string" || field(response, "pipe") === "disconnected";
}

// 거부 모양은 시작 전과 시작 후가 같다(execute_gathering.unknown-name.json · capabilities.json의 timeout · canceled).
// 시작 전 거부로만 확인된 코드가 아니면 시작 후 끊긴 것으로 보고 쓴 것으로 센다
function isFree(response: Json): boolean {
  const error = field(response, "error");
  return field(response, "pipe") === "disconnected" || (typeof error === "string" && freeRejections.has(error));
}
