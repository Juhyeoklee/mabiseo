import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatGptAuth } from "./chatgpt.js";

function jwt(claims: object): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

const inSeconds = (seconds: number): number => Math.floor(Date.now() / 1000) + seconds;

interface Posted {
  url: string;
  form: URLSearchParams;
}

function tokenEndpoint(reply: (form: URLSearchParams) => Response) {
  const posted: Posted[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const form = new URLSearchParams(String(init?.body));
    posted.push({ url: String(url), form });
    return reply(form);
  };
  return { fetch, posted };
}

async function saved(access: object, extra: object = {}) {
  const file = join(await mkdtemp(join(tmpdir(), "mabiseo-chatgpt-")), "chatgpt.json");
  await writeFile(file, JSON.stringify({ client_id: "oaiapp_1", access_token: jwt(access), refresh_token: "r1", id_token: jwt({ email: "me@example.com" }), ...extra }));
  return file;
}

describe("ChatGPT 인증 상태", () => {
  it("저장된 토큰이 없으면 로그아웃 상태이고 자격을 내지 않는다", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "mabiseo-chatgpt-")), "chatgpt.json");
    const auth = new ChatGptAuth({ file });
    expect(await auth.state()).toEqual({ signedIn: false });
    expect(await auth.credential()).toBeUndefined();
  });

  it("저장된 토큰이 있으면 id_token의 이메일을 계정으로 보인다", async () => {
    const auth = new ChatGptAuth({ file: await saved({ exp: inSeconds(3600) }) });
    expect(await auth.state()).toEqual({ signedIn: true, account: "me@example.com" });
  });

  it("토큰 파일이 깨졌거나 필요한 필드가 없으면 던지지 않고 로그아웃 상태로 읽는다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mabiseo-chatgpt-"));
    for (const [name, text] of [["broken.json", '{"client_id":"oaiapp_1","access'], ["partial.json", '{"client_id":"oaiapp_1","access_token":"a"}']]) {
      const file = join(dir, name!);
      await writeFile(file, text!);
      const auth = new ChatGptAuth({ file });
      expect(await auth.state()).toEqual({ signedIn: false });
      expect(await auth.credential()).toBeUndefined();
    }
  });

  it("로그아웃하면 토큰 파일이 지워진다", async () => {
    const file = await saved({ exp: inSeconds(3600) });
    const auth = new ChatGptAuth({ file });
    expect(await auth.logout()).toEqual({ signedIn: false });
    expect(await auth.state()).toEqual({ signedIn: false });
  });
});

describe("ChatGPT 자격 전달", () => {
  it("액세스 토큰이 넉넉히 남았으면 갱신 없이 그대로 낸다", async () => {
    const access = { exp: inSeconds(3600) };
    const { fetch, posted } = tokenEndpoint(() => new Response("{}", { status: 500 }));
    expect(await new ChatGptAuth({ file: await saved(access), fetch }).credential()).toBe(jwt(access));
    expect(posted).toEqual([]);
  });

  it("만료가 2분 안이면 갱신 토큰으로 바꿔 받고 저장한다. client_id는 남는다", async () => {
    const file = await saved({ exp: inSeconds(60) });
    const fresh = jwt({ exp: inSeconds(3600) });
    const { fetch, posted } = tokenEndpoint(() => Response.json({ access_token: fresh, refresh_token: "r2" }));
    expect(await new ChatGptAuth({ file, fetch }).credential()).toBe(fresh);
    expect(Object.fromEntries(posted[0]!.form)).toEqual({ grant_type: "refresh_token", refresh_token: "r1", client_id: "oaiapp_1", resource: "https://api.openai.com/v1" });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ client_id: "oaiapp_1", access_token: fresh, refresh_token: "r2" });
  });

  it("갱신이 거절되면 로그아웃 상태가 되고 자격을 내지 않는다", async () => {
    const file = await saved({ exp: inSeconds(0) });
    const { fetch } = tokenEndpoint(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const auth = new ChatGptAuth({ file, fetch });
    expect(await auth.credential()).toBeUndefined();
    expect(await auth.state()).toEqual({ signedIn: false });
  });

  it("갱신 응답에 access_token이 없으면 저장하지 않고 던진다", async () => {
    const file = await saved({ exp: inSeconds(0) });
    const before = await readFile(file, "utf8");
    const { fetch } = tokenEndpoint(() => Response.json({ refresh_token: "r2" }));
    await expect(new ChatGptAuth({ file, fetch }).credential()).rejects.toThrow("access_token");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("갱신 서버가 5xx면 로그아웃하지 않고 던진다", async () => {
    const file = await saved({ exp: inSeconds(0) });
    const { fetch } = tokenEndpoint(() => new Response("", { status: 503 }));
    const auth = new ChatGptAuth({ file, fetch });
    await expect(auth.credential()).rejects.toThrow("503");
    expect(await auth.state()).toMatchObject({ signedIn: true });
  });
});

describe("ChatGPT PC 로그인", () => {
  it("셀프 등록 주소를 열고 루프백 콜백의 code를 PKCE로 바꿔 발급된 client_id와 함께 저장한다", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "mabiseo-chatgpt-")), "nested", "chatgpt.json");
    let authorize: URL | undefined;
    const { fetch, posted } = tokenEndpoint((form) => {
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== authorize?.searchParams.get("code_challenge")) return new Response("", { status: 400 });
      return Response.json({ access_token: jwt({ exp: inSeconds(3600) }), refresh_token: "r1", id_token: jwt({ email: "me@example.com", nonce: authorize.searchParams.get("nonce") }) });
    });
    const auth = new ChatGptAuth({ file, fetch });

    const state = await auth.login(async (url) => {
      authorize = new URL(url);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "c1", state: authorize.searchParams.get("state")!, client_id: "oaiapp_new" }).toString();
      void globalThis.fetch(callback);
    });

    expect(authorize?.origin + authorize!.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(authorize?.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize?.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(posted[0]?.form.get("grant_type")).toBe("authorization_code");
    expect(posted[0]?.form.get("client_id")).toBe("oaiapp_new");
    expect(state).toEqual({ signedIn: true, account: "me@example.com" });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ client_id: "oaiapp_new", refresh_token: "r1" });
  });

  it("토큰 응답에 id_token이 없으면 저장하지 않고 던진다", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "mabiseo-chatgpt-")), "chatgpt.json");
    const { fetch } = tokenEndpoint(() => Response.json({ access_token: jwt({ exp: inSeconds(3600) }), refresh_token: "r1" }));
    const auth = new ChatGptAuth({ file, fetch });
    const login = auth.login(async (url) => {
      const authorize = new URL(url);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "c1", state: authorize.searchParams.get("state")!, client_id: "oaiapp_new" }).toString();
      void globalThis.fetch(callback);
    });
    await expect(login).rejects.toThrow("토큰 응답");
    expect(await auth.state()).toEqual({ signedIn: false });
  });

  it("콜백이 error를 실어 오면 저장하지 않고 던진다", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "mabiseo-chatgpt-")), "chatgpt.json");
    const { fetch, posted } = tokenEndpoint(() => new Response("", { status: 500 }));
    const auth = new ChatGptAuth({ file, fetch });
    const login = auth.login(async (url) => {
      const authorize = new URL(url);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ error: "access_denied", state: authorize.searchParams.get("state")! }).toString();
      void globalThis.fetch(callback);
    });
    await expect(login).rejects.toThrow("access_denied");
    expect(posted).toEqual([]);
    expect(await auth.state()).toEqual({ signedIn: false });
  });

  it("state가 다른 콜백은 받지 않고 맞는 콜백을 기다린다", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "mabiseo-chatgpt-")), "chatgpt.json");
    let nonce: string | null = null;
    const { fetch } = tokenEndpoint(() => Response.json({ access_token: jwt({ exp: inSeconds(3600) }), refresh_token: "r1", id_token: jwt({ email: "me@example.com", nonce }) }));
    const auth = new ChatGptAuth({ file, fetch });
    let forged: number | undefined;
    await auth.login(async (url) => {
      const authorize = new URL(url);
      nonce = authorize.searchParams.get("nonce");
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "c1", state: "forged", client_id: "oaiapp_evil" }).toString();
      forged = (await globalThis.fetch(callback)).status;
      callback.search = new URLSearchParams({ code: "c1", state: authorize.searchParams.get("state")!, client_id: "oaiapp_new" }).toString();
      void globalThis.fetch(callback);
    });
    expect(forged).toBe(400);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ client_id: "oaiapp_new" });
  });
});
