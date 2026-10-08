import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { desktopMessage, plan, type DesktopMessage, type PhoneMessage } from "../../protocol/messages.js";
import type { AgentEvent, Session } from "../agent/agent.js";
import type { Connector, Json } from "../connector/connector.js";
import { FakeConnector } from "../connector/fake.js";
import { readJson } from "../connector/recordings.js";
import { productionSteps, type Outline } from "../tools/production.js";
import { Tools } from "../tools/tools.js";
import { Server, type Ask, type Report, type ServerView } from "./server.js";

const recordings = fileURLToPath(new URL("../../recordings/", import.meta.url));
const code = "482913";
const pcName = "SOAP-PC";

class Phone {
  private readonly inbox: DesktopMessage[] = [];
  private waiting: ((message: DesktopMessage) => void) | undefined;
  closed: Promise<number>;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = desktopMessage.parse(JSON.parse(data.toString()));
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(message);
      } else this.inbox.push(message);
    });
    this.closed = new Promise((resolve) => socket.on("close", resolve));
  }

  static async connect(port: number): Promise<Phone> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => socket.once("open", resolve));
    return new Phone(socket);
  }

  send(message: PhoneMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  next(): Promise<DesktopMessage> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => (this.waiting = resolve));
  }

  async pair(): Promise<void> {
    this.send({ type: "pair", code });
    expect(await this.next()).toEqual({ type: "paired", pcName });
    expect((await this.next()).type).toBe("status");
  }

  close(): void {
    this.socket.close();
  }
}

const echoAsk: Ask = async (prompt, session) => {
  session.onEvent({ kind: "started", model: "fake" });
  session.onEvent({ kind: "text", text: prompt });
  session.onEvent({ kind: "done", text: prompt, turns: 1, costUsd: 0 });
};

const gatheringAsk: Ask = async (_prompt, session) => {
  session.onEvent({ kind: "started", model: "fake" });
  const allowed = await session.approve("execute_gathering", { displayName: "새록 버섯", count: 100 }, 5);
  session.onEvent({ kind: "done", text: allowed ? "채집을 시작했다." : "승인되지 않았다.", turns: 1, costUsd: 0 });
};

function waitForAbort(session: Session): Promise<void> {
  const signal = session.abort?.signal;
  if (!signal) throw new Error("서버가 abort를 주지 않았다");
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

const hangingAsk: Ask = async (_prompt, session) => {
  session.onEvent({ kind: "started", model: "fake" });
  await waitForAbort(session);
  session.onEvent({ kind: "failed", reason: "aborted by sdk" });
};

class Notes implements Report {
  readonly views: ServerView[] = [];
  readonly logs: string[] = [];
  private readonly checks: (() => void)[] = [];

  view(view: ServerView): void {
    this.views.push(view);
    this.wake();
  }

  log(line: string): void {
    this.logs.push(line);
    this.wake();
  }

  until(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        if (!done()) return;
        this.checks.splice(this.checks.indexOf(check), 1);
        resolve();
      };
      this.checks.push(check);
    });
  }

  private wake(): void {
    for (const check of [...this.checks]) check();
  }
}

async function serve(ask: Ask, fail?: "login" | "offline"): Promise<{ server: Server; tools: Tools; notes: Notes }> {
  const tools = new Tools(await FakeConnector.fromDirectory(recordings, fail), 10);
  const notes = new Notes();
  const server = await Server.start({ port: 0, code, pcName, tools, ask, report: notes });
  return { server, tools, notes };
}

describe("페어링", () => {
  let server: Server;
  beforeEach(async () => ({ server } = await serve(echoAsk)));
  afterEach(() => server.close());

  test("맞는 코드면 paired와 status가 온다", async () => {
    const phone = await Phone.connect(server.port);
    phone.send({ type: "pair", code });
    expect(await phone.next()).toEqual({ type: "paired", pcName });
    expect(await phone.next()).toEqual({ type: "status", connector: "connected", wings: 10 });
    phone.close();
  });

  test("틀린 코드면 pair_failed가 오고 다시 시도할 수 있다", async () => {
    const phone = await Phone.connect(server.port);
    phone.send({ type: "pair", code: "000000" });
    expect(await phone.next()).toEqual({ type: "pair_failed", reason: "wrong_code" });
    await phone.pair();
    phone.close();
  });

  test("페어링 전의 ask는 소켓이 닫힌다", async () => {
    const phone = await Phone.connect(server.port);
    phone.send({ type: "ask", id: "a1", text: "날개 얼마나 남았어" });
    expect(await phone.closed).toBe(1008);
  });

  test("스키마에 없는 메시지는 소켓이 닫힌다", async () => {
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.sendRaw('{"type":"shout","text":"hi"}');
    expect(await phone.closed).toBe(1008);
  });
});

describe("상태", () => {
  test("캐릭터 선택 화면이면 not_in_game", async () => {
    const { server } = await serve(echoAsk, "login");
    const phone = await Phone.connect(server.port);
    phone.send({ type: "pair", code });
    await phone.next();
    expect(await phone.next()).toEqual({ type: "status", connector: "not_in_game", wings: 10 });
    phone.close();
    await server.close();
  });

  test("게임이 꺼져 있으면 disconnected", async () => {
    const { server } = await serve(echoAsk, "offline");
    const phone = await Phone.connect(server.port);
    phone.send({ type: "pair", code });
    await phone.next();
    expect(await phone.next()).toEqual({ type: "status", connector: "disconnected", wings: 10 });
    phone.close();
    await server.close();
  });
});

describe("대화", () => {
  test("상태 조회가 던져도 run이 남지 않고 마지막 상태를 보낸다", async () => {
    let calls = 0;
    const connector: Connector = {
      run: async () => {
        if (calls++ > 0) throw new Error("CLI 없음");
        return { pipe: "connected" };
      },
    };
    const tools = new Tools(connector, 10);
    const server = await Server.start({ port: 0, code, pcName, tools, ask: echoAsk, report: new Notes() });
    const phone = await Phone.connect(server.port);
    await phone.pair();
    for (const id of ["a1", "a2"]) {
      phone.send({ type: "ask", id, text: "다시" });
      for (let i = 0; i < 3; i++) expect(await phone.next()).toMatchObject({ type: "event", id });
      expect(await phone.next()).toEqual({ type: "status", connector: "connected", wings: 10 });
    }
    phone.close();
    await server.close();
  });

  test("ask는 같은 id의 event 스트림으로 돌아오고 끝나면 status가 온다", async () => {
    const { server } = await serve(echoAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "날개 얼마나 남았어" });
    const kinds: AgentEvent["kind"][] = [];
    for (let i = 0; i < 3; i++) {
      const message = await phone.next();
      expect(message.type).toBe("event");
      if (message.type === "event") {
        expect(message.id).toBe("a1");
        kinds.push(message.event.kind);
      }
    }
    expect(kinds).toEqual(["started", "text", "done"]);
    expect((await phone.next()).type).toBe("status");
    phone.close();
    await server.close();
  });

  test("event의 seq는 ask마다 0부터 1씩 는다", async () => {
    const { server } = await serve(echoAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    for (const id of ["a1", "a2"]) {
      phone.send({ type: "ask", id, text: "날개 얼마나 남았어" });
      const seqs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const message = await phone.next();
        if (message.type !== "event") throw new Error(message.type);
        expect(message.id).toBe(id);
        seqs.push(message.seq);
      }
      expect(seqs).toEqual([0, 1, 2]);
      expect((await phone.next()).type).toBe("status");
    }
    phone.close();
    await server.close();
  });

  test("한 번에 하나만 돈다. 겹친 ask는 busy로 실패한다", async () => {
    const { server } = await serve(hangingAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "첫째" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "started" } });
    phone.send({ type: "ask", id: "a2", text: "둘째" });
    expect(await phone.next()).toEqual({ type: "event", id: "a2", seq: 0, event: { kind: "failed", reason: "busy" } });
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "failed", reason: "cancelled" } });
    phone.close();
    await server.close();
  });

  test("직전 ask와 같은 id의 ask는 에이전트를 부르지 않고 failed(duplicate_id)로 거절되며, 다음 새 id는 받는다", async () => {
    const prompts: string[] = [];
    const recordingAsk: Ask = async (prompt, session) => {
      prompts.push(prompt);
      await echoAsk(prompt, session);
    };
    const { server, notes } = await serve(recordingAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "첫째" });
    for (let i = 0; i < 3; i++) await phone.next();
    expect((await phone.next()).type).toBe("status");
    phone.send({ type: "ask", id: "a1", text: "다시" });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "failed", reason: "duplicate_id" } });
    expect(notes.logs).toContain("요청 거절: 직전 요청과 같은 id");
    phone.send({ type: "ask", id: "a2", text: "둘째" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a2", seq: 0, event: { kind: "started" } });
    expect(prompts).toEqual(["첫째", "둘째"]);
    phone.close();
    await server.close();
  });

  test("도는 중인 ask와 같은 id의 ask는 busy가 아니라 duplicate_id로 거절된다", async () => {
    const { server } = await serve(hangingAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "첫째" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", seq: 0, event: { kind: "started" } });
    phone.send({ type: "ask", id: "a1", text: "다시" });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "failed", reason: "duplicate_id" } });
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "failed", reason: "cancelled" } });
    phone.close();
    await server.close();
  });

  test("done 직후의 ask는 busy 없이 받고, 앞 요청의 상태 조회가 끝난 뒤에 에이전트를 시작한다", async () => {
    const held = gate();
    let calls = 0;
    const connector: Connector = {
      run: async () => {
        if (calls++ === 2) await held.wait;
        return { pipe: "connected" };
      },
    };
    const prompts: string[] = [];
    const recordingAsk: Ask = async (prompt, session) => {
      prompts.push(prompt);
      session.onEvent({ kind: "done", text: prompt, turns: 1, costUsd: 0 });
    };
    const notes = new Notes();
    const server = await Server.start({ port: 0, code, pcName, tools: new Tools(connector, 10), ask: recordingAsk, report: notes });
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "첫째" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", seq: 0, event: { kind: "done" } });
    phone.send({ type: "ask", id: "a2", text: "둘째" });
    await notes.until(() => notes.logs.includes("요청: 둘째"));
    await settle();
    expect(prompts).toEqual(["첫째"]);
    held.open();
    const rest = [await phone.next(), await phone.next(), await phone.next()];
    expect(rest).toContainEqual({ type: "event", id: "a2", seq: 0, event: { kind: "done", text: "둘째", turns: 1, costUsd: 0 } });
    expect(rest.filter((message) => message.type === "status")).toHaveLength(2);
    expect(prompts).toEqual(["첫째", "둘째"]);
    expect(notes.logs).not.toContain("요청 거절: 처리 중인 요청이 있음");
    phone.close();
    await server.close();
  });

  test("cancel하면 failed(cancelled)가 한 번만 오고 다음 ask를 받는다", async () => {
    let calls = 0;
    const ask: Ask = (prompt, session) => (calls++ === 0 ? hangingAsk(prompt, session) : echoAsk(prompt, session));
    const { server } = await serve(ask);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "오래 걸리는 일" });
    await phone.next();
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "failed", reason: "cancelled" } });
    expect((await phone.next()).type).toBe("status");
    phone.send({ type: "ask", id: "a2", text: "다음" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a2", event: { kind: "started" } });
    phone.close();
    await server.close();
  });

  test("cancel 전에 에이전트가 끝냈으면 done이 그대로 온다", async () => {
    const ask: Ask = async (_prompt, session) => {
      session.onEvent({ kind: "started", model: "fake" });
      await waitForAbort(session);
      session.onEvent({ kind: "done", text: "이미 시작했다.", turns: 1, costUsd: 0 });
    };
    const { server } = await serve(ask);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "채집해" });
    await phone.next();
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "done", text: "이미 시작했다." } });
    phone.close();
    await server.close();
  });

  test("다른 id의 cancel은 무시된다", async () => {
    const { server } = await serve(hangingAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "오래 걸리는 일" });
    await phone.next();
    phone.send({ type: "cancel", id: "other" });
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "failed", reason: "cancelled" } });
    phone.close();
    await server.close();
  });
});

describe("승인", () => {
  test("맡기기는 approval_request로 폰에 묻고 allow가 돌아와야 진행한다", async () => {
    const { server } = await serve(gatheringAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "새록 버섯 100개 채집해" });
    await phone.next();
    const request = await phone.next();
    expect(request).toMatchObject({
      type: "approval_request",
      askId: "a1",
      tool: "execute_gathering",
      input: { displayName: "새록 버섯", count: 100 },
      wings: 5,
    });
    if (request.type !== "approval_request") return;
    phone.send({ type: "approve", id: request.id, allow: true });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "done", text: "채집을 시작했다." } });
    phone.close();
    await server.close();
  });

  test("가공 계획 승인은 단계 모양을 plan으로 싣고, 단계 진행은 plan_step 이벤트로 폰에 간다. 다른 승인에는 plan이 없다", async () => {
    const outline: Outline = {
      item: "철괴",
      count: 3,
      steps: [
        { kind: "register", item: "철괴", count: 1, seconds: 7, wings: 5, facility: "금속 가공 시설" },
        { kind: "wait", item: "철괴", count: 3, seconds: 30, wings: 0, facility: "금속 가공 시설" },
      ],
    };
    const planned: Ask = async (_prompt, session) => {
      await session.approve("propose_plan", { "execute_altering 철괴(철 광석)": 1 }, 5, outline);
      session.onEvent({ kind: "plan_step", done: 1, remainingSeconds: 30 });
      await session.approve("execute_gathering", { displayName: "새록 버섯" }, 5);
      session.onEvent({ kind: "done", text: "끝", turns: 1, costUsd: 0 });
    };
    const { server } = await serve(planned);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "철괴 3개 만들어줘" });
    const request = await phone.next();
    if (request.type !== "approval_request") throw new Error(request.type);
    expect(request.plan).toEqual(outline);
    phone.send({ type: "approve", id: request.id, allow: true });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "plan_step", done: 1, remainingSeconds: 30 } });
    const plain = await phone.next();
    if (plain.type !== "approval_request") throw new Error(plain.type);
    expect(plain).not.toHaveProperty("plan");
    phone.close();
    await server.close();
  });

  test("생산 계획이 내는 단계 모양은 프로토콜의 plan 계약을 그대로 통과한다", () => {
    const production = productionSteps("강철괴", 24, new Map(), ["철 광석"]);
    if (!("outline" in production)) throw new Error("계획이 서지 않았다");
    expect(plan.parse(production.outline)).toEqual(production.outline);
  });

  test("allow가 false면 거부로 돌아간다", async () => {
    const { server } = await serve(gatheringAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "새록 버섯 100개 채집해" });
    await phone.next();
    const request = await phone.next();
    if (request.type !== "approval_request") throw new Error(request.type);
    phone.send({ type: "approve", id: request.id, allow: false });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "done", text: "승인되지 않았다." } });
    phone.close();
    await server.close();
  });

  test("승인을 기다리는 중에 cancel하면 거부로 돌아가고 늦게 온 allow는 아무것도 실행하지 않는다", async () => {
    let answer: Promise<boolean> | undefined;
    const ask: Ask = async (_prompt, session) => {
      const input = { displayName: "새록 버섯", count: 100 };
      answer = session.approve("execute_gathering", input, 5);
      if (await answer) await session.tools.call("execute_gathering", input);
      session.onEvent({ kind: "done", text: "", turns: 1, costUsd: 0 });
    };
    const { server, tools } = await serve(ask);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "새록 버섯 100개 채집해" });
    const request = await phone.next();
    if (request.type !== "approval_request") throw new Error(request.type);
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "done", text: "" } });
    expect(await answer).toBe(false);
    phone.send({ type: "approve", id: request.id, allow: true });
    expect((await phone.next()).type).toBe("status");
    expect(tools.wings).toBe(10);
    phone.close();
    await server.close();
  });

  test("승인을 기다리는 중에 폰이 끊겨도 승인 대기는 남고, 다시 페어링한 폰에 같은 approval_request가 다시 가며 그 답으로 진행한다", async () => {
    const { server } = await serve(gatheringAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "새록 버섯 100개 채집해" });
    await phone.next();
    const first = await phone.next();
    if (first.type !== "approval_request") throw new Error(first.type);
    phone.close();
    await phone.closed;
    const again = await Phone.connect(server.port);
    await again.pair();
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "started", model: "fake" } });
    const repeated = await again.next();
    expect(repeated).toEqual(first);
    if (repeated.type !== "approval_request") throw new Error(repeated.type);
    again.send({ type: "approve", id: repeated.id, allow: true });
    expect(await again.next()).toEqual({
      type: "event",
      id: "a1",
      seq: 1,
      event: { kind: "done", text: "채집을 시작했다.", turns: 1, costUsd: 0 },
    });
    again.close();
    await server.close();
  });

  test("답한 승인은 다시 페어링해도 다시 오지 않는다", async () => {
    const release = gate();
    const ask: Ask = async (_prompt, session) => {
      session.onEvent({ kind: "started", model: "fake" });
      const allowed = await session.approve("execute_gathering", { displayName: "새록 버섯", count: 100 }, 5);
      session.onEvent({ kind: "text", text: allowed ? "승인됨" : "거부됨" });
      await release.wait;
      session.onEvent({ kind: "done", text: "", turns: 1, costUsd: 0 });
    };
    const { server } = await serve(ask);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "새록 버섯 100개 채집해" });
    await phone.next();
    const request = await phone.next();
    if (request.type !== "approval_request") throw new Error(request.type);
    phone.send({ type: "approve", id: request.id, allow: true });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "text", text: "승인됨" } });
    phone.close();
    await phone.closed;
    const again = await Phone.connect(server.port);
    await again.pair();
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "started", model: "fake" } });
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "text", text: "승인됨" } });
    release.open();
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 2, event: { kind: "done", text: "", turns: 1, costUsd: 0 } });
    again.close();
    await server.close();
  });
});

class Gathering implements Connector {
  calls: string[] = [];
  private pending: ((value: Json) => void) | undefined;

  private constructor(
    private readonly fake: FakeConnector,
    private readonly activity: Json,
  ) {}

  static async load(): Promise<Gathering> {
    return new Gathering(await FakeConnector.fromDirectory(recordings), await readJson(recordings, "get_activity.json"));
  }

  run(command: string, body: string | undefined): Promise<Json> {
    this.calls.push(command);
    switch (command) {
      case "execute_gathering":
        return new Promise((resolve) => (this.pending = resolve));
      case "stop_action":
        this.finish();
        return Promise.resolve({ message: "" });
      case "get_activity":
        return Promise.resolve(this.activity);
      default:
        return this.fake.run(command, body);
    }
  }

  finish(): void {
    this.pending?.({ result: "stopped", gained: 3, target: 100 });
    this.pending = undefined;
  }
}

class Counting implements Connector {
  calls: [string, string | undefined][] = [];
  constructor(private readonly inner: Connector) {}
  async run(command: string, body: string | undefined, timeoutMs: number): Promise<Json> {
    this.calls.push([command, body]);
    return this.inner.run(command, body, timeoutMs);
  }
}

describe("중단", () => {
  let gathered: Promise<Json> | undefined;
  const gatheringUntilStopped: Ask = async (_prompt, session) => {
    session.onEvent({ kind: "started", model: "fake" });
    gathered = session.tools.call("execute_gathering", { displayName: "통나무" });
    await gathered;
    if (session.abort?.signal.aborted) session.onEvent({ kind: "failed", reason: "aborted by sdk" });
    else session.onEvent({ kind: "done", text: "", turns: 1, costUsd: 0 });
  };

  async function serveGathering(): Promise<{ server: Server; tools: Tools; connector: Gathering }> {
    const connector = await Gathering.load();
    const tools = new Tools(connector, 10);
    const server = await Server.start({ port: 0, code, pcName, tools, ask: gatheringUntilStopped, report: new Notes() });
    return { server, tools, connector };
  }

  beforeEach(() => (gathered = undefined));

  test("cancel은 붙든 활동에 stop_action을 보낸다", async () => {
    const { server, tools, connector } = await serveGathering();
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "통나무 채집해" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "started" } });
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "failed", reason: "cancelled" } });
    expect((await phone.next()).type).toBe("status");
    expect(connector.calls).toContain("stop_action");
    expect(await gathered).toEqual({ result: "stopped", gained: 3, target: 100 });
    expect(await tools.cancel()).toBeUndefined();
    phone.close();
    await server.close();
  });

  test("폰이 끊겨도 활동은 잇는다", async () => {
    const { server, connector } = await serveGathering();
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "통나무 채집해" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "started" } });
    phone.close();
    await phone.closed;
    const again = await Phone.connect(server.port);
    await again.pair();
    expect(connector.calls).not.toContain("stop_action");
    connector.finish();
    await gathered;
    again.close();
    await server.close();
  });

  test("폰이 끊겨도 에이전트는 끊지 않는다", async () => {
    const { server, connector } = await serveGathering();
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "통나무 채집해" });
    await phone.next();
    phone.close();
    await phone.closed;
    connector.finish();
    await gathered;
    const again = await Phone.connect(server.port);
    await again.pair();
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "started", model: "fake" } });
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "done", text: "", turns: 1, costUsd: 0 } });
    expect(connector.calls).not.toContain("stop_action");
    again.close();
    await server.close();
  });

  test("다시 페어링한 폰의 cancel도 진행 중인 ask를 끊고 stop_action을 보낸다", async () => {
    const { server, connector } = await serveGathering();
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "통나무 채집해" });
    await phone.next();
    phone.close();
    await phone.closed;
    const again = await Phone.connect(server.port);
    await again.pair();
    expect(await again.next()).toMatchObject({ type: "event", id: "a1", seq: 0, event: { kind: "started" } });
    again.send({ type: "cancel", id: "a1" });
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "failed", reason: "cancelled" } });
    expect((await again.next()).type).toBe("status");
    expect(connector.calls).toContain("stop_action");
    again.close();
    await server.close();
  });

  test("서버를 닫으면 진행 중인 에이전트를 끊고 활동은 잇는다", async () => {
    let aborted: Promise<void> | undefined;
    const ask: Ask = async (prompt, session) => {
      aborted = waitForAbort(session);
      await gatheringUntilStopped(prompt, session);
    };
    const connector = await Gathering.load();
    const server = await Server.start({ port: 0, code, pcName, tools: new Tools(connector, 10), ask, report: new Notes() });
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "통나무 채집해" });
    await phone.next();
    await server.close();
    await aborted;
    expect(connector.calls).not.toContain("stop_action");
    connector.finish();
    await gathered;
  });

  test("활동이 없으면 cancel은 stop_action을 보내지 않는다", async () => {
    const connector = new Counting(await FakeConnector.fromDirectory(recordings));
    const tools = new Tools(connector, 10);
    const server = await Server.start({ port: 0, code, pcName, tools, ask: hangingAsk, report: new Notes() });
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "오래 걸리는 일" });
    await phone.next();
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "failed", reason: "cancelled" } });
    expect(connector.calls.map(([command]) => command)).not.toContain("stop_action");
    phone.close();
    await server.close();
  });

  test("진행 event는 ask의 id로 폰에 간다", async () => {
    const ask: Ask = async (_prompt, session) => {
      session.onEvent({ kind: "progress", activity: "execute_gathering", elapsedSeconds: 20 });
      session.onEvent({ kind: "done", text: "", turns: 1, costUsd: 0 });
    };
    const { server } = await serve(ask);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "채집 어디까지 했어" });
    expect(await phone.next()).toEqual({
      type: "event",
      id: "a1",
      seq: 0,
      event: { kind: "progress", activity: "execute_gathering", elapsedSeconds: 20 },
    });
    phone.close();
    await server.close();
  });
});

describe("다시 페어링", () => {
  test("진행 중에 다시 페어링한 폰에는 paired · status 뒤로 그 ask의 event가 seq 0부터 다시 오고, 이어서 새 event가 온다", async () => {
    const release = gate();
    const ask: Ask = async (_prompt, session) => {
      session.onEvent({ kind: "started", model: "fake" });
      session.onEvent({ kind: "text", text: "채집 중" });
      await release.wait;
      session.onEvent({ kind: "done", text: "끝", turns: 1, costUsd: 0 });
    };
    const { server } = await serve(ask);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "채집해" });
    await phone.next();
    await phone.next();
    phone.close();
    await phone.closed;
    const again = await Phone.connect(server.port);
    again.send({ type: "pair", code });
    expect(await again.next()).toEqual({ type: "paired", pcName });
    expect((await again.next()).type).toBe("status");
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "started", model: "fake" } });
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "text", text: "채집 중" } });
    release.open();
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 2, event: { kind: "done", text: "끝", turns: 1, costUsd: 0 } });
    expect((await again.next()).type).toBe("status");
    again.close();
    await server.close();
  });

  test("끝난 ask는 다음 ask가 올 때까지 다시 페어링한 폰에 다시 온다", async () => {
    const release = gate();
    const ask: Ask = async (_prompt, session) => {
      session.onEvent({ kind: "started", model: "fake" });
      await release.wait;
      session.onEvent({ kind: "done", text: "끝", turns: 1, costUsd: 0 });
    };
    const { server } = await serve(ask);
    const observer = await Phone.connect(server.port);
    await observer.pair();
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "채집해" });
    await phone.next();
    phone.close();
    await phone.closed;
    release.open();
    expect(await observer.next()).toMatchObject({ type: "event", id: "a1", seq: 0 });
    expect(await observer.next()).toMatchObject({ type: "event", id: "a1", seq: 1, event: { kind: "done" } });
    expect((await observer.next()).type).toBe("status");
    const again = await Phone.connect(server.port);
    again.send({ type: "pair", code });
    expect(await again.next()).toEqual({ type: "paired", pcName });
    expect(await again.next()).toEqual({ type: "status", connector: "connected", wings: 10 });
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "started", model: "fake" } });
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "done", text: "끝", turns: 1, costUsd: 0 } });
    observer.close();
    again.close();
    await server.close();
  });

  test("새 ask가 시작되면 앞 ask의 기록은 다시 보내지 않는다", async () => {
    const { server } = await serve(echoAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    for (const id of ["a1", "a2"]) {
      phone.send({ type: "ask", id, text: id });
      for (let i = 0; i < 3; i++) await phone.next();
      expect((await phone.next()).type).toBe("status");
    }
    phone.close();
    await phone.closed;
    const again = await Phone.connect(server.port);
    await again.pair();
    expect(await again.next()).toEqual({ type: "event", id: "a2", seq: 0, event: { kind: "started", model: "fake" } });
    expect(await again.next()).toEqual({ type: "event", id: "a2", seq: 1, event: { kind: "text", text: "a2" } });
    expect(await again.next()).toEqual({ type: "event", id: "a2", seq: 2, event: { kind: "done", text: "a2", turns: 1, costUsd: 0 } });
    again.close();
    await server.close();
  });

  test("겹친 ask의 busy는 그 폰에만 seq 0으로 가고 기록에 남지 않는다", async () => {
    const { server } = await serve(hangingAsk);
    const first = await Phone.connect(server.port);
    await first.pair();
    const second = await Phone.connect(server.port);
    await second.pair();
    first.send({ type: "ask", id: "a1", text: "첫째" });
    expect(await first.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "started", model: "fake" } });
    expect(await second.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "started", model: "fake" } });
    second.send({ type: "ask", id: "a2", text: "둘째" });
    expect(await second.next()).toEqual({ type: "event", id: "a2", seq: 0, event: { kind: "failed", reason: "busy" } });
    const third = await Phone.connect(server.port);
    await third.pair();
    expect(await third.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "started", model: "fake" } });
    first.send({ type: "cancel", id: "a1" });
    const cancelled = { type: "event", id: "a1", seq: 1, event: { kind: "failed", reason: "cancelled" } };
    expect(await first.next()).toEqual(cancelled);
    expect(await third.next()).toEqual(cancelled);
    for (const phone of [first, second, third]) phone.close();
    await server.close();
  });

  test("같은 id로 거절된 ask는 그 폰에만 가고 기록에 남지 않아, 다시 페어링하면 앞 ask의 기록만 다시 온다", async () => {
    const { server } = await serve(echoAsk);
    const observer = await Phone.connect(server.port);
    await observer.pair();
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "첫째" });
    for (const each of [phone, observer]) {
      for (let i = 0; i < 3; i++) await each.next();
      expect((await each.next()).type).toBe("status");
    }
    phone.send({ type: "ask", id: "a1", text: "다시" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", seq: 0, event: { kind: "failed", reason: "duplicate_id" } });
    phone.close();
    await phone.closed;
    const again = await Phone.connect(server.port);
    await again.pair();
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 0, event: { kind: "started", model: "fake" } });
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "text", text: "첫째" } });
    expect(await again.next()).toEqual({ type: "event", id: "a1", seq: 2, event: { kind: "done", text: "첫째", turns: 1, costUsd: 0 } });
    again.send({ type: "ask", id: "a2", text: "둘째" });
    expect(await again.next()).toMatchObject({ type: "event", id: "a2", seq: 0, event: { kind: "started" } });
    expect(await observer.next()).toMatchObject({ type: "event", id: "a2", seq: 0, event: { kind: "started" } });
    observer.close();
    again.close();
    await server.close();
  });
});

describe("상태 창 보고", () => {
  const phoneAddress = "127.0.0.1";

  test("시작 직후 view는 폰 없이 대기 중이고 게임 상태와 날개를 담는다", async () => {
    const { server } = await serve(echoAsk);
    expect(server.view()).toEqual({ connector: "connected", wings: 10, phones: [], asking: false });
    await server.close();
  });

  test("페어링하면 phones에 폰 주소가 들어가고 「폰 연결」 로그가 남는다", async () => {
    const { server, notes } = await serve(echoAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    expect(server.view().phones).toEqual([phoneAddress]);
    expect(notes.views.at(-1)?.phones).toEqual([phoneAddress]);
    expect(notes.logs).toEqual([`폰 연결: ${phoneAddress}`]);
    phone.close();
    await server.close();
  });

  test("페어링한 폰이 끊기면 phones에서 빠지고 「폰 끊김」 로그가 남는다", async () => {
    const { server, notes } = await serve(echoAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.close();
    await notes.until(() => notes.logs.includes(`폰 끊김: ${phoneAddress}`));
    expect(server.view().phones).toEqual([]);
    expect(notes.views.at(-1)?.phones).toEqual([]);
    expect(notes.logs).toEqual([`폰 연결: ${phoneAddress}`, `폰 끊김: ${phoneAddress}`]);
    await server.close();
  });

  test("페어링하지 않은 소켓이 끊기면 아무것도 보고하지 않는다", async () => {
    const { server, notes } = await serve(echoAsk);
    const stranger = await Phone.connect(server.port);
    stranger.close();
    await stranger.closed;
    const phone = await Phone.connect(server.port);
    await phone.pair();
    expect(notes.logs).toEqual([`폰 연결: ${phoneAddress}`]);
    expect(notes.views).toHaveLength(1);
    phone.close();
    await server.close();
  });

  test("틀린 코드는 「페어링 실패」 로그만 남기고 phones는 비어 있다", async () => {
    const { server, notes } = await serve(echoAsk);
    const phone = await Phone.connect(server.port);
    phone.send({ type: "pair", code: "000000" });
    expect(await phone.next()).toEqual({ type: "pair_failed", reason: "wrong_code" });
    expect(notes.logs).toEqual([`페어링 실패: ${phoneAddress} 코드가 틀림`]);
    expect(notes.views).toEqual([]);
    expect(server.view().phones).toEqual([]);
    phone.close();
    await server.close();
  });

  test("요청이 도는 동안 asking이 true로, 끝나면 false로 보고된다", async () => {
    const { server, notes } = await serve(hangingAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "오래 걸리는 일" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "started" } });
    expect(server.view().asking).toBe(true);
    expect(notes.views.at(-1)?.asking).toBe(true);
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "failed" } });
    expect((await phone.next()).type).toBe("status");
    expect(server.view().asking).toBe(false);
    expect(notes.views.at(-1)?.asking).toBe(false);
    phone.close();
    await server.close();
  });

  test("요청 · 승인 요청 · 승인 답 · 끝이 로그에 순서대로 남는다", async () => {
    const { server, notes } = await serve(gatheringAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "채집해 줘" });
    await phone.next();
    const request = await phone.next();
    if (request.type !== "approval_request") throw new Error(request.type);
    phone.send({ type: "approve", id: request.id, allow: true });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "done" } });
    expect(notes.logs).toEqual([
      `폰 연결: ${phoneAddress}`,
      "요청: 채집해 줘",
      "승인 요청: execute_gathering · 날개 5",
      "승인 허용: execute_gathering",
      "끝: 완료 · 1턴 · $0.000",
    ]);
    phone.close();
    await server.close();
  });

  test("도구 event는 「도구」 로그로 남는다", async () => {
    const ask: Ask = async (_prompt, session) => {
      session.onEvent({ kind: "tool", name: "get_my_info", input: {} });
      session.onEvent({ kind: "done", text: "", turns: 1, costUsd: 0 });
    };
    const { server, notes } = await serve(ask);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "내 정보" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a1", event: { kind: "tool" } });
    expect(notes.logs).toContain("도구: get_my_info");
    phone.close();
    await server.close();
  });

  test("취소된 요청은 「취소 요청」과 「끝: 실패 (cancelled)」로 남는다", async () => {
    const { server, notes } = await serve(hangingAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "오래 걸리는 일" });
    await phone.next();
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "failed", reason: "cancelled" } });
    expect(notes.logs).toEqual([`폰 연결: ${phoneAddress}`, "요청: 오래 걸리는 일", "취소 요청", "끝: 실패 (cancelled)"]);
    phone.close();
    await server.close();
  });

  test("처리 중에 들어온 요청은 「요청 거절」로 남는다", async () => {
    const { server, notes } = await serve(hangingAsk);
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "첫째" });
    await phone.next();
    phone.send({ type: "ask", id: "a2", text: "둘째" });
    expect(await phone.next()).toMatchObject({ type: "event", id: "a2", event: { kind: "failed", reason: "busy" } });
    expect(notes.logs).toContain("요청 거절: 처리 중인 요청이 있음");
    phone.send({ type: "cancel", id: "a1" });
    await phone.next();
    phone.close();
    await server.close();
  });

  test("recheck는 로그를 남기고 상태를 다시 조회해 페어링된 폰에 status를 보내고 view를 보고한다", async () => {
    let calls = 0;
    const connector: Connector = {
      run: async () => (calls++ === 0 ? { pipe: "connected" } : { pipe: "disconnected", reason: "game_off" }),
    };
    const notes = new Notes();
    const server = await Server.start({ port: 0, code, pcName, tools: new Tools(connector, 10), ask: echoAsk, report: notes });
    expect(server.view().connector).toBe("connected");
    const phone = await Phone.connect(server.port);
    await phone.pair();
    const before = calls;
    await server.recheck();
    expect(calls).toBe(before + 1);
    expect(await phone.next()).toEqual({ type: "status", connector: "disconnected", wings: 10 });
    expect(notes.views.at(-1)?.connector).toBe("disconnected");
    expect(notes.logs.at(-1)).toBe("상태 다시 확인");
    phone.close();
    await server.close();
  });

  test("요청이 도는 동안 recheck는 CLI를 부르지 않고 나중에 확인한다고 로그를 남긴다", async () => {
    const connector = new Counting(await FakeConnector.fromDirectory(recordings));
    const notes = new Notes();
    const server = await Server.start({ port: 0, code, pcName, tools: new Tools(connector, 10), ask: hangingAsk, report: notes });
    const phone = await Phone.connect(server.port);
    await phone.pair();
    phone.send({ type: "ask", id: "a1", text: "오래 걸리는 일" });
    await phone.next();
    const before = connector.calls.length;
    await server.recheck();
    expect(connector.calls).toHaveLength(before);
    expect(notes.logs.at(-1)).toBe("상태 다시 확인: 요청이 끝난 뒤에 확인한다");
    phone.send({ type: "cancel", id: "a1" });
    expect(await phone.next()).toEqual({ type: "event", id: "a1", seq: 1, event: { kind: "failed", reason: "cancelled" } });
    phone.close();
    await server.close();
  });

  test("상태 조회가 도는 중에 들어온 요청은 조회가 끝난 뒤에 에이전트를 시작한다", async () => {
    const held = gate();
    let calls = 0;
    const connector: Connector = {
      run: async () => {
        if (calls++ === 2) await held.wait;
        return { pipe: "connected" };
      },
    };
    let started = false;
    const watchingAsk: Ask = async (_prompt, session) => {
      started = true;
      session.onEvent({ kind: "done", text: "", turns: 1, costUsd: 0 });
    };
    const notes = new Notes();
    const server = await Server.start({ port: 0, code, pcName, tools: new Tools(connector, 10), ask: watchingAsk, report: notes });
    const phone = await Phone.connect(server.port);
    await phone.pair();
    const rechecked = server.recheck();
    phone.send({ type: "ask", id: "a1", text: "날개 얼마나 남았어" });
    await notes.until(() => notes.logs.includes("요청: 날개 얼마나 남았어"));
    expect(started).toBe(false);
    held.open();
    await rechecked;
    await notes.until(() => notes.logs.includes("끝: 완료 · 1턴 · $0.000"));
    expect(started).toBe(true);
    phone.close();
    await server.close();
  });

  test("상태 조회 둘이 겹치면 요청은 둘 다 끝난 뒤에 에이전트를 시작한다", async () => {
    const held = gate();
    let calls = 0;
    const connector: Connector = {
      run: async () => {
        if (calls++ === 2) await held.wait;
        return { pipe: "connected" };
      },
    };
    let started = false;
    const watchingAsk: Ask = async (_prompt, session) => {
      started = true;
      session.onEvent({ kind: "done", text: "", turns: 1, costUsd: 0 });
    };
    const notes = new Notes();
    const server = await Server.start({ port: 0, code, pcName, tools: new Tools(connector, 10), ask: watchingAsk, report: notes });
    const phone = await Phone.connect(server.port);
    await phone.pair();
    const rechecked = server.recheck();
    const other = await Phone.connect(server.port);
    await other.pair();
    other.send({ type: "ask", id: "a1", text: "날개 얼마나 남았어" });
    await notes.until(() => notes.logs.includes("요청: 날개 얼마나 남았어"));
    await settle();
    expect(started).toBe(false);
    held.open();
    await rechecked;
    await notes.until(() => notes.logs.includes("끝: 완료 · 1턴 · $0.000"));
    expect(started).toBe(true);
    phone.close();
    other.close();
    await server.close();
  });

  test("상태 조회를 기다리는 사이에 취소된 요청은 에이전트를 띄우지 않고 취소로 끝난다", async () => {
    const held = gate();
    let calls = 0;
    const connector: Connector = {
      run: async () => {
        if (calls++ === 2) await held.wait;
        return { pipe: "connected" };
      },
    };
    let started = false;
    const watchingAsk: Ask = async (_prompt, session) => {
      started = true;
      session.onEvent({ kind: "done", text: "", turns: 1, costUsd: 0 });
    };
    const notes = new Notes();
    const server = await Server.start({ port: 0, code, pcName, tools: new Tools(connector, 10), ask: watchingAsk, report: notes });
    const phone = await Phone.connect(server.port);
    await phone.pair();
    const rechecked = server.recheck();
    phone.send({ type: "ask", id: "a1", text: "날개 얼마나 남았어" });
    await notes.until(() => notes.logs.includes("요청: 날개 얼마나 남았어"));
    phone.send({ type: "cancel", id: "a1" });
    await notes.until(() => notes.logs.includes("취소 요청"));
    held.open();
    await rechecked;
    await notes.until(() => notes.logs.includes("끝: 실패 (cancelled)"));
    expect(started).toBe(false);
    phone.close();
    await server.close();
  });

  test("recheck 중 상태 조회가 던지면 로그를 남기고 마지막 상태를 보낸다", async () => {
    let calls = 0;
    const connector: Connector = {
      run: async () => {
        if (calls++ > 0) throw new Error("CLI 없음");
        return { pipe: "connected" };
      },
    };
    const notes = new Notes();
    const server = await Server.start({ port: 0, code, pcName, tools: new Tools(connector, 10), ask: echoAsk, report: notes });
    const phone = await Phone.connect(server.port);
    await phone.pair();
    const seen = notes.logs.length;
    await server.recheck();
    expect(await phone.next()).toEqual({ type: "status", connector: "connected", wings: 10 });
    expect(notes.logs.slice(seen)).toEqual(["상태 다시 확인", "상태 조회 실패, 마지막 값을 보낸다: CLI 없음"]);
    phone.close();
    await server.close();
  });
});
