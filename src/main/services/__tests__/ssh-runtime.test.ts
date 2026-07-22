import { EventEmitter } from "node:events"
import { describe, expect, test } from "vitest"
import type { Client } from "ssh2"
import { execOnClient } from "../ssh-runtime"

/**
 * execOnClient only depends on `client.exec`; we construct a minimal stand-in
 * that hands us a stream (a plain EventEmitter) so we can drive ssh2's event
 * semantics without importing the real ssh2 Client.
 *
 * The exec callback is invoked synchronously (ssh2 itself fires it on the next
 * tick, but for test determinism we call it immediately so stream listeners are
 * guaranteed to be registered before any emitted events).
 */
function makeMockClient(stream: EventEmitter): Client {
  return {
    exec: (_cmd: string, cb: (err: Error | undefined, s: EventEmitter) => void) => {
      cb(undefined, stream)
    },
  } as unknown as Client
}

describe("execOnClient error handling", () => {
  test("rejects when stream emits 'error' (connection reset mid-command)", async () => {
    const stream = new EventEmitter()
    ;(stream as any).stderr = new EventEmitter()
    const client = makeMockClient(stream)

    // Emit on a later tick so execOnClient's stream.on('error') is attached first.
    setImmediate(() => stream.emit("error", new Error("read ECONNRESET")))

    await expect(execOnClient(client, "apt-get update", { timeoutMs: 1000 })).rejects.toThrow(
      "read ECONNRESET",
    )
  })

  test("still resolves normally on stream close with code", async () => {
    const stream = new EventEmitter()
    ;(stream as any).stderr = new EventEmitter()
    const client = makeMockClient(stream)

    setImmediate(() => {
      stream.emit("data", Buffer.from("done\n"))
      stream.emit("close", 0)
    })

    const result = await execOnClient(client, "echo done", { timeoutMs: 1000 })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("done")
  })
})
