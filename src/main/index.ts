import { app, BrowserWindow, ipcMain, Menu, screen } from "./electron-shim"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  getVpsConnectionInput,
  initializeDatabase,
  listLocalProjects,
} from "./services/db"
import { disposeAllRemoteFileSessions } from "./services/remote-files"
import { disposeAllRemoteInspectionSessions } from "./services/remote-inspection-session-manager"
import { fetchBitcoinPrice } from "./services/bitcoin"

import {
  initializeProjectActionState,
  markProjectActionRun,
} from "./services/project-action-state"
import {
  initializeProjectOperationLog,
} from "./services/project-operation-log"

import { resolveStoredPayload } from "./ipc/helpers"

import { registerProjectHandlers } from "./ipc/register-project-handlers"
import { registerVpsHandlers } from "./ipc/register-vps-handlers"


const isDev = !!process.env.ELECTRON_RENDERER_URL
const appDisplayName = "CloudRoost"
const aboutPanelCopyright = "西山懒懒翁"
const appDisplayVersion = "0.01"
const userDataDirectoryName = "CloudRoost"
const currentDir = path.dirname(fileURLToPath(import.meta.url))

function getAppIconPath() {
  const appBundleResource = path.join(process.resourcesPath, "cloud-roost.png")
  if (fs.existsSync(appBundleResource)) {
    return appBundleResource
  }
  return path.join(app.getAppPath(), "resources", "cloud-roost.png")
}

function configureAppIdentity() {
  const iconPath = getAppIconPath()
  const userDataPath = path.join(app.getPath("appData"), userDataDirectoryName)

  app.setPath("userData", userDataPath)
  app.setAboutPanelOptions({
    applicationName: appDisplayName,
    applicationVersion: appDisplayVersion,
    copyright: aboutPanelCopyright,
    iconPath: fs.existsSync(iconPath) ? iconPath : undefined,
  })

  if (process.platform === "darwin" && app.dock && fs.existsSync(iconPath)) {
    app.dock.setIcon(iconPath)
  }
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea
  const iconPath = getAppIconPath()

  const window = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    title: appDisplayName,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0d0f14",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(currentDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process gone:", details)
  })

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("Preload failed:", preloadPath, error)
  })

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error("Renderer failed to load:", {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    })
  })

  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") {
      return
    }

    const key = input.key.toLowerCase()
    const isReloadShortcut =
      key === "f5" ||
      ((input.meta || input.control) && key === "r")

    if (isReloadShortcut) {
      event.preventDefault()
    }
  })

  window.webContents.on("will-navigate", (event) => {
    event.preventDefault()
  })

  window.once("ready-to-show", () => {
    window.maximize()
    window.show()
  })

  if (isDev) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL!)
    window.webContents.openDevTools({ mode: "detach" })
  } else {
    window.loadFile(path.join(currentDir, "../renderer/index.html"))
  }
}

app.whenReady().then(() => {
  configureAppIdentity()
  Menu.setApplicationMenu(null)
  const userDataPath = app.getPath("userData")
  initializeDatabase(userDataPath)
  initializeProjectActionState(userDataPath)
  initializeProjectOperationLog(userDataPath)
  registerProjectHandlers()
  registerVpsHandlers()

  ipcMain.handle("bitcoin:get-price", async () => {
    return fetchBitcoinPrice()
  })

  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", () => {
  void disposeAllRemoteFileSessions()
  void disposeAllRemoteInspectionSessions()
})
