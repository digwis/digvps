import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { generateProjectScaffoldFiles, setProjectRuntimeModules } from "../project-scaffold"

let tempRoot = ""

describe("generateProjectScaffoldFiles", () => {
  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "digwis-panel-scaffold-"))
  })

  afterAll(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("creates a next-payload scaffold with cms and worker files", () => {
    const localPath = path.join(tempRoot, "payload-demo")
    fs.mkdirSync(localPath, { recursive: true })

    const result = generateProjectScaffoldFiles(
      {
        displayName: "Payload Demo",
        slug: "payload-demo",
        localPath,
        packageManager: "pnpm",
        monorepo: true,
        template: "next-payload",
        database: "postgresql",
        runtimeModules: ["auth", "dashboard"],
        serviceModules: ["python-ai"],
      },
      localPath,
    )

    expect(result.contract.template).toBe("next-payload")
    expect(result.contract.services.cms?.type).toBe("payload")
    expect(result.contract.services.pythonAi?.enabled).toBe(true)
    expect(result.createdFiles).toContain("apps/web/payload.config.ts")
    expect(result.createdFiles).toContain("apps/web/app/(payload)/api/[...slug]/route.ts")

    expect(fs.existsSync(path.join(localPath, "apps/web/payload.config.ts"))).toBe(true)
    expect(fs.existsSync(path.join(localPath, "apps/web/app/(payload)/admin/[[...segments]]/page.tsx"))).toBe(true)
    expect(fs.existsSync(path.join(localPath, "services/py-ai/app/main.py"))).toBe(true)

    const rootEnv = fs.readFileSync(path.join(localPath, ".env.example"), "utf8")
    expect(rootEnv).toContain("PAYLOAD_SECRET=")
    expect(rootEnv).toContain("DATABASE_URL=postgresql://")

    const readme = fs.readFileSync(path.join(localPath, "README.md"), "utf8")
    expect(readme).toContain("Open `/admin`")
  })

  test("creates a next-directus scaffold with runnable sidecar files", () => {
    const localPath = path.join(tempRoot, "directus-demo")
    fs.mkdirSync(localPath, { recursive: true })

    const result = generateProjectScaffoldFiles(
      {
        displayName: "Directus Demo",
        slug: "directus-demo",
        localPath,
        packageManager: "pnpm",
        monorepo: true,
        template: "next-directus",
        database: "postgresql",
        runtimeModules: ["auth"],
        serviceModules: [],
      },
      localPath,
    )

    expect(result.contract.template).toBe("next-directus")
    expect(result.contract.services.cms?.type).toBe("directus")
    expect(result.createdFiles).toContain("services/directus/package.json")
    expect(result.createdFiles).toContain("services/directus/.env.example")

    const directusPackage = fs.readFileSync(path.join(localPath, "services/directus/package.json"), "utf8")
    expect(directusPackage).toContain("\"directus\"")
    expect(directusPackage).toContain("\"dev\": \"directus start\"")

    const directusEnv = fs.readFileSync(path.join(localPath, "services/directus/.env.example"), "utf8")
    expect(directusEnv).toContain("PORT=8055")
    expect(directusEnv).toContain("DB_CLIENT=pg")

    const rootPackage = fs.readFileSync(path.join(localPath, "package.json"), "utf8")
    expect(rootPackage).toContain("directus:dev")
  })

  test("adds and disables light runtime modules after scaffold creation", () => {
    const localPath = path.join(tempRoot, "module-demo")
    fs.mkdirSync(localPath, { recursive: true })

    generateProjectScaffoldFiles(
      {
        displayName: "Module Demo",
        slug: "module-demo",
        localPath,
        packageManager: "pnpm",
        monorepo: true,
        template: "next-core",
        database: "postgresql",
        runtimeModules: ["auth"],
        serviceModules: [],
      },
      localPath,
    )

    const enabled = setProjectRuntimeModules(localPath, ["auth", "docs", "dashboard", "i18n"])
    expect(enabled.ok).toBe(true)
    expect(enabled.contract.runtimeModules).toContain("docs")
    expect(enabled.createdFiles).toContain("apps/web/app/docs/page.tsx")
    expect(enabled.createdFiles).toContain("apps/web/app/dashboard/page.tsx")
    expect(enabled.createdFiles).toContain("apps/web/app/[locale]/page.tsx")

    const helper = fs.readFileSync(path.join(localPath, "apps/web/lib/digwis-runtime-modules.ts"), "utf8")
    expect(helper).toContain('"dashboard"')
    expect(helper).toContain('"i18n"')

    const disabled = setProjectRuntimeModules(localPath, ["auth", "docs"])
    expect(disabled.ok).toBe(true)
    expect(disabled.contract.runtimeModules).toEqual(["auth", "docs"])

    const nextHelper = fs.readFileSync(path.join(localPath, "apps/web/lib/digwis-runtime-modules.ts"), "utf8")
    expect(nextHelper).toContain('"docs"')
    expect(nextHelper).not.toContain('"dashboard"')
    expect(nextHelper).not.toContain('"i18n"')
  })
})
