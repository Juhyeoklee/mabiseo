import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import type { Report, ServerView } from "../server/server.js";
import { parseArgs, start, usage, type Started } from "../start.js";
import { appendLog, rows, stamp, type Pairing } from "./view.js";

// app/main.ts가 아니라 번들(app/dist/main.mjs) 자리 기준이다
const recordings = fileURLToPath(new URL("../../../recordings/", import.meta.url));
const page = fileURLToPath(new URL("../window.html", import.meta.url));
const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));

let window: BrowserWindow | undefined;
let pairing: Pairing | undefined;
let view: ServerView | undefined;
let log: string[] = [];

function push(): void {
  if (!window || !pairing || !view) return;
  window.webContents.send("screen", { rows: rows(view, pairing), log });
}

const report: Report = {
  view: (next) => {
    view = next;
    push();
  },
  log: (line) => {
    console.log(`[로그] ${line}`);
    log = appendLog(log, stamp(line, new Date()));
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
  console.log(`[대기] ${started.pcName} · 포트 ${started.server.port} · 페어링 코드 ${args.code}${args.trace ? ` · 추적 ${args.trace}` : ""}`);

  ipcMain.on("recheck", () => void started.server.recheck());
  app.on("window-all-closed", () => {
    window = undefined;
    void started.stop().finally(() => app.quit());
  });

  window = new BrowserWindow({
    width: 460,
    height: 600,
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
