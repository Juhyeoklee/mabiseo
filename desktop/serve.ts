import { randomInt } from "node:crypto";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { ask } from "./agent/host.js";
import type { FailMode } from "./connector/connector.js";
import { selectConnector, type ConnectorChoice } from "./connector/select.js";
import { advertise } from "./server/bonjour.js";
import { Server } from "./server/server.js";
import { Tools } from "./tools/tools.js";

const recordings = fileURLToPath(new URL("../recordings/", import.meta.url));
const usage = "사용법: npm run serve -- [--fail=login|offline | --real] [--wings=N] [--port=N] [--code=NNNNNN]";
const failFlags: Readonly<Record<string, FailMode>> = { "--fail=login": "login", "--fail=offline": "offline" };

interface Args {
  connector: ConnectorChoice;
  wings: number;
  port: number;
  code: string;
}

function parseArgs(argv: string[]): Args | undefined {
  let fail: FailMode | undefined;
  let real = false;
  let wings = 10;
  let port = 7470;
  let code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  for (const arg of argv) {
    const mode = failFlags[arg];
    if (mode) fail = mode;
    else if (arg === "--real") real = true;
    else if (arg.startsWith("--wings=")) wings = Number(arg.slice("--wings=".length));
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--code=")) code = arg.slice("--code=".length);
    else return undefined;
  }
  const whole = (n: number): boolean => Number.isInteger(n) && n >= 0;
  if (!whole(wings) || !whole(port) || !/^\d{6}$/.test(code) || (real && fail)) return undefined;
  return { connector: real ? { kind: "real" } : { kind: "fake", fail }, wings, port, code };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const pcName = hostname().replace(/\.local$/, "");
  const tools = new Tools(await selectConnector(args.connector, recordings), args.wings);
  const server = await Server.start({ port: args.port, code: args.code, pcName, tools, ask });
  const stopAdvertising = advertise(pcName, server.port);
  console.log(`[대기] ${pcName} · 포트 ${server.port} · 페어링 코드 ${args.code}`);

  const stop = async (): Promise<void> => {
    await stopAdvertising();
    await server.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`[오류] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
