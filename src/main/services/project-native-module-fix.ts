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
  {
    dirPrefix: "@napi-rs+snappy-darwin-arm64@",
    relativeBinaryPath: path.join(
      "node_modules",
      "@napi-rs",
      "snappy-darwin-arm64",
      "snappy.darwin-arm64.node",
    ),
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
      if (signNativeBinary(binaryPath)) {
        repaired.add(binaryPath)
      }
    }
  }

  for (const entry of entries) {
    const entryDir = path.join(pnpmDir, entry, "node_modules")
    if (!fs.existsSync(entryDir)) {
      continue
    }
    collectNativeBinaries(entryDir, repaired)
  }

  return {
    repaired: Array.from(repaired),
  }
}

function collectNativeBinaries(rootDir: string, repaired: Set<string>) {
  const stack = [rootDir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === ".bin") {
          continue
        }
        stack.push(fullPath)
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".node")) {
        if (signNativeBinary(fullPath)) {
          repaired.add(fullPath)
        }
      }
    }
  }
}

function signNativeBinary(binaryPath: string) {
  try {
    execFileSync("/usr/bin/xattr", ["-cr", binaryPath], { stdio: "ignore" })
  } catch {
    // ignore xattr failures
  }
  try {
    execFileSync("/usr/bin/codesign", ["--remove-signature", binaryPath], { stdio: "ignore" })
  } catch {
    // ignore unsigned binaries
  }
  try {
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", binaryPath], {
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}
