import { describe, expect, test } from "vitest"
import {
  operationLogAppendSchema,
  parseOrThrow,
  projectDeploySchema,
  projectLocalPathUpdateSchema,
  projectRuntimeModulesUpdateSchema,
  projectScaffoldSchema,
  remoteDownloadSchema,
  remoteManagedProjectScanSchema,
  vpsConnectionInputSchema,
} from "../schemas"

describe("ipc schemas", () => {
  test("accepts a valid deploy payload", () => {
    const parsed = parseOrThrow(projectDeploySchema, {
      projectId: "proj-1",
      connectionId: "conn-1",
      strategy: "local-npm-script",
      npmScript: "deploy:panel",
    })
    expect(parsed.npmScript).toBe("deploy:panel")
  })

  test("accepts a project local-path update payload", () => {
    const parsed = parseOrThrow(projectLocalPathUpdateSchema, {
      projectId: "proj-1",
      localPath: "/tmp/demo",
    })
    expect(parsed.projectId).toBe("proj-1")
    expect(parsed.localPath).toBe("/tmp/demo")
  })

  test("accepts a project scaffold payload", () => {
    const parsed = parseOrThrow(projectScaffoldSchema, {
      displayName: "Payload Demo",
      slug: "payload-demo",
      localPath: "/tmp/payload-demo",
      packageManager: "pnpm",
      monorepo: true,
      template: "next-payload",
      database: "postgresql",
      clientTargets: ["electron"],
      runtimeModules: ["auth", "dashboard"],
      serviceModules: ["python-ai"],
    })
    expect(parsed.template).toBe("next-payload")
    expect(parsed.serviceModules).toContain("python-ai")
  })

  test("accepts a runtime module update payload", () => {
    const parsed = parseOrThrow(projectRuntimeModulesUpdateSchema, {
      projectId: "proj-1",
      runtimeModules: ["auth", "docs", "dashboard"],
    })
    expect(parsed.runtimeModules).toContain("docs")
  })

  test("accepts a project operation log append payload", () => {
    const parsed = parseOrThrow(operationLogAppendSchema, {
      projectId: "proj-1",
      stream: "system",
      chunk: "[local-fix] start\n",
    })
    expect(parsed.stream).toBe("system")
    expect(parsed.chunk).toContain("local-fix")
  })

  test("rejects invalid remote download payload", () => {
    expect(() =>
      parseOrThrow(remoteDownloadSchema, {
        connectionId: "conn-1",
        path: "",
        name: "demo",
        type: "bogus",
      }),
    ).toThrow()
  })

  test("accepts a remote managed project scan payload", () => {
    const parsed = parseOrThrow(remoteManagedProjectScanSchema, {
      connectionId: "conn-123",
    })
    expect(parsed.connectionId).toBe("conn-123")
  })

  test("rejects remote managed project scan without connectionId", () => {
    expect(() => parseOrThrow(remoteManagedProjectScanSchema, {})).toThrow()
  })

  test("requires matching auth credentials", () => {
    expect(() =>
      parseOrThrow(vpsConnectionInputSchema, {
        name: "demo",
        host: "127.0.0.1",
        port: 22,
        username: "root",
        authType: "password",
      }),
    ).toThrow(/password/)
  })

  test("allows saved private-key connection without embedded secret", () => {
    const parsed = parseOrThrow(vpsConnectionInputSchema, {
      id: "conn-1",
      name: "demo",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      authType: "privateKey",
    })
    expect(parsed.id).toBe("conn-1")
    expect(parsed.authType).toBe("privateKey")
  })

  test("accepts optional provider metadata", () => {
    const parsed = parseOrThrow(vpsConnectionInputSchema, {
      name: "demo",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      provider: "GreenCloud",
      locationLabel: "东京软银",
      expiresAt: "2026-12-31",
      authType: "password",
      password: "secret",
    })
    expect(parsed.provider).toBe("GreenCloud")
    expect(parsed.locationLabel).toBe("东京软银")
    expect(parsed.expiresAt).toBe("2026-12-31")
  })
})
