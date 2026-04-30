import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

type NativeFixResult = {
  repaired: string[]
}

const nativeModulePatterns = [
  {
    dirPrefix: "@next+swc-darwin-arm64@",
    relativeBinaryPath: path.join("node_modules", "@next", "swc-darwin-arm64", "next-swc.darwin-arm64.node"),
  },
  {
    dirPrefix: "@img+sharp-darwin-arm64@",
    relativeBinaryPath: path.join("node_modules", "@img", "sharp-darwin-arm64", "lib", "sharp-darwin-arm64.node"),
  },
]

export function repairProjectNativeModules(projectPath: string): NativeFixResult {
  if (process.platform !== "darwin") {
    return { repaired: [] }
  }
  const pnpmDir = path.join(projectPath, "node_modules", ".pnpm")
  if (!fs.existsSync(pnpmDir)) {
    return { repaired: [] }
  }

  const repaired = new Set<string>()
  const entries = fs.readdirSync(pnpmDir)
  for (const pattern of nativeModulePatterns) {
    for (const entry of entries) {
      if (!entry.startsWith(pattern.dirPrefix)) {
        continue
      }
      const binaryPath = path.join(pnpmDir, entry, pattern.relativeBinaryPath)
      if (!fs.existsSync(binaryPath)) {
        continue
      }
      try {
        execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", binaryPath], {
          stdio: "ignore",
        })
        repaired.add(binaryPath)
      } catch {
        // Ignore signing failures and let runtime fall back to normal error handling.
      }
    }
  }

  return {
    repaired: Array.from(repaired),
  }
}
