import fs from "node:fs"
import path from "node:path"
import type { ProjectDeployProfile, ProjectPanelDeployConfig } from "../../shared/projects"
import { readPackageJsonScriptNames } from "./project-local-npm"

const DEPLOY_CONFIG_FILENAMES = ["digwis-panel.deploy.json", ".digwis-panel.deploy.json"]

type ResolvedDeployConfig = {
  path?: string
  config?: ProjectPanelDeployConfig
  error?: string
}

function readDeployConfig(projectRoot: string): ResolvedDeployConfig {
  for (const filename of DEPLOY_CONFIG_FILENAMES) {
    const fullPath = path.join(projectRoot, filename)
    if (!fs.existsSync(fullPath)) {
      continue
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as ProjectPanelDeployConfig
      if (parsed.version !== 1) {
        return {
          path: fullPath,
          error: `部署配置 version 仅支持 1，当前为 ${String(parsed.version ?? "unknown")}`,
        }
      }
      return { path: fullPath, config: parsed }
    } catch (error) {
      return {
        path: fullPath,
        error: error instanceof Error ? error.message : "部署配置解析失败",
      }
    }
  }
  return {}
}

export function readProjectDeployProfile(projectRoot: string): ProjectDeployProfile {
  const npmScripts = readPackageJsonScriptNames(projectRoot)
  const configResult = readDeployConfig(projectRoot)
  const config = configResult.config?.deploy
  const configuredScript = config?.script?.trim()
  const recommendedNpmScript =
    configuredScript && npmScripts.includes(configuredScript)
      ? configuredScript
      : npmScripts.includes("deploy:panel")
        ? "deploy:panel"
        : npmScripts.includes("deploy:vps:code")
          ? "deploy:vps:code"
          : npmScripts[0]

  return {
    npmScripts,
    recommendedStrategy:
      config?.strategy === "sftp" || config?.strategy === "local-npm-script"
        ? config.strategy
        : recommendedNpmScript
          ? "local-npm-script"
          : "sftp",
    recommendedNpmScript,
    canInitialize: Boolean(configResult.config?.init),
    configPath: configResult.path ?? null,
    configError: configResult.error ?? null,
    defaultRemoteAppDir: config?.remoteAppDir?.trim() || null,
    defaultRemoteService: config?.remoteService?.trim() || null,
    defaultPublicCheckUrl: config?.publicCheckUrl?.trim() || null,
  }
}

export function readProjectDeployConfig(projectRoot: string): ProjectPanelDeployConfig | null {
  return readDeployConfig(projectRoot).config ?? null
}
