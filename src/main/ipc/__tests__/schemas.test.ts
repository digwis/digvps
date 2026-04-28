import { describe, expect, test } from "vitest"
import {
  parseOrThrow,
  projectDeploySchema,
  remoteDownloadSchema,
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
})
