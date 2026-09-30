import type { Connector, FailMode } from "./connector.js";
import { FakeConnector } from "./fake.js";
import { defaultCliPath, RealConnector } from "./real.js";

export type ConnectorChoice = { kind: "fake"; fail: FailMode | undefined } | { kind: "real" };

export async function selectConnector(choice: ConnectorChoice, recordingsDir: string): Promise<Connector> {
  if (choice.kind === "fake") return FakeConnector.fromDirectory(recordingsDir, choice.fail);
  if (process.platform !== "win32") throw new Error("실물 커넥터는 Windows에서만 켜진다");
  return new RealConnector(defaultCliPath);
}
