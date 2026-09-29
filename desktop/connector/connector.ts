export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type FailMode = "offline";

export interface Connector {
  run(command: string, body?: string): Promise<Json>;
}
