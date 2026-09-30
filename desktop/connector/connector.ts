export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type FailMode = "login" | "offline";

export interface Connector {
  run(command: string, body: string | undefined, timeoutMs: number): Promise<Json>;
}
