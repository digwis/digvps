import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readProjectDeployConfig } from "./project-deploy-profile"

const execFileAsync = promisify(execFile)

function expandEnvTemplate(value: string, env: NodeJS.ProcessEnv) {
  return value.replace(/\$\{([A-Z0-9_]+)(:-([^}]*))?\}/gi, (_all, key: string, _fallbackRaw: string, fallback: string) => {
    const fromEnv = env[key]
    if (fromEnv != null && fromEnv !== "") {
      return fromEnv
    }
    return fallback ?? ""
  })
}

function resolveLocalDbUrl(projectPath: string): string {
  const config = readProjectDeployConfig(projectPath)
  const env = {
    ...process.env,
    ...(config?.deploy?.env ?? {}),
  }
  const fromConfig = config?.deploy?.env?.LOCAL_DB_URL ?? config?.deploy?.env?.DATABASE_URL
  const raw = fromConfig || process.env.LOCAL_DB_URL || process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:${PGPORT:-5432}/digwis"
  return expandEnvTemplate(raw, env)
}

export async function readLocalPostgresLsn(projectPath: string): Promise<string | null> {
  const dbUrl = resolveLocalDbUrl(projectPath)
  try {
    const { stdout } = await execFileAsync(
      "psql",
      [dbUrl, "-At", "-v", "ON_ERROR_STOP=1", "-c", "SELECT pg_current_wal_lsn()::text;"],
      { timeout: 8000, cwd: path.resolve(projectPath) },
    )
    const marker = stdout.trim()
    return marker || null
  } catch {
    return null
  }
}
