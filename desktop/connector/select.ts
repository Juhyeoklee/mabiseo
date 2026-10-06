import type { Connector, FailMode } from "./connector.js";
import { FakeConnector } from "./fake.js";
import { defaultCliPath, RealConnector } from "./real.js";
import { TracingConnector } from "./trace.js";
import { Workshop } from "./workshop.js";

export type ConnectorChoice = { kind: "fake"; fail: FailMode | undefined } | { kind: "workshop" } | { kind: "real" };

const workshopStock = { "철 광석": 12 };
const workshopWings = 1000;

export function chooseConnector(flags: { real: boolean; workshop: boolean; fail: FailMode | undefined }): ConnectorChoice | undefined {
  if ([flags.real, flags.workshop, flags.fail !== undefined].filter(Boolean).length > 1) return undefined;
  if (flags.real) return { kind: "real" };
  if (flags.workshop) return { kind: "workshop" };
  return { kind: "fake", fail: flags.fail };
}

export async function selectConnector(choice: ConnectorChoice, recordingsDir: string, traceDir?: string): Promise<Connector> {
  const connector = await pick(choice, recordingsDir);
  return traceDir ? new TracingConnector(connector, traceDir) : connector;
}

async function pick(choice: ConnectorChoice, recordingsDir: string): Promise<Connector> {
  if (choice.kind === "fake") return FakeConnector.fromDirectory(recordingsDir, choice.fail);
  if (choice.kind === "workshop") return new Workshop(await FakeConnector.fromDirectory(recordingsDir), workshopStock, workshopWings);
  if (process.platform !== "win32") throw new Error("실물 커넥터는 Windows에서만 켜진다");
  return new RealConnector(defaultCliPath);
}
