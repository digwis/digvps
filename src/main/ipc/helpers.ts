import { randomUUID } from "node:crypto"
import { getConnectionSecrets } from "../services/db"
import type { ProjectActionKind } from "../../shared/projects"
import type { VpsConnectionInput } from "../../shared/vps"

export function resolveActionKindFromScript(script?: string): ProjectActionKind | null {
  if (!script) {
    return null
  }
  if (script === "deploy:panel" || script === "deploy:vps:code") {
    return "code"
  }
  if (script === "sync:vps:admin-data" || script === "sync:vps:data" || script === "sync:vps") {
    return "data"
  }
  if (script === "sync:vps:uploads" || script === "sync:uploads:vps") {
    return "uploads"
  }
  if (script === "backup:vps" || script === "backup") {
    return "backup"
  }
  return null
}

export function ensureSavedPayload(payload: VpsConnectionInput) {
  const existingSecrets = payload.id ? getConnectionSecrets(payload.id) : null
  const normalizedPassword = payload.password?.trim() ? payload.password : undefined
  const normalizedPrivateKey = payload.privateKey?.trim() ? payload.privateKey : undefined
  const normalizedPassphrase =
    payload.passphrase && payload.passphrase.length > 0 ? payload.passphrase : undefined

  return {
    ...payload,
    id: payload.id ?? randomUUID(),
    password:
      payload.authType === "password"
        ? normalizedPassword ?? existingSecrets?.password
        : undefined,
    privateKey:
      payload.authType === "privateKey"
        ? normalizedPrivateKey ?? existingSecrets?.privateKey
        : undefined,
    passphrase:
      payload.authType === "privateKey"
        ? normalizedPassphrase ?? existingSecrets?.passphrase
        : undefined,
  }
}

export function resolveStoredPayload(payload: VpsConnectionInput) {
  const secrets = payload.id ? getConnectionSecrets(payload.id) : null

  return payload.id
    ? {
        ...payload,
        ...(secrets ?? {}),
      }
    : payload
}

export function buildProjectScriptEnv(args: {
  projectId: string
  projectPath: string
  connection: VpsConnectionInput
  configRemoteAppDir?: string | null
  configRemoteService?: string | null
  configPublicCheckUrl?: string | null
  configEnv?: Record<string, string>
}): NodeJS.ProcessEnv {
  const {
    projectId,
    projectPath,
    connection,
    configRemoteAppDir,
    configRemoteService,
    configPublicCheckUrl,
    configEnv,
  } = args
  const base: NodeJS.ProcessEnv = {
    DIGWIS_PANEL: "1",
    DIGWIS_PANEL_PROJECT_ID: projectId,
    DIGWIS_PANEL_PROJECT_PATH: projectPath,
    VPS_CONNECTION_NAME: connection.name,
    VPS_HOST: connection.host,
    VPS_PORT: String(connection.port),
    VPS_USER: connection.username,
    VPS_AUTH_TYPE: connection.authType,
    REMOTE_APP_DIR: configRemoteAppDir ?? undefined,
    REMOTE_SERVICE: configRemoteService ?? undefined,
    PUBLIC_CHECK_URL: configPublicCheckUrl ?? undefined,
  }

  if (connection.authType === "password") {
    base.VPS_PASSWORD = connection.password
  } else {
    base.VPS_PRIVATE_KEY = connection.privateKey
    base.VPS_PASSPHRASE = connection.passphrase
  }

  for (const [key, value] of Object.entries(configEnv ?? {})) {
    base[key] = value
  }

  return base
}
