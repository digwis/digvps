import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LoaderCircle, RotateCw, TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getDesktopApi } from "@/lib/desktop-api"
import { deriveTerminalPageView, type TerminalPagePhase } from "./terminal-page-state"
import type {
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalErrorEvent,
  TerminalExitEvent,
  VpsConnectionRecord,
} from "../../../shared/vps"

export function TerminalPage({
  connections,
  selectedConnectionId,
}: {
  connections: VpsConnectionRecord[]
  selectedConnectionId?: string
}) {
  const selectedConnection = useMemo(
    () => connections.find((item) => item.id === selectedConnectionId),
    [connections, selectedConnectionId],
  )
  const [phase, setPhase] = useState<TerminalPagePhase>("idle")
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [output, setOutput] = useState("")
  const [reconnectToken, setReconnectToken] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const sessionIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!selectedConnectionId) {
      sessionIdRef.current = undefined
      setPhase("idle")
      setMessage(undefined)
      setOutput("")
      return
    }

    let disposed = false
    let currentSessionId: string | undefined

    setPhase("connecting")
    setMessage(undefined)
    setOutput("")

    const offData = getDesktopApi().terminal.onData((event: TerminalDataEvent) => {
      if (event.sessionId === sessionIdRef.current) {
        setOutput((current) => current + event.data)
      }
    })
    const offExit = getDesktopApi().terminal.onExit((event: TerminalExitEvent) => {
      if (event.sessionId === sessionIdRef.current) {
        sessionIdRef.current = undefined
        setPhase("closed")
        setMessage(event.code != null ? `远端会话已退出（code ${event.code}）` : "远端会话已关闭")
      }
    })
    const offError = getDesktopApi().terminal.onError((event: TerminalErrorEvent) => {
      if (event.sessionId === sessionIdRef.current) {
        setPhase("error")
        setMessage(event.message)
      }
    })

    void getDesktopApi().terminal
      .createSession({ connectionId: selectedConnectionId })
      .then((result: TerminalCreateResult) => {
        if (disposed) {
          void getDesktopApi().terminal.closeSession({ sessionId: result.sessionId })
          return
        }
        currentSessionId = result.sessionId
        sessionIdRef.current = result.sessionId
        setPhase("connected")
      })
      .catch((error: unknown) => {
        if (disposed) return
        setPhase("error")
        setMessage(error instanceof Error ? error.message : "终端连接失败")
      })

    return () => {
      disposed = true
      offData()
      offExit()
      offError()
      sessionIdRef.current = undefined
      if (currentSessionId) {
        void getDesktopApi().terminal.closeSession({ sessionId: currentSessionId })
      }
    }
  }, [selectedConnectionId, reconnectToken])

  const sendLine = useCallback(async () => {
    const value = inputRef.current?.value ?? ""
    const sessionId = sessionIdRef.current
    if (!value.trim() || !sessionId || phase !== "connected") return
    await getDesktopApi().terminal.writeInput({ sessionId, data: `${value}\n` })
    if (inputRef.current) {
      inputRef.current.value = ""
    }
  }, [phase])

  const view = deriveTerminalPageView({
    hasConnection: Boolean(selectedConnection),
    phase,
    message,
  })

  return (
    <div className="flex h-full min-h-[min(520px,70svh)] flex-col gap-4 rounded-3xl border border-border/70 bg-card/70 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {selectedConnection ? `${selectedConnection.name} 的终端` : view.title}
          </h2>
          <p className="text-sm text-muted-foreground">
            {selectedConnection
              ? `${selectedConnection.username}@${selectedConnection.host}:${selectedConnection.port}`
              : view.detail}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!selectedConnectionId || phase === "connecting" || !view.canReconnect}
          onClick={() => setReconnectToken((value) => value + 1)}
        >
          {phase === "connecting" ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <RotateCw className="size-4" />
          )}
          重连
        </Button>
      </div>

      {phase !== "connected" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/70 bg-muted/20 px-6 text-center">
          <TerminalSquare className="size-8 text-muted-foreground" />
          <p className="text-base font-medium text-foreground">{view.title}</p>
          <p className="max-w-md text-sm text-muted-foreground">{view.detail}</p>
        </div>
      ) : (
        <>
          <pre className="flex-1 overflow-auto rounded-2xl bg-black p-4 text-xs leading-relaxed text-green-400">
            {output || "# 已连接，等待远端输出...\n"}
          </pre>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              className="flex-1 rounded-2xl border border-border bg-background px-4 py-2 text-sm outline-none"
              placeholder="输入命令后回车，例如：pwd"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void sendLine()
                }
              }}
            />
            <Button onClick={() => void sendLine()} disabled={!sessionIdRef.current}>
              发送
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
