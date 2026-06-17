export type TerminalPagePhase = "idle" | "connecting" | "connected" | "error" | "closed"

export function deriveTerminalPageView(args: {
  hasConnection: boolean
  phase: TerminalPagePhase
  message?: string
}) {
  if (!args.hasConnection) {
    return {
      title: "先选择一台 VPS",
      detail: "在右上角选择服务器后即可打开远程终端。",
      canReconnect: false,
    }
  }

  if (args.phase === "connecting") {
    return {
      title: "正在连接远程终端…",
      detail: "请稍候，正在建立 SSH 会话。",
      canReconnect: false,
    }
  }

  if (args.phase === "error") {
    return {
      title: "终端连接失败",
      detail: args.message ?? "连接失败，请重试。",
      canReconnect: true,
    }
  }

  if (args.phase === "closed") {
    return {
      title: "终端会话已断开",
      detail: args.message ?? "可以点击重连重新建立会话。",
      canReconnect: true,
    }
  }

  if (args.phase === "connected") {
    return {
      title: "终端已连接",
      detail: "当前会话已连接到所选 VPS。",
      canReconnect: false,
    }
  }

  return {
    title: "准备连接终端",
    detail: "进入页面后会自动连接当前选中的 VPS。",
    canReconnect: false,
  }
}
