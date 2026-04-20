import path from "node:path"
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"

const root = path.resolve(__dirname)

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      sourcemap: true,
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
    resolve: {
      alias: {
        "@": path.resolve(root, "src/renderer/src"),
      },
    },
    plugins: [react()],
  },
})