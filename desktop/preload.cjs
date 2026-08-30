const { contextBridge, ipcRenderer } = require("electron");

const allowedChoices = new Set(["tray", "quit", "cancel"]);

contextBridge.exposeInMainWorld("videoManagerWindow", {
  onCloseRequested(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = () => callback();
    ipcRenderer.on("window:request-close", handler);
    return () => ipcRenderer.removeListener("window:request-close", handler);
  },
  respondToClose(choice) {
    if (allowedChoices.has(choice)) ipcRenderer.send("window:close-choice", choice);
  },
  setTitleBarTheme(theme) {
    if (["light", "dark"].includes(theme)) ipcRenderer.send("window:titlebar-theme", theme);
  },
});
