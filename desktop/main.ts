import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ask, type AgentEvent } from "./agent/host.js";
import type { FailMode } from "./connector/connector.js";
import { chooseConnector, selectConnector, type ConnectorChoice } from "./connector/select.js";
import { Tools } from "./tools/tools.js";

const recordings = fileURLToPath(new URL("../recordings/", import.meta.url));
const usage = '사용법: npm run ask -- [--fail=login|offline | --workshop | --real] [--wings=N] "할 일"';
const failFlags: Readonly<Record<string, FailMode>> = { "--fail=login": "login", "--fail=offline": "offline" };

interface Args {
  prompt: string;
  connector: ConnectorChoice;
  wings: number;
}

function parseArgs(argv: string[]): Args | undefined {
  let fail: FailMode | undefined;
  let real = false;
  let workshop = false;
  let wings = 10;
  const words: string[] = [];
  for (const arg of argv) {
    const mode = failFlags[arg];
    if (mode) fail = mode;
    else if (arg === "--real") real = true;
    else if (arg === "--workshop") workshop = true;
    else if (arg.startsWith("--wings=")) wings = Number(arg.slice("--wings=".length));
    else if (arg.startsWith("--")) return undefined;
    else words.push(arg);
  }
  const connector = chooseConnector({ real, workshop, fail });
  if (!words.length || !Number.isInteger(wings) || wings < 0 || !connector) return undefined;
  return { prompt: words.join(" "), connector, wings };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const { prompt, connector, wings } = args;

  const tools = new Tools(await selectConnector(connector, recordings), wings);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await ask(prompt, {
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
