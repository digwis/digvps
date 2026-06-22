import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"
import { getDesktopApi } from "@/lib/desktop-api"
import type {
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
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<string | undefined>(undefined)
  const selectedConnection = connections.find((item) => item.id === selectedConnectionId)

  useEffect(() => {
    if (!selectedConnectionId || !containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Menlo", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: "#000000",
        foreground: "#22c55e",
        cursor: "#22c55e",
        selectionBackground: "#14532d",
      },
      allowProposedApi: true,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    fit.fit()
    term.writeln("\x1b[36mConnecting...\x1b[0m")

    let disposed = false
    let pendingResize: { cols: number; rows: number } | null = null

    const offData = getDesktopApi().terminal.onData((event: TerminalDataEvent) => {
      if (event.sessionId === sessionRef.current) term.write(event.data)
    })
    const offExit = getDesktopApi().terminal.onExit((event: TerminalExitEvent) => {
      if (event.sessionId !== sessionRef.current) return
      sessionRef.current = undefined
      const reason =
        event.code != null ? `exit code ${event.code}` : event.signal ? `signal ${event.signal}` : "closed"
      term.write(`\r\n\x1b[31m[connection ${reason}]\x1b[0m\r\n`)
    })
    const offError = getDesktopApi().terminal.onError((event: TerminalErrorEvent) => {
      if (event.sessionId !== sessionRef.current) return
      term.write(`\r\n\x1b[31m[error] ${event.message}\x1b[0m\r\n`)
    })

    const dataDisp = term.onData((data) => {
      const sid = sessionRef.current
      if (!sid) return
      void getDesktopApi().terminal.writeInput({ sessionId: sid, data })
    })
    const resizeDisp = term.onResize(({ cols, rows }) => {
      const sid = sessionRef.current
      if (!sid) {
        pendingResize = { cols, rows }
        return
      }
      void getDesktopApi().terminal.resize({ sessionId: sid, cols, rows })
    })

    void getDesktopApi().terminal
      .createSession({ connectionId: selectedConnectionId })
      .then((result) => {
        if (disposed) {
          void getDesktopApi().terminal.closeSession({ sessionId: result.sessionId })
          return
        }
        sessionRef.current = result.sessionId
        term.clear()
        fit.fit()
        if (pendingResize) {
          void getDesktopApi().terminal.resize({
            sessionId: result.sessionId,
            cols: pendingResize.cols,
            rows: pendingResize.rows,
          })
          pendingResize = null
        }
      })
      .catch((error: unknown) => {
        if (disposed) return
        const message = error instanceof Error ? error.message : "终端连接失败"
        term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
      })

    const onWinResize = () => fit.fit()
    window.addEventListener("resize", onWinResize)

    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)

    return () => {
      disposed = true
      window.removeEventListener("resize", onWinResize)
      ro.disconnect()
      dataDisp.dispose()
      resizeDisp.dispose()
      offData()
      offExit()
      offError()
      if (sessionRef.current) {
        const sid = sessionRef.current
        sessionRef.current = undefined
        void getDesktopApi().terminal.closeSession({ sessionId: sid })
      }
      term.dispose()
    }
  }, [selectedConnectionId])

  return (
    <div className="flex h-full min-h-[min(520px,70svh)] flex-col gap-4 rounded-3xl border border-border/70 bg-card/70 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {selectedConnection ? `${selectedConnection.name} · ${t("terminal.title")}` : t("terminal.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {selectedConnection
              ? `${selectedConnection.username}@${selectedConnection.host}:${selectedConnection.port}`
              : t("terminal.selectPrompt")}
          </p>
        </div>
      </div>
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden rounded-2xl bg-black p-2"
      />
    </div>
  )
}
