import fs from "node:fs"
import path from "node:path"
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"

const root = path.resolve(__dirname)

function mainCommonJsPackagePlugin() {
  return {
    name: "digwis-main-commonjs-package",
    closeBundle() {
      const mainPackagePath = path.resolve(root, "out/main/package.json")
      fs.mkdirSync(path.dirname(mainPackagePath), { recursive: true })
      fs.writeFileSync(mainPackagePath, JSON.stringify({ type: "commonjs" }, null, 2))
    },
  }
}

export default defineConfig({
  main: {
    plugins: [mainCommonJsPackagePlugin()],
    build: {
      externalizeDeps: true,
      sourcemap: true,
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "index.js",
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      sourcemap: "inline",
    },
  },
  renderer: {
    root: path.resolve(root, "src/renderer"),
    server: {
      host: "127.0.0.1",
      port: 5173,
    },
    resolve: {
      alias: {
        "@": path.resolve(root, "src/renderer/src"),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules")) {
              if (id.includes("lucide-react")) return "vendor-lucide"
              if (id.includes("@radix-ui")) return "vendor-radix"
              if (id.includes("cmdk")) return "vendor-cmdk"
              if (id.includes("xterm")) return "vendor-xterm"
              if (id.includes("i18next") || id.includes("react-i18next")) return "vendor-i18n"
              if (id.includes("zustand")) return "vendor-zustand"
            }
          },
        },
      },
    },
  },
})