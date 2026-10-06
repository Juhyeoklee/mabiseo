import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { agentEvent, desktopMessage, phoneMessage, type ConnectorState, type DesktopMessage, type PhoneMessage } from "../../protocol/messages.js";
import type { ask as hostAsk, AgentEvent } from "../agent/host.js";
import type { Json } from "../connector/connector.js";
import type { ToolInput, Tools } from "../tools/tools.js";

export type Ask = typeof hostAsk;

export interface ServerView {
  connector: ConnectorState;
  wings: number;
  phones: string[];
  asking: boolean;
}

export interface Report {
  view(view: ServerView): void;
  log(line: string): void;
}

export interface ServerOptions {
  port: number;
  code: string;
  pcName: string;
  tools: Tools;
  ask: Ask;
  report: Report;
}

type Status = Extract<DesktopMessage, { type: "status" }>;
type ApprovalRequest = Extract<DesktopMessage, { type: "approval_request" }>;

interface Run {
  id: string;
  abort: AbortController;
  events: AgentEvent[];
}

interface Approval {
  run: Run;
  request: ApprovalRequest;
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

  private readonly paired = new Map<WebSocket, string>();
  private readonly approvals = new Map<string, Approval>();
  private run: Run | undefined;
  private refreshing: Promise<unknown> = Promise.resolve();
  private last: Run | undefined;

  private constructor(
    private readonly wss: WebSocketServer,
    private readonly options: ServerOptions,
    private lastStatus: Status,
  ) {
    wss.on("connection", (socket, request) => {
      const address = (request.socket.remoteAddress ?? "?").replace(/^::ffff:/, "");
      socket.on("message", (data) => void this.receive(socket, address, data.toString()));
      socket.on("close", () => this.forget(socket));
    });
  }

  get port(): number {
    const address = this.wss.address();
    return typeof address === "object" && address !== null ? address.port : this.options.port;
  }

  view(): ServerView {
    return {
      connector: this.lastStatus.connector,
      wings: this.lastStatus.wings,
      phones: [...this.paired.values()],
      asking: this.run !== undefined,
    };
  }

  async recheck(): Promise<void> {
    if (this.run) return this.options.report.log("상태 다시 확인: 요청이 끝난 뒤에 확인한다");
    this.options.report.log("상태 다시 확인");
    this.broadcast(await this.refreshStatus());
    this.options.report.view(this.view());
  }

  async close(): Promise<void> {
    if (this.run) this.cancel(this.run);
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve, reject) => this.wss.close((error) => (error ? reject(error) : resolve())));
  }

  private async receive(socket: WebSocket, address: string, raw: string): Promise<void> {
    const message = decode(raw);
    if (!message) return socket.close(policyViolation);
    if (message.type === "pair") return this.pair(socket, address, message.code);
    if (!this.paired.has(socket)) return socket.close(policyViolation);
    switch (message.type) {
      case "ask":
        return this.ask(socket, message.id, message.text);
      case "approve":
        return this.answer(message.id, message.allow);
      case "cancel":
        if (this.run?.id === message.id) {
          this.options.report.log("취소 요청");
          this.cancel(this.run);
          this.stopActivity();
        }
        return;
    }
  }

  private async pair(socket: WebSocket, address: string, code: string): Promise<void> {
    if (code !== this.options.code) {
      this.options.report.log(`페어링 실패: ${address} 코드가 틀림`);
      return send(socket, { type: "pair_failed", reason: "wrong_code" });
    }
    const status = this.run ? this.lastStatus : await this.refreshStatus();
    if (socket.readyState !== WebSocket.OPEN) return;
    // 여기서 다시 보내기까지 await를 넣지 않는다. 사이에 실시간 event가 끼면 폰이 높은 seq를 먼저 받아 다시 보낸 낮은 seq를 버린다
    this.paired.set(socket, address);
    send(socket, { type: "paired", pcName: this.options.pcName });
    send(socket, status);
    const last = this.last;
    last?.events.forEach((event, seq) => send(socket, eventMessage(last.id, seq, event)));
    for (const approval of this.approvals.values()) if (approval.run === this.run) send(socket, approval.request);
    this.options.report.log(`폰 연결: ${address}`);
    this.options.report.view(this.view());
  }

  private async ask(socket: WebSocket, id: string, text: string): Promise<void> {
    this.options.report.log(`요청: ${text}`);
    if (this.last?.id === id) {
      this.options.report.log("요청 거절: 직전 요청과 같은 id");
      return send(socket, eventMessage(id, 0, { kind: "failed", reason: "duplicate_id" }));
    }
    if (this.run) {
      this.options.report.log("요청 거절: 처리 중인 요청이 있음");
      return send(socket, eventMessage(id, 0, { kind: "failed", reason: "busy" }));
    }
    const run: Run = { id, abort: new AbortController(), events: [] };
    this.run = this.last = run;
    this.options.report.view(this.view());
    // 상태 조회는 tools/의 재거부 차단을 푼다. 페어링 · recheck · 앞 요청의 마무리가 시작한 조회가 모두 끝난 뒤에 에이전트를 띄운다
    await this.refreshing;
    let ended = false;
    const emit = (event: AgentEvent): void => {
      if (ended) return;
      const cancelled = event.kind === "failed" && run.abort.signal.aborted;
      ended = event.kind === "done" || event.kind === "failed";
      const recorded: AgentEvent = cancelled ? { kind: "failed", reason: "cancelled" } : event;
      run.events.push(recorded);
      this.broadcast(eventMessage(id, run.events.length - 1, recorded));
      const line = eventLine(recorded);
      if (line) this.options.report.log(line);
    };
    try {
      if (!run.abort.signal.aborted) {
        await this.options.ask(text, {
          tools: this.options.tools,
          approve: (name, input, wings) => this.approve(run, name, input, wings),
          onEvent: emit,
          abort: run.abort,
        });
      }
      if (!ended) emit({ kind: "failed", reason: run.abort.signal.aborted ? "cancelled" : "ended_without_result" });
    } catch (error) {
      if (!ended) emit({ kind: "failed", reason: run.abort.signal.aborted ? "cancelled" : errorMessage(error) });
    } finally {
      this.releaseApprovals(run);
    }
    const status = this.refreshStatus();
    this.run = undefined;
    this.options.report.view(this.view());
    this.broadcast(await status);
  }

  private approve(run: Run, name: string, input: ToolInput, wings: number): Promise<boolean> {
    if (run.abort.signal.aborted) return Promise.resolve(false);
    const id = randomUUID();
    const request: ApprovalRequest = { type: "approval_request", id, askId: run.id, tool: name, input: definedFields(input), wings };
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
      this.options.report.log(`승인 요청: ${name} · 날개 ${request.wings}`);
    });
  }

  private answer(id: string, allow: boolean): void {
    const approval = this.approvals.get(id);
    if (!approval) return;
    this.options.report.log(`${allow ? "승인 허용" : "승인 거절"}: ${approval.request.tool}`);
    approval.resolve(allow);
  }

  private broadcast(message: DesktopMessage): void {
    for (const socket of this.paired.keys()) send(socket, message);
  }

  private cancel(run: Run): void {
    run.abort.abort();
    this.releaseApprovals(run);
  }

  private stopActivity(): void {
    void this.options.tools.cancel().catch((error) => this.options.report.log(`활동 중단 실패: ${errorMessage(error)}`));
  }

  private releaseApprovals(run: Run): void {
    for (const approval of this.approvals.values()) if (approval.run === run) approval.resolve(false);
  }

  private forget(socket: WebSocket): void {
    const address = this.paired.get(socket);
    if (address === undefined) return;
    this.paired.delete(socket);
    this.options.report.log(`폰 끊김: ${address}`);
    this.options.report.view(this.view());
  }

  private refreshStatus(): Promise<Status> {
    const query = this.queryStatus();
    this.refreshing = Promise.all([this.refreshing, query]);
    return query;
  }

  private async queryStatus(): Promise<Status> {
    try {
      this.lastStatus = await status(this.options.tools);
    } catch (error) {
      this.options.report.log(`상태 조회 실패, 마지막 값을 보낸다: ${errorMessage(error)}`);
    }
    return this.lastStatus;
  }
}

// 상태 조회는 tools/의 재거부 차단을 푼다. 에이전트가 도는 동안에는 부르지 않는다
async function status(tools: Tools): Promise<Status> {
  return { type: "status", connector: connectorState(await tools.call("get_my_info")), wings: tools.wings };
}

function connectorState(response: Json): ConnectorState {
  if (typeof response !== "object" || response === null || Array.isArray(response)) return "connected";
  if (response["pipe"] === "disconnected") return "disconnected";
  if (response["error"] === "not_in_game") return "not_in_game";
  return "connected";
}

function eventLine(event: AgentEvent): string | undefined {
  switch (event.kind) {
    case "tool":
      return `도구: ${event.name}`;
    case "done":
      return `끝: 완료 · ${event.turns}턴 · $${event.costUsd.toFixed(3)}`;
    case "failed":
      return `끝: 실패 (${event.reason})`;
    default:
      return undefined;
  }
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
