import path from "node:path"
import fs from "node:fs"
import { randomUUID } from "node:crypto"
import Database from "better-sqlite3"
import electron from "electron"
const { safeStorage } = electron
import type { VpsConnectionInput, VpsConnectionRecord } from "../../shared/vps"
import type {
  LocalProjectCategory,
  LocalProjectInput,
  LocalProjectRecord,
  ProjectDeployStrategy,
} from "../../shared/projects"

type ConnectionRow = {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth_type: "password" | "privateKey"
  source: "manual" | "ssh-config"
  password: string | null
  private_key: string | null
  passphrase: string | null
  status: "idle" | "connected" | "failed"
  last_error: string | null
  last_connected_at: string | null
  created_at: string
  updated_at: string
}

let db: Database.Database | null = null

function encryptSecret(value?: string) {
  if (!value) {
    return null
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return value
  }

  return `enc:${safeStorage.encryptString(value).toString("base64")}`
}

function decryptSecret(value: string | null) {
  if (!value) {
    return undefined
  }

  if (!value.startsWith("enc:")) {
    return value
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return undefined
  }

  return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"))
}

function getDbFile(userDataPath: string) {
  return path.join(userDataPath, "digwis-panel.sqlite")
}

export function initializeDatabase(userDataPath: string) {
  if (db) {
    return db
  }

  db = new Database(getDbFile(userDataPath))
  db.pragma("journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS vps_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      password TEXT,
      private_key TEXT,
      passphrase TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      last_connected_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const columns = db.prepare("PRAGMA table_info(vps_connections)").all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === "source")) {
    db.exec("ALTER TABLE vps_connections ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';")
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS local_projects (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      local_path TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'local-dev',
      last_connection_id TEXT,
      last_remote_path TEXT,
      last_deploy_at TEXT,
      last_deploy_status TEXT NOT NULL DEFAULT 'none',
      last_deploy_message TEXT,
      last_deploy_kind TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const localProjectColumns = db.prepare("PRAGMA table_info(local_projects)").all() as Array<{ name: string }>
  if (!localProjectColumns.some((column) => column.name === "last_deploy_kind")) {
    db.exec("ALTER TABLE local_projects ADD COLUMN last_deploy_kind TEXT;")
  }

  return db
}

function mapRecord(row: ConnectionRow): VpsConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type,
    source: row.source,
    status: row.status,
    lastError: row.last_error,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listConnections() {
  const rows = db!
    .prepare(
      `
      SELECT *
      FROM vps_connections
      ORDER BY
        CASE status
          WHEN 'connected' THEN 0
          WHEN 'failed' THEN 1
          ELSE 2
        END,
        updated_at DESC
      `,
    )
    .all() as ConnectionRow[]

  return rows.map(mapRecord)
}

export function saveConnection(record: VpsConnectionInput & { id: string }) {
  const now = new Date().toISOString()
  const existing = db!
    .prepare("SELECT created_at FROM vps_connections WHERE id = ?")
    .get(record.id) as { created_at: string } | undefined

  db!
    .prepare(
      `
      INSERT INTO vps_connections (
        id, name, host, port, username, auth_type, password, private_key, passphrase,
        source, status, last_error, last_connected_at, created_at, updated_at
      ) VALUES (
        @id, @name, @host, @port, @username, @authType, @password, @privateKey, @passphrase,
        @source, 'idle', NULL, NULL, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        host = excluded.host,
        port = excluded.port,
        username = excluded.username,
        auth_type = excluded.auth_type,
        source = excluded.source,
        password = excluded.password,
        private_key = excluded.private_key,
        passphrase = excluded.passphrase,
        updated_at = excluded.updated_at
      `,
    )
    .run({
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      authType: record.authType,
      source: "source" in record && record.source ? record.source : "manual",
      password: encryptSecret(record.password),
      privateKey: encryptSecret(record.privateKey),
      passphrase: encryptSecret(record.passphrase),
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    })

  const row = db!
    .prepare("SELECT * FROM vps_connections WHERE id = ?")
    .get(record.id) as ConnectionRow

  return mapRecord(row)
}

export function getConnectionSecrets(id: string) {
  const row = db!
    .prepare(
      "SELECT password, private_key, passphrase FROM vps_connections WHERE id = ?",
    )
    .get(id) as
    | {
        password: string | null
        private_key: string | null
        passphrase: string | null
      }
    | undefined

  if (!row) {
    return null
  }

  return {
    password: decryptSecret(row.password),
    privateKey: decryptSecret(row.private_key),
    passphrase: decryptSecret(row.passphrase),
  }
}

export function updateConnectionHealth(
  id: string,
  payload: { status: VpsConnectionRecord["status"]; lastError?: string | null },
) {
  const now = new Date().toISOString()
  db!
    .prepare(
      `
      UPDATE vps_connections
      SET
        status = @status,
        last_error = @lastError,
        last_connected_at = CASE WHEN @status = 'connected' THEN @updatedAt ELSE last_connected_at END,
        updated_at = @updatedAt
      WHERE id = @id
      `,
    )
    .run({
      id,
      status: payload.status,
      lastError: payload.lastError ?? null,
      updatedAt: now,
    })
}

export function deleteConnection(id: string) {
  db!.prepare("DELETE FROM vps_connections WHERE id = ?").run(id)
}

export function getVpsConnectionInput(id: string): VpsConnectionInput | null {
  const row = db!
    .prepare("SELECT * FROM vps_connections WHERE id = ?")
    .get(id) as ConnectionRow | undefined
  if (!row) {
    return null
  }
  const secrets = getConnectionSecrets(id)
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type,
    password: secrets?.password,
    privateKey: secrets?.privateKey,
    passphrase: secrets?.passphrase,
  }
}

type LocalProjectRow = {
  id: string
  display_name: string
  local_path: string
  category: string
  last_connection_id: string | null
  last_remote_path: string | null
  last_deploy_at: string | null
  last_deploy_status: string
  last_deploy_message: string | null
  last_deploy_kind: string | null
  created_at: string
  updated_at: string
}

function mapLocalProject(row: LocalProjectRow): LocalProjectRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    localPath: row.local_path,
    category: row.category as LocalProjectCategory,
    lastConnectionId: row.last_connection_id,
    lastRemotePath: row.last_remote_path,
    lastDeployAt: row.last_deploy_at ?? undefined,
    lastDeployStatus: row.last_deploy_status as LocalProjectRecord["lastDeployStatus"],
    lastDeployMessage: row.last_deploy_message,
    lastDeployKind: (row.last_deploy_kind as ProjectDeployStrategy | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listLocalProjects(): LocalProjectRecord[] {
  const rows = db!
    .prepare("SELECT * FROM local_projects ORDER BY updated_at DESC")
    .all() as LocalProjectRow[]
  return rows.map(mapLocalProject)
}

export function getLocalProject(id: string): LocalProjectRecord | null {
  const row = db!.prepare("SELECT * FROM local_projects WHERE id = ?").get(id) as LocalProjectRow | undefined
  return row ? mapLocalProject(row) : null
}

export function addLocalProjectFromPath(payload: LocalProjectInput): LocalProjectRecord {
  const resolved = path.resolve(payload.localPath.trim())
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new Error("本地路径不存在或无法访问")
  }
  if (!stat.isDirectory()) {
    throw new Error("请选择文件夹（目录）作为项目根路径")
  }

  const displayName = (payload.displayName?.trim() || path.basename(resolved)).slice(0, 200)
  const category: LocalProjectCategory = payload.category ?? "local-dev"
  const id = randomUUID()
  const now = new Date().toISOString()

  try {
    db!
      .prepare(
        `
        INSERT INTO local_projects (
          id, display_name, local_path, category,
          last_connection_id, last_remote_path, last_deploy_at,
          last_deploy_status, last_deploy_message, created_at, updated_at
        ) VALUES (
          @id, @displayName, @localPath, @category,
          NULL, NULL, NULL,
          'none', NULL, @createdAt, @updatedAt
        )
      `,
      )
      .run({
        id,
        displayName,
        localPath: resolved,
        category,
        createdAt: now,
        updatedAt: now,
      })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.includes("UNIQUE")) {
      throw new Error("该本地路径已在项目管理中")
    }
    throw error
  }

  return getLocalProject(id)!
}

export function deleteLocalProject(id: string) {
  db!.prepare("DELETE FROM local_projects WHERE id = ?").run(id)
}

export function updateLocalProjectDeployResult(
  id: string,
  payload: {
    connectionId: string
    remotePath?: string
    status: "success" | "failed"
    message: string
    deployKind?: ProjectDeployStrategy | null
  },
) {
  const now = new Date().toISOString()
  db!
    .prepare(
      `
      UPDATE local_projects SET
        last_connection_id = @connectionId,
        last_remote_path = @remotePath,
        last_deploy_at = @deployAt,
        last_deploy_status = @status,
        last_deploy_message = @message,
        last_deploy_kind = @deployKind,
        updated_at = @updatedAt
      WHERE id = @id
    `,
    )
    .run({
      id,
      connectionId: payload.connectionId,
      remotePath: payload.remotePath ?? null,
      deployAt: now,
      status: payload.status,
      message: payload.message.slice(0, 2000),
      deployKind: payload.deployKind ?? null,
      updatedAt: now,
    })
}

export function importDiscoveredConnections(records: Array<VpsConnectionInput & { source: "ssh-config" }>) {
  for (const record of records) {
    const existing = db!
      .prepare(
        "SELECT id FROM vps_connections WHERE host = ? AND port = ? AND username = ?",
      )
      .get(record.host, record.port, record.username) as { id: string } | undefined

    saveConnection({
      ...record,
      id: existing?.id ?? randomUUID(),
    })
  }

  return listConnections()
}
