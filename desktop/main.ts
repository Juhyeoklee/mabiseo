import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { AgentEvent, Session, Usage } from "./agent/agent.js";
import { make } from "./agent/make.js";
import { providerFlags, selectAgents, type Provider, type Tiers } from "./agent/select.js";
import type { FailMode } from "./connector/connector.js";
import { chooseConnector, selectConnector, workshopFlags, type ConnectorChoice } from "./connector/select.js";
import { Tools } from "./tools/tools.js";

const recordings = fileURLToPath(new URL("../recordings/", import.meta.url));
const usage = '사용법: npm run ask -- [--provider=openai|claude] [--fail=login|offline | --workshop[=fast] | --real] [--wings=N] "할 일" | --make 품목 개수';
const failFlags: Readonly<Record<string, FailMode>> = { "--fail=login": "login", "--fail=offline": "offline" };

interface Args {
  work: (agents: Tiers, session: Session) => Promise<void>;
  connector: ConnectorChoice;
  wings: number;
  provider: Provider;
}

function parseArgs(argv: string[]): Args | undefined {
  let fail: FailMode | undefined;
  let real = false;
  let workshop: number | undefined;
  let wings = 10;
  let provider: Provider = "openai";
  let making = false;
  const words: string[] = [];
  for (const arg of argv) {
    const mode = failFlags[arg];
    if (mode) fail = mode;
    else if (providerFlags[arg]) provider = providerFlags[arg];
    else if (arg === "--real") real = true;
    else if (workshopFlags[arg] !== undefined) workshop = workshopFlags[arg];
    else if (arg === "--make") making = true;
    else if (arg.startsWith("--wings=")) wings = Number(arg.slice("--wings=".length));
    else if (arg.startsWith("--")) return undefined;
    else words.push(arg);
  }
  const connector = chooseConnector({ real, workshop, fail });
  if (!words.length || !Number.isInteger(wings) || wings < 0 || !connector) return undefined;
  if (!making) return { work: (agents, session) => agents.mid.ask(words.join(" "), session), connector, wings, provider };
  const count = Number(words.at(-1));
  const item = words.slice(0, -1).join(" ");
  if (!item || !Number.isInteger(count) || count < 1) return undefined;
  return { work: (agents, session) => make(item, count, session, agents), connector, wings, provider };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const { work, connector, wings, provider } = args;

  const tools = new Tools(await selectConnector(connector, recordings), wings);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const used: Usage = { input: 0, cached: 0, output: 0 };
    await work(selectAgents(provider), {
      tools,
      approve: async (name, input) => {
        try {
          const answer = await rl.question(`승인? ${name} ${JSON.stringify(input)} [y/N] `);
          return answer.trim().toLowerCase() === "y";
        } catch {
          return false;
        }
      },
      onEvent: print,
      onUsage: (turn) => {
        used.input += turn.input;
        used.cached += turn.cached;
        used.output += turn.output;
        console.log(`[토큰] 입력 ${turn.input} (캐시 ${turn.cached}) · 출력 ${turn.output} · 누적 입력 ${used.input} (캐시 ${used.cached}) · 출력 ${used.output}`);
      },
    });
  } finally {
    rl.close();
  }
}

function print(event: AgentEvent): void {
  switch (event.kind) {
    case "started":
      console.log(`[모델] ${event.model}`);
      break;
    case "text":
      console.log(event.text);
      break;
    case "tool":
      console.log(`[도구] ${event.name} ${JSON.stringify(event.input)}`);
      break;
    case "tool_result":
      console.log(`[결과] ${event.text}`);
      break;
    case "progress":
      console.log(`[진행] ${event.activity} · ${event.elapsedSeconds}초`);
      break;
    case "plan_step":
      console.log(`[계획] ${event.done}단계 마침 · 약 ${event.remainingSeconds}초 남음`);
      break;
    case "done":
      console.log(`[끝] ${event.turns}턴 · $${event.costUsd.toFixed(4)}`);
      break;
    case "failed":
      console.log(`[실패] ${event.reason}`);
      process.exitCode = 1;
      break;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`[오류] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
