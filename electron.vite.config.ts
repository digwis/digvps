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
  },
})