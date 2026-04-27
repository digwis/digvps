import { describe, expect, test } from "vitest"
import { parseCheckOutput } from "../system-upgrade"

describe("parseCheckOutput", () => {
  test("parses supported apt result", () => {
    const parsed = parseCheckOutput([
      "status=supported",
      "manager=apt",
      "upgradable_count=12",
      "index_refreshed=1",
    ].join("\n"))

    expect(parsed).toEqual({
      supported: true,
      manager: "apt",
      upgradableCount: 12,
      indexRefreshed: true,
      reason: undefined,
    })
  })

  test("falls back safely on invalid count", () => {
    const parsed = parseCheckOutput([
      "status=unsupported",
      "manager=weird",
      "upgradable_count=n/a",
      "index_refreshed=0",
      "reason=no_apt",
    ].join("\n"))

    expect(parsed.supported).toBe(false)
    expect(parsed.manager).toBe("none")
    expect(parsed.upgradableCount).toBe(0)
    expect(parsed.reason).toBe("no_apt")
  })
})
