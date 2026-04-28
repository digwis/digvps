import type { ManagedProjectsApi } from "./projects"

export type DigwisIpcError = {
  code: string
  message: string
  details?: unknown
}

export type AuthType = "password" | "privateKey"

export type ConnectionStatus = "idle" | "connected" | "failed"

export type VpsConnectionInput = {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
}

export type VpsConnectionRecord = {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  source?: "manual" | "ssh-config" | "known-hosts"
  status: ConnectionStatus
  lastError?: string | null
  lastConnectedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type DiscoveredHostCandidate = {
  name: string
  host: string
  port: number
  source: "known-hosts"
}

export type SshConfigCandidate = {
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  source: "ssh-config"
  configPath: string
  identityFilePath?: string
}

export type SshConfigMutationInput = {
  configPath: string
  originalName?: string
  name: string
  host: string
  port: number
  username: string
  identityFilePath?: string
}

export type RawSshConfigFile = {
  path: string
  content: string
}

export type ConnectionTestResult = {
  success: boolean
  message: string
  latencyMs: number
  serverFingerprint?: string
  workingDirectory?: string
}

export type SshKeySetupResult = {
  ok: true
  keyPath: string
  publicKeyPath: string
  configPath: string
  privateKey: string
  publicKey: string
  created: boolean
  message: string
}

export type RemoteFileType = "file" | "directory" | "symlink"

export type RemoteFileEntry = {
  name: string
  path: string
  type: RemoteFileType
  size: number
  modifiedAt?: string
}

export type RemoteFileBrowseResult = {
  currentPath: string
  parentPath?: string | null
  rootPath: string
  focusedPath?: string | null
  focusedType?: RemoteFileType | null
  transport?: "helper" | "sftp"
  entries: RemoteFileEntry[]
}

export type RemoteFileReadResult = {
  path: string
  content: string
  size: number
  modifiedAt?: string
}

export type RemoteFileMutationResult = {
  ok: true
  path: string
  message: string
}

export type RemoteTrashEntry = {
  id: string
  name: string
  originalPath: string
  trashedPath: string
  type: RemoteFileType
  size: number
  deletedAt: string
  modifiedAt?: string
}

export type RemoteTrashListResult = {
  rootPath: string
  transport?: "helper" | "sftp"
  entries: RemoteTrashEntry[]
}

export type RemoteFileUploadResult = {
  ok: true
  uploadedCount: number
  message: string
}

export type RemoteFileDownloadInput = {
  path: string
  name: string
  type: RemoteFileType
}

export type RemotePackageStatus = {
  name: string
  /** 远程安装脚本使用的标识，与巡检脚本 PKG 行一致 */
  id: string
  installed: boolean
  version?: string
  command: string
  /** 常见端口或说明占位（如 80/443、5432） */
  portHint?: string
  /** 运行详情摘要：容器数量、PM2 托管数等 */
  detail?: string
  /** systemd 检测到的单元名（如 postgresql@16-main），用于精确重启/停止 */
  systemdUnit?: string
  /** 对 Nginx/Docker/PostgreSQL/PM2：服务是否 active；解释器类通常与已安装一致 */
  running?: boolean
}

export type DependencyInstallResult = {
  ok: boolean
  message: string
  stdout: string
}

export type DependencyUsageProject = {
  projectId: string
  displayName: string
  localPath: string
  reasons: string[]
}

export type DependencyUsageReport = {
  dependencyId: string
  connectionId?: string
  checkedAt: string
  projects: DependencyUsageProject[]
}

export type DependencyServiceAction = "restart" | "stop" | "start"

export type SystemMetric = {
  label: string
  value: string
}

/** 远程脚本采集的实时资源占用（百分比 0–100；网络为估算速率 B/s） */
export type InspectionTelemetry = {
  cpuPercent: number
  cpuIowaitPercent: number
  cpuStealPercent: number
  memoryPercent: number
  diskPercent: number
  inodePercent: number
  loadPercent: number
  netDownBps: number
  netUpBps: number
}

export type InspectionPortCheck = {
  label: string
  port: number
  listening: boolean
}

export type InspectionReachabilityCheck = {
  label: string
  url: string
  ok: boolean
  statusCode?: number
  responseTimeMs?: number
  detail?: string
}

export type RemoteServiceStatus = {
  unit: string
  load: string
  active: string
  sub: string
  description: string
}

export type VpsInspection = {
  connectionId: string
  hostname: string
  os: string
  kernel: string
  uptime: string
  workingDirectory: string
  packageManager?: string
  metrics: SystemMetric[]
  /** 可选：旧版脚本无该段时前端降级为纯文本指标 */
  telemetry?: InspectionTelemetry
  portChecks?: InspectionPortCheck[]
  reachabilityChecks?: InspectionReachabilityCheck[]
  packages: RemotePackageStatus[]
  services?: RemoteServiceStatus[]
  checkedAt: string
}

export type BitcoinPrice = {
  usd: number
  cny: number
  usd_24h_change: number
  cny_24h_change: number
  last_updated_at: number
}

export type SystemUpgradeCheckResult = {
  supported: boolean
  manager: "apt" | "apt-get" | "none"
  upgradableCount: number
  indexRefreshed: boolean
  reason?: string
  /** 远程 stderr 摘要，便于排查 */
  hint?: string
}

export type SystemUpgradeApplyResult = {
  ok: boolean
  likelyRebooting?: boolean
  stdout: string
  message: string
}

export type DigwisApi = {
  projects: ManagedProjectsApi
  vps: {
    listConnections: () => Promise<VpsConnectionRecord[]>
    saveConnection: (payload: VpsConnectionInput) => Promise<VpsConnectionRecord>
    testConnection: (payload: VpsConnectionInput) => Promise<ConnectionTestResult>
    inspectConnection: (payload: VpsConnectionInput, options?: { forceRefresh?: boolean }) => Promise<VpsInspection>
    installDependency: (
      payload: VpsConnectionInput,
      dependencyId: string,
    ) => Promise<DependencyInstallResult>
    inspectDependencyUsage: (
      payload: VpsConnectionInput,
      dependencyId: string,
    ) => Promise<DependencyUsageReport>
    uninstallDependency: (
      payload: VpsConnectionInput,
      dependencyId: string,
    ) => Promise<DependencyInstallResult>
    dependencyServiceAction: (
      payload: VpsConnectionInput,
      options: { dependencyId: string; action: DependencyServiceAction; systemdUnit?: string },
    ) => Promise<DependencyInstallResult>
    checkSystemUpgrades: (payload: VpsConnectionInput) => Promise<SystemUpgradeCheckResult>
    applySystemUpgrade: (
      payload: VpsConnectionInput,
      options: { reboot: boolean },
    ) => Promise<SystemUpgradeApplyResult>
    importLocalConnections: () => Promise<VpsConnectionRecord[]>
    listSshConfigCandidates: () => Promise<SshConfigCandidate[]>
    getRawSshConfig: () => Promise<RawSshConfigFile>
    saveRawSshConfig: (payload: { content: string }) => Promise<RawSshConfigFile>
    createSshConfigCandidate: (payload: SshConfigMutationInput) => Promise<SshConfigCandidate[]>
    updateSshConfigCandidate: (payload: SshConfigMutationInput) => Promise<SshConfigCandidate[]>
    deleteSshConfigCandidate: (payload: { configPath: string; originalName: string }) => Promise<SshConfigCandidate[]>
    listDiscoveredHosts: () => Promise<DiscoveredHostCandidate[]>
    deleteConnection: (id: string) => Promise<{ success: true }>
    createAndInstallSshKey: (payload: VpsConnectionInput) => Promise<SshKeySetupResult>
    browseRemoteFiles: (payload: { connectionId: string; path?: string; forceRefresh?: boolean }) => Promise<RemoteFileBrowseResult>
    readRemoteTextFile: (payload: { connectionId: string; path: string }) => Promise<RemoteFileReadResult>
    writeRemoteTextFile: (payload: { connectionId: string; path: string; content: string }) => Promise<RemoteFileMutationResult>
    createRemoteDirectory: (
      payload: { connectionId: string; parentPath: string; directoryName: string },
    ) => Promise<RemoteFileMutationResult>
    renameRemoteEntry: (payload: { connectionId: string; path: string; nextName: string }) => Promise<RemoteFileMutationResult>
    deleteRemoteEntry: (payload: { connectionId: string; path: string }) => Promise<RemoteFileMutationResult>
    listRemoteTrash: (payload: { connectionId: string }) => Promise<RemoteTrashListResult>
    restoreRemoteTrashEntry: (payload: { connectionId: string; trashId: string }) => Promise<RemoteFileMutationResult>
    purgeRemoteTrashEntry: (payload: { connectionId: string; trashId: string }) => Promise<RemoteFileMutationResult>
    uploadRemoteEntries: (payload: { connectionId: string; remotePath: string }) => Promise<RemoteFileUploadResult>
    downloadRemoteEntry: (payload: { connectionId: string } & RemoteFileDownloadInput) => Promise<RemoteFileMutationResult>
  }
  bitcoin: {
    getPrice: () => Promise<BitcoinPrice>
  }
}
