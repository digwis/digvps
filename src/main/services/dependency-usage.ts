import fs from "node:fs"
import path from "node:path"
import type { DependencyUsageProject, DependencyUsageReport, VpsConnectionInput } from "../../shared/vps"
import type { LocalProjectRecord } from "../../shared/projects"
import { listLocalProjects } from "./db"
import { readProjectDeployConfig } from "./project-deploy-profile"
import { readPackageJsonScriptNames } from "./project-local-npm"

const PYTHON_MARKERS = ["pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock", "uv.lock"]
const DOCKER_MARKERS = ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]
const ENV_MARKERS = [".env", ".env.local", ".env.production", ".env.example", ".env.sample"]

function pushReason(reasons: string[], reason: string) {
  if (!reasons.includes(reason)) {
    reasons.push(reason)
  }
}

function safeRead(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf-8")
  } catch {
    return ""
  }
}

function packageJsonText(projectRoot: string) {
  return safeRead(path.join(projectRoot, "package.json"))
}

function dependencyReasons(project: LocalProjectRecord, dependencyId: string, connectionId?: string): string[] {
  const reasons: string[] = []
  if (connectionId && project.lastConnectionId === connectionId) {
    pushReason(reasons, "当前项目最近一次部署到这台主机")
  }

  const config = readProjectDeployConfig(project.localPath)
  const deploy = config?.deploy
  const init = config?.init
  const scripts = readPackageJsonScriptNames(project.localPath)
  const pkgText = packageJsonText(project.localPath)

  if (init?.remotePackages?.includes(dependencyId)) {
    pushReason(reasons, "初始化配置显式要求安装该依赖")
  }

  switch (dependencyId) {
    case "nodejs":
      if (fs.existsSync(path.join(project.localPath, "package.json"))) {
        pushReason(reasons, "项目包含 package.json")
      }
      if (scripts.some((script) => script.startsWith("deploy:") || script.startsWith("sync:"))) {
        pushReason(reasons, "项目通过 npm 脚本参与部署或同步")
      }
      break
    case "python3":
      if (PYTHON_MARKERS.some((name) => fs.existsSync(path.join(project.localPath, name)))) {
        pushReason(reasons, "项目包含 Python 运行或依赖清单")
      }
      break
    case "docker":
      if (DOCKER_MARKERS.some((name) => fs.existsSync(path.join(project.localPath, name)))) {
        pushReason(reasons, "项目包含 Docker / Compose 文件")
      }
      if (/docker|compose/i.test(pkgText)) {
        pushReason(reasons, "package.json 中出现 Docker / Compose 相关命令")
      }
      break
    case "pm2":
      if ((deploy?.remoteService?.trim() || init?.systemdUnit?.trim()) && scripts.some((script) => /pm2/i.test(script))) {
        pushReason(reasons, "项目存在 PM2 相关脚本")
      } else if (/pm2/i.test(pkgText)) {
        pushReason(reasons, "package.json 中出现 PM2 相关配置")
      }
      break
    case "nginx":
      if (init?.remotePackages?.includes("nginx")) {
        pushReason(reasons, "初始化配置要求 Nginx")
      }
      if (deploy?.publicCheckUrl?.trim()) {
        pushReason(reasons, "项目配置了公网检查地址，通常依赖 Nginx 入口")
      }
      if (/(nginx|reverse proxy|proxy_pass)/i.test(pkgText)) {
        pushReason(reasons, "项目脚本或配置中出现 Nginx / 反向代理关键词")
      }
      break
    case "postgresql": {
      const envSources = [
        JSON.stringify(deploy?.env ?? {}),
        ...ENV_MARKERS.map((name) => safeRead(path.join(project.localPath, name))),
      ].join("\n")
      if (/(postgres(?:ql)?:\/\/|DATABASE_URL|PGHOST|PGPORT|PGUSER|PGDATABASE)/i.test(envSources)) {
        pushReason(reasons, "项目环境配置中出现 PostgreSQL 连接信息")
      }
      break
    }
    default:
      break
  }

  return reasons
}

export async function inspectDependencyUsage(
  payload: VpsConnectionInput,
  dependencyId: string,
): Promise<DependencyUsageReport> {
  const projects = listLocalProjects()
  const matched: DependencyUsageProject[] = []

  for (const project of projects) {
    const reasons = dependencyReasons(project, dependencyId, payload.id)
    if (reasons.length === 0) {
      continue
    }
    matched.push({
      projectId: project.id,
      displayName: project.displayName,
      localPath: project.localPath,
      reasons,
    })
  }

  matched.sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-Hans-CN"))

  return {
    dependencyId,
    connectionId: payload.id,
    checkedAt: new Date().toISOString(),
    projects: matched,
  }
}
