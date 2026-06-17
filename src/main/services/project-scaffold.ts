import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import { addLocalProjectFromPath, listLocalProjects } from "./db"
import { repairProjectNativeModules } from "./project-native-module-fix"
import { readProjectLocalRuntime, writeProjectLocalRuntime } from "./project-local-runtime"
import { appendOperationLog } from "./project-operation-log"
import type {
  DigwisProjectConfig,
  LocalProjectRecord,
  ProjectClientTarget,
  ProjectRuntimeModule,
  ProjectRuntimeModulesUpdateResult,
  ProjectScaffoldInput,
  ProjectScaffoldProgressEvent,
  ProjectScaffoldResult,
  ProjectScaffoldTemplate,
} from "../../shared/projects"
import { DIRECTUS_LOCAL_ADMIN_URL } from "../../shared/projects"

type ScaffoldContext = {
  rootPath: string
  projectName: string
  slug: string
  template: ProjectScaffoldTemplate
  database: ProjectScaffoldInput["database"]
  webPort: number
  clientTargets: Set<ProjectScaffoldInput["clientTargets"][number]>
  runtimeModules: Set<ProjectScaffoldInput["runtimeModules"][number]>
  serviceModules: Set<ProjectScaffoldInput["serviceModules"][number]>
}

type ScaffoldProgressReporter = (event: ProjectScaffoldProgressEvent) => void

type CreateProjectScaffoldOptions = {
  onProgress?: ScaffoldProgressReporter
}

const DEFAULT_PAYLOAD_PUBLISHED_VERSION = "3.84.1"
const DEFAULT_WEB_PORT = 3000
const MAX_WEB_PORT = 3999
const LIGHT_RUNTIME_MODULES = ["docs", "dashboard", "blog", "i18n"] as const

type LightRuntimeModule = (typeof LIGHT_RUNTIME_MODULES)[number]

function toPosixPath(value: string) {
  return value.split(path.sep).join("/")
}

function buildLocalPreviewUrl(port: number) {
  return `http://127.0.0.1:${port}`
}

function buildLocalAdminUrl(port: number) {
  return `${buildLocalPreviewUrl(port)}/admin`
}

function writeTextFile(rootPath: string, relativePath: string, content: string, createdFiles: string[]) {
  const absolutePath = path.join(rootPath, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, content, "utf8")
  createdFiles.push(toPosixPath(relativePath))
}

function emitScaffoldProgress(
  reporter: ScaffoldProgressReporter | undefined,
  input: Omit<ProjectScaffoldProgressEvent, "at">,
) {
  reporter?.({
    ...input,
    at: new Date().toISOString(),
  })
}

function logScaffoldOperation(projectId: string | undefined, chunk: string, stream: "stdout" | "stderr" | "system") {
  if (!projectId) {
    return
  }
  appendOperationLog({
    projectId,
    stream,
    chunk,
  })
}

function ensureScaffoldRoot(localPath: string) {
  const resolved = path.resolve(localPath.trim())
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) {
      throw new Error("项目路径已存在且不是目录")
    }
    const entries = fs.readdirSync(resolved)
    if (entries.length > 0) {
      throw new Error("项目路径已存在内容，请选择一个空目录或新目录")
    }
  } else {
    fs.mkdirSync(resolved, { recursive: true })
  }
  return resolved
}

function isPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, "127.0.0.1")
  })
}

function readAssignedWebPort(projectPath: string) {
  const runtime = readProjectLocalRuntime(projectPath)
  if (runtime?.previewUrl) {
    try {
      const preview = new URL(runtime.previewUrl)
      const port = Number(preview.port)
      if (Number.isInteger(port) && port > 0) {
        return port
      }
    } catch {
      // ignore invalid runtime URL and fall back to contract parsing
    }
  }
  const contractPath = path.join(projectPath, "digwis-project.json")
  if (!fs.existsSync(contractPath)) {
    return null
  }
  try {
    const raw = fs.readFileSync(contractPath, "utf8")
    const parsed = JSON.parse(raw) as DigwisProjectConfig
    if (typeof parsed.apps?.web?.port === "number") {
      return parsed.apps.web.port
    }
    if (parsed.panel?.previewUrl) {
      const preview = new URL(parsed.panel.previewUrl)
      const port = Number(preview.port)
      return Number.isInteger(port) && port > 0 ? port : null
    }
  } catch {
    return null
  }
  return null
}

async function allocateWebPort() {
  const reservedPorts = new Set<number>()
  for (const project of listLocalProjects()) {
    const port = readAssignedWebPort(project.localPath)
    if (port) {
      reservedPorts.add(port)
    }
  }

  for (let port = DEFAULT_WEB_PORT; port <= MAX_WEB_PORT; port += 1) {
    if (reservedPorts.has(port)) {
      continue
    }
    if (await isPortAvailable(port)) {
      return port
    }
  }

  throw new Error(`没有找到可用的本地 Web 端口（已尝试 ${DEFAULT_WEB_PORT}-${MAX_WEB_PORT}）`)
}

function envWithExtraPath(): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return process.env
  }
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
  const existing = (process.env.PATH ?? "")
    .split(":")
    .map((item) => item.trim())
    .filter(Boolean)
  const merged: string[] = []
  const seen = new Set<string>()
  for (const entry of [...extra, ...existing]) {
    if (!seen.has(entry)) {
      seen.add(entry)
      merged.push(entry)
    }
  }
  return { ...process.env, PATH: merged.join(":") }
}

function runCommand(
  projectRoot: string,
  command: string,
  timeoutMs: number,
  options?: { onOutput?: (line: string, stream: "stdout" | "stderr") => void },
) {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/c", command], { cwd: projectRoot, env: envWithExtraPath() })
        : spawn("/bin/bash", ["-lc", `cd "${projectRoot.replace(/"/g, '\\"')}" && ${command}`], {
            env: envWithExtraPath(),
          })
    let combined = ""
    let pendingStdout = ""
    let pendingStderr = ""
    const flushBuffer = (buffer: string, stream: "stdout" | "stderr") => {
      const normalized = buffer.replace(/\r/g, "")
      const parts = normalized.split("\n")
      const remainder = parts.pop() ?? ""
      for (const part of parts) {
        const line = part.trim()
        if (line) {
          options?.onOutput?.(line, stream)
        }
      }
      return remainder
    }
    const append = (chunk: Buffer | string, stream: "stdout" | "stderr") => {
      const text = chunk.toString()
      combined += text
      if (combined.length > 24_000) {
        combined = combined.slice(-18_000)
      }
      if (stream === "stdout") {
        pendingStdout = flushBuffer(pendingStdout + text, stream)
      } else {
        pendingStderr = flushBuffer(pendingStderr + text, stream)
      }
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      resolve({ ok: false, output: "command timeout" })
    }, timeoutMs)
    child.stdout?.on("data", (chunk) => append(chunk, "stdout"))
    child.stderr?.on("data", (chunk) => append(chunk, "stderr"))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: error instanceof Error ? error.message : "command failed" })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const stdoutTail = pendingStdout.trim()
      const stderrTail = pendingStderr.trim()
      if (stdoutTail) {
        options?.onOutput?.(stdoutTail, "stdout")
      }
      if (stderrTail) {
        options?.onOutput?.(stderrTail, "stderr")
      }
      resolve({ ok: code === 0, output: combined.trim() })
    })
  })
}

function resolveDetachedDevCommand(contract: DigwisProjectConfig) {
  return "npm run dev"
}

function startDevServerDetached(projectRoot: string) {
  const runtimeDir = path.join(projectRoot, ".digwis-panel")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const logPath = path.join(runtimeDir, "local-dev.log")
  const logFd = fs.openSync(logPath, "a")
  const contractPath = path.join(projectRoot, "digwis-project.json")
  let devCommand = "npm run dev"
  if (fs.existsSync(contractPath)) {
    try {
      const raw = fs.readFileSync(contractPath, "utf8")
      devCommand = resolveDetachedDevCommand(JSON.parse(raw) as DigwisProjectConfig)
    } catch {
      devCommand = "npm run dev"
    }
  }
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/c", devCommand], {
          cwd: projectRoot,
          env: envWithExtraPath(),
          detached: true,
          stdio: ["ignore", logFd, logFd],
        })
      : spawn("/bin/bash", ["-lc", `cd "${projectRoot.replace(/"/g, '\\"')}" && ${devCommand}`], {
          env: envWithExtraPath(),
          detached: true,
          stdio: ["ignore", logFd, logFd],
        })
  fs.closeSync(logFd)
  child.unref()
  return {
    pid: child.pid ?? null,
    logPath,
  }
}

function buildNpmFallbackInstallCommand(contract: DigwisProjectConfig) {
  const webPath = contract.apps?.web?.path?.trim() || "apps/web"
  if (webPath === "." || webPath === "./") {
    return "npm install"
  }
  return `npm install --prefix ${JSON.stringify(webPath)}`
}

function waitForHttp(url: string, timeoutMs: number) {
  const startedAt = Date.now()
  return new Promise<boolean>((resolve) => {
    const loop = () => {
      if (Date.now() - startedAt > timeoutMs) {
        resolve(false)
        return
      }
      const req = httpRequest(url, { method: "GET", timeout: 2500 }, (res) => {
        const status = res.statusCode ?? 0
        res.resume()
        if (status > 0 && status < 600) {
          resolve(true)
          return
        }
        setTimeout(loop, 1200)
      })
      req.on("error", () => setTimeout(loop, 1200))
      req.on("timeout", () => {
        req.destroy()
        setTimeout(loop, 1200)
      })
      req.end()
    }
    loop()
  })
}

async function waitForPreviewUrlFromLog(logPath: string, timeoutMs: number) {
  const startedAt = Date.now()
  const patterns = [
    /Local:\s+(http:\/\/localhost:\d+)/i,
    /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/i,
    /Local:\s+(http:\/\/\[::1\]:\d+)/i,
  ]
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(logPath)) {
      const raw = fs.readFileSync(logPath, "utf8")
      for (const pattern of patterns) {
        const match = raw.match(pattern)
        if (match?.[1]) {
          return match[1].replace("http://localhost:", "http://127.0.0.1:").replace("http://[::1]:", "http://127.0.0.1:")
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return null
}

function resolveAdminUrlFromPreview(previewUrl: string, fallbackAdminUrl?: string) {
  if (!fallbackAdminUrl) {
    return `${previewUrl.replace(/\/$/, "")}/admin`
  }
  try {
    const preview = new URL(previewUrl)
    const admin = new URL(fallbackAdminUrl)
    if (admin.port === "8055") {
      return fallbackAdminUrl
    }
    admin.protocol = preview.protocol
    admin.hostname = preview.hostname
    admin.port = preview.port
    return admin.toString().replace(/\/$/, "")
  } catch {
    return fallbackAdminUrl
  }
}

async function pullPayloadFullTemplate(targetPath: string, payloadVersion: string) {
  const command = [
    "set -e",
    "tmp_tar=$(mktemp /tmp/payload-website-XXXXXX.tar.gz)",
    `curl -fsSL "https://codeload.github.com/payloadcms/payload/tar.gz/refs/tags/v${payloadVersion}" -o "$tmp_tar"`,
    `tar -xzf "$tmp_tar" -C "${targetPath.replace(/"/g, '\\"')}" --strip-components=3 payload-${payloadVersion}/templates/website`,
    'rm -f "$tmp_tar"',
  ].join(" && ")
  return await runCommand(targetPath, command, 10 * 60 * 1000)
}

function patchPayloadFolderApiCompatibility(projectRoot: string) {
  const mediaPath = path.join(projectRoot, "src", "collections", "Media.ts")
  if (fs.existsSync(mediaPath)) {
    let media = fs.readFileSync(mediaPath, "utf8")
    if (media.includes("createFolderField")) {
      media = media.replace(/import \{ createFolderField \} from 'payload'\n/, "")
      media = media.replace(/\n    createFolderField\(\{ relationTo: 'folders' \}\),/, "")
      if (!media.includes("folders: true,")) {
        media = media.replace(
          /export const Media: CollectionConfig = \{\n  slug: 'media',/,
          "export const Media: CollectionConfig = {\n  slug: 'media',\n  folders: true,",
        )
      }
      fs.writeFileSync(mediaPath, media, "utf8")
    }
  }

  const payloadConfigPath = path.join(projectRoot, "src", "payload.config.ts")
  if (fs.existsSync(payloadConfigPath)) {
    let payloadConfig = fs.readFileSync(payloadConfigPath, "utf8")
    if (payloadConfig.includes("slug: 'folders'")) {
      payloadConfig = payloadConfig.replace(
        /  collections: \[\n    \{\n      slug: 'folders',[\s\S]*?\n    \},\n    Pages,/,
        "  collections: [Pages,",
      )
      fs.writeFileSync(payloadConfigPath, payloadConfig, "utf8")
    }
  }
}

async function resolvePayloadPublishedVersion(projectRoot: string) {
  const result = await runCommand(projectRoot, "npm view payload version", 60_000)
  if (result.ok) {
    const version = result.output.trim().split(/\s+/).pop()?.trim()
    if (version) {
      return version
    }
  }
  return DEFAULT_PAYLOAD_PUBLISHED_VERSION
}

async function normalizePayloadTemplatePackageJson(projectRoot: string) {
  const packageJsonPath = path.join(projectRoot, "package.json")
  if (!fs.existsSync(packageJsonPath)) {
    return {
      changed: false,
      version: DEFAULT_PAYLOAD_PUBLISHED_VERSION,
      replacedPackages: [] as string[],
      detail: "package.json not found",
    }
  }
  const raw = fs.readFileSync(packageJsonPath, "utf8")
  const parsed = JSON.parse(raw) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const payloadVersion = await resolvePayloadPublishedVersion(projectRoot)
  const replacedPackages: string[] = []
  let changed = false
  for (const section of ["dependencies", "devDependencies"] as const) {
    const current = parsed[section]
    if (!current) {
      continue
    }
    for (const [packageName, packageVersion] of Object.entries(current)) {
      if (packageVersion === "workspace:*") {
        current[packageName] = payloadVersion
        replacedPackages.push(packageName)
        changed = true
      }
    }
  }
  if (changed) {
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  }
  return {
    changed,
    version: payloadVersion,
    replacedPackages,
    detail: changed
      ? `workspace deps rewritten to ${payloadVersion}: ${replacedPackages.join(", ")}`
      : "no workspace deps found",
  }
}

function buildFullPayloadEnv(input: ProjectScaffoldInput, secret: string, webPort: number) {
  const previewUrl = buildLocalPreviewUrl(webPort)
  return [
    `DATABASE_URL=${input.database === "postgresql" ? `postgresql://postgres:postgres@127.0.0.1:5432/${input.slug}` : "file:./local.db"}`,
    `PAYLOAD_SECRET=${secret}`,
    `NEXT_PUBLIC_SERVER_URL=${previewUrl}`,
    `NEXT_PUBLIC_APP_URL=${previewUrl}`,
    `CRON_SECRET=${randomBytes(24).toString("hex")}`,
    `PREVIEW_SECRET=${randomBytes(24).toString("hex")}`,
    "",
  ].join("\n")
}

function buildClientAppsContract(input: ProjectScaffoldInput) {
  return {
    desktop: input.clientTargets.includes("electron")
      ? {
          path: "apps/desktop",
          platform: "desktop" as const,
          devCommand: "pnpm --filter desktop dev",
          buildCommand: "pnpm --filter desktop build",
          startCommand: "pnpm --filter desktop start",
        }
      : undefined,
    mobileIos: input.clientTargets.includes("ios-native")
      ? {
          path: "apps/mobile-ios",
          platform: "ios" as const,
        }
      : undefined,
    mobileAndroid: input.clientTargets.includes("android-native")
      ? {
          path: "apps/mobile-android",
          platform: "android" as const,
        }
      : undefined,
  }
}

function ensurePayloadTsconfigBaseUrl(projectRoot: string) {
  const tsconfigPath = path.join(projectRoot, "tsconfig.json")
  if (!fs.existsSync(tsconfigPath)) {
    return
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(tsconfigPath, "utf8")) as {
      compilerOptions?: Record<string, unknown>
    }
    const compilerOptions = parsed.compilerOptions ?? {}
    if (compilerOptions.baseUrl === ".") {
      return
    }
    parsed.compilerOptions = {
      ...compilerOptions,
      baseUrl: ".",
    }
    fs.writeFileSync(tsconfigPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  } catch {
    // ignore invalid tsconfig
  }
}

function ensureNextConfigAllowsLoopback(projectRoot: string) {
  const nextConfigCandidates = ["next.config.ts", "next.config.js", "next.config.mjs"]
    .map((filename) => path.join(projectRoot, filename))
    .filter((filename) => fs.existsSync(filename))
  for (const configPath of nextConfigCandidates) {
    const raw = fs.readFileSync(configPath, "utf8")
    if (raw.includes("allowedDevOrigins")) {
      return
    }
    const nextConfigMatch = raw.match(/const\s+nextConfig\s*:\s*NextConfig\s*=\s*\{/)
    if (!nextConfigMatch) {
      continue
    }
    const patched = raw.replace(
      nextConfigMatch[0],
      `${nextConfigMatch[0]}\n  allowedDevOrigins: ["127.0.0.1", "localhost"],`,
    )
    if (patched !== raw) {
      fs.writeFileSync(configPath, patched, "utf8")
    }
    return
  }
}

async function patchFullPayloadTemplate(projectRoot: string, input: ProjectScaffoldInput, webPort: number) {
  const packageJsonPath = path.join(projectRoot, "package.json")
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error("Payload 模板缺少 package.json")
  }

  const raw = fs.readFileSync(packageJsonPath, "utf8")
  const pkg = JSON.parse(raw) as {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    workspaces?: string[]
    packageManager?: string
  }

  const payloadVersion = await resolvePayloadPublishedVersion(projectRoot)
  const dependencies = { ...(pkg.dependencies ?? {}) }
  const devDependencies = { ...(pkg.devDependencies ?? {}) }
  const replacedPackages: string[] = []

  for (const current of [dependencies, devDependencies]) {
    for (const [packageName, packageVersion] of Object.entries(current)) {
      if (packageVersion === "workspace:*") {
        current[packageName] = payloadVersion
        replacedPackages.push(packageName)
      }
    }
  }

  delete dependencies["@payloadcms/db-mongodb"]
  if (input.database === "postgresql") {
    dependencies["@payloadcms/db-postgres"] = payloadVersion
    dependencies.pg = dependencies.pg || "^8.16.3"
  } else {
    dependencies["@payloadcms/db-sqlite"] = payloadVersion
  }

  pkg.dependencies = dependencies
  pkg.devDependencies = devDependencies
  pkg.scripts = { ...(pkg.scripts ?? {}) }
  if (pkg.scripts.dev) {
    pkg.scripts.dev = `next dev --hostname 127.0.0.1 --port ${webPort}`
  }
  if (pkg.scripts.start) {
    pkg.scripts.start = `next start --hostname 127.0.0.1 --port ${webPort}`
  }
  addDesktopScripts(pkg.scripts, input.clientTargets)
  pkg.workspaces = Array.from(new Set([...(pkg.workspaces ?? []), ...buildWorkspacePatterns()]))
  pkg.packageManager = pkg.packageManager ?? "pnpm@10"
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8")

  writePayloadCmsTemplate(input.database, "src", (relativePath, content) => {
    if (
      relativePath.endsWith("collections/Users.ts")
      || relativePath.endsWith("collections/Media.ts")
      || relativePath.endsWith("collections/Categories.ts")
      || relativePath.endsWith("collections/Pages.ts")
      || relativePath.endsWith("collections/Posts.ts")
    ) {
      return
    }
    const absolutePath = path.join(projectRoot, relativePath)
    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
      fs.writeFileSync(absolutePath, content, "utf8")
    }
  })

  const payloadConfigPath = path.join(projectRoot, "src", "payload.config.ts")
  if (fs.existsSync(payloadConfigPath)) {
    let payloadConfig = fs.readFileSync(payloadConfigPath, "utf8")
    payloadConfig = payloadConfig.replace(
      /import\s+\{\s*mongooseAdapter\s*\}\s+from\s+['"]@payloadcms\/db-mongodb['"]/,
      input.database === "postgresql"
        ? `import { postgresAdapter } from '@payloadcms/db-postgres'`
        : `import { sqliteAdapter } from '@payloadcms/db-sqlite'`,
    )
    payloadConfig = payloadConfig.replace(
      /db:\s*mongooseAdapter\(\{\s*url:\s*process\.env\.DATABASE_URL,\s*\}\),/m,
      input.database === "postgresql"
        ? `db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL || "",
    },
  }),`
        : `db: sqliteAdapter({
    client: {
      url: process.env.DATABASE_URL || "file:./local.db",
    },
  }),`,
    )
    payloadConfig = payloadConfig.replace(
      /import sharp from 'sharp'\n/,
      `let sharp: typeof import('sharp').default | undefined\ntry {\n  sharp = (await import('sharp')).default\n} catch {\n  sharp = undefined\n}\n`,
    )
    fs.writeFileSync(payloadConfigPath, payloadConfig, "utf8")
  }
  ensureNextConfigAllowsLoopback(projectRoot)
  ensurePayloadTsconfigBaseUrl(projectRoot)
  patchPayloadFolderApiCompatibility(projectRoot)

  const secret = randomBytes(24).toString("hex")
  const envContent = buildFullPayloadEnv(input, secret, webPort)
  fs.writeFileSync(path.join(projectRoot, ".env"), envContent, "utf8")
  fs.writeFileSync(
    path.join(projectRoot, ".env.example"),
    buildFullPayloadEnv(input, "change-me-before-production", webPort),
    "utf8",
  )

  return {
    version: payloadVersion,
    replacedPackages,
    secretGenerated: true,
    database: input.database,
  }
}


function buildContractForFullPayload(input: ProjectScaffoldInput, webPort: number): DigwisProjectConfig {
  return {
    version: 1,
    projectType: "next-platform",
    template: input.template,
    packageManager: input.packageManager,
    monorepo: false,
    database: input.database,
    clientTargets: input.clientTargets,
    runtimeModules: input.runtimeModules,
    serviceModules: input.serviceModules,
    apps: {
      web: {
        path: ".",
        platform: "web",
        devCommand: `pnpm dev -- --hostname 127.0.0.1 --port ${webPort}`,
        buildCommand: "pnpm build",
        startCommand: `pnpm start -- --hostname 127.0.0.1 --port ${webPort}`,
        port: webPort,
      },
      ...buildClientAppsContract(input),
    },
    services: {
      cms: {
        enabled: true,
        type: "payload",
        path: ".",
        runtime: "node",
      },
    },
    panel: {
      previewUrl: buildLocalPreviewUrl(webPort),
      adminUrl: buildLocalAdminUrl(webPort),
    },
  }
}

function buildContractForFullDirectus(input: ProjectScaffoldInput, webPort: number): DigwisProjectConfig {
  return {
    version: 1,
    projectType: "next-platform",
    template: input.template,
    packageManager: input.packageManager,
    monorepo: false,
    database: input.database,
    clientTargets: input.clientTargets,
    runtimeModules: input.runtimeModules,
    serviceModules: input.serviceModules,
    apps: {
      web: {
        path: "apps/web",
        platform: "web",
        devCommand: "npm run dev --prefix apps/web",
        buildCommand: "npm run build --prefix apps/web",
        startCommand: "npm run start --prefix apps/web",
        port: webPort,
      },
      ...buildClientAppsContract(input),
    },
    services: {
      cms: {
        enabled: true,
        type: "directus",
        path: "services/directus",
        runtime: "node",
        devCommand: "docker compose up -d",
      },
    },
    panel: {
      previewUrl: buildLocalPreviewUrl(webPort),
      adminUrl: DIRECTUS_LOCAL_ADMIN_URL,
    },
  }
}

function buildDirectusFullDockerCompose(input: ProjectScaffoldInput) {
  const dbService =
    input.database === "postgresql"
      ? `  directus-db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${input.slug}_directus
      POSTGRES_USER: directus
      POSTGRES_PASSWORD: directus
    ports:
      - "5433:5432"
    volumes:
      - directus_pg:/var/lib/postgresql/data
`
      : ``
  const dbEnv =
    input.database === "postgresql"
      ? `DB_CLIENT=pg
DB_CONNECTION_STRING=postgres://directus:directus@directus-db:5432/${input.slug}_directus`
      : `DB_CLIENT=sqlite3
DB_CONNECTION_STRING=/directus/database/directus.db`
  return `services:
${dbService}  directus:
    image: directus/directus:11.11.0
    restart: unless-stopped
    ports:
      - "8055:8055"
    env_file:
      - .env
    ${input.database === "postgresql" ? "depends_on:\n      - directus-db" : ""}
    volumes:
      - ./uploads:/directus/uploads
      - ./extensions:/directus/extensions
      - ./snapshots:/directus/snapshots
${input.database === "sqlite" ? "      - ./database:/directus/database" : ""}

volumes:
${input.database === "postgresql" ? "  directus_pg:\n" : ""}
# .env requires:
# ${dbEnv}
`
}

function buildDirectusFullEnv(input: ProjectScaffoldInput) {
  const dbSection =
    input.database === "postgresql"
      ? `DB_CLIENT=pg
DB_CONNECTION_STRING=postgres://directus:directus@directus-db:5432/${input.slug}_directus`
      : `DB_CLIENT=sqlite3
DB_CONNECTION_STRING=/directus/database/directus.db`
  return `PORT=8055
KEY=change-me-key
SECRET=change-me-secret
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me-admin-password
PUBLIC_URL=http://127.0.0.1:8055
${dbSection}
`
}

function buildDirectusFullRootPackageJson(input: ProjectScaffoldInput, webPort: number) {
  const scripts: Record<string, string> = {
    dev: "npm run dev --prefix apps/web",
    build: "npm run build --prefix apps/web",
    start: "npm run start --prefix apps/web",
    "directus:up": "docker compose -f services/directus/docker-compose.yml --env-file services/directus/.env up -d",
    "directus:down": "docker compose -f services/directus/docker-compose.yml --env-file services/directus/.env down",
  }
  addDesktopScripts(scripts, input.clientTargets)
  return JSON.stringify(
    {
      name: input.slug,
      private: true,
      packageManager: "pnpm@10",
      workspaces: buildWorkspacePatterns(),
      scripts,
    },
    null,
    2,
  ) + "\n"
}

function buildWorkspacePatterns() {
  return ["apps/*", "packages/*", "services/*"]
}

function addDesktopScripts(scripts: Record<string, string>, clientTargets: ProjectClientTarget[]) {
  if (!clientTargets.includes("electron")) {
    return
  }
  scripts["desktop:dev"] = "pnpm --filter desktop dev"
  scripts["desktop:start"] = "pnpm --filter desktop start"
  scripts["desktop:build"] = "pnpm --filter desktop build"
}

function buildRootPackageJson(input: ProjectScaffoldInput) {
  const scripts: Record<string, string> = {
    dev: "pnpm --filter web dev",
    build: "pnpm --filter web build",
    start: "pnpm --filter web start",
    lint: "pnpm --filter web lint",
  }
  if (input.template === "next-payload") {
    scripts["payload:types"] = "pnpm --filter web generate:types"
    scripts["payload:importmap"] = "pnpm --filter web generate:importmap"
  }
  if (input.template === "next-directus") {
    scripts["directus:bootstrap"] = "NAPI_RS_FORCE_WASI=1 pnpm --dir services/directus bootstrap"
    scripts["directus:dev"] = "NAPI_RS_FORCE_WASI=1 pnpm --dir services/directus dev"
    scripts["directus:start"] = "NAPI_RS_FORCE_WASI=1 pnpm --dir services/directus start"
  }
  addDesktopScripts(scripts, input.clientTargets)
  return JSON.stringify(
    {
      name: input.slug,
      private: true,
      packageManager: "pnpm@10",
      workspaces: buildWorkspacePatterns(),
      scripts,
    },
    null,
    2,
  ) + "\n"
}

function clientTargetLabel(target: ProjectClientTarget) {
  if (target === "electron") return "Electron desktop client"
  if (target === "ios-native") return "Native iOS client"
  return "Native Android client"
}

function buildWebPackageJson(input: ProjectScaffoldInput, webPort: number) {
  const hasPayload = input.template === "next-payload"
  const deps: Record<string, string> = {
    "@digwis/api-client": "workspace:*",
    "@digwis/core": "workspace:*",
    next: "^16.0.0",
    react: "^19.2.0",
    "react-dom": "^19.2.0",
  }
  if (hasPayload) {
    deps["@payloadcms/next"] = "^3.0.0"
    deps["@payloadcms/richtext-lexical"] = "^3.0.0"
    deps["@payloadcms/db-postgres"] = "^3.0.0"
    deps["@payloadcms/db-sqlite"] = "^3.0.0"
    deps.payload = "^3.0.0"
    deps.sharp = "^0.34.0"
  }
  const scripts: Record<string, string> = {
    dev: "node ./scripts/dev-with-wasm.cjs",
    build: "next build",
    start: `next start --hostname 127.0.0.1 --port ${webPort}`,
    lint: "next lint",
  }
  if (hasPayload) {
    scripts["generate:importmap"] = "payload generate:importmap"
    scripts["generate:types"] = "payload generate:types"
  }
  return JSON.stringify(
    {
      name: "web",
      private: true,
      scripts,
      dependencies: deps,
      devDependencies: {
        "@next/swc-wasm-nodejs": "^16.2.6",
        "@types/node": "^24.0.0",
        "@types/react": "^19.2.0",
        "@types/react-dom": "^19.2.0",
        typescript: "^5.8.0",
      },
    },
    null,
    2,
  ) + "\n"
}

function buildWebDevLauncher(webPort: number) {
  return `const path = require("node:path")
const { spawn } = require("node:child_process")

const wasmDir = path.dirname(require.resolve("@next/swc-wasm-nodejs/wasm.js"))
const nextBin = require.resolve("next/dist/bin/next")

const child = spawn(
  process.execPath,
  [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "${webPort}"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_TEST_WASM_DIR: wasmDir,
    },
  },
)

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
`
}

function buildWebLayout(projectName: string) {
  return `import "./globals.css"

export const metadata = {
  title: "${projectName}",
  description: "Generated by Digwis Panel",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`
}

function buildFeatureList(ctx: ScaffoldContext) {
  const features: string[] = [
    "Next.js app router as the default product shell",
    `${ctx.database === "postgresql" ? "PostgreSQL" : "SQLite"} as the primary database target`,
  ]
  if (ctx.template === "next-payload") {
    features.push("Payload selected as the CMS contract")
  }
  if (ctx.template === "next-directus") {
    features.push("Directus selected as the CMS contract")
  }
  if (ctx.clientTargets.size > 0) {
    features.push(`Client targets: ${Array.from(ctx.clientTargets).map(clientTargetLabel).join(", ")}`)
  }
  if (ctx.runtimeModules.size > 0) {
    features.push(`Runtime modules: ${Array.from(ctx.runtimeModules).join(", ")}`)
  }
  if (ctx.serviceModules.size > 0) {
    features.push(`Worker services: ${Array.from(ctx.serviceModules).join(", ")}`)
  }
  return features.map((item) => `        <li>${item}</li>`).join("\n")
}

function buildWebPage(ctx: ScaffoldContext) {
  return `import { buildWebApiClient } from "../lib/api-client"

export default function HomePage() {
  const client = buildWebApiClient()

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Digwis Platform Scaffold</p>
        <h1>${ctx.projectName}</h1>
        <p className="summary">
          This project was generated from Digwis Panel as a reusable Next-centered platform workspace.
        </p>
      </section>
      <section className="panel">
        <h2>Included in this scaffold</h2>
        <ul>
${buildFeatureList(ctx)}
        </ul>
      </section>
      <section className="panel">
        <h2>Shared API Contract</h2>
        <p className="summary">
          Web, Electron, iOS, and Android can point to the same API surface through <code>@digwis/api-client</code>.
        </p>
        <div className="api-grid">
          <div className="api-card">
            <p className="api-label">Base URL</p>
            <p className="api-value">{client.baseUrl}</p>
          </div>
          <div className="api-card">
            <p className="api-label">Healthcheck</p>
            <p className="api-value">GET /api/health</p>
          </div>
          <div className="api-card">
            <p className="api-label">Session</p>
            <p className="api-value">GET /api/session</p>
          </div>
        </div>
      </section>
    </main>
  )
}
`
}

function buildWebCss() {
  return `:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #09111f;
  color: #f5f7fb;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
  background:
    radial-gradient(circle at top, rgba(49, 120, 198, 0.2), transparent 40%),
    #09111f;
}

body {
  min-height: 100vh;
}

.shell {
  width: min(1120px, calc(100vw - 48px));
  margin: 0 auto;
  padding: 64px 0 96px;
}

.hero {
  padding: 48px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(15, 23, 42, 0.75);
  border-radius: 8px;
}

.eyebrow {
  margin: 0 0 16px;
  color: #7dd3fc;
  font-size: 14px;
}

h1 {
  margin: 0;
  font-size: 48px;
}

.summary {
  max-width: 720px;
  line-height: 1.6;
  color: #cbd5e1;
}

.panel {
  margin-top: 24px;
  padding: 32px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(15, 23, 42, 0.72);
  border-radius: 8px;
}

ul {
  margin: 16px 0 0;
  padding-left: 20px;
  color: #e2e8f0;
}

code {
  font-family: "SF Mono", "Geist Mono", ui-monospace, monospace;
}

.api-grid {
  display: grid;
  gap: 16px;
  margin-top: 20px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.api-card {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.55);
  padding: 18px;
}

.api-label {
  margin: 0 0 8px;
  color: #7dd3fc;
  font-size: 12px;
  text-transform: uppercase;
}

.api-value {
  margin: 0;
  color: #f8fafc;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}
`
}

function buildTsconfig() {
  return JSON.stringify(
    {
      compilerOptions: {
        baseUrl: ".",
        target: "ES2022",
        lib: ["dom", "dom.iterable", "es2022"],
        allowJs: false,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "preserve",
        incremental: true,
        plugins: [{ name: "next" }],
        paths: {
          "@payload-config": ["./payload.config.ts"],
        },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
      exclude: ["node_modules"],
    },
    null,
    2,
  ) + "\n"
}

function buildNextConfig() {
  return `const nextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  transpilePackages: ["@digwis/api-client", "@digwis/core"],
}

export default nextConfig
`
}

function buildWebApiClientHelper() {
  return `import { DigwisApiClient, resolveApiBaseUrl } from "@digwis/api-client"

export function buildWebApiClient() {
  const baseUrl = resolveApiBaseUrl(process.env.NEXT_PUBLIC_APP_URL)
  const client = new DigwisApiClient({ baseUrl })
  return {
    baseUrl,
    client,
  }
}
`
}

function buildRuntimeModulesHelper(enabledModules: ProjectRuntimeModule[]) {
  return `export const enabledRuntimeModules = new Set(${JSON.stringify([...new Set(enabledModules)].sort())} as const)

export function isRuntimeModuleEnabled(moduleId: string) {
  return enabledRuntimeModules.has(moduleId as never)
}
`
}

function buildDashboardModulePage() {
  return `import Link from "next/link"
import { notFound } from "next/navigation"

import { isRuntimeModuleEnabled } from "../../lib/digwis-runtime-modules"

export default function DashboardPage() {
  if (!isRuntimeModuleEnabled("dashboard")) {
    notFound()
  }

  return (
    <main style={{ padding: 32 }}>
      <h1>Operations Dashboard</h1>
      <p style={{ color: "#64748b", maxWidth: 720 }}>
        This route is enabled by Digwis Panel as the first dashboard shell. Replace the static summary cards with your
        own operator metrics, workflow queues, and CMS shortcuts.
      </p>
      <div style={{ display: "grid", gap: 16, marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {[
          ["Content backlog", "12 drafts need review"],
          ["Support inbox", "4 unresolved help requests"],
          ["Publishing queue", "2 scheduled releases today"],
        ].map(([label, value]) => (
          <section key={label} style={{ border: "1px solid rgba(148, 163, 184, 0.18)", borderRadius: 8, padding: 20 }}>
            <p style={{ margin: 0, color: "#94a3b8", fontSize: 14 }}>{label}</p>
            <p style={{ margin: "12px 0 0", fontSize: 24, fontWeight: 600 }}>{value}</p>
          </section>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 28 }}>
        <Link href="/admin">Open CMS</Link>
        <Link href="/docs">Docs</Link>
        <Link href="/blog">Blog</Link>
      </div>
    </main>
  )
}
`
}

function buildDocsModulePage() {
  return `import { notFound } from "next/navigation"

import { isRuntimeModuleEnabled } from "../../lib/digwis-runtime-modules"

const sections = [
  {
    title: "Getting started",
    body: "Document onboarding, environment conventions, and deployment checkpoints here.",
  },
  {
    title: "Editor playbooks",
    body: "Add content workflow guides, QA lists, and operational runbooks for the team.",
  },
  {
    title: "Support FAQ",
    body: "Turn repeated support answers into reusable internal or public documentation.",
  },
]

export default function DocsPage() {
  if (!isRuntimeModuleEnabled("docs")) {
    notFound()
  }

  return (
    <main style={{ padding: 32 }}>
      <h1>Documentation Center</h1>
      <p style={{ color: "#64748b", maxWidth: 720 }}>
        This scaffold reserves a dedicated docs surface. You can later swap it to MDX, a CMS-driven help center, or a
        search-backed knowledge base.
      </p>
      <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
        {sections.map((section) => (
          <section key={section.title} style={{ border: "1px solid rgba(148, 163, 184, 0.18)", borderRadius: 8, padding: 20 }}>
            <h2 style={{ marginTop: 0 }}>{section.title}</h2>
            <p style={{ marginBottom: 0, color: "#94a3b8" }}>{section.body}</p>
          </section>
        ))}
      </div>
    </main>
  )
}
`
}

function buildBlogIndexModulePage() {
  return `import Link from "next/link"
import { notFound } from "next/navigation"

import { isRuntimeModuleEnabled } from "../../lib/digwis-runtime-modules"

const posts = [
  { slug: "hello-digwis", title: "Hello Digwis", summary: "Start shaping the editorial experience from this route." },
  { slug: "editorial-workflow", title: "Editorial Workflow", summary: "Connect this index to Payload posts or another CMS source later." },
]

export default function BlogIndexPage() {
  if (!isRuntimeModuleEnabled("blog")) {
    notFound()
  }

  return (
    <main style={{ padding: 32 }}>
      <h1>Blog</h1>
      <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
        {posts.map((post) => (
          <article key={post.slug} style={{ border: "1px solid rgba(148, 163, 184, 0.18)", borderRadius: 8, padding: 20 }}>
            <h2 style={{ marginTop: 0 }}>{post.title}</h2>
            <p style={{ color: "#94a3b8" }}>{post.summary}</p>
            <Link href={\`/blog/\${post.slug}\`}>Read more</Link>
          </article>
        ))}
      </div>
    </main>
  )
}
`
}

function buildBlogPostModulePage() {
  return `import { notFound } from "next/navigation"

import { isRuntimeModuleEnabled } from "../../../lib/digwis-runtime-modules"

type Args = {
  params: Promise<{
    slug: string
  }>
}

export default async function BlogPostPage({ params }: Args) {
  if (!isRuntimeModuleEnabled("blog")) {
    notFound()
  }

  const { slug } = await params

  return (
    <main style={{ padding: 32 }}>
      <p style={{ color: "#94a3b8" }}>Blog article</p>
      <h1 style={{ textTransform: "capitalize" }}>{slug.replace(/-/g, " ")}</h1>
      <p style={{ color: "#64748b", maxWidth: 720 }}>
        Replace this placeholder with a CMS query or static generation strategy once your content model is ready.
      </p>
    </main>
  )
}
`
}

function buildI18nMessages() {
  return `export const locales = ["en", "zh-CN"] as const

export type SupportedLocale = (typeof locales)[number]

export const localeLabels: Record<SupportedLocale, string> = {
  en: "English",
  "zh-CN": "简体中文",
}

export const messages: Record<SupportedLocale, { title: string; summary: string }> = {
  en: {
    title: "Localized entry",
    summary: "Use this route to branch your app experience per locale.",
  },
  "zh-CN": {
    title: "多语言入口",
    summary: "这个路由用于放置按语言区分的站点入口与文案。",
  },
}

export function resolveLocale(input: string): SupportedLocale {
  return locales.includes(input as SupportedLocale) ? (input as SupportedLocale) : "en"
}
`
}

function buildI18nModulePage() {
  return `import Link from "next/link"
import { notFound } from "next/navigation"

import { isRuntimeModuleEnabled } from "../../lib/digwis-runtime-modules"
import { localeLabels, messages, resolveLocale } from "../../lib/digwis-i18n"

type Args = {
  params: Promise<{
    locale: string
  }>
}

export default async function LocalizedHomePage({ params }: Args) {
  if (!isRuntimeModuleEnabled("i18n")) {
    notFound()
  }

  const { locale } = await params
  const resolved = resolveLocale(locale)
  const content = messages[resolved]

  return (
    <main style={{ padding: 32 }}>
      <p style={{ color: "#94a3b8" }}>{localeLabels[resolved]}</p>
      <h1>{content.title}</h1>
      <p style={{ color: "#64748b", maxWidth: 720 }}>{content.summary}</p>
      <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
        <Link href="/en">English</Link>
        <Link href="/zh-CN">简体中文</Link>
      </div>
    </main>
  )
}
`
}

function buildReadme(ctx: ScaffoldContext) {
  const cmsText =
    ctx.template === "next-payload"
      ? "Payload was selected as the CMS runtime. The scaffold includes a standard CMS baseline with pages, posts, categories, tags, site settings, navigation, media, users, admin routes, and REST routes."
      : ctx.template === "next-directus"
        ? "Directus was selected as the CMS contract. This first scaffold keeps the Next frontend and panel contract ready while Directus itself can be attached as a separate service."
        : "This scaffold starts without a CMS runtime."
  return `# ${ctx.projectName}

Generated by Digwis Panel.

## What is included

- Next.js as the primary product shell
- Next app location: \`apps/web\`
- ${ctx.database === "postgresql" ? "PostgreSQL" : "SQLite"} as the default data target
- Panel contract in \`digwis-project.json\`
- Shared workspace buckets in \`packages/core\` and \`packages/api-client\`
- Optional service modules declared by the panel

## Template notes

${cmsText}

## Service modules

${ctx.serviceModules.size ? Array.from(ctx.serviceModules).map((item) => `- ${item}`).join("\n") : "- none"}

## Client targets

${ctx.clientTargets.size ? Array.from(ctx.clientTargets).map((item) => `- ${clientTargetLabel(item)}`).join("\n") : "- web only"}

## Local preview

- Preview URL: \`${buildLocalPreviewUrl(ctx.webPort)}\`

## First run

1. Copy \`.env.example\` to \`.env\`
2. Install dependencies with \`pnpm install\`
3. Start the web app with \`pnpm dev\` (this runs \`apps/web\`)
${ctx.template === "next-payload" ? "4. Open `/admin` to finish the first Payload user bootstrap\n5. If you change Payload collection imports, run `pnpm payload:importmap` and `pnpm payload:types`" : ""}
${ctx.template === "next-directus" ? "4. Run `pnpm directus:dev` to start Directus sidecar\n5. Open `http://127.0.0.1:8055/admin` for Directus admin" : ""}
`
}

function buildRootEnvExample(input: ProjectScaffoldInput, webPort: number) {
  const lines = [
    `DATABASE_URL=${input.database === "postgresql" ? `postgresql://postgres:postgres@127.0.0.1:5432/${input.slug}` : "file:./apps/web/local.db"}`,
    `NEXT_PUBLIC_APP_URL=${buildLocalPreviewUrl(webPort)}`,
  ]
  if (input.template === "next-payload") {
    lines.push("PAYLOAD_SECRET=change-me-before-production")
  }
  if (input.template === "next-directus") {
    lines.push("DIRECTUS_URL=http://127.0.0.1:8055")
  }
  return lines.join("\n") + "\n"
}

function buildWebEnvExample(input: ProjectScaffoldInput) {
  const lines = [
    `DATABASE_URL=${input.database === "postgresql" ? `postgresql://postgres:postgres@127.0.0.1:5432/${input.slug}` : "file:./local.db"}`,
  ]
  if (input.template === "next-payload") {
    lines.push("PAYLOAD_SECRET=change-me-before-production")
  }
  if (input.template === "next-directus") {
    lines.push("DIRECTUS_URL=http://127.0.0.1:8055")
  }
  return lines.join("\n") + "\n"
}

function buildDirectusServicePackageJson() {
  return JSON.stringify(
    {
      name: "directus-sidecar",
      private: true,
      scripts: {
        dev: "NAPI_RS_FORCE_WASI=1 directus start",
        start: "NAPI_RS_FORCE_WASI=1 directus start",
        bootstrap: "NAPI_RS_FORCE_WASI=1 directus bootstrap",
      },
      dependencies: {
        directus: "^11.0.0",
        "@napi-rs/snappy-wasm32-wasi": "7.3.3",
      },
      optionalDependencies: {
        "@napi-rs/snappy-darwin-arm64": "7.3.3",
      },
    },
    null,
    2,
  ) + "\n"
}

function buildDirectusServiceEnvExample(input: ProjectScaffoldInput) {
  const dbClient = input.database === "postgresql" ? "pg" : "sqlite3"
  const dbConnection =
    input.database === "postgresql"
      ? `postgresql://postgres:postgres@127.0.0.1:5432/${input.slug}_directus`
      : "./directus.db"
  return [
    "PORT=8055",
    "KEY=change-me-key",
    "SECRET=change-me-secret",
    `DB_CLIENT=${dbClient}`,
    `DB_CONNECTION_STRING=${dbConnection}`,
    "ADMIN_EMAIL=admin@example.com",
    "ADMIN_PASSWORD=change-me-admin-password",
    "",
  ].join("\n")
}

function buildDirectusReadme() {
  return `# Directus Sidecar

This service is generated by Digwis Panel as the CMS sidecar for the Next-centered project.

## Quick start

1. Copy \`.env.example\` to \`.env\`
2. Install dependencies: \`pnpm install\`
3. Start Directus: \`pnpm dev\`

Default admin URL: http://127.0.0.1:8055/admin
`
}

function buildPayloadConfig(database: ProjectScaffoldInput["database"]) {
  const adapterImport =
    database === "postgresql"
      ? 'import { postgresAdapter } from "@payloadcms/db-postgres"'
      : 'import { sqliteAdapter } from "@payloadcms/db-sqlite"'
  const adapter =
    database === "postgresql"
      ? `postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL || "",
    },
  })`
      : `sqliteAdapter({
    client: {
      url: process.env.DATABASE_URL || "file:./local.db",
    },
  })`
  return `import path from "node:path"
import { fileURLToPath } from "node:url"
${adapterImport}
import { lexicalEditor } from "@payloadcms/richtext-lexical"
import { buildConfig } from "payload"

import { MainNavigation } from "./globals/MainNavigation"
import { SiteSettings } from "./globals/SiteSettings"
import { Categories } from "./collections/Categories"
import { Media } from "./collections/Media"
import { Pages } from "./collections/Pages"
import { Posts } from "./collections/Posts"
import { Tags } from "./collections/Tags"
import { Users } from "./collections/Users"

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Media, Categories, Tags, Pages, Posts],
  globals: [SiteSettings, MainNavigation],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || "change-me",
  typescript: {
    outputFile: path.resolve(dirname, "payload-types.ts"),
  },
  db: ${adapter},
})
`
}

function buildPayloadUsersCollection() {
  return `import type { CollectionConfig } from "payload"

export const Users: CollectionConfig = {
  slug: "users",
  admin: {
    useAsTitle: "email",
  },
  auth: true,
  fields: [],
}
`
}

function buildPayloadCategoriesCollection() {
  return `import type { CollectionConfig } from "payload"

export const Categories: CollectionConfig = {
  slug: "categories",
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "slug", "updatedAt"],
  },
  access: {
    read: () => true,
  },
  fields: [
    {
      name: "title",
      type: "text",
      required: true,
    },
    {
      name: "slug",
      type: "text",
      required: true,
      unique: true,
      index: true,
    },
    {
      name: "description",
      type: "textarea",
    },
  ],
}
`
}

function buildPayloadTagsCollection() {
  return `import type { CollectionConfig } from "payload"

export const Tags: CollectionConfig = {
  slug: "tags",
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "slug", "updatedAt"],
  },
  access: {
    read: () => true,
  },
  fields: [
    {
      name: "title",
      type: "text",
      required: true,
    },
    {
      name: "slug",
      type: "text",
      required: true,
      unique: true,
      index: true,
    },
  ],
}
`
}

function buildPayloadSeoFields() {
  return `[
  {
    name: "metaTitle",
    label: "Meta Title",
    type: "text",
  },
  {
    name: "metaDescription",
    label: "Meta Description",
    type: "textarea",
  },
  {
    name: "metaImage",
    label: "Meta Image",
    type: "upload",
    relationTo: "media",
  },
  {
    name: "canonicalUrl",
    label: "Canonical URL",
    type: "text",
  },
  {
    name: "noIndex",
    label: "No Index",
    type: "checkbox",
    defaultValue: false,
  },
]`
}

function buildPayloadPagesCollection() {
  return `import type { CollectionConfig } from "payload"

export const Pages: CollectionConfig = {
  slug: "pages",
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "slug", "status", "updatedAt"],
  },
  access: {
    read: () => true,
  },
  versions: {
    drafts: true,
  },
  fields: [
    {
      type: "tabs",
      tabs: [
        {
          label: "Content",
          fields: [
            {
              name: "title",
              type: "text",
              required: true,
            },
            {
              name: "slug",
              type: "text",
              required: true,
              unique: true,
              index: true,
            },
            {
              name: "summary",
              type: "textarea",
            },
            {
              name: "content",
              type: "richText",
              required: true,
            },
          ],
        },
        {
          label: "SEO",
          fields: ${buildPayloadSeoFields()},
        },
        {
          label: "Settings",
          fields: [
            {
              name: "status",
              type: "select",
              defaultValue: "draft",
              options: [
                { label: "Draft", value: "draft" },
                { label: "Published", value: "published" },
              ],
            },
          ],
        },
      ],
    },
  ],
}
`
}

function buildPayloadPostsCollection() {
  return `import type { CollectionConfig } from "payload"

export const Posts: CollectionConfig = {
  slug: "posts",
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "status", "publishedAt", "updatedAt"],
  },
  access: {
    read: () => true,
  },
  versions: {
    drafts: true,
  },
  fields: [
    {
      type: "tabs",
      tabs: [
        {
          label: "Content",
          fields: [
            {
              name: "title",
              type: "text",
              required: true,
            },
            {
              name: "slug",
              type: "text",
              required: true,
              unique: true,
              index: true,
            },
            {
              name: "excerpt",
              type: "textarea",
            },
            {
              name: "featuredImage",
              type: "upload",
              relationTo: "media",
            },
            {
              name: "content",
              type: "richText",
              required: true,
            },
          ],
        },
        {
          label: "Taxonomy",
          fields: [
            {
              name: "categories",
              type: "relationship",
              relationTo: "categories",
              hasMany: true,
            },
            {
              name: "tags",
              type: "relationship",
              relationTo: "tags",
              hasMany: true,
            },
            {
              name: "authors",
              type: "relationship",
              relationTo: "users",
              hasMany: true,
            },
          ],
        },
        {
          label: "SEO",
          fields: ${buildPayloadSeoFields()},
        },
        {
          label: "Publishing",
          fields: [
            {
              name: "status",
              type: "select",
              defaultValue: "draft",
              options: [
                { label: "Draft", value: "draft" },
                { label: "Published", value: "published" },
              ],
            },
            {
              name: "publishedAt",
              type: "date",
              admin: {
                position: "sidebar",
              },
            },
          ],
        },
      ],
    },
  ],
}
`
}

function buildPayloadMediaCollection() {
  return `import type { CollectionConfig } from "payload"

export const Media: CollectionConfig = {
  slug: "media",
  admin: {
    useAsTitle: "alt",
    defaultColumns: ["alt", "updatedAt"],
  },
  access: {
    read: () => true,
  },
  fields: [
    {
      name: "alt",
      type: "text",
      required: true,
    },
  ],
  upload: true,
}
`
}

function buildPayloadSiteSettingsGlobal() {
  return `import type { GlobalConfig } from "payload"

export const SiteSettings: GlobalConfig = {
  slug: "site-settings",
  label: "Site Settings",
  access: {
    read: () => true,
  },
  fields: [
    {
      name: "siteName",
      type: "text",
      required: true,
    },
    {
      name: "siteTagline",
      type: "text",
    },
    {
      name: "siteUrl",
      type: "text",
    },
    {
      name: "defaultSeo",
      type: "group",
      fields: ${buildPayloadSeoFields()},
    },
  ],
}
`
}

function buildPayloadMainNavigationGlobal() {
  return `import type { GlobalConfig } from "payload"

export const MainNavigation: GlobalConfig = {
  slug: "main-navigation",
  label: "Main Navigation",
  access: {
    read: () => true,
  },
  fields: [
    {
      name: "items",
      type: "array",
      fields: [
        {
          name: "label",
          type: "text",
          required: true,
        },
        {
          name: "description",
          type: "text",
        },
        {
          name: "kind",
          type: "select",
          defaultValue: "custom",
          options: [
            { label: "Custom URL", value: "custom" },
            { label: "Page", value: "page" },
            { label: "Post", value: "post" },
          ],
        },
        {
          name: "url",
          type: "text",
        },
        {
          name: "page",
          type: "relationship",
          relationTo: "pages",
        },
        {
          name: "post",
          type: "relationship",
          relationTo: "posts",
        },
      ],
    },
  ],
}
`
}

function buildPayloadImportMap() {
  return `import { CollectionCards as CollectionCards_7f2f5f31c58b6b } from "@payloadcms/next/rsc"

export const importMap = {
  "@payloadcms/next/rsc#CollectionCards": CollectionCards_7f2f5f31c58b6b,
}
`
}

function buildPayloadLayout() {
  return `import config from "@payload-config"
import "@payloadcms/next/css"
import type { ServerFunctionClient } from "payload"
import { handleServerFunctions, RootLayout } from "@payloadcms/next/layouts"
import React from "react"

import { importMap } from "./admin/importMap"
import "./custom.css"

type Args = {
  children: React.ReactNode
}

const serverFunction: ServerFunctionClient = async function (args) {
  "use server"
  return handleServerFunctions({
    ...args,
    config,
    importMap,
  })
}

export default function Layout({ children }: Args) {
  return (
    <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
      {children}
    </RootLayout>
  )
}
`
}

function buildPayloadAdminPage() {
  return `import type { Metadata } from "next"

import config from "@payload-config"
import { RootPage, generatePageMetadata } from "@payloadcms/next/views"

import { importMap } from "../importMap"

type Args = {
  params: Promise<{
    segments: string[]
  }>
  searchParams: Promise<{
    [key: string]: string | string[]
  }>
}

export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
  generatePageMetadata({ config, params, searchParams })

export default function Page({ params, searchParams }: Args) {
  return RootPage({ config, params, searchParams, importMap })
}
`
}

function buildPayloadApiRoute() {
  return `import config from "@payload-config"
import "@payloadcms/next/css"
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from "@payloadcms/next/routes"

export const GET = REST_GET(config)
export const POST = REST_POST(config)
export const DELETE = REST_DELETE(config)
export const PATCH = REST_PATCH(config)
export const PUT = REST_PUT(config)
export const OPTIONS = REST_OPTIONS(config)
`
}

function buildPayloadCustomCss() {
  return `:root {
  --theme-elevation-0: #09111f;
}
`
}

function writePayloadCmsTemplate(
  database: ProjectScaffoldInput["database"],
  basePath: string,
  writer: (relativePath: string, content: string) => void,
) {
  writer(path.posix.join(basePath, "payload.config.ts"), buildPayloadConfig(database))
  writer(path.posix.join(basePath, "collections/Users.ts"), buildPayloadUsersCollection())
  writer(path.posix.join(basePath, "collections/Media.ts"), buildPayloadMediaCollection())
  writer(path.posix.join(basePath, "collections/Categories.ts"), buildPayloadCategoriesCollection())
  writer(path.posix.join(basePath, "collections/Tags.ts"), buildPayloadTagsCollection())
  writer(path.posix.join(basePath, "collections/Pages.ts"), buildPayloadPagesCollection())
  writer(path.posix.join(basePath, "collections/Posts.ts"), buildPayloadPostsCollection())
  writer(path.posix.join(basePath, "globals/SiteSettings.ts"), buildPayloadSiteSettingsGlobal())
  writer(path.posix.join(basePath, "globals/MainNavigation.ts"), buildPayloadMainNavigationGlobal())
}

function buildRequirementsTxt() {
  return ["fastapi>=0.116.0", "uvicorn[standard]>=0.35.0", "pydantic>=2.11.0"].join("\n") + "\n"
}

function buildPythonMain(kind: "python-ai" | "python-data") {
  const title = kind === "python-ai" ? "Digwis AI worker" : "Digwis data worker"
  return `from fastapi import FastAPI

app = FastAPI(title="${title}")


@app.get("/health")
def health():
    return {"ok": True, "service": "${kind}"}
`
}

function buildGoMain(slug: string) {
  return `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

func main() {
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true,
			"service": "go-worker",
			"project": "${slug}",
		})
	})

	log.Println("go-worker listening on :8200")
	log.Fatal(http.ListenAndServe(":8200", nil))
}
`
}

function buildRustMain() {
  return `use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

fn respond(mut stream: TcpStream) {
    let mut buffer = [0; 512];
    let _ = stream.read(&mut buffer);
    let response = "HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n{\\"ok\\":true,\\"service\\":\\"rust-worker\\"}";
    let _ = stream.write_all(response.as_bytes());
}

fn main() {
    let listener = TcpListener::bind("127.0.0.1:8300").expect("bind rust worker");
    for stream in listener.incoming().flatten() {
        respond(stream);
    }
}
`
}

function readProjectContract(projectRoot: string) {
  const contractPath = path.join(projectRoot, "digwis-project.json")
  if (!fs.existsSync(contractPath)) {
    throw new Error("项目缺少 digwis-project.json，暂时无法管理模块")
  }
  return {
    contractPath,
    contract: JSON.parse(fs.readFileSync(contractPath, "utf8")) as DigwisProjectConfig,
  }
}

function resolveWebRoot(projectRoot: string, contract: DigwisProjectConfig) {
  return path.join(projectRoot, contract.apps.web.path || ".")
}

function resolveNextAppDir(webRoot: string) {
  const candidates = [path.join(webRoot, "app"), path.join(webRoot, "src", "app")]
  const match = candidates.find((candidate) => fs.existsSync(candidate))
  if (!match) {
    throw new Error("当前项目还没有可识别的 Next app 目录")
  }
  return match
}

function resolveNextLibDir(webRoot: string, appDir: string) {
  const relativeAppDir = path.relative(webRoot, appDir)
  if (relativeAppDir.startsWith(`src${path.sep}`) || relativeAppDir === "src") {
    return path.join(webRoot, "src", "lib")
  }
  return path.join(webRoot, "lib")
}

function writeFileIfMissing(absolutePath: string, content: string, projectRoot: string, createdFiles: string[], warnings: string[]) {
  if (fs.existsSync(absolutePath)) {
    warnings.push(`保留现有文件：${toPosixPath(path.relative(projectRoot, absolutePath))}`)
    return
  }
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, content, "utf8")
  createdFiles.push(toPosixPath(path.relative(projectRoot, absolutePath)))
}

function ensureRuntimeModuleScaffold(
  moduleId: LightRuntimeModule,
  projectRoot: string,
  webRoot: string,
  enabledModules: ProjectRuntimeModule[],
  createdFiles: string[],
  warnings: string[],
) {
  const appDir = resolveNextAppDir(webRoot)
  const libDir = resolveNextLibDir(webRoot, appDir)
  const runtimeModulesPath = path.join(libDir, "digwis-runtime-modules.ts")
  const runtimeModulesRelative = toPosixPath(path.relative(projectRoot, runtimeModulesPath))
  const existed = fs.existsSync(runtimeModulesPath)
  fs.mkdirSync(path.dirname(runtimeModulesPath), { recursive: true })
  fs.writeFileSync(runtimeModulesPath, buildRuntimeModulesHelper(enabledModules), "utf8")
  if (!existed && !createdFiles.includes(runtimeModulesRelative)) {
    createdFiles.push(runtimeModulesRelative)
  }

  if (moduleId === "dashboard") {
    writeFileIfMissing(path.join(appDir, "dashboard", "page.tsx"), buildDashboardModulePage(), projectRoot, createdFiles, warnings)
    return
  }
  if (moduleId === "docs") {
    writeFileIfMissing(path.join(appDir, "docs", "page.tsx"), buildDocsModulePage(), projectRoot, createdFiles, warnings)
    return
  }
  if (moduleId === "blog") {
    writeFileIfMissing(path.join(appDir, "blog", "page.tsx"), buildBlogIndexModulePage(), projectRoot, createdFiles, warnings)
    writeFileIfMissing(
      path.join(appDir, "blog", "[slug]", "page.tsx"),
      buildBlogPostModulePage(),
      projectRoot,
      createdFiles,
      warnings,
    )
    return
  }
  if (moduleId === "i18n") {
    writeFileIfMissing(path.join(libDir, "digwis-i18n.ts"), buildI18nMessages(), projectRoot, createdFiles, warnings)
    writeFileIfMissing(path.join(appDir, "[locale]", "page.tsx"), buildI18nModulePage(), projectRoot, createdFiles, warnings)
  }
}

function buildContract(input: ProjectScaffoldInput, webPort: number): DigwisProjectConfig {
  return {
    version: 1,
    projectType: "next-platform",
    template: input.template,
    packageManager: input.packageManager,
    monorepo: input.monorepo,
    database: input.database,
    clientTargets: input.clientTargets,
    runtimeModules: input.runtimeModules,
    serviceModules: input.serviceModules,
    apps: {
      web: {
        path: "apps/web",
        platform: "web",
        devCommand: "pnpm --filter web dev",
        buildCommand: "pnpm --filter web build",
        startCommand: "pnpm --filter web start",
        port: webPort,
      },
      ...buildClientAppsContract(input),
    },
    services: {
      cms:
        input.template === "next-payload"
          ? {
              enabled: true,
              type: "payload",
              path: "apps/web",
              runtime: "node",
            }
          : input.template === "next-directus"
            ? {
                enabled: true,
                type: "directus",
                path: "services/directus",
                runtime: "node",
              }
            : undefined,
      pythonAi: input.serviceModules.includes("python-ai")
        ? {
            enabled: true,
            path: "services/py-ai",
            runtime: "python",
            devCommand: "python3 -m uvicorn app.main:app --reload --port 8100",
          }
        : undefined,
      pythonData: input.serviceModules.includes("python-data")
        ? {
            enabled: true,
            path: "services/py-data",
            runtime: "python",
            devCommand: "python3 -m uvicorn app.main:app --reload --port 8101",
          }
        : undefined,
      goWorker: input.serviceModules.includes("go-worker")
        ? {
            enabled: true,
            path: "services/go-worker",
            runtime: "go",
            devCommand: "go run .",
          }
        : undefined,
      rustWorker: input.serviceModules.includes("rust-worker")
        ? {
            enabled: true,
            path: "services/rust-worker",
            runtime: "rust",
            devCommand: "cargo run",
          }
        : undefined,
    },
    panel: {
      previewUrl: buildLocalPreviewUrl(webPort),
      adminUrl:
        input.template === "next-directus" ? DIRECTUS_LOCAL_ADMIN_URL : buildLocalAdminUrl(webPort),
    },
  }
}

function buildSharedCoreReadme() {
  return `# Shared core

Place cross-platform domain logic, business rules, and shared types here.
`
}

function buildSharedCorePackageJson() {
  return JSON.stringify(
    {
      name: "@digwis/core",
      private: true,
      version: "0.1.0",
      type: "module",
      exports: {
        ".": "./src/index.ts",
      },
    },
    null,
    2,
  ) + "\n"
}

function buildSharedCoreIndex() {
  return `export type DigwisRuntime = "web" | "desktop" | "ios" | "android"

export type DigwisSession = {
  accessToken?: string
  refreshToken?: string
}
`
}

function buildApiClientReadme() {
  return `# Shared API client

Place shared fetch wrappers, DTOs, and auth/session helpers here.

## Included starter files

- \`src/config.ts\` for endpoint defaults
- \`src/contracts.ts\` for shared DTOs
- \`src/client.ts\` for a tiny fetch-based API client
`
}

function buildApiClientPackageJson() {
  return JSON.stringify(
    {
      name: "@digwis/api-client",
      private: true,
      version: "0.1.0",
      type: "module",
      exports: {
        ".": "./src/index.ts",
      },
    },
    null,
    2,
  ) + "\n"
}

function buildApiClientTsconfig() {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        jsx: "preserve",
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ["src/**/*"],
    },
    null,
    2,
  ) + "\n"
}

function buildApiClientConfig(webPort: number) {
  return `export const DEFAULT_API_BASE_URL = "${buildLocalPreviewUrl(webPort)}"

export function resolveApiBaseUrl(explicit?: string) {
  return explicit?.trim() || DEFAULT_API_BASE_URL
}
`
}

function buildApiClientContracts() {
  return `export type HealthcheckResponse = {
  ok: boolean
  service: string
  version?: string
}

export type SessionUser = {
  id: string
  email: string
  displayName?: string
}

export type SessionResponse = {
  authenticated: boolean
  user?: SessionUser
}
`
}

function buildApiClientSource() {
  return `import { resolveApiBaseUrl } from "./config"
import type { HealthcheckResponse, SessionResponse } from "./contracts"

export type DigwisApiClientOptions = {
  baseUrl?: string
  headers?: HeadersInit
  fetcher?: typeof fetch
}

export class DigwisApiClient {
  private readonly baseUrl: string
  private readonly headers: HeadersInit
  private readonly fetcher: typeof fetch

  constructor(options: DigwisApiClientOptions = {}) {
    this.baseUrl = resolveApiBaseUrl(options.baseUrl)
    this.headers = options.headers ?? {}
    this.fetcher = options.fetcher ?? fetch
  }

  async getHealthcheck() {
    return this.request<HealthcheckResponse>("/api/health")
  }

  async getSession() {
    return this.request<SessionResponse>("/api/session")
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(this.baseUrl.replace(/\\/$/, "") + path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...this.headers,
        ...(init?.headers ?? {}),
      },
    })
    if (!response.ok) {
      throw new Error("API request failed: " + response.status)
    }
    return (await response.json()) as T
  }
}
`
}

function buildApiClientIndex() {
  return `export * from "./config"
export * from "./contracts"
export * from "./client"
`
}

function buildApiClientExample() {
  return `import { DigwisApiClient } from "./client"

export async function runHealthcheckExample() {
  const client = new DigwisApiClient()
  return await client.getHealthcheck()
}
`
}

function buildElectronPackageJson() {
  return JSON.stringify(
    {
      name: "desktop",
      private: true,
      main: "main.js",
      scripts: {
        dev: "electron .",
        start: "electron .",
        build: 'echo "Package the Electron client with your preferred desktop pipeline."',
      },
      devDependencies: {
        electron: "^41.3.0",
      },
    },
    null,
    2,
  ) + "\n"
}

function buildElectronMain(projectName: string) {
  return `const { app, BrowserWindow } = require("electron")
const path = require("node:path")

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: "${projectName} Desktop",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  })

  win.loadFile(path.join(__dirname, "renderer", "index.html"))
}

app.whenReady().then(() => {
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
`
}

function buildElectronPreload() {
  return `const { contextBridge } = require("electron")

contextBridge.exposeInMainWorld("digwisDesktop", {
  platform: "electron",
})
`
}

function buildElectronHtml(projectName: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName} Desktop</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <p class="eyebrow">Desktop shell</p>
        <h1>${projectName}</h1>
        <p class="summary">Electron workspace for desktop flows that share the same backend, auth, and domain model as the web app.</p>
        <ul class="list">
          <li>Connect shared domain logic from <code>packages/core</code></li>
          <li>Connect shared API client code from <code>packages/api-client</code></li>
          <li>Use <code>packages/api-client/src/client.ts</code> as the default HTTP contract</li>
          <li>Use this shell for desktop-only navigation, local file access, and native menu flows</li>
        </ul>
      </section>
    </main>
    <script src="./renderer.js"></script>
  </body>
</html>
`
}

function buildElectronRendererJs() {
  return `const root = document.querySelector(".shell")

if (root && window.digwisDesktop) {
  const chip = document.createElement("div")
  chip.className = "chip"
  chip.textContent = "Runtime: " + window.digwisDesktop.platform
  root.appendChild(chip)
}
`
}

function buildElectronCss() {
  return `:root {
  color-scheme: dark;
  font-family: Inter, "SF Pro Display", system-ui, sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
  background: #141414;
  color: #f5f5f5;
}

.shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 32px;
}

.hero {
  width: min(820px, 100%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.04);
  padding: 32px;
}

.eyebrow {
  margin: 0 0 8px;
  color: #f59e0b;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

h1 {
  margin: 0;
  font-size: 40px;
}

.summary {
  color: #cbd5e1;
  line-height: 1.6;
}

.list {
  margin: 20px 0 0;
  padding-left: 18px;
  color: #e2e8f0;
  line-height: 1.8;
}

.chip {
  display: inline-flex;
  margin-top: 20px;
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 999px;
  padding: 8px 12px;
  color: #fbbf24;
  font-size: 13px;
}
`
}

function buildElectronReadme() {
  return `# Desktop client

This Electron shell is intended for desktop-only workflows while reusing backend APIs and shared domain logic.

## Suggested next steps

1. Install root dependencies with \`pnpm install\`
2. Run \`pnpm desktop:dev\`
3. Move shared business logic into \`packages/core\`
4. Move shared request/auth code into \`packages/api-client\`
`
}

function buildIosReadme(projectName: string) {
  return `# Native iOS client

This folder contains a SwiftUI app template for ${projectName}.

## Suggested next steps

1. Run \`xcodegen generate\` in this directory if the Xcode project has not been generated yet
2. Keep API and domain contracts aligned with \`packages/core\` and \`packages/api-client\`
3. Point your networking layer at the same backend used by the web app
`
}

function buildIosProjectYml(projectName: string) {
  const schemeName = projectName.replace(/[^A-Za-z0-9]/g, "") || "DigwisMobile"
  return `name: ${schemeName}
options:
  bundleIdPrefix: com.digwis
settings:
  base:
    SWIFT_VERSION: 5.10
    IPHONEOS_DEPLOYMENT_TARGET: 17.0
targets:
  ${schemeName}:
    type: application
    platform: iOS
    deploymentTarget: "17.0"
    sources:
      - path: Sources
    resources:
      - path: Resources
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.digwis.${schemeName.toLowerCase()}
        INFOPLIST_FILE: Resources/Info.plist
        DEVELOPMENT_TEAM: ""
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
    scheme:
      testTargets: []
`
}

function buildIosAppSwift(projectName: string) {
  return `import SwiftUI

@main
struct ${projectName.replace(/[^A-Za-z0-9]/g, "") || "Digwis"}App: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appState)
        }
    }
}
`
}

function buildIosContentView(projectName: string) {
  return `import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("${projectName}")
                .font(.largeTitle)
                .fontWeight(.semibold)
            Text("Native iOS shell for a multi-platform Digwis product.")
                .foregroundStyle(.secondary)
            Text("Connect shared auth, content, and backend APIs here.")
                .foregroundStyle(.secondary)
            Text("API: \\(appState.apiBaseURL.absoluteString)")
                .font(.footnote)
                .foregroundStyle(.tertiary)
            Text("Shared contract: packages/api-client")
                .font(.footnote)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(24)
    }
}

#Preview {
    ContentView()
}
`
}

function buildIosInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleIdentifier</key>
  <string>com.digwis.mobile</string>
  <key>CFBundleName</key>
  <string>DigwisMobile</string>
  <key>UILaunchScreen</key>
  <dict/>
</dict>
</plist>
`
}

function buildIosApiConfig(webPort: number) {
  return `API_BASE_URL = ${buildLocalPreviewUrl(webPort)}
`
}

function buildIosAppState(webPort: number) {
  const fallbackUrl = buildLocalPreviewUrl(webPort)
  return `import Foundation

@MainActor
final class AppState: ObservableObject {
    let apiBaseURL: URL
    let apiClient: APIClient

    init() {
        let baseURLString = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String
            ?? "${fallbackUrl}"
        self.apiBaseURL = URL(string: baseURLString) ?? URL(string: "${fallbackUrl}")!
        self.apiClient = APIClient(baseURL: apiBaseURL)
    }
}
`
}

function buildIosApiClient() {
  return `import Foundation

struct APIClient {
    let baseURL: URL

    func makeRequest(path: String) -> URLRequest {
        let url = baseURL.appending(path: path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        return URLRequest(url: url)
    }
}
`
}

function buildAppleAssetsContents() {
  return `{
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
`
}

function buildIosAppIconContents() {
  return `{
  "images" : [
    {
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
`
}

function buildIosAccentColorContents() {
  return `{
  "colors" : [
    {
      "color" : {
        "color-space" : "srgb",
        "components" : {
          "alpha" : "1.000",
          "blue" : "0.208",
          "green" : "0.608",
          "red" : "0.961"
        }
      },
      "idiom" : "universal"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
`
}

function buildAndroidReadme(projectName: string) {
  return `# Native Android client

This folder contains a Kotlin + Compose Android template for ${projectName}.

## Suggested next steps

1. Open this directory in Android Studio
2. Align networking and auth flows with \`packages/api-client\`
3. Keep shared business rules and DTOs mirrored from \`packages/core\`
`
}

function buildAndroidSettingsGradle() {
  return `pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "DigwisMobile"
include(":app")
`
}

function buildAndroidRootGradle() {
  return `plugins {
  id("com.android.application") version "8.7.2" apply false
  id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
`
}

function buildAndroidAppGradle() {
  return `plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.digwis.mobile"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.digwis.mobile"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }

  buildFeatures {
    compose = true
  }

  composeOptions {
    kotlinCompilerExtensionVersion = "1.5.15"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
    }
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.activity:activity-compose:1.10.1")
  implementation("androidx.compose.material3:material3:1.3.1")
}
`
}

function buildAndroidGradleProperties() {
  return `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
`
}

function buildAndroidProguardRules() {
  return `# Project-specific ProGuard rules.
`
}

function buildAndroidManifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application
    android:allowBackup="true"
    android:label="@string/app_name"
    android:supportsRtl="true"
    android:theme="@style/Theme.Material3.DayNight.NoActionBar">
    <activity
      android:name=".MainActivity"
      android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`
}

function buildAndroidMainActivity(projectName: string) {
  return `package com.digwis.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import com.digwis.mobile.ui.DigwisApp
import com.digwis.mobile.ui.theme.DigwisMobileTheme

class MainActivity : ComponentActivity() {
  private val viewModel: MainViewModel by viewModels()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      DigwisMobileTheme {
        DigwisApp(
          projectName = "${projectName}",
          viewModel = viewModel,
        )
      }
    }
  }
}
`
}

function buildAndroidStrings() {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="app_name">Digwis Mobile</string>
</resources>
`
}

function buildAndroidThemes() {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources xmlns:tools="http://schemas.android.com/tools">
  <style name="Theme.DigwisMobile" parent="Theme.Material3.DayNight.NoActionBar">
    <item name="android:statusBarColor" tools:targetApi="l">#141414</item>
    <item name="android:navigationBarColor">#141414</item>
  </style>
</resources>
`
}

function buildAndroidApiConfig(webPort: number) {
  return `package com.digwis.mobile

object ApiConfig {
  const val BASE_URL = "http://10.0.2.2:${webPort}"
}
`
}

function buildAndroidAppState() {
  return `package com.digwis.mobile

data class AppState(
  val apiBaseUrl: String = ApiConfig.BASE_URL,
)
`
}

function buildAndroidMainViewModel() {
  return `package com.digwis.mobile

import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class MainViewModel : ViewModel() {
  private val _appState = MutableStateFlow(AppState())
  val appState: StateFlow<AppState> = _appState.asStateFlow()
}
`
}

function buildAndroidAppComposable() {
  return `package com.digwis.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.digwis.mobile.MainViewModel

@Composable
fun DigwisApp(projectName: String, viewModel: MainViewModel) {
  val appState by viewModel.appState.collectAsState()

  Surface(modifier = Modifier.fillMaxSize()) {
    Column(
      modifier = Modifier.padding(24.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Text(text = projectName, style = MaterialTheme.typography.headlineMedium)
      Text(text = "Native Android shell for a shared Digwis platform product.")
      Text(text = "Wire backend APIs and shared domain contracts here.")
      Text(
        text = "API: " + appState.apiBaseUrl,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Text(
        text = "Shared contract: packages/api-client",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}
`
}

function buildAndroidColorScheme() {
  return `package com.digwis.mobile.ui.theme

import androidx.compose.ui.graphics.Color

val DigwisBackground = Color(0xFF141414)
val DigwisSurface = Color(0xFF1D1D1D)
val DigwisPrimary = Color(0xFFF59B35)
val DigwisOnSurface = Color(0xFFF5F5F5)
val DigwisOnSurfaceVariant = Color(0xFFB8B8B8)
`
}

function buildAndroidThemeKt() {
  return `package com.digwis.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val DigwisDarkColors = darkColorScheme(
  primary = DigwisPrimary,
  background = DigwisBackground,
  surface = DigwisSurface,
  onSurface = DigwisOnSurface,
  onSurfaceVariant = DigwisOnSurfaceVariant,
)

@Composable
fun DigwisMobileTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = DigwisDarkColors,
    content = content,
  )
}
`
}

function scaffoldClientTargets(projectRoot: string, input: ProjectScaffoldInput, createdFiles: string[], webPort: number) {
  writeTextFile(projectRoot, "packages/core/README.md", buildSharedCoreReadme(), createdFiles)
  writeTextFile(projectRoot, "packages/core/package.json", buildSharedCorePackageJson(), createdFiles)
  writeTextFile(projectRoot, "packages/core/src/index.ts", buildSharedCoreIndex(), createdFiles)
  writeTextFile(projectRoot, "packages/api-client/README.md", buildApiClientReadme(), createdFiles)
  writeTextFile(projectRoot, "packages/api-client/package.json", buildApiClientPackageJson(), createdFiles)
  writeTextFile(projectRoot, "packages/api-client/tsconfig.json", buildApiClientTsconfig(), createdFiles)
  writeTextFile(projectRoot, "packages/api-client/src/config.ts", buildApiClientConfig(webPort), createdFiles)
  writeTextFile(projectRoot, "packages/api-client/src/contracts.ts", buildApiClientContracts(), createdFiles)
  writeTextFile(projectRoot, "packages/api-client/src/client.ts", buildApiClientSource(), createdFiles)
  writeTextFile(projectRoot, "packages/api-client/src/example.ts", buildApiClientExample(), createdFiles)
  writeTextFile(projectRoot, "packages/api-client/src/index.ts", buildApiClientIndex(), createdFiles)

  if (input.clientTargets.includes("electron")) {
    writeTextFile(projectRoot, "apps/desktop/package.json", buildElectronPackageJson(), createdFiles)
    writeTextFile(projectRoot, "apps/desktop/main.js", buildElectronMain(input.displayName.trim()), createdFiles)
    writeTextFile(projectRoot, "apps/desktop/preload.js", buildElectronPreload(), createdFiles)
    writeTextFile(projectRoot, "apps/desktop/renderer/index.html", buildElectronHtml(input.displayName.trim()), createdFiles)
    writeTextFile(projectRoot, "apps/desktop/renderer/renderer.js", buildElectronRendererJs(), createdFiles)
    writeTextFile(projectRoot, "apps/desktop/renderer/styles.css", buildElectronCss(), createdFiles)
    writeTextFile(projectRoot, "apps/desktop/README.md", buildElectronReadme(), createdFiles)
  }

  if (input.clientTargets.includes("ios-native")) {
    writeTextFile(projectRoot, "apps/mobile-ios/README.md", buildIosReadme(input.displayName.trim()), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-ios/project.yml", buildIosProjectYml(input.displayName.trim()), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-ios/Sources/App/App.swift", buildIosAppSwift(input.displayName.trim()), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-ios/Sources/App/ContentView.swift", buildIosContentView(input.displayName.trim()), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-ios/Sources/App/AppState.swift", buildIosAppState(webPort), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-ios/Sources/App/APIClient.swift", buildIosApiClient(), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-ios/Resources/Info.plist", buildIosInfoPlist(), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-ios/Config/API.xcconfig", buildIosApiConfig(webPort), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-ios/Resources/Assets.xcassets/Contents.json", buildAppleAssetsContents(), createdFiles)
    writeTextFile(
      projectRoot,
      "apps/mobile-ios/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json",
      buildIosAppIconContents(),
      createdFiles,
    )
    writeTextFile(
      projectRoot,
      "apps/mobile-ios/Resources/Assets.xcassets/AccentColor.colorset/Contents.json",
      buildIosAccentColorContents(),
      createdFiles,
    )
  }

  if (input.clientTargets.includes("android-native")) {
    writeTextFile(projectRoot, "apps/mobile-android/README.md", buildAndroidReadme(input.displayName.trim()), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-android/settings.gradle.kts", buildAndroidSettingsGradle(), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-android/build.gradle.kts", buildAndroidRootGradle(), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-android/gradle.properties", buildAndroidGradleProperties(), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-android/app/build.gradle.kts", buildAndroidAppGradle(), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-android/app/proguard-rules.pro", buildAndroidProguardRules(), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-android/app/src/main/AndroidManifest.xml", buildAndroidManifest(), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-android/app/src/main/java/com/digwis/mobile/ApiConfig.kt", buildAndroidApiConfig(webPort), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-android/app/src/main/java/com/digwis/mobile/AppState.kt", buildAndroidAppState(), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-android/app/src/main/java/com/digwis/mobile/MainViewModel.kt", buildAndroidMainViewModel(), createdFiles)
    writeTextFile(
      projectRoot,
      "apps/mobile-android/app/src/main/java/com/digwis/mobile/MainActivity.kt",
      buildAndroidMainActivity(input.displayName.trim()),
      createdFiles,
    )
    writeTextFile(projectRoot, "apps/mobile-android/app/src/main/java/com/digwis/mobile/ui/DigwisApp.kt", buildAndroidAppComposable(), createdFiles)
    writeTextFile(
      projectRoot,
      "apps/mobile-android/app/src/main/java/com/digwis/mobile/ui/theme/Color.kt",
      buildAndroidColorScheme(),
      createdFiles,
    )
    writeTextFile(
      projectRoot,
      "apps/mobile-android/app/src/main/java/com/digwis/mobile/ui/theme/Theme.kt",
      buildAndroidThemeKt(),
      createdFiles,
    )
    writeTextFile(projectRoot, "apps/mobile-android/app/src/main/res/values/strings.xml", buildAndroidStrings(), createdFiles)
    writeTextFile(projectRoot, "apps/mobile-android/app/src/main/res/values/themes.xml", buildAndroidThemes(), createdFiles)
  }
}

export function generateProjectScaffoldFiles(
  input: ProjectScaffoldInput,
  rootPath: string,
  options?: { webPort?: number },
) {
  const createdFiles: string[] = []
  const webPort = options?.webPort ?? DEFAULT_WEB_PORT
  const ctx: ScaffoldContext = {
    rootPath,
    projectName: input.displayName.trim(),
    slug: input.slug.trim(),
    template: input.template,
    database: input.database,
    webPort,
    clientTargets: new Set(input.clientTargets),
    runtimeModules: new Set(input.runtimeModules),
    serviceModules: new Set(input.serviceModules),
  }

  writeTextFile(rootPath, "package.json", buildRootPackageJson(input), createdFiles)
  writeTextFile(rootPath, "pnpm-workspace.yaml", `packages:\n${buildWorkspacePatterns().map((item) => `  - ${item}`).join("\n")}\n`, createdFiles)
  writeTextFile(rootPath, ".gitignore", "node_modules\n.next\n.env\n.env.local\n.dist\n__pycache__\n.venv\n", createdFiles)
  writeTextFile(rootPath, ".env.example", buildRootEnvExample(input, webPort), createdFiles)
  writeTextFile(rootPath, "README.md", buildReadme(ctx), createdFiles)
  writeTextFile(rootPath, "apps/web/package.json", buildWebPackageJson(input, webPort), createdFiles)
  writeTextFile(rootPath, "apps/web/.env.example", buildWebEnvExample(input), createdFiles)
  writeTextFile(rootPath, "apps/web/tsconfig.json", buildTsconfig(), createdFiles)
  writeTextFile(rootPath, "apps/web/next-env.d.ts", '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n\n// This file is managed by Next.js.\n', createdFiles)
  writeTextFile(rootPath, "apps/web/next.config.mjs", buildNextConfig(), createdFiles)
  writeTextFile(rootPath, "apps/web/scripts/dev-with-wasm.cjs", buildWebDevLauncher(webPort), createdFiles)
  writeTextFile(rootPath, "apps/web/app/layout.tsx", buildWebLayout(ctx.projectName), createdFiles)
  writeTextFile(rootPath, "apps/web/app/page.tsx", buildWebPage(ctx), createdFiles)
  writeTextFile(rootPath, "apps/web/app/globals.css", buildWebCss(), createdFiles)
  writeTextFile(rootPath, "apps/web/lib/api-client.ts", buildWebApiClientHelper(), createdFiles)
  writeTextFile(rootPath, "apps/web/lib/digwis-runtime-modules.ts", buildRuntimeModulesHelper(input.runtimeModules), createdFiles)
  scaffoldClientTargets(rootPath, input, createdFiles, webPort)
  writeTextFile(rootPath, "packages/ui/README.md", "# Shared UI package\n\nReserve this workspace for cross-project components.\n", createdFiles)
  writeTextFile(rootPath, "packages/config/README.md", "# Shared config package\n\nKeep theme and site-level configuration here.\n", createdFiles)

  if (input.template === "next-directus") {
    writeTextFile(
      rootPath,
      "services/directus/README.md",
      buildDirectusReadme(),
      createdFiles,
    )
    writeTextFile(rootPath, "services/directus/package.json", buildDirectusServicePackageJson(), createdFiles)
    writeTextFile(rootPath, "services/directus/.env.example", buildDirectusServiceEnvExample(input), createdFiles)
  }

  if (input.template === "next-payload") {
    writePayloadCmsTemplate(input.database, "apps/web", (relativePath, content) => {
      writeTextFile(rootPath, relativePath, content, createdFiles)
    })
    writeTextFile(rootPath, "apps/web/app/(payload)/layout.tsx", buildPayloadLayout(), createdFiles)
    writeTextFile(rootPath, "apps/web/app/(payload)/custom.css", buildPayloadCustomCss(), createdFiles)
    writeTextFile(rootPath, "apps/web/app/(payload)/admin/importMap.ts", buildPayloadImportMap(), createdFiles)
    writeTextFile(
      rootPath,
      "apps/web/app/(payload)/admin/[[...segments]]/page.tsx",
      buildPayloadAdminPage(),
      createdFiles,
    )
    writeTextFile(rootPath, "apps/web/app/(payload)/api/[...slug]/route.ts", buildPayloadApiRoute(), createdFiles)
  }

  if (ctx.serviceModules.has("python-ai")) {
    writeTextFile(rootPath, "services/py-ai/requirements.txt", buildRequirementsTxt(), createdFiles)
    writeTextFile(rootPath, "services/py-ai/app/main.py", buildPythonMain("python-ai"), createdFiles)
  }
  if (ctx.serviceModules.has("python-data")) {
    writeTextFile(rootPath, "services/py-data/requirements.txt", buildRequirementsTxt(), createdFiles)
    writeTextFile(rootPath, "services/py-data/app/main.py", buildPythonMain("python-data"), createdFiles)
  }
  if (ctx.serviceModules.has("go-worker")) {
    writeTextFile(rootPath, "services/go-worker/go.mod", `module ${ctx.slug}/go-worker\n\ngo 1.23\n`, createdFiles)
    writeTextFile(rootPath, "services/go-worker/main.go", buildGoMain(ctx.slug), createdFiles)
  }
  if (ctx.serviceModules.has("rust-worker")) {
    writeTextFile(
      rootPath,
      "services/rust-worker/Cargo.toml",
      `[package]
name = "rust-worker"
version = "0.1.0"
edition = "2024"

[dependencies]
`,
      createdFiles,
    )
    writeTextFile(rootPath, "services/rust-worker/src/main.rs", buildRustMain(), createdFiles)
  }

  const contract = buildContract(input, webPort)
  writeTextFile(rootPath, "digwis-project.json", JSON.stringify(contract, null, 2) + "\n", createdFiles)
  const lightModules = input.runtimeModules.filter((moduleId): moduleId is LightRuntimeModule =>
    (LIGHT_RUNTIME_MODULES as readonly string[]).includes(moduleId),
  )
  for (const moduleId of lightModules) {
    ensureRuntimeModuleScaffold(moduleId, rootPath, path.join(rootPath, "apps", "web"), input.runtimeModules, createdFiles, [])
  }
  return { contract, createdFiles }
}

export function getProjectConfig(projectRoot: string) {
  const contractPath = path.join(projectRoot, "digwis-project.json")
  if (!fs.existsSync(contractPath)) {
    return null
  }
  return readProjectContract(projectRoot).contract
}

export function setProjectRuntimeModules(
  projectRoot: string,
  nextRuntimeModules: ProjectRuntimeModule[],
): ProjectRuntimeModulesUpdateResult {
  const { contract, contractPath } = readProjectContract(projectRoot)
  if (contract.projectType !== "next-platform") {
    throw new Error("当前项目不是 Digwis 平台项目，无法切换模块")
  }

  const previousModules = new Set(contract.runtimeModules)
  const normalized = [...new Set(nextRuntimeModules)]
  const addedModules = normalized.filter((moduleId) => !previousModules.has(moduleId))
  const unsupportedAdds = addedModules.filter((moduleId) => !(LIGHT_RUNTIME_MODULES as readonly string[]).includes(moduleId))
  if (unsupportedAdds.length > 0) {
    throw new Error(`当前版本只支持创建后扩展轻模块：${LIGHT_RUNTIME_MODULES.join("、")}；暂不支持 ${unsupportedAdds.join("、")}`)
  }

  const createdFiles: string[] = []
  const warnings: string[] = []
  const webRoot = resolveWebRoot(projectRoot, contract)
  const appDir = resolveNextAppDir(webRoot)
  const libDir = resolveNextLibDir(webRoot, appDir)
  const runtimeModulesPath = path.join(libDir, "digwis-runtime-modules.ts")
  fs.mkdirSync(path.dirname(runtimeModulesPath), { recursive: true })
  const runtimeModulesRelative = toPosixPath(path.relative(projectRoot, runtimeModulesPath))
  const runtimeModulesExisted = fs.existsSync(runtimeModulesPath)
  fs.writeFileSync(runtimeModulesPath, buildRuntimeModulesHelper(normalized), "utf8")
  if (!runtimeModulesExisted) {
    createdFiles.push(runtimeModulesRelative)
  }

  for (const moduleId of addedModules) {
    if ((LIGHT_RUNTIME_MODULES as readonly string[]).includes(moduleId)) {
      ensureRuntimeModuleScaffold(
        moduleId as LightRuntimeModule,
        projectRoot,
        webRoot,
        normalized,
        createdFiles,
        warnings,
      )
    }
  }

  contract.runtimeModules = normalized
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8")

  const enabledLightModules = normalized.filter((moduleId) =>
    (LIGHT_RUNTIME_MODULES as readonly string[]).includes(moduleId),
  )
  const disabledLightModules = [...previousModules].filter(
    (moduleId) => (LIGHT_RUNTIME_MODULES as readonly string[]).includes(moduleId) && !normalized.includes(moduleId),
  )

  return {
    ok: true,
    message:
      [
        addedModules.length ? `已启用：${addedModules.join("、")}` : "",
        disabledLightModules.length ? `已停用：${disabledLightModules.join("、")}` : "",
        !addedModules.length && !disabledLightModules.length ? "模块配置未变化" : "",
      ]
        .filter(Boolean)
        .join("；") || "模块配置已更新",
    contract,
    createdFiles,
    warnings: [
      ...warnings,
      addedModules.length === 0 && enabledLightModules.length > 0 ? "已存在的模块文件不会被重写。" : "",
    ].filter(Boolean),
  }
}

export async function createProjectScaffold(
  payload: ProjectScaffoldInput,
  options?: CreateProjectScaffoldOptions,
): Promise<ProjectScaffoldResult> {
  const resolvedRoot = ensureScaffoldRoot(payload.localPath)
  const webPort = await allocateWebPort()
  const warnings: string[] = []
  const useFullPayloadTemplate = payload.template === "next-payload" && Boolean(payload.fullTemplatePull)
  const useFullDirectusTemplate = payload.template === "next-directus" && Boolean(payload.fullTemplatePull)
  const report = (event: Omit<ProjectScaffoldProgressEvent, "at" | "displayName" | "localPath">) =>
    emitScaffoldProgress(options?.onProgress, {
      ...event,
      displayName: payload.displayName,
      localPath: resolvedRoot,
    })
  let createdProject: LocalProjectRecord | null = null

  report({
    stage: "prepare",
    status: "running",
    percent: 4,
    message: "正在准备项目目录",
    detail: `已分配本地预览端口 ${webPort}`,
  })

  let contract: DigwisProjectConfig
  let createdFiles: string[]
  if (useFullPayloadTemplate) {
    report({
      stage: "template",
      status: "running",
      percent: 18,
      message: "正在载入 Payload 完整模板",
      detail: "正在在线拉取 Payload 官方 website 模板。",
    })
    const payloadVersion = await resolvePayloadPublishedVersion(resolvedRoot)
    const pulled = await pullPayloadFullTemplate(resolvedRoot, payloadVersion)
    if (!pulled.ok) {
      report({
      stage: "failed",
      status: "error",
      percent: 100,
      message: "拉取 Payload 完整模板失败",
      detail: pulled.output || "unknown error",
    })
      throw new Error(`拉取 Payload 官方 website 模板失败：${pulled.output || "unknown error"}`)
    }
    const normalized = await patchFullPayloadTemplate(resolvedRoot, payload, webPort)
    report({
      stage: "template",
      status: "running",
      percent: 28,
      message: "正在修正 Payload 模板配置",
      detail: `已切换到 ${normalized.database}，workspace 依赖改为 ${normalized.version}，并自动生成 website 模板运行环境`,
    })
    contract = buildContractForFullPayload(payload, webPort)
    fs.writeFileSync(path.join(resolvedRoot, "digwis-project.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8")
    createdFiles = [
      "digwis-project.json",
      "package.json",
      "src/payload.config.ts",
      "src/collections/Pages.ts",
      "src/collections/Posts.ts",
      "src/collections/Categories.ts",
      "src/collections/Tags.ts",
      "src/globals/SiteSettings.ts",
      "src/globals/MainNavigation.ts",
      "src/app/(payload)/admin/[[...segments]]/page.tsx",
    ]
    scaffoldClientTargets(resolvedRoot, payload, createdFiles, webPort)
    warnings.push(`已在线拉取 Payload 官方 website 模板，并注入 Digwis 运行补丁；项目结构是单体应用，不是 apps/web。`)
  } else if (useFullDirectusTemplate) {
    report({
      stage: "template",
      status: "running",
      percent: 18,
      message: "正在生成 Next + Directus 完整项目模板",
    })
    const generated = generateProjectScaffoldFiles(payload, resolvedRoot, { webPort })
    contract = buildContractForFullDirectus(payload, webPort)
    fs.writeFileSync(path.join(resolvedRoot, "digwis-project.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8")
    fs.mkdirSync(path.join(resolvedRoot, "services", "directus"), { recursive: true })
    fs.mkdirSync(path.join(resolvedRoot, "services", "directus", "uploads"), { recursive: true })
    fs.mkdirSync(path.join(resolvedRoot, "services", "directus", "extensions"), { recursive: true })
    fs.mkdirSync(path.join(resolvedRoot, "services", "directus", "snapshots"), { recursive: true })
    if (payload.database === "sqlite") {
      fs.mkdirSync(path.join(resolvedRoot, "services", "directus", "database"), { recursive: true })
    }
    fs.writeFileSync(
      path.join(resolvedRoot, "services", "directus", "docker-compose.yml"),
      buildDirectusFullDockerCompose(payload),
      "utf8",
    )
    fs.writeFileSync(path.join(resolvedRoot, "services", "directus", ".env"), buildDirectusFullEnv(payload), "utf8")
    fs.writeFileSync(path.join(resolvedRoot, "services", "directus", ".env.example"), buildDirectusFullEnv(payload), "utf8")
    fs.writeFileSync(
      path.join(resolvedRoot, "services", "directus", "README.md"),
      "# Directus Full Sidecar\n\nRun `npm run directus:up` from project root and open http://127.0.0.1:8055/admin\n",
      "utf8",
    )
    fs.writeFileSync(path.join(resolvedRoot, "package.json"), buildDirectusFullRootPackageJson(payload, webPort), "utf8")
    createdFiles = [
      ...generated.createdFiles,
      "services/directus/docker-compose.yml",
      "services/directus/.env",
      "services/directus/.env.example",
      "services/directus/README.md",
      "digwis-project.json",
      "package.json",
    ]
    warnings.push("已生成 Directus 完整 sidecar（docker-compose），可直接 `npm run directus:up`。")
  } else {
    report({
      stage: "template",
      status: "running",
      percent: 18,
      message: "正在生成平台项目骨架",
    })
    const generated = generateProjectScaffoldFiles(payload, resolvedRoot, { webPort })
    contract = generated.contract
    createdFiles = generated.createdFiles
  }

  report({
    stage: "template",
    status: "success",
    percent: 34,
    message: "模板文件已准备完成",
    detail: `${createdFiles.length} 个项目文件已写入`,
  })

  if (payload.serviceModules.includes("go-worker") || payload.serviceModules.includes("rust-worker")) {
    warnings.push("Go/Rust worker 已生成骨架，但依赖安装和运行环境仍需在目标机器上准备。")
  }

  const autoInstall = payload.autoInstall ?? true
  const autoStart = payload.autoStart ?? true
  const bootstrap = {
    attempted: autoInstall || autoStart,
    installOk: false,
    startOk: false,
    previewUrl: contract.panel.previewUrl,
    healthChecks: [] as Array<{ name: string; ok: boolean; detail?: string }>,
  }

  try {
    createdProject = addLocalProjectFromPath({
      localPath: resolvedRoot,
      displayName: payload.displayName,
      category: "local-dev",
    })
    report({
      stage: "register",
      status: "success",
      percent: 42,
      message: "项目已加入面板",
      projectId: createdProject.id,
    })
    logScaffoldOperation(createdProject.id, `[scaffold] registered localPath=${resolvedRoot}\n`, "system")
  } catch (error) {
    report({
      stage: "failed",
      status: "error",
      percent: 100,
      message: "项目写入成功，但加入面板失败",
      detail: error instanceof Error ? error.message : "register failed",
    })
    fs.rmSync(resolvedRoot, { recursive: true, force: true })
    throw error
  }

  if (autoInstall) {
    const fallbackInstallCommand = buildNpmFallbackInstallCommand(contract)
    report({
      stage: "install",
      status: "running",
      percent: 52,
      message: "正在安装项目依赖",
      detail: useFullPayloadTemplate || useFullDirectusTemplate ? "pnpm install || npm install" : "pnpm install",
      projectId: createdProject.id,
    })
    logScaffoldOperation(createdProject.id, "[scaffold] install start\n", "system")
    const installCommand = useFullPayloadTemplate || useFullDirectusTemplate ? "pnpm install || npm install" : "pnpm install"
    let installProgressStep = 0
    const publishInstallProgress = (line: string, stream: "stdout" | "stderr") => {
      installProgressStep += 1
      const percent = Math.min(70, 52 + Math.floor(installProgressStep / 3))
      report({
        stage: "install",
        status: stream === "stderr" ? "warning" : "running",
        percent,
        message: "正在安装项目依赖",
        detail: line.slice(0, 220),
        projectId: createdProject.id,
      })
    }
    const install = await runCommand(resolvedRoot, installCommand, 30 * 60 * 1000, {
      onOutput: publishInstallProgress,
    })
    let installOk = install.ok
    let installDetail = install.output
    if (!install.ok) {
      report({
        stage: "install",
        status: "warning",
        percent: 66,
        message: "pnpm 安装失败，正在回退到 npm",
        detail: fallbackInstallCommand,
        projectId: createdProject.id,
      })
      const fallbackInstall = await runCommand(resolvedRoot, fallbackInstallCommand, 30 * 60 * 1000, {
        onOutput: publishInstallProgress,
      })
      installOk = fallbackInstall.ok
      installDetail = `${install.output}\n--- fallback ${fallbackInstallCommand} ---\n${fallbackInstall.output}`.trim()
    }
    bootstrap.installOk = installOk
    if (installOk) {
      const repaired = repairProjectNativeModules(resolvedRoot)
      if (repaired.repaired.length > 0) {
        logScaffoldOperation(
          createdProject.id,
          `[scaffold] repaired native modules\n${repaired.repaired.join("\n")}\n`,
          "system",
        )
      }
    }
    bootstrap.healthChecks.push({
      name: "install",
      ok: installOk,
      detail: installOk ? "dependency installation completed" : (installDetail || "install failed").slice(-300),
    })
    logScaffoldOperation(
      createdProject.id,
      installOk
        ? "[scaffold] install success\n"
        : `[scaffold] install failed\n${(installDetail || "install failed").slice(-600)}\n`,
      installOk ? "system" : "stderr",
    )
    report({
      stage: "install",
      status: installOk ? "success" : "warning",
      percent: installOk ? 72 : 70,
      message: installOk ? "项目依赖安装完成" : "项目依赖安装失败，已保留目录",
      detail: installOk ? "可以继续自动启动预览" : (installDetail || "install failed").slice(-220),
      projectId: createdProject.id,
    })
    if (!installOk) {
      warnings.push(`自动安装依赖失败，已保留项目目录，可手动执行 ${fallbackInstallCommand}。`)
    }
  } else {
    bootstrap.installOk = true
  }

  if (autoStart && bootstrap.installOk) {
    report({
      stage: "start",
      status: "running",
      percent: 82,
      message: "正在启动本地预览服务",
      detail: contract.panel.previewUrl,
      projectId: createdProject.id,
    })
    logScaffoldOperation(createdProject.id, `[scaffold] start preview=${contract.panel.previewUrl}\n`, "system")
    const started = startDevServerDetached(resolvedRoot)
    const detectedPreviewUrl = await waitForPreviewUrlFromLog(started.logPath, 20_000)
    const effectivePreviewUrl = detectedPreviewUrl || contract.panel.previewUrl
    const effectiveAdminUrl = resolveAdminUrlFromPreview(effectivePreviewUrl, contract.panel.adminUrl)
    writeProjectLocalRuntime(resolvedRoot, {
      previewUrl: effectivePreviewUrl,
      adminUrl: effectiveAdminUrl,
      pid: started.pid ?? undefined,
      logPath: started.logPath,
    })
    bootstrap.previewUrl = effectivePreviewUrl
    const ready = await waitForHttp(effectivePreviewUrl, 45_000)
    bootstrap.startOk = ready
    bootstrap.healthChecks.push({
      name: "preview",
      ok: ready,
      detail: ready ? `dev server reachable at ${effectivePreviewUrl}` : "dev server not reachable in 45s",
    })
    if (!ready) {
      warnings.push("已尝试后台启动开发服务，但在 45 秒内未探测到可访问页面。")
    } else if (started.pid) {
      bootstrap.healthChecks.push({
        name: "pid",
        ok: true,
        detail: `dev server pid ${started.pid}`,
      })
    }
    logScaffoldOperation(
      createdProject.id,
      ready
        ? `[scaffold] preview ready ${effectivePreviewUrl}${started.pid ? ` pid=${started.pid}` : ""}\n`
        : `[scaffold] preview not reachable ${effectivePreviewUrl}\n`,
      ready ? "system" : "stderr",
    )
    report({
      stage: "start",
      status: ready ? "success" : "warning",
      percent: ready ? 90 : 88,
      message: ready ? "本地预览已可访问" : "本地预览尚未就绪",
      detail: ready ? effectivePreviewUrl : "45 秒内未探测到可访问页面",
      projectId: createdProject.id,
    })

    if (useFullDirectusTemplate) {
      report({
        stage: "admin",
        status: "running",
        percent: 92,
        message: "正在启动 Directus 管理端",
        detail: contract.panel.adminUrl,
        projectId: createdProject.id,
      })
      const directusStart = await runCommand(resolvedRoot, "npm run directus:up", 2 * 60 * 1000)
      bootstrap.healthChecks.push({
        name: "directus-up",
        ok: directusStart.ok,
        detail: directusStart.ok ? "directus sidecar started" : (directusStart.output || "directus up failed").slice(-300),
      })
      logScaffoldOperation(
        createdProject.id,
        directusStart.ok
          ? "[scaffold] directus sidecar started\n"
          : `[scaffold] directus sidecar failed\n${(directusStart.output || "directus up failed").slice(-500)}\n`,
        directusStart.ok ? "system" : "stderr",
      )
      if (directusStart.ok) {
        const adminReady = await waitForHttp(effectiveAdminUrl, 45_000)
        bootstrap.healthChecks.push({
          name: "directus-admin",
          ok: adminReady,
          detail: adminReady ? `directus admin reachable at ${effectiveAdminUrl}` : "directus admin not reachable in 45s",
        })
        logScaffoldOperation(
          createdProject.id,
          adminReady
            ? `[scaffold] directus admin ready ${effectiveAdminUrl}\n`
            : `[scaffold] directus admin not reachable ${effectiveAdminUrl}\n`,
          adminReady ? "system" : "stderr",
        )
        report({
          stage: "admin",
          status: adminReady ? "success" : "warning",
          percent: adminReady ? 97 : 95,
          message: adminReady ? "Directus 管理端已可访问" : "Directus 管理端尚未就绪",
          detail: adminReady ? effectiveAdminUrl : "45 秒内未探测到管理端可访问",
          projectId: createdProject.id,
        })
        if (!adminReady) {
          warnings.push("Directus sidecar 已启动，但 /admin 在 45 秒内未就绪。")
        }
      } else {
        report({
          stage: "admin",
          status: "warning",
          percent: 95,
          message: "Directus sidecar 自动启动失败",
          detail: (directusStart.output || "directus up failed").slice(-220),
          projectId: createdProject.id,
        })
        warnings.push("Directus sidecar 自动启动失败，可手动执行 npm run directus:up。")
      }
    }
  } else if (autoStart) {
    bootstrap.healthChecks.push({
      name: "preview",
      ok: false,
      detail: "skip start because install failed",
    })
    report({
      stage: "start",
      status: "warning",
      percent: 82,
      message: "跳过本地预览启动",
      detail: "因为依赖安装失败，未继续自动启动。",
      projectId: createdProject.id,
    })
  }
  report({
    stage: "done",
    status: warnings.length > 0 ? "warning" : "success",
    percent: 100,
    message: warnings.length > 0 ? "项目已创建，但有后续注意事项" : "项目已创建完成",
    detail: warnings[0],
    projectId: createdProject.id,
  })
  logScaffoldOperation(createdProject.id, "[scaffold] done\n", warnings.length > 0 ? "stderr" : "system")

  return {
    ok: true,
    message: "已生成项目骨架并加入面板",
    project: createdProject,
    localPath: resolvedRoot,
    createdFiles,
    warnings,
    contract,
    bootstrap,
  }
}
