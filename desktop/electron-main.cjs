const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } = require("electron");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const iconPath = path.join(appRoot, "视频管理器.ico");
const appUrlArgument = process.argv.find((argument) => argument.startsWith("--app-url="));
const serverPidArgument = process.argv.find((argument) => argument.startsWith("--server-pid="));
const appUrl = appUrlArgument
  ? appUrlArgument.slice("--app-url=".length)
  : "http://127.0.0.1:47128";
const serverPid = serverPidArgument
  ? Number(serverPidArgument.slice("--server-pid=".length))
  : 0;

app.setName("视频素材管理器");
app.setAppUserModelId("VideoAssetManager.Desktop");
app.setPath("userData", path.join(appRoot, "data", "ElectronProfile"));

let mainWindow = null;
let tray = null;
let allowQuit = false;
let closePromptOpen = false;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function quitApplication() {
  allowQuit = true;
  app.quit();
}

function createTray() {
  const trayImage = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayImage);
  tray.setToolTip("视频素材管理器");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开视频管理器", click: showMainWindow },
    { type: "separator" },
    { label: "关闭程序", click: quitApplication },
  ]));
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    icon: iconPath,
    title: "视频素材管理器",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#fafafc",
      symbolColor: "#1d1d1f",
      height: 40,
    },
    autoHideMenuBar: true,
    backgroundColor: "#f5f5f7",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("close", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    mainWindow.webContents.send("window:request-close");
  });

  mainWindow.webContents.on("did-finish-load", () => {
    closePromptOpen = false;
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.loadURL(appUrl);
}

ipcMain.on("window:close-choice", (event, choice) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (!["tray", "quit", "cancel"].includes(choice)) return;
  closePromptOpen = false;
  if (choice === "tray") mainWindow.hide();
  if (choice === "quit") quitApplication();
});

ipcMain.on("window:titlebar-theme", (event, theme) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  const dark = theme === "dark";
  mainWindow.setTitleBarOverlay({
    color: dark ? "#1c1c1e" : "#fafafc",
    symbolColor: dark ? "#f5f5f7" : "#1d1d1f",
    height: 40,
  });
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  app.whenReady().then(() => {
    createTray();
    createWindow();
  });
}

app.on("activate", showMainWindow);
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  allowQuit = true;
});
app.on("will-quit", () => {
  tray?.destroy();
  if (hasSingleInstanceLock && Number.isInteger(serverPid) && serverPid > 0) {
    try {
      process.kill(serverPid);
    } catch {}
  }
});
