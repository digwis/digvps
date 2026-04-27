import { describe, expect, test } from "vitest"
import { parseInspectionTelemetry, parsePortChecks } from "../inspection"

describe("inspection parsers", () => {
  test("parses telemetry values and clamps ranges", () => {
    const map = new Map<string, string>([
      ["metric_cpu_pct", "105"],
      ["metric_cpu_iowait_pct", "3.1"],
      ["metric_cpu_steal_pct", "-2"],
      ["metric_mem_pct", "65.4"],
      ["metric_disk_pct", "71"],
      ["metric_inode_pct", "4"],
      ["metric_load_pct", "18"],
      ["metric_net_rx_bps", "128"],
      ["metric_net_tx_bps", "256"],
    ])
    expect(parseInspectionTelemetry(map)).toEqual({
      cpuPercent: 100,
      cpuIowaitPercent: 3.1,
      cpuStealPercent: 0,
      memoryPercent: 65.4,
      diskPercent: 71,
      inodePercent: 4,
      loadPercent: 18,
      netDownBps: 128,
      netUpBps: 256,
    })
  })

  test("parses known port checks", () => {
    const map = new Map<string, string>([
      ["port_http", "true"],
      ["port_https", "false"],
      ["port_postgres", "true"],
      ["port_kiro", "false"],
      ["port_vite", "true"],
    ])
    expect(parsePortChecks(map)?.find((item) => item.port === 80)?.listening).toBe(true)
    expect(parsePortChecks(map)?.find((item) => item.port === 443)?.listening).toBe(false)
  })
})
