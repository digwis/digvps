import { afterEach, describe, expect, test, vi } from "vitest"
import { closeTerminalSession, createTerminalSession, writeTerminalInput } from "../remote-terminal"

const mockShellWrite = vi.fn()
const mockShellSetWindow = vi.fn()
const mockClientEnd = vi.fn()

vi.mock("../ssh-runtime", () => {
  return {
    connectSshClient: vi.fn(async () => ({
      shell: (_options: unknown, callback: (error: Error | undefined, stream: any) => void) => {
        callback(undefined, {
          write: mockShellWrite,
          setWindow: mockShellSetWindow,
          close: vi.fn(),
          on: vi.fn().mockReturnThis(),
          stderr: { on: vi.fn() },
        })
      },
      end: mockClientEnd,
    })),
  }
})

describe("remote-terminal", () => {
  afterEach(() => {
    mockShellWrite.mockReset()
    mockShellSetWindow.mockReset()
    mockClientEnd.mockReset()
  })

  test("creates a terminal session", async () => {
    const result = await createTerminalSession({
      id: "c1",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      authType: "password",
      password: "secret",
      name: "demo",
    })

    expect(result.sessionId).toBeTruthy()
  })

  test("writes input to existing session", async () => {
    const result = await createTerminalSession({
      id: "c1",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      authType: "password",
      password: "secret",
      name: "demo",
    })

    await writeTerminalInput({ sessionId: result.sessionId, data: "ls\n" })

    expect(mockShellWrite).toHaveBeenCalledWith("ls\n")
  })

  test("throws when writing to missing session", async () => {
    await expect(writeTerminalInput({ sessionId: "missing", data: "pwd\n" })).rejects.toThrow(
      "终端会话不存在",
    )
  })

  test("closes session and ends client", async () => {
    const result = await createTerminalSession({
      id: "c1",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      authType: "password",
      password: "secret",
      name: "demo",
    })

    await closeTerminalSession({ sessionId: result.sessionId })

    expect(mockClientEnd).toHaveBeenCalled()
  })
})
