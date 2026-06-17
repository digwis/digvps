import { describe, expect, test } from "vitest"
import { deriveTerminalPageView } from "../terminal-page-state"

describe("deriveTerminalPageView", () => {
  test("shows empty state when no server is selected", () => {
    expect(deriveTerminalPageView({ hasConnection: false, phase: "idle" })).toMatchObject({
      title: "先选择一台 VPS",
      canReconnect: false,
    })
  })

  test("shows reconnect action on error", () => {
    expect(
      deriveTerminalPageView({ hasConnection: true, phase: "error", message: "认证失败" }),
    ).toMatchObject({
      title: "终端连接失败",
      detail: "认证失败",
      canReconnect: true,
    })
  })
})
