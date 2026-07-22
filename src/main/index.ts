import { app, BrowserWindow, ipcMain, Menu, screen } from "./electron-shim"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  closeDatabase,
  getVpsConnectionInput,
  initializeDatabase,
  listConnections,
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
import { registerSettingsHandlers } from "./ipc/register-settings-handlers"
import { registerVpsHandlers } from "./ipc/register-vps-handlers"


const isDev = !!process.env.ELECTRON_RENDERER_URL
const appDisplayName = "OpenVPS"
const aboutPanelCopyright = "西山懒懒翁"
const appDisplayVersion = "0.01"
const userDataDirectoryName = "OpenVPS"
const currentDir = path.dirname(fileURLToPath(import.meta.url))

function getAppIconPath() {
  const appBundleResource = path.join(process.resourcesPath, "openvps.png")
  if (fs.existsSync(appBundleResource)) {
    return appBundleResource
  }
  return path.join(app.getAppPath(), "resources", "openvps.png")
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

function migrateFromLegacyAppData() {
  const legacyDir = path.join(app.getPath("appData"), "digwis-panel")
  if (!fs.existsSync(legacyDir)) {
    return
  }

  const userDataPath = app.getPath("userData")
  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true })
  }

  const fileMigrations: Array<{ legacyName: string; currentName: string }> = [
    { legacyName: "project-action-state.json", currentName: "project-action-state.json" },
    { legacyName: "project-operation-log.ndjson", currentName: "project-operation-log.ndjson" },
  ]

  for (const { legacyName, currentName } of fileMigrations) {
    const legacyFile = path.join(legacyDir, legacyName)
    const currentFile = path.join(userDataPath, currentName)

    if (!fs.existsSync(legacyFile)) {
      continue
    }

    const currentStats = fs.existsSync(currentFile) ? fs.statSync(currentFile) : null
    if (currentStats && currentStats.size > 0) {
      console.log(`Migration skipped: ${currentName} already exists with data`)
      continue
    }

    try {
      fs.copyFileSync(legacyFile, currentFile)
      console.log(`Migrated legacy data: ${legacyName} -> ${currentName}`)
    } catch (error) {
      console.error(`Failed to migrate ${legacyName}:`, error)
    }
  }
}

function migrateLegacyDatabase(userDataPath: string) {
  const currentDb = path.join(userDataPath, "openvps.sqlite")
  const legacyDatabases = [
    path.join(app.getPath("appData"), "CloudRoost", "cloudroost.sqlite"),
    path.join(app.getPath("appData"), "digwis-panel", "digwis-panel.sqlite"),
  ]
  const legacyDb = legacyDatabases.find((candidate) => fs.existsSync(candidate))

  if (!legacyDb) {
    return
  }

  if (listConnections().length > 0) {
    console.log("Migration skipped: current database already has VPS connections")
    return
  }

  try {
    closeDatabase()
    fs.copyFileSync(legacyDb, currentDb)
    initializeDatabase(userDataPath)
    console.log(`Migrated legacy database: ${legacyDb} -> openvps.sqlite`)
  } catch (error) {
    console.error("Failed to migrate legacy database:", error)
    initializeDatabase(userDataPath)
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
  migrateFromLegacyAppData()
  Menu.setApplicationMenu(null)
  const userDataPath = app.getPath("userData")
  initializeDatabase(userDataPath)
  migrateLegacyDatabase(userDataPath)
  initializeProjectActionState(userDataPath)
  initializeProjectOperationLog(userDataPath)
  registerProjectHandlers()
  registerSettingsHandlers()
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
