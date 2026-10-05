import { randomInt } from "node:crypto";
import { hostname } from "node:os";
import { ask } from "./agent/host.js";
import type { FailMode } from "./connector/connector.js";
import { selectConnector, type ConnectorChoice } from "./connector/select.js";
import { advertise } from "./server/bonjour.js";
import { Server, type Report } from "./server/server.js";
import { Tools } from "./tools/tools.js";

export const usage = "사용법: npm run serve|app -- [--fail=login|offline | --real] [--wings=N] [--port=N] [--code=NNNNNN] [--trace=DIR]";
const failFlags: Readonly<Record<string, FailMode>> = { "--fail=login": "login", "--fail=offline": "offline" };

export interface Args {
  connector: ConnectorChoice;
  wings: number;
  port: number;
  code: string;
  trace: string | undefined;
}

export function parseArgs(argv: string[]): Args | undefined {
  let fail: FailMode | undefined;
  let real = false;
  let wings = 10;
  let port = 7470;
  let code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  let trace: string | undefined;
  for (const arg of argv) {
    const mode = failFlags[arg];
    if (mode) fail = mode;
    else if (arg === "--real") real = true;
    else if (arg.startsWith("--wings=")) wings = Number(arg.slice("--wings=".length));
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--code=")) code = arg.slice("--code=".length);
    else if (arg.startsWith("--trace=")) trace = arg.slice("--trace=".length) || undefined;
    else return undefined;
  }
  const whole = (n: number): boolean => Number.isInteger(n) && n >= 0;
  if (!whole(wings) || !whole(port) || !/^\d{6}$/.test(code) || (real && fail)) return undefined;
  return { connector: real ? { kind: "real" } : { kind: "fake", fail }, wings, port, code, trace };
}

export interface Started {
  server: Server;
  pcName: string;
  stop(): Promise<void>;
}

export async function start(args: Args, recordings: string, report: Report): Promise<Started> {
  const pcName = hostname().replace(/\.local$/, "");
  const tools = new Tools(await selectConnector(args.connector, recordings, args.trace), args.wings);
  const server = await Server.start({ port: args.port, code: args.code, pcName, tools, ask, report });
  const stopAdvertising = advertise(pcName, server.port);
  return {
    server,
    pcName,
    stop: async () => {
      await stopAdvertising();
      await server.close();
    },
  };
}
