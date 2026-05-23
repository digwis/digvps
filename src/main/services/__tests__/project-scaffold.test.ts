import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { generateProjectScaffoldFiles, setProjectRuntimeModules } from "../project-scaffold"
import { writeProjectLocalRuntime } from "../project-local-runtime"

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
        clientTargets: [],
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
    expect(result.createdFiles).toContain("apps/web/lib/api-client.ts")

    expect(fs.existsSync(path.join(localPath, "apps/web/payload.config.ts"))).toBe(true)
    expect(fs.existsSync(path.join(localPath, "apps/web/app/(payload)/admin/[[...segments]]/page.tsx"))).toBe(true)
    expect(fs.existsSync(path.join(localPath, "services/py-ai/app/main.py"))).toBe(true)

    const rootEnv = fs.readFileSync(path.join(localPath, ".env.example"), "utf8")
    expect(rootEnv).toContain("PAYLOAD_SECRET=")
    expect(rootEnv).toContain("DATABASE_URL=postgresql://")

    const readme = fs.readFileSync(path.join(localPath, "README.md"), "utf8")
    expect(readme).toContain("Open `/admin`")
    const webHelper = fs.readFileSync(path.join(localPath, "apps/web/lib/api-client.ts"), "utf8")
    expect(webHelper).toContain("@digwis/api-client")
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
        clientTargets: [],
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
        clientTargets: [],
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

  test("creates optional desktop and mobile client shells", () => {
    const localPath = path.join(tempRoot, "multi-client-demo")
    fs.mkdirSync(localPath, { recursive: true })

    const result = generateProjectScaffoldFiles(
      {
        displayName: "Multi Client Demo",
        slug: "multi-client-demo",
        localPath,
        packageManager: "pnpm",
        monorepo: true,
        template: "next-core",
        database: "postgresql",
        clientTargets: ["electron", "ios-native", "android-native"],
        runtimeModules: ["auth"],
        serviceModules: [],
      },
      localPath,
    )

    expect(result.contract.clientTargets).toEqual(["electron", "ios-native", "android-native"])
    expect(result.contract.apps.desktop?.path).toBe("apps/desktop")
    expect(result.contract.apps.mobileIos?.path).toBe("apps/mobile-ios")
    expect(result.contract.apps.mobileAndroid?.path).toBe("apps/mobile-android")
    expect(result.createdFiles).toContain("apps/desktop/package.json")
    expect(result.createdFiles).toContain("apps/mobile-ios/Sources/App/App.swift")
    expect(result.createdFiles).toContain("apps/mobile-ios/Sources/App/AppState.swift")
    expect(result.createdFiles).toContain("apps/mobile-ios/Sources/App/APIClient.swift")
    expect(result.createdFiles).toContain("apps/mobile-ios/project.yml")
    expect(result.createdFiles).toContain("apps/mobile-android/app/src/main/AndroidManifest.xml")
    expect(result.createdFiles).toContain("apps/mobile-android/app/src/main/java/com/digwis/mobile/MainViewModel.kt")
    expect(result.createdFiles).toContain("apps/mobile-android/app/src/main/java/com/digwis/mobile/ui/theme/Theme.kt")
    expect(result.createdFiles).toContain("apps/mobile-android/app/src/main/res/values/themes.xml")

    const rootPackage = fs.readFileSync(path.join(localPath, "package.json"), "utf8")
    expect(rootPackage).toContain("desktop:dev")
    const webPackage = fs.readFileSync(path.join(localPath, "apps/web/package.json"), "utf8")
    expect(webPackage).toContain("@digwis/api-client")
    expect(webPackage).toContain("dev-with-wasm.cjs")
    const webPage = fs.readFileSync(path.join(localPath, "apps/web/app/page.tsx"), "utf8")
    expect(webPage).toContain("Shared API Contract")
    expect(fs.existsSync(path.join(localPath, "apps/web/scripts/dev-with-wasm.cjs"))).toBe(true)
    const apiClientSource = fs.readFileSync(path.join(localPath, "packages/api-client/src/client.ts"), "utf8")
    expect(apiClientSource).toContain("getHealthcheck")
    const apiContracts = fs.readFileSync(path.join(localPath, "packages/api-client/src/contracts.ts"), "utf8")
    expect(apiContracts).toContain("HealthcheckResponse")
    const iosProject = fs.readFileSync(path.join(localPath, "apps/mobile-ios/project.yml"), "utf8")
    expect(iosProject).toContain("platform: iOS")
    const iosAppState = fs.readFileSync(path.join(localPath, "apps/mobile-ios/Sources/App/AppState.swift"), "utf8")
    expect(iosAppState).toContain("APIClient")
    const androidTheme = fs.readFileSync(
      path.join(localPath, "apps/mobile-android/app/src/main/res/values/themes.xml"),
      "utf8",
    )
    expect(androidTheme).toContain("Theme.DigwisMobile")
    const androidApp = fs.readFileSync(
      path.join(localPath, "apps/mobile-android/app/src/main/java/com/digwis/mobile/ui/DigwisApp.kt"),
      "utf8",
    )
    expect(androidApp).toContain("appState.apiBaseUrl")
    expect(fs.existsSync(path.join(localPath, "packages/core/src/index.ts"))).toBe(true)
    expect(fs.existsSync(path.join(localPath, "packages/api-client/README.md"))).toBe(true)
  })

  test("writes assigned web port through scaffolded clients and contract", () => {
    const localPath = path.join(tempRoot, "custom-port-demo")
    fs.mkdirSync(localPath, { recursive: true })

    const result = generateProjectScaffoldFiles(
      {
        displayName: "Custom Port Demo",
        slug: "custom-port-demo",
        localPath,
        packageManager: "pnpm",
        monorepo: true,
        template: "next-core",
        database: "postgresql",
        clientTargets: ["ios-native", "android-native"],
        runtimeModules: ["auth"],
        serviceModules: [],
      },
      localPath,
      { webPort: 3012 },
    )

    expect(result.contract.apps.web.port).toBe(3012)
    expect(result.contract.panel.previewUrl).toBe("http://127.0.0.1:3012")

    const webPackage = fs.readFileSync(path.join(localPath, "apps/web/package.json"), "utf8")
    expect(webPackage).toContain("dev-with-wasm.cjs")

    const apiClientConfig = fs.readFileSync(path.join(localPath, "packages/api-client/src/config.ts"), "utf8")
    expect(apiClientConfig).toContain("http://127.0.0.1:3012")

    const iosConfig = fs.readFileSync(path.join(localPath, "apps/mobile-ios/Config/API.xcconfig"), "utf8")
    expect(iosConfig).toContain("API_BASE_URL = http://127.0.0.1:3012")

    const androidConfig = fs.readFileSync(
      path.join(localPath, "apps/mobile-android/app/src/main/java/com/digwis/mobile/ApiConfig.kt"),
      "utf8",
    )
    expect(androidConfig).toContain('http://10.0.2.2:3012')
  })

  test("keeps runtime-assigned preview ports reserved for later scaffolds", () => {
    const existingPath = path.join(tempRoot, "existing-runtime-port")
    fs.mkdirSync(existingPath, { recursive: true })

    generateProjectScaffoldFiles(
      {
        displayName: "Existing Runtime Port",
        slug: "existing-runtime-port",
        localPath: existingPath,
        packageManager: "pnpm",
        monorepo: true,
        template: "next-core",
        database: "postgresql",
        clientTargets: [],
        runtimeModules: ["auth"],
        serviceModules: [],
      },
      existingPath,
      { webPort: 3000 },
    )

    writeProjectLocalRuntime(existingPath, {
      previewUrl: "http://127.0.0.1:3001",
      adminUrl: "http://127.0.0.1:3001/admin",
      pid: 12345,
      logPath: path.join(existingPath, ".digwis-panel", "local-dev.log"),
    })

    const runtime = fs.readFileSync(path.join(existingPath, ".digwis-panel", "local-runtime.json"), "utf8")
    expect(runtime).toContain("3001")
  })
})
