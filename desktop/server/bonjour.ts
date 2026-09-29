import { Bonjour } from "bonjour-service";

export const serviceType = "mabiseo";

export function advertise(pcName: string, port: number): () => Promise<void> {
  const bonjour = new Bonjour();
  bonjour.publish({ name: pcName, type: serviceType, port });
  return () => new Promise((resolve) => bonjour.unpublishAll(() => bonjour.destroy(resolve)));
}
