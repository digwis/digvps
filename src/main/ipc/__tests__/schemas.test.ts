import { describe, expect, test } from "vitest"
import * as schemas from "../schemas"

const {
  parseOrThrow,
  projectDeploySchema,
  projectLocalPathUpdateSchema,
  projectScaffoldSchema,
  projectRuntimeModulesUpdateSchema,
  operationLogAppendSchema,
  remoteDownloadSchema,
  remoteManagedProjectScanSchema,
  openClawInstallSchema,
  openClawLogsSchema,
  vpsConnectionInputSchema,
} = schemas

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
      template: "next-core",
      database: "postgresql",
      clientTargets: ["electron"],
      runtimeModules: ["auth", "dashboard"],
      serviceModules: ["python-ai"],
    })
    expect(parsed.displayName).toBe("Payload Demo")
  })

  test("accepts a runtime module update payload", () => {
    const parsed = parseOrThrow(projectRuntimeModulesUpdateSchema, {
      projectId: "proj-1",
      runtimeModules: ["auth"],
    })
    expect(parsed.runtimeModules).toEqual(["auth"])
  })

  test("accepts a project operation log append payload", () => {
    const parsed = parseOrThrow(operationLogAppendSchema, {
      projectId: "proj-1",
      stream: "stdout",
      chunk: "hello",
    })
    expect(parsed.stream).toBe("stdout")
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

  test("accepts openclaw install payload", () => {
    const parsed = parseOrThrow(openClawInstallSchema, {
      connectionId: "conn-1",
      listenPort: 18789,
    })
    expect(parsed.listenPort).toBe(18789)
  })

  test("rejects openclaw install with port out of range", () => {
    expect(() =>
      parseOrThrow(openClawInstallSchema, { connectionId: "c", listenPort: 80 }),
    ).toThrow()
  })

  test("accepts openclaw logs payload", () => {
    const parsed = parseOrThrow(openClawLogsSchema, {
      connectionId: "conn-1",
      instanceId: "i-1",
      lines: 50,
    })
    expect(parsed.lines).toBe(50)
  })

  test("requires matching auth credentials", () => {
    expect(() =>
      parseOrThrow(vpsConnectionInputSchema, {
        name: "demo",
        host: "1.2.3.4",
        port: 22,
        username: "root",
        authType: "password",
        password: "x",
      }),
    ).not.toThrow()
  })

  test("allows saved private-key connection without embedded secret", () => {
    const parsed = parseOrThrow(vpsConnectionInputSchema, {
      name: "demo",
      host: "1.2.3.4",
      port: 22,
      username: "root",
      authType: "privateKey",
      privateKey: "PLACEHOLDER",
      privateKeySecretRef: "secret-1",
    })
    expect(parsed.authType).toBe("privateKey")
  })

  test("accepts optional provider metadata", () => {
    const parsed = parseOrThrow(vpsConnectionInputSchema, {
      name: "demo",
      host: "1.2.3.4",
      port: 22,
      username: "root",
      authType: "password",
      password: "x",
      provider: "aliyun",
    })
    expect(parsed.provider).toBe("aliyun")
  })
})