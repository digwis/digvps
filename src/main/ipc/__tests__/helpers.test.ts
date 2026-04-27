import { describe, expect, test } from "vitest"
import { resolveActionKindFromScript } from "../helpers"

describe("resolveActionKindFromScript", () => {
  test("maps known deploy and sync scripts", () => {
    expect(resolveActionKindFromScript("deploy:panel")).toBe("code")
    expect(resolveActionKindFromScript("sync:vps:data")).toBe("data")
    expect(resolveActionKindFromScript("sync:vps:uploads")).toBe("uploads")
    expect(resolveActionKindFromScript("backup:vps")).toBe("backup")
  })

  test("returns null for unknown scripts", () => {
    expect(resolveActionKindFromScript("dev")).toBeNull()
    expect(resolveActionKindFromScript()).toBeNull()
  })
})
