import { describe, expect, test } from "vitest"
import { assertSaneRemoteDeployPath } from "../project-deploy"

describe("assertSaneRemoteDeployPath", () => {
  test("accepts common app directories", () => {
    expect(() => assertSaneRemoteDeployPath("/var/www/my-app")).not.toThrow()
    expect(() => assertSaneRemoteDeployPath("/home/root/app")).not.toThrow()
  })

  test("rejects dangerous system paths", () => {
    expect(() => assertSaneRemoteDeployPath("/etc/nginx")).toThrow()
    expect(() => assertSaneRemoteDeployPath("/usr/bin/app")).toThrow()
    expect(() => assertSaneRemoteDeployPath("../tmp")).toThrow()
  })
})
