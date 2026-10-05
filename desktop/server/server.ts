import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { agentEvent, desktopMessage, phoneMessage, type ConnectorState, type DesktopMessage, type PhoneMessage } from "../../protocol/messages.js";
import type { ask as hostAsk, AgentEvent } from "../agent/host.js";
import type { Json } from "../connector/connector.js";
import { spec, type ToolName } from "../tools/catalog.js";
import type { ToolInput, Tools } from "../tools/tools.js";

export type Ask = typeof hostAsk;

export interface ServerOptions {
  port: number;
  code: string;
  pcName: string;
  tools: Tools;
  ask: Ask;
}

interface Run {
  id: string;
  abort: AbortController;
  events: AgentEvent[];
}

interface Approval {
  run: Run;
  request: DesktopMessage;
  resolve: (allow: boolean) => void;
}

const policyViolation = 1008;

export class Server {
  static async start(options: ServerOptions): Promise<Server> {
    const wss = new WebSocketServer({ port: options.port });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    return new Server(wss, options, await status(options.tools));
  }

  private readonly paired = new Set<WebSocket>();
  private readonly approvals = new Map<string, Approval>();
  private run: Run | undefined;
  private last: Run | undefined;

  private constructor(
    private readonly wss: WebSocketServer,
    private readonly options: ServerOptions,
    private lastStatus: DesktopMessage,
  ) {
    wss.on("connection", (socket) => {
      socket.on("message", (data) => void this.receive(socket, data.toString()));
      socket.on("close", () => this.forget(socket));
    });
  }

  get port(): number {
    const address = this.wss.address();
    return typeof address === "object" && address !== null ? address.port : this.options.port;
  }

  async close(): Promise<void> {
    if (this.run) this.cancel(this.run);
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve, reject) => this.wss.close((error) => (error ? reject(error) : resolve())));
  }

  private async receive(socket: WebSocket, raw: string): Promise<void> {
    const message = decode(raw);
    if (!message) return socket.close(policyViolation);
    if (message.type === "pair") return this.pair(socket, message.code);
    if (!this.paired.has(socket)) return socket.close(policyViolation);
    switch (message.type) {
      case "ask":
        return this.ask(socket, message.id, message.text);
      case "approve":
        return this.approvals.get(message.id)?.resolve(message.allow);
      case "cancel":
        if (this.run?.id === message.id) {
          this.cancel(this.run);
          this.stopActivity();
        }
        return;
    }
  }

  private async pair(socket: WebSocket, code: string): Promise<void> {
    if (code !== this.options.code) return send(socket, { type: "pair_failed", reason: "wrong_code" });
    const status = this.run ? this.lastStatus : await this.refreshStatus();
    if (socket.readyState !== WebSocket.OPEN) return;
    // 여기서 다시 보내기까지 await를 넣지 않는다. 사이에 실시간 event가 끼면 폰이 높은 seq를 먼저 받아 다시 보낸 낮은 seq를 버린다
    this.paired.add(socket);
    send(socket, { type: "paired", pcName: this.options.pcName });
    send(socket, status);
    const last = this.last;
    last?.events.forEach((event, seq) => send(socket, eventMessage(last.id, seq, event)));
    for (const approval of this.approvals.values()) if (approval.run === this.run) send(socket, approval.request);
  }

  private async ask(socket: WebSocket, id: string, text: string): Promise<void> {
    if (this.run) return send(socket, eventMessage(id, 0, { kind: "failed", reason: "busy" }));
    const run: Run = { id, abort: new AbortController(), events: [] };
    this.run = this.last = run;
    let ended = false;
    const emit = (event: AgentEvent): void => {
      if (ended) return;
      const cancelled = event.kind === "failed" && run.abort.signal.aborted;
      ended = event.kind === "done" || event.kind === "failed";
      const recorded: AgentEvent = cancelled ? { kind: "failed", reason: "cancelled" } : event;
      run.events.push(recorded);
      this.broadcast(eventMessage(id, run.events.length - 1, recorded));
    };
    try {
      await this.options.ask(text, {
        tools: this.options.tools,
        approve: (name, input) => this.approve(run, name, input),
        onEvent: emit,
        abort: run.abort,
      });
      if (!ended) emit({ kind: "failed", reason: run.abort.signal.aborted ? "cancelled" : "ended_without_result" });
    } catch (error) {
      if (!ended) emit({ kind: "failed", reason: run.abort.signal.aborted ? "cancelled" : errorMessage(error) });
    } finally {
      this.releaseApprovals(run);
    }
    const status = await this.refreshStatus();
    this.run = undefined;
    this.broadcast(status);
  }

  private approve(run: Run, name: ToolName, input: ToolInput): Promise<boolean> {
    if (run.abort.signal.aborted) return Promise.resolve(false);
    const id = randomUUID();
    const request: DesktopMessage = { type: "approval_request", id, askId: run.id, tool: name, input: definedFields(input), wings: spec(name).wings };
    return new Promise((resolve) => {
      this.approvals.set(id, {
        run,
        request,
        resolve: (allow) => {
          this.approvals.delete(id);
          resolve(allow);
        },
      });
      this.broadcast(request);
    });
  }

  private broadcast(message: DesktopMessage): void {
    for (const socket of this.paired) send(socket, message);
  }

  private cancel(run: Run): void {
    run.abort.abort();
    this.releaseApprovals(run);
  }

  private stopActivity(): void {
    void this.options.tools.cancel().catch((error) => console.error(`[중단] 활동 중단 실패: ${errorMessage(error)}`));
  }

  private releaseApprovals(run: Run): void {
    for (const approval of this.approvals.values()) if (approval.run === run) approval.resolve(false);
  }

  private forget(socket: WebSocket): void {
    this.paired.delete(socket);
  }

  private async refreshStatus(): Promise<DesktopMessage> {
    try {
      this.lastStatus = await status(this.options.tools);
    } catch (error) {
      console.error(`[상태] 조회 실패, 마지막 값을 보낸다: ${errorMessage(error)}`);
    }
    return this.lastStatus;
  }
}

// 상태 조회는 tools/의 재거부 차단을 푼다. 에이전트가 도는 동안에는 부르지 않는다
async function status(tools: Tools): Promise<DesktopMessage> {
  return { type: "status", connector: connectorState(await tools.call("get_my_info")), wings: tools.wings };
}

function connectorState(response: Json): ConnectorState {
  if (typeof response !== "object" || response === null || Array.isArray(response)) return "connected";
  if (response["pipe"] === "disconnected") return "disconnected";
  if (response["error"] === "not_in_game") return "not_in_game";
  return "connected";
}

function decode(raw: string): PhoneMessage | undefined {
  try {
    const parsed = phoneMessage.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function eventMessage(id: string, seq: number, event: AgentEvent): DesktopMessage {
  return { type: "event", id, seq, event: agentEvent.parse(event) };
}

function send(socket: WebSocket, message: DesktopMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(desktopMessage.parse(message)));
}

function definedFields(input: ToolInput): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) if (value !== undefined) fields[key] = value;
  return fields;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
