import { describe, expect, test } from "vitest"
import {
  buildPrecheck,
  buildSystemdUnit,
  detectStatusFromSystemctl,
  ensurePortInRange,
  isVersionAtLeast,
  nextAvailablePort,
  OPENCLAW_REQUIRED_NODE_VERSION,
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
  test("treats auto-restart crash loop as failed", () => {
    expect(
      detectStatusFromSystemctl(
        "Active: activating (auto-restart) (Result: exit-code)\nMain PID: 123 (code=exited, status=1/FAILURE)",
      ),
    ).toBe("failed")
  })
})

describe("isVersionAtLeast", () => {
  test("accepts exact required node version", () => {
    expect(isVersionAtLeast("v22.19.0", OPENCLAW_REQUIRED_NODE_VERSION)).toBe(true)
  })
  test("accepts newer node version", () => {
    expect(isVersionAtLeast("v22.20.1", OPENCLAW_REQUIRED_NODE_VERSION)).toBe(true)
  })
  test("rejects older node major", () => {
    expect(isVersionAtLeast("v20.19.2", OPENCLAW_REQUIRED_NODE_VERSION)).toBe(false)
  })
  test("rejects older node minor", () => {
    expect(isVersionAtLeast("v22.18.0", OPENCLAW_REQUIRED_NODE_VERSION)).toBe(false)
  })
})

describe("buildPrecheck", () => {
  test("keeps install ready when node is old but auto-upgrade can fix it", () => {
    expect(
      buildPrecheck({
        nodeVersion: "v20.19.2",
        memoryAvailableMb: 2048,
        portInUse: false,
        existingInstances: 0,
        systemdPresent: true,
      }),
    ).toMatchObject({
      ready: true,
      reasons: ["node_too_old"],
    })
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
