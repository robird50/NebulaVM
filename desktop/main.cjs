const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

let mainWindow = null;
let localServer = null;

const appRoot = () => app.getAppPath();

const preferredIso = () => {
  try {
    return fs
      .readdirSync(app.getPath("downloads"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /win.*x64.*\.iso$/i.test(entry.name))
      .map((entry) => path.join(app.getPath("downloads"), entry.name))
      .sort()
      .at(-1);
  } catch {
    return "";
  }
};

const hostIsReady = () =>
  new Promise((resolve) => {
    const request = http.get(
      "http://127.0.0.1:5174/api/emustar-hyperv/status",
      { timeout: 1200 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });

const startLocalHost = async () => {
  if (await hostIsReady()) {
    return "http://127.0.0.1:5174";
  }

  const dataDirectory = app.getPath("userData");
  process.env.NEBULAVM_DATA_DIR = dataDirectory;
  process.env.NEBULAVM_VM_DIR = path.join(dataDirectory, "vm-disks", "emustar-hyperv");
  process.env.NEBULAVM_HYPERV_SCRIPT = app.isPackaged
    ? path.join(appRoot(), "scripts", "emustar-hyperv.ps1")
    : path.join(appRoot(), "scripts", "emustar-hyperv.ps1");

  const { createServer } = await import("vite");
  localServer = await createServer({
    configFile: path.join(appRoot(), "vite.config.js"),
    root: appRoot(),
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: false,
    },
  });
  await localServer.listen();
  return localServer.resolvedUrls?.local?.[0]?.replace(/\/$/, "") || "http://127.0.0.1:5174";
};

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 720,
    title: "NebulaVM",
    backgroundColor: "#081019",
    icon: path.join(appRoot(), "public", "assets", "nebulavm-emulator-icon.png"),
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      "<style>body{margin:0;background:#081019;color:#eaf5ff;font:600 16px Segoe UI;display:grid;place-items:center;height:100vh}div{text-align:center}strong{display:block;font-size:24px;margin-bottom:10px;color:#67e8f9}</style><div><strong>NebulaVM</strong>Starting EMUSTAR...</div>",
    )}`,
  );

  try {
    const origin = await startLocalHost();
    const launchUrl = new URL(origin);
    launchUrl.searchParams.set("desktop", "1");
    const detectedIso = preferredIso();
    if (detectedIso) {
      launchUrl.searchParams.set("iso", detectedIso);
    }
    await mainWindow.loadURL(launchUrl.toString());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<style>body{margin:0;background:#081019;color:#eaf5ff;font:500 16px Segoe UI;display:grid;place-items:center;height:100vh}main{max-width:680px;padding:32px}h1{color:#fca5a5}code{display:block;background:#111c28;padding:14px;border-radius:6px;white-space:pre-wrap}</style><main><h1>NebulaVM could not start</h1><code>${message.replace(/[&<>]/g, "")}</code></main>`,
      )}`,
    );
    throw error;
  }
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await createWindow();
  }).catch((error) => {
    dialog.showErrorBox("NebulaVM startup failed", error?.message || String(error));
  });

  app.on("activate", () => {
    if (!mainWindow) {
      void createWindow();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    if (localServer) {
      void localServer.close();
      localServer = null;
    }
  });
}
