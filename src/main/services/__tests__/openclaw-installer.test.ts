import { describe, expect, test } from "vitest"
import {
  buildSystemdUnit,
  detectStatusFromSystemctl,
  ensurePortInRange,
  nextAvailablePort,
  parseSystemdUnitList,
} from "../openclaw-installer"

describe("ensurePortInRange", () => {
  test("rejects ports below 1024", () => {
    expect(() => ensurePortInRange(80)).toThrow()
  })
  test("accepts 18789", () => {
    expect(ensurePortInRange(18789)).toBe(18789)
  })
})

describe("nextAvailablePort", () => {
  test("returns base port when none used", () => {
    expect(nextAvailablePort(18789, [])).toBe(18789)
  })
  test("skips used ports", () => {
    expect(nextAvailablePort(18789, [18789, 18790])).toBe(18791)
  })
  test("throws after 4 used", () => {
    expect(() => nextAvailablePort(18789, [18789, 18790, 18791, 18792])).toThrow()
  })
})

describe("parseSystemdUnitList", () => {
  test("extracts openclaw@<port>.service names", () => {
    const stdout = [
      "openclaw@18789.service  loaded active running   OpenClaw 18789",
      "openclaw@18790.service  loaded active running   OpenClaw 18790",
      "sshd.service           loaded active running   OpenSSH",
    ].join("\n")
    expect(parseSystemdUnitList(stdout)).toEqual([18789, 18790])
  })
  test("returns empty when no openclaw units", () => {
    expect(parseSystemdUnitList("sshd.service loaded active running")).toEqual([])
  })
})

describe("detectStatusFromSystemctl", () => {
  test("detects running", () => {
    expect(detectStatusFromSystemctl("active (running)")).toBe("running")
  })
  test("detects stopped", () => {
    expect(detectStatusFromSystemctl("inactive (dead)")).toBe("stopped")
  })
  test("detects failed", () => {
    expect(detectStatusFromSystemctl("failed")).toBe("failed")
  })
})

describe("buildSystemdUnit", () => {
  test("produces a unit with port and data dir", () => {
    const unit = buildSystemdUnit(18790)
    expect(unit).toContain("OPENCLAW_PORT=18790")
    expect(unit).toContain("/root/.openclaw-18790")
    expect(unit).toContain("openclaw gateway")
  })
})