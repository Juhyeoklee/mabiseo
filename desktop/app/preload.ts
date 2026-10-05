import { contextBridge, ipcRenderer } from "electron";
import type { Row } from "./view.js";

contextBridge.exposeInMainWorld("mabiseo", {
  onScreen: (listener: (screen: { rows: Row[]; log: string[] }) => void) =>
    ipcRenderer.on("screen", (_event, screen: { rows: Row[]; log: string[] }) => listener(screen)),
  recheck: () => ipcRenderer.send("recheck"),
});
