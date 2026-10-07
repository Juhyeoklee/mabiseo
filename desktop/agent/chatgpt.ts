import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Auth, AuthState } from "./agent.js";

// 오픈소스 · 로컬 앱용 셀프 등록. dynamic_agent_client로 시작하면 콜백에 이 설치만의 oaiapp_ client_id가 실려 온다(developers.openai.com/siwc)
const authorizeUrl = "https://auth.openai.com/api/accounts/authorize";
const tokenUrl = "https://auth.openai.com/api/accounts/oauth/token";
const resource = "https://api.openai.com/v1";
const scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const loginTimeoutMs = 10 * 60_000;
const refreshMarginMs = 120_000;

const tokenReply = z.looseObject({ access_token: z.string(), refresh_token: z.string(), id_token: z.string() });
const refreshReply = z.object({ access_token: z.string(), refresh_token: z.string().optional(), id_token: z.string().optional() });
const savedFile = tokenReply.extend({ client_id: z.string() });

type Saved = z.infer<typeof savedFile>;

export interface ChatGptAuthOptions {
  file?: string;
  fetch?: typeof fetch;
}

export class ChatGptAuth implements Auth {
  readonly service = "ChatGPT";
  private readonly file: string;
  private readonly fetch: typeof fetch;

  constructor(options: ChatGptAuthOptions = {}) {
    this.file = options.file ?? join(homedir(), ".config", "mabiseo", "chatgpt.json");
    this.fetch = options.fetch ?? fetch;
  }

  async state(): Promise<AuthState> {
    const saved = await this.read();
    if (!saved) return { signedIn: false };
    const email = claims(saved.id_token)["email"];
    return { signedIn: true, account: typeof email === "string" ? email : "로그인됨" };
  }

  async credential(): Promise<string | undefined> {
    const saved = await this.read();
    if (!saved) return undefined;
    if (Number(claims(saved.access_token)["exp"]) * 1000 - Date.now() > refreshMarginMs) return saved.access_token;
    const response = await this.fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refresh_token, client_id: saved.client_id, resource }),
    });
    if (response.status === 400 || response.status === 401) {
      await this.logout();
      return undefined;
    }
    if (!response.ok) throw new Error(`ChatGPT 토큰 갱신 실패: HTTP ${response.status}`);
    const reply = refreshReply.safeParse(await response.json());
    if (!reply.success) throw new Error("ChatGPT 토큰 갱신 응답에 access_token이 없다");
    const { access_token, refresh_token = saved.refresh_token, id_token = saved.id_token } = reply.data;
    const next = { ...saved, access_token, refresh_token, id_token, saved_at: new Date().toISOString() };
    await this.write(next);
    return next.access_token;
  }

  async login(open: (url: string) => Promise<void>): Promise<AuthState> {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    const nonce = randomBytes(16).toString("base64url");
    const hostId = `urn:uuid:${randomUUID()}`;
    let redirectUri = "";

    const callback = new Promise<URLSearchParams>((resolve, reject) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") return void response.writeHead(404).end();
        if (url.searchParams.get("state") !== state) return void response.writeHead(400).end();
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("마비서 로그인을 받았습니다. 이 창은 닫아도 됩니다.");
        finish(() => resolve(url.searchParams));
      });
      const timer = setTimeout(() => finish(() => reject(new Error("ChatGPT 로그인 시간이 지났다"))), loginTimeoutMs);
      const finish = (settle: () => void): void => {
        clearTimeout(timer);
        server.close();
        server.closeAllConnections();
        settle();
      };
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
        const query = new URLSearchParams({
          client_id: "dynamic_agent_client",
          agent_name_hint: "mabiseo",
          ext_agent_host_id: hostId,
          response_type: "code",
          redirect_uri: redirectUri,
          scope,
          resource,
          state,
          nonce,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        });
        open(`${authorizeUrl}?${query}`).catch((error: unknown) => finish(() => reject(error)));
      });
    });

    const params = await callback;
    const error = params.get("error");
    if (error) throw new Error(`ChatGPT 로그인 거절: ${error}`);
    const code = params.get("code");
    const clientId = params.get("client_id");
    if (!code || !clientId) throw new Error("ChatGPT 로그인 콜백에 code나 client_id가 없다");

    const response = await this.fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier, redirect_uri: redirectUri, resource }),
    });
    if (!response.ok) throw new Error(`ChatGPT 토큰 교환 실패: HTTP ${response.status}`);
    const reply = tokenReply.safeParse(await response.json());
    if (!reply.success) throw new Error("ChatGPT 토큰 응답에 필요한 토큰이 없다");
    if (claims(reply.data.id_token)["nonce"] !== nonce) throw new Error("ChatGPT 로그인의 nonce가 맞지 않는다");
    await this.write({ ...reply.data, client_id: clientId, ext_agent_host_id: hostId, saved_at: new Date().toISOString() });
    return this.state();
  }

  async logout(): Promise<AuthState> {
    await rm(this.file, { force: true });
    return { signedIn: false };
  }

  private async read(): Promise<Saved | undefined> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    try {
      return savedFile.safeParse(JSON.parse(text)).data;
    } catch {
      return undefined;
    }
  }

  private async write(next: Saved): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
  }
}

function claims(jwt: string): Record<string, unknown> {
  try {
    const payload: unknown = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
