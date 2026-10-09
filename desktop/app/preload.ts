import { contextBridge, ipcRenderer } from "electron";
import type { Screen } from "./view.js";

contextBridge.exposeInMainWorld("mabiseo", {
  onScreen: (listener: (screen: Screen) => void) => ipcRenderer.on("screen", (_event, screen: Screen) => listener(screen)),
  recheck: () => ipcRenderer.send("recheck"),
  login: () => ipcRenderer.send("login"),
  logout: () => ipcRenderer.send("logout"),
  stop: () => ipcRenderer.send("stop"),
});
