import { contextBridge, ipcRenderer } from "electron";
import type { Action, Row } from "./view.js";

interface Screen {
  rows: Row[];
  action: Action | undefined;
  log: string[];
}

contextBridge.exposeInMainWorld("mabiseo", {
  onScreen: (listener: (screen: Screen) => void) => ipcRenderer.on("screen", (_event, screen: Screen) => listener(screen)),
  recheck: () => ipcRenderer.send("recheck"),
  login: () => ipcRenderer.send("login"),
  logout: () => ipcRenderer.send("logout"),
});
