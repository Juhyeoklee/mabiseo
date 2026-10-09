import type { Connector, FailMode } from "./connector.js";
import { FakeConnector } from "./fake.js";
import { defaultCliPath, RealConnector } from "./real.js";
import { TracingConnector } from "./trace.js";
import { Workshop } from "./workshop.js";

export type ConnectorChoice = { kind: "fake"; fail: FailMode | undefined } | { kind: "workshop"; speed: number } | { kind: "real" };

const workshopStock = { "철 광석": 12 };
const workshopWings = 1000;

export const workshopFlags: Readonly<Record<string, number>> = { "--workshop": 1, "--workshop=fast": 60 };

export function chooseConnector(flags: { real: boolean; workshop: number | undefined; fail: FailMode | undefined }): ConnectorChoice | undefined {
  if ([flags.real, flags.workshop !== undefined, flags.fail !== undefined].filter(Boolean).length > 1) return undefined;
  if (flags.real) return { kind: "real" };
  if (flags.workshop !== undefined) return { kind: "workshop", speed: flags.workshop };
  return { kind: "fake", fail: flags.fail };
}

export async function selectConnector(choice: ConnectorChoice, recordingsDir: string, traceDir?: string): Promise<Connector> {
  const connector = await pick(choice, recordingsDir);
  return traceDir ? new TracingConnector(connector, traceDir) : connector;
}

function clock(speed: number): () => number {
  const start = Date.now();
  return () => start + (Date.now() - start) * speed;
}

async function pick(choice: ConnectorChoice, recordingsDir: string): Promise<Connector> {
  if (choice.kind === "fake") return FakeConnector.fromDirectory(recordingsDir, choice.fail);
  if (choice.kind === "workshop") return new Workshop(await FakeConnector.fromDirectory(recordingsDir), workshopStock, workshopWings, clock(choice.speed));
  if (process.platform !== "win32") throw new Error("실물 커넥터는 Windows에서만 켜진다");
  return new RealConnector(defaultCliPath);
}
