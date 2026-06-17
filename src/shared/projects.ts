/** 自本机文件夹导入的开发项目（与「仅 SSH 连接」的 VPS 记录区分） */
export type LocalProjectCategory = "local-dev"

/** 面板 SFTP 同步 vs 在本机执行 package.json 脚本（如 digwis 的 deploy:vps:code） */
export type ProjectDeployStrategy = "sftp" | "local-npm-script"

export type LocalProjectRecord = {
  id: string
  displayName: string
  localPath: string
  category: LocalProjectCategory
  /** 上次一键部署使用的 VPS 连接 */
  lastConnectionId?: string | null
  /** 远端实际目录（绝对路径）；「本地脚本」模式可能为空 */
  lastRemotePath?: string | null
  lastDeployAt?: string | null
  lastDeployStatus: "none" | "success" | "failed" | "running"
  lastDeployMessage?: string | null
  /** 上次部署采用的方式 */
  lastDeployKind?: ProjectDeployStrategy | null
  createdAt: string
  updatedAt: string
}

export type LocalProjectInput = {
  localPath: string
  displayName?: string
  category?: LocalProjectCategory
}

export type ProjectScaffoldTemplate = "next-core" | "next-payload" | "next-directus"
export type ProjectScaffoldDatabase = "postgresql" | "sqlite"
export type ProjectPackageManager = "pnpm"
export type ProjectClientTarget = "electron" | "ios-native" | "android-native"
export type ProjectRuntimeModule =
  | "auth"
  | "docs"
  | "dashboard"
  | "blog"
  | "i18n"
  | "search"
  | "queue"
  | "payments"
  | "multi-tenant"
export type ProjectServiceModule = "python-ai" | "python-data" | "go-worker" | "rust-worker"

export type ProjectScaffoldInput = {
  displayName: string
  slug: string
  localPath: string
  packageManager: ProjectPackageManager
  monorepo: boolean
  template: ProjectScaffoldTemplate
  database: ProjectScaffoldDatabase
  clientTargets: ProjectClientTarget[]
  runtimeModules: ProjectRuntimeModule[]
  serviceModules: ProjectServiceModule[]
  autoInstall?: boolean
  autoStart?: boolean
  fullTemplatePull?: boolean
}

export type ProjectRuntimeModulesUpdateInput = {
  projectId: string
  runtimeModules: ProjectRuntimeModule[]
}

export type ProjectScaffoldBootstrap = {
  attempted: boolean
  installOk: boolean
  startOk: boolean
  previewUrl?: string
  healthChecks: Array<{
    name: string
    ok: boolean
    detail?: string
  }>
}

export type ProjectScaffoldProgressStage =
  | "prepare"
  | "template"
  | "register"
  | "install"
  | "start"
  | "admin"
  | "done"
  | "failed"

export type ProjectScaffoldProgressEvent = {
  stage: ProjectScaffoldProgressStage
  status: "running" | "success" | "warning" | "error"
  percent: number
  message: string
  detail?: string
  localPath: string
  displayName: string
  projectId?: string
  at: string
}

export type DigwisProjectAppContract = {
  path: string
  devCommand?: string
  buildCommand?: string
  startCommand?: string
  port?: number
  platform?: "web" | "desktop" | "ios" | "android"
}

export type DigwisProjectServiceContract = {
  enabled: boolean
  path: string
  devCommand?: string
  runtime?: "node" | "python" | "go" | "rust"
}

export type DigwisProjectConfig = {
  version: 1
  projectType: "next-platform"
  template: ProjectScaffoldTemplate
  packageManager: ProjectPackageManager
  monorepo: boolean
  database: ProjectScaffoldDatabase
  clientTargets: ProjectClientTarget[]
  runtimeModules: ProjectRuntimeModule[]
  serviceModules: ProjectServiceModule[]
  apps: {
    web: DigwisProjectAppContract
    desktop?: DigwisProjectAppContract
    mobileIos?: DigwisProjectAppContract
    mobileAndroid?: DigwisProjectAppContract
  }
  services: {
    cms?: (DigwisProjectServiceContract & {
      type: "payload" | "directus"
    })
    pythonAi?: DigwisProjectServiceContract
    pythonData?: DigwisProjectServiceContract
    goWorker?: DigwisProjectServiceContract
    rustWorker?: DigwisProjectServiceContract
  }
  panel: {
    previewUrl: string
    adminUrl: string
  }
}

export type ProjectScaffoldResult = {
  ok: boolean
  message: string
  project: LocalProjectRecord
  localPath: string
  createdFiles: string[]
  warnings: string[]
  contract: DigwisProjectConfig
  bootstrap?: ProjectScaffoldBootstrap
}

export type ProjectRuntimeModulesUpdateResult = {
  ok: boolean
  message: string
  contract: DigwisProjectConfig
  createdFiles: string[]
  warnings: string[]
}

/** Directus sidecar 默认管理端（与 Next 预览端口 3000 分离） */
export const DIRECTUS_LOCAL_ADMIN_URL = "http://127.0.0.1:8055/admin"

export function resolveProjectPanelAdminUrl(
  config: Pick<DigwisProjectConfig, "services" | "panel">,
  fallback?: string,
): string {
  if (config.services?.cms?.type === "directus") {
    return DIRECTUS_LOCAL_ADMIN_URL
  }
  const fromPanel = config.panel?.adminUrl?.trim()
  if (fromPanel) {
    return fromPanel
  }
  if (fallback?.trim()) {
    return fallback.trim()
  }
  const preview = config.panel?.previewUrl?.trim() || "http://127.0.0.1:3000"
  return `${preview.replace(/\/$/, "")}/admin`
}

export type ProjectLocalPreview = {
  url: string
  webPath: string
  adminUrl?: string
}

export type ProjectLocalDevStartResult = {
  ok: boolean
  message: string
  pid?: number
  previewUrl: string
}

export type ProjectLocalAdminStartResult = {
  ok: boolean
  message: string
  adminUrl: string
}

export type ProjectUrlReachabilityResult = {
  ok: boolean
  detail: string
  status?: number
  finalUrl?: string
}

export type ProjectClientAppInput = {
  projectId: string
  target: ProjectClientTarget
}

export type ProjectClientAppOpenResult = {
  ok: true
  target: ProjectClientTarget
  path: string
}

export type ProjectClientAppStartResult = {
  ok: true
  message: string
  target: ProjectClientTarget
  path: string
  pid?: number
}

export type ProjectClientAppIdeOpenResult = {
  ok: true
  target: ProjectClientTarget
  path: string
  application: "Xcode" | "Android Studio"
}

export type ProjectLocalPathUpdateInput = {
  projectId: string
  localPath: string
}

export type ProjectDeleteInput = {
  projectId: string
  removeLocalDirectory?: boolean
}

export type ProjectDeleteResult = {
  success: true
  removedLocalDirectory: boolean
  localPath?: string
}

export type ProjectPanelDeployConfig = {
  version: 1
  deploy?: {
    strategy?: ProjectDeployStrategy
    script?: string
    remoteAppDir?: string
    remoteService?: string
    publicCheckUrl?: string
    env?: Record<string, string>
  }
  init?: {
    remotePackages?: string[]
    envTemplate?: string
    systemdUnit?: string
  }
}

export type ProjectDeployProfile = {
  npmScripts: string[]
  recommendedStrategy: ProjectDeployStrategy
  recommendedNpmScript?: string
  canInitialize: boolean
  configPath?: string | null
  configError?: string | null
  defaultRemoteAppDir?: string | null
  defaultRemoteService?: string | null
  defaultPublicCheckUrl?: string | null
}

export type ProjectRemoteStateInput = {
  projectId: string
  connectionId: string
}

export type ProjectRemoteState = {
  canInitialize: boolean
  ready: boolean
  missingItems: string[]
  runtimeIssues: string[]
  checkedAt: string
}

export type ProjectRemoteFileEntry = {
  name: string
  path: string
  type: "file" | "directory" | "symlink"
  size: number
  modifiedAt?: string
}

export type ProjectRemoteServiceStatus = {
  configured: boolean
  unit?: string | null
  active: boolean
  enabled: boolean
  statusText: string
}

export type ProjectRemoteSiteStatus = {
  mode: "none" | "port" | "domain"
  domain?: string | null
  previewPort?: number | null
  sslEnabled: boolean
  sslMode?: "none" | "letsencrypt" | "custom"
  customCertificateConfigured?: boolean
  certificatePem?: string | null
  nginxInstalled: boolean
  certbotInstalled: boolean
  configPath?: string | null
}

export type ProjectRemoteDetailsInput = {
  projectId: string
  connectionId: string
  browsePath?: string
  forceRefresh?: boolean
}

export type ProjectRemoteDetails = {
  remoteAppDir: string
  currentPath: string
  pathExists: boolean
  appPort?: number | null
  previewUrl?: string | null
  publicUrl?: string | null
  files: ProjectRemoteFileEntry[]
  service: ProjectRemoteServiceStatus
  site: ProjectRemoteSiteStatus
  checkedAt: string
}

export type ProjectSiteSettingsInput = {
  projectId: string
  connectionId: string
  domain?: string
  sslEmail?: string
  certificatePem?: string
  privateKeyPem?: string
}

export type ProjectSiteSettingsResult = {
  ok: boolean
  message: string
  previewUrl?: string | null
  publicUrl?: string | null
}

export type ProjectDeployInput = {
  projectId: string
  connectionId: string
  /** 默认 sftp：面板用 SSH 同步文件 */
  strategy?: ProjectDeployStrategy
  /** strategy 为 local-npm-script 时必填，且须为 package.json scripts 中的键名 */
  npmScript?: string
  /** 远端父目录，留空则使用登录用户主目录下的 digwis-panel-projects（仅 SFTP 模式） */
  remoteParentPath?: string
}

export type ProjectInitializeInput = {
  projectId: string
  connectionId: string
}

export type ProjectEnvInput = {
  projectId: string
  connectionId: string
}

export type ProjectEnvUpdateInput = ProjectEnvInput & {
  content: string
}

export type ProjectEnvResult = {
  ok: boolean
  message: string
  content?: string
}

export type ProjectDeployResult = {
  ok: boolean
  message: string
  remotePath?: string
  durationMs: number
  kind?: ProjectDeployStrategy
}

export type ProjectOperationResult = {
  ok: boolean
  message: string
  durationMs: number
}

export type ProjectDeployLogEvent = {
  projectId: string
  script?: string
  stream: "stdout" | "stderr" | "system"
  chunk: string
  at: string
}

export type ProjectOperationLogEntry = {
  id: string
  projectId: string
  stream: "stdout" | "stderr" | "system"
  chunk: string
  at: string
}

export type ProjectOperationLogAppendInput = {
  projectId: string
  stream: "stdout" | "stderr" | "system"
  chunk: string
}

export type RemoteManagedProjectPathSource =
  | "systemd"
  | "pm2"
  | "docker"
  | "heuristic"
  | "unknown"

export type RemoteManagedProject = {
  id: string
  connectionId: string
  domain: string
  nginxConfigPath: string
  proxyTarget: string
  projectPath?: string
  pathSource: RemoteManagedProjectPathSource
  serviceName?: string
  runtimeType?: "node" | "pm2" | "docker" | "unknown"
  status: "ok" | "warning" | "unknown"
  statusText: string
}

export type RemoteManagedProjectScanInput = {
  connectionId: string
}

export type RemoteManagedProjectScanResult = {
  connectionId: string
  projects: RemoteManagedProject[]
  scannedAt: string
}

export type OpenClawInstanceStatus =
  | "running"
  | "stopped"
  | "failed"
  | "unknown"

export type OpenClawInstance = {
  id: string
  connectionId: string
  host: string
  listenPort: number
  dataDir: string
  serviceName: string
  nodeVersion?: string
  openclawVersion?: string
  status: OpenClawInstanceStatus
  installedAt: string
  lastCheckedAt?: string
  lastLog?: string
}

export type OpenClawPrecheckReason =
  | "node_missing"
  | "node_too_old"
  | "memory_low"
  | "port_in_use"
  | "systemd_missing"
  | "instance_limit_reached"

export type OpenClawPrecheck = {
  ready: boolean
  reasons: OpenClawPrecheckReason[]
  nodeVersion?: string
  memoryAvailableMb?: number
  existingInstances: number
  portInUse: boolean
}

export type OpenClawInstallInput = {
  connectionId: string
  listenPort: number
}

export type OpenClawUninstallInput = {
  connectionId: string
  instanceId: string
}

export type OpenClawRestartInput = {
  connectionId: string
  instanceId: string
}

export type OpenClawLogsInput = {
  connectionId: string
  instanceId: string
  lines: number
}

export type ProjectActionKind = "code" | "data" | "uploads" | "backup"
export type ProjectBackupSchedule = "off" | "daily" | "weekly" | "monthly"

export type ProjectActionHint = {
  action: ProjectActionKind
  needsAttention: boolean
  reason: string
  lastRunAt?: string | null
  localChangedAt?: string | null
}

export type ProjectActionHints = {
  projectId: string
  checkedAt: string
  hints: ProjectActionHint[]
}

export type ProjectBackupScheduleState = {
  projectId: string
  schedule: ProjectBackupSchedule
  nextRunAt?: string | null
  lastRunAt?: string | null
}

export type ProjectMigrationInput = {
  projectId: string
  sourceConnectionId: string
  targetConnectionId: string
}

export type ProjectMigrationResult = ProjectOperationResult & {
  targetConnectionId?: string
  targetRemotePath?: string
  sourceDisabled: boolean
}

export type ManagedProjectsApi = {
  listProjects: () => Promise<LocalProjectRecord[]>
  addProjectFromPath: (payload: LocalProjectInput) => Promise<LocalProjectRecord>
  createProjectScaffold: (payload: ProjectScaffoldInput) => Promise<ProjectScaffoldResult>
  onScaffoldProgress: (handler: (event: ProjectScaffoldProgressEvent) => void) => () => void
  scanRemoteProjects: (payload: RemoteManagedProjectScanInput) => Promise<RemoteManagedProjectScanResult>
  listOpenClawInstances: (connectionId: string) => Promise<OpenClawInstance[]>
  precheckOpenClawInstall: (payload: OpenClawInstallInput) => Promise<OpenClawPrecheck>
  installOpenClaw: (payload: OpenClawInstallInput) => Promise<OpenClawInstance>
  uninstallOpenClaw: (payload: OpenClawUninstallInput) => Promise<{ ok: true }>
  restartOpenClaw: (payload: OpenClawRestartInput) => Promise<{ ok: true }>
  fetchOpenClawLogs: (payload: OpenClawLogsInput) => Promise<string>
  getProjectConfig: (projectId: string) => Promise<DigwisProjectConfig | null>
  setProjectRuntimeModules: (payload: ProjectRuntimeModulesUpdateInput) => Promise<ProjectRuntimeModulesUpdateResult>
  updateProjectLocalPath: (payload: ProjectLocalPathUpdateInput) => Promise<LocalProjectRecord>
  deleteProject: (payload: ProjectDeleteInput) => Promise<ProjectDeleteResult>
  pickProjectDirectory: () => Promise<string | null>
  listNpmScripts: (projectId: string) => Promise<string[]>
  getProjectLocalPreview: (projectId: string) => Promise<ProjectLocalPreview>
  openProjectLocalPreview: (projectId: string) => Promise<ProjectLocalPreview>
  openProjectLocalAdmin: (projectId: string) => Promise<ProjectLocalPreview>
  startProjectLocalDev: (projectId: string) => Promise<ProjectLocalDevStartResult>
  startProjectLocalAdminService: (projectId: string) => Promise<ProjectLocalAdminStartResult>
  checkProjectUrlReachable: (url: string) => Promise<ProjectUrlReachabilityResult>
  openProjectClientAppPath: (payload: ProjectClientAppInput) => Promise<ProjectClientAppOpenResult>
  startProjectClientApp: (payload: ProjectClientAppInput) => Promise<ProjectClientAppStartResult>
  openProjectClientAppIde: (payload: ProjectClientAppInput) => Promise<ProjectClientAppIdeOpenResult>
  getDeployProfile: (projectId: string) => Promise<ProjectDeployProfile>
  getProjectRemoteState: (payload: ProjectRemoteStateInput) => Promise<ProjectRemoteState>
  getProjectRemoteDetails: (payload: ProjectRemoteDetailsInput) => Promise<ProjectRemoteDetails>
  getProjectEnv: (payload: ProjectEnvInput) => Promise<ProjectEnvResult>
  saveProjectEnv: (payload: ProjectEnvUpdateInput) => Promise<ProjectEnvResult>
  rotateProjectSecret: (payload: ProjectEnvInput) => Promise<ProjectEnvResult>
  restartProjectService: (payload: ProjectEnvInput) => Promise<ProjectEnvResult>
  stopProjectService: (payload: ProjectEnvInput) => Promise<ProjectEnvResult>
  saveProjectSiteSettings: (payload: ProjectSiteSettingsInput) => Promise<ProjectSiteSettingsResult>
  initializeProject: (payload: ProjectInitializeInput) => Promise<ProjectDeployResult>
  deployProject: (payload: ProjectDeployInput) => Promise<ProjectDeployResult>
  getProjectActionHints: (projectId: string) => Promise<ProjectActionHints>
  getProjectBackupSchedule: (projectId: string) => Promise<ProjectBackupScheduleState>
  setProjectBackupSchedule: (
    payload: { projectId: string; schedule: ProjectBackupSchedule },
  ) => Promise<ProjectBackupScheduleState>
  runProjectBackup: (payload: ProjectEnvInput) => Promise<ProjectOperationResult>
  migrateProject: (payload: ProjectMigrationInput) => Promise<ProjectMigrationResult>
  listOperationLogs: (payload?: { limit?: number }) => Promise<ProjectOperationLogEntry[]>
  appendProjectOperationLog: (payload: ProjectOperationLogAppendInput) => Promise<ProjectOperationLogEntry>
  onDeployLog: (handler: (event: ProjectDeployLogEvent) => void) => () => void
}
