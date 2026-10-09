import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import type { Report, ServerView } from "../server/server.js";
import { parseArgs, start, usage, type Started } from "../start.js";
import { accountAction, accountRow, appendLog, card, chips, clock, progressLines, rows, type Account, type Line, type Pairing, type Screen } from "./view.js";

// app/main.ts가 아니라 번들(app/dist/main.mjs) 자리 기준이다
const recordings = fileURLToPath(new URL("../../../recordings/", import.meta.url));
const page = fileURLToPath(new URL("../window.html", import.meta.url));
const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));

let window: BrowserWindow | undefined;
let pairing: Pairing | undefined;
let view: ServerView | undefined;
let account: Account | undefined;
let log: Line[] = [];

function push(): void {
  if (!window || !pairing || !view || !account) return;
  const screen: Screen = {
    chips: chips(view, pairing, account),
    rows: [accountRow(account), ...rows(view, pairing)],
    action: accountAction(account),
    card: card(view.task),
    asking: view.asking,
    log,
  };
  window.webContents.send("screen", screen);
}

function record(text: string): void {
  console.log(`[로그] ${text}`);
  log = appendLog(log, { at: clock(new Date()), text });
}

let auth: Started["auth"] | undefined;
let signingIn = false;

async function refreshAccount(): Promise<void> {
  if (!auth) return;
  account = { service: auth.service, state: await auth.state(), signingIn, canLogin: Boolean(auth.login), canLogout: Boolean(auth.logout) };
  push();
}

async function signIn(): Promise<void> {
  if (!auth?.login || signingIn) return;
  signingIn = true;
  await refreshAccount();
  try {
    await auth.login((url) => shell.openExternal(url));
    report.log(`${auth.service} 로그인`);
  } catch (error) {
    report.log(`${auth.service} 로그인 실패: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    signingIn = false;
  }
  await refreshAccount();
}

async function signOut(): Promise<void> {
  if (!auth?.logout) return;
  await auth.logout();
  report.log(`${auth.service} 로그아웃`);
  await refreshAccount();
}

const report: Report = {
  view: (next) => {
    for (const line of progressLines(view?.task, next.task)) record(line);
    view = next;
    // 요청 중 갱신이 거절되면 토큰이 지워진다. 요청이 끝날 때마다 다시 읽는다
    if (next.asking) push();
    else void refreshAccount();
  },
  log: (line) => {
    record(line);
    push();
  },
};

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args) {
    console.error(usage);
    app.exit(2);
    return;
  }
  await app.whenReady();
  const started: Started = await start(args, recordings, report);
  pairing = { pcName: started.pcName, port: started.server.port, code: args.code };
  view = started.server.view();
  auth = started.auth;
  await refreshAccount();
  console.log(`[대기] ${started.pcName} · 포트 ${started.server.port} · 페어링 코드 ${args.code}${args.trace ? ` · 추적 ${args.trace}` : ""}`);

  ipcMain.on("recheck", () => void started.server.recheck());
  ipcMain.on("stop", () => started.server.stopRequest());
  ipcMain.on("login", () => void signIn());
  ipcMain.on("logout", () => void signOut());
  app.on("window-all-closed", () => {
    window = undefined;
    void started.stop().finally(() => app.quit());
  });

  window = new BrowserWindow({
    width: 860,
    height: 680,
    minWidth: 420,
    minHeight: 480,
    title: "마비서",
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  window.removeMenu();
  window.webContents.on("did-finish-load", push);
  await window.loadFile(page);
}

// 최상위 await로 기다리지 않는다. ESM 진입 모듈의 평가가 끝나야 ready가 오므로 whenReady가 영영 풀리지 않는다
main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`[오류] ${error instanceof Error ? error.message : String(error)}`);
  app.exit(1);
});
