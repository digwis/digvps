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

export type ManagedProjectsApi = {
  listProjects: () => Promise<LocalProjectRecord[]>
  addProjectFromPath: (payload: LocalProjectInput) => Promise<LocalProjectRecord>
  deleteProject: (id: string) => Promise<{ success: true }>
  pickProjectDirectory: () => Promise<string | null>
  listNpmScripts: (projectId: string) => Promise<string[]>
  getDeployProfile: (projectId: string) => Promise<ProjectDeployProfile>
  getProjectRemoteState: (payload: ProjectRemoteStateInput) => Promise<ProjectRemoteState>
  getProjectRemoteDetails: (payload: ProjectRemoteDetailsInput) => Promise<ProjectRemoteDetails>
  getProjectEnv: (payload: ProjectEnvInput) => Promise<ProjectEnvResult>
  saveProjectEnv: (payload: ProjectEnvUpdateInput) => Promise<ProjectEnvResult>
  rotateProjectSecret: (payload: ProjectEnvInput) => Promise<ProjectEnvResult>
  restartProjectService: (payload: ProjectEnvInput) => Promise<ProjectEnvResult>
  saveProjectSiteSettings: (payload: ProjectSiteSettingsInput) => Promise<ProjectSiteSettingsResult>
  initializeProject: (payload: ProjectInitializeInput) => Promise<ProjectDeployResult>
  deployProject: (payload: ProjectDeployInput) => Promise<ProjectDeployResult>
}
