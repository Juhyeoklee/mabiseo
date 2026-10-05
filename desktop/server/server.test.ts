import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { desktopMessage, type DesktopMessage, type PhoneMessage } from "../../protocol/messages.js";
import type { AgentEvent, Session } from "../agent/host.js";
import type { Connector, Json } from "../connector/connector.js";
import { FakeConnector } from "../connector/fake.js";
import { readJson } from "../connector/recordings.js";
import { Tools } from "../tools/tools.js";
import { Server, type Ask } from "./server.js";

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
  const allowed = await session.approve("execute_gathering", { displayName: "새록 버섯", count: 100 });
  session.onEvent({ kind: "done", text: allowed ? "채집을 시작했다." : "승인되지 않았다.", turns: 1, costUsd: 0 });
};

function waitForAbort(session: Session): Promise<void> {
  const signal = session.abort?.signal;
  if (!signal) throw new Error("서버가 abort를 주지 않았다");
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
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

async function serve(ask: Ask, fail?: "login" | "offline"): Promise<{ server: Server; tools: Tools }> {
  const tools = new Tools(await FakeConnector.fromDirectory(recordings, fail), 10);
  const server = await Server.start({ port: 0, code, pcName, tools, ask });
  return { server, tools };
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
    const server = await Server.start({ port: 0, code, pcName, tools, ask: echoAsk });
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
      answer = session.approve("execute_gathering", input);
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
      const allowed = await session.approve("execute_gathering", { displayName: "새록 버섯", count: 100 });
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
    const server = await Server.start({ port: 0, code, pcName, tools, ask: gatheringUntilStopped });
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
    const server = await Server.start({ port: 0, code, pcName, tools: new Tools(connector, 10), ask });
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
    const server = await Server.start({ port: 0, code, pcName, tools, ask: hangingAsk });
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
});
