import { afterEach, describe, expect, test, vi } from "vitest"
import * as remoteCommand from "../remote-command"
import { applySystemUpgrade, parseCheckOutput } from "../system-upgrade"

// Mock runSshCommand so applySystemUpgrade can be tested without a real SSH
// server. parseCheckOutput (below) is pure and does not touch this mock.
vi.mock("../remote-command", () => ({
  runSshCommand: vi.fn(),
}))

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

describe("applySystemUpgrade connection interruption", () => {
  const validPayload = {
    id: "c1",
    host: "127.0.0.1",
    port: 22,
    username: "root",
    authType: "password",
    password: "secret",
    name: "demo",
  } as const

  afterEach(() => {
    vi.mocked(remoteCommand.runSshCommand).mockReset()
  })

  test("ECONNRESET without reboot returns likelyInterrupted, not raw error", async () => {
    // Simulates ssh2 emitting a socket reset mid-upgrade (e.g. openssh-server
    // being restarted by apt full-upgrade drops the active channel).
    const connError = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
    vi.mocked(remoteCommand.runSshCommand).mockRejectedValueOnce(connError)

    const result = await applySystemUpgrade(validPayload, { reboot: false })

    expect(result.ok).toBe(false)
    expect(result.likelyInterrupted).toBe(true)
    // Friendly message must replace the raw ssh error leaking through.
    expect(result.message).not.toBe("read ECONNRESET")
    expect(result.message.length).toBeGreaterThan(0)
  })

  test("connection closed without reboot also treated as interrupted", async () => {
    vi.mocked(remoteCommand.runSshCommand).mockRejectedValueOnce(
      new Error("Connection closed by remote host"),
    )

    const result = await applySystemUpgrade(validPayload, { reboot: false })

    expect(result.ok).toBe(false)
    expect(result.likelyInterrupted).toBe(true)
  })

  test("ECONNRESET with reboot still returns likelyRebooting success", async () => {
    const connError = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
    vi.mocked(remoteCommand.runSshCommand).mockRejectedValueOnce(connError)

    const result = await applySystemUpgrade(validPayload, { reboot: true })

    expect(result.ok).toBe(true)
    expect(result.likelyRebooting).toBe(true)
  })

  test("non-connection error surfaces as plain failure without likelyInterrupted", async () => {
    // A sudo password error is a real command failure, not a connection drop:
    // it must NOT be misclassified as an interruption.
    vi.mocked(remoteCommand.runSshCommand).mockRejectedValueOnce(
      new Error("sudo: a password is required"),
    )

    const result = await applySystemUpgrade(validPayload, { reboot: false })

    expect(result.ok).toBe(false)
    expect(result.likelyInterrupted).not.toBe(true)
    expect(result.message).toContain("password is required")
  })
})
