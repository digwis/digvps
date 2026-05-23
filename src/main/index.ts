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
import { readPackageJsonScriptNames, runLocalNpmScript } from "./services/project-local-npm"
import {
  getProjectBackupSchedule,
  initializeProjectActionState,
  markProjectActionRun,
  markProjectBackupRun,
} from "./services/project-action-state"
import {
  initializeProjectOperationLog,
} from "./services/project-operation-log"
import { readProjectDeployConfig } from "./services/project-deploy-profile"
import { buildProjectScriptEnv, resolveStoredPayload } from "./ipc/helpers"
import { runProjectRemoteBackup } from "./services/project-backup"
import { registerProjectHandlers } from "./ipc/register-project-handlers"
import { registerVpsHandlers } from "./ipc/register-vps-handlers"
import type { ProjectBackupSchedule } from "../shared/projects"

const isDev = !!process.env.ELECTRON_RENDERER_URL
const appDisplayName = "digwis-panel"
const aboutPanelCopyright = "西山懒懒翁"
const appDisplayVersion = "0.01"
const userDataDirectoryName = "digwis-panel"
let backupScheduler: NodeJS.Timeout | null = null
const runningBackupProjects = new Set<string>()
const currentDir = path.dirname(fileURLToPath(import.meta.url))

function getAppIconPath() {
  const appBundleResource = path.join(process.resourcesPath, "digwis-panel.png")
  if (fs.existsSync(appBundleResource)) {
    return appBundleResource
  }
  return path.join(app.getAppPath(), "resources", "digwis-panel.png")
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

function backupDue(schedule: ProjectBackupSchedule, nextRunAt?: string | null) {
  if (schedule === "off" || !nextRunAt) {
    return false
  }
  return new Date(nextRunAt).getTime() <= Date.now()
}

async function runDueBackupTasks() {
  const projects = listLocalProjects()
  for (const project of projects) {
    const backup = getProjectBackupSchedule(project.id)
    if (!backupDue(backup.schedule, backup.nextRunAt)) {
      continue
    }
    if (runningBackupProjects.has(project.id)) {
      continue
    }
    runningBackupProjects.add(project.id)
    try {
      if (!project.lastConnectionId) {
        markProjectBackupRun(project.id)
        continue
      }
      const connection = getVpsConnectionInput(project.lastConnectionId)
      if (!connection) {
        markProjectBackupRun(project.id)
        continue
      }
      const config = readProjectDeployConfig(project.localPath)
      const scripts = readPackageJsonScriptNames(project.localPath)
      const backupScript = scripts.includes("backup:vps") ? "backup:vps" : scripts.includes("backup") ? "backup" : null
      if (!backupScript) {
        const remoteAppDir = project.lastRemotePath || config?.deploy?.remoteAppDir?.trim()
        if (!remoteAppDir) {
          markProjectBackupRun(project.id)
          continue
        }
        const result = await runProjectRemoteBackup({
          connection: resolveStoredPayload(connection),
          projectId: project.id,
          remoteAppDir,
        })
        if (result.ok) {
          markProjectActionRun(project.id, "backup")
        }
        markProjectBackupRun(project.id)
        continue
      }
      const result = await runLocalNpmScript(project.localPath, backupScript, {
        timeoutMs: 2 * 60 * 60 * 1000,
        env: buildProjectScriptEnv({
          projectId: project.id,
          projectPath: project.localPath,
          connection: resolveStoredPayload(connection),
          configRemoteAppDir: config?.deploy?.remoteAppDir?.trim() || undefined,
          configRemoteService: config?.deploy?.remoteService?.trim() || undefined,
          configPublicCheckUrl: config?.deploy?.publicCheckUrl?.trim() || undefined,
          configEnv: config?.deploy?.env,
        }),
      })
      if (result.ok) {
        markProjectActionRun(project.id, "backup")
      }
      markProjectBackupRun(project.id)
    } catch {
      markProjectBackupRun(project.id)
    } finally {
      runningBackupProjects.delete(project.id)
    }
  }
}

app.whenReady().then(() => {
  configureAppIdentity()
  Menu.setApplicationMenu(null)
  const userDataPath = app.getPath("userData")
  initializeDatabase(userDataPath)
  initializeProjectActionState(userDataPath)
  initializeProjectOperationLog(userDataPath)
  void runDueBackupTasks()
  backupScheduler = setInterval(() => {
    void runDueBackupTasks()
  }, 60_000)
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
  if (backupScheduler) {
    clearInterval(backupScheduler)
    backupScheduler = null
  }
  void disposeAllRemoteFileSessions()
  void disposeAllRemoteInspectionSessions()
})
