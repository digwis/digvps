import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { packager } from "@electron/packager"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const outDir = path.join(root, "dist", "packager")
const iconPath = path.join(root, "resources", "digwis-panel.icns")
const aboutIconPng = path.join(root, "resources", "digwis-panel.png")
const electronPackage = JSON.parse(
  fs.readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8"),
)
const electronVersion = electronPackage.version
const localZipDir = path.join(root, "dist", "electron-zips")
const localElectronZip = path.join(
  localZipDir,
  `electron-v${electronVersion}-darwin-arm64.zip`,
)

fs.mkdirSync(localZipDir, { recursive: true })

if (!fs.existsSync(localElectronZip)) {
  execFileSync(
    "ditto",
    [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      path.join(root, "node_modules", "electron", "dist", "Electron.app"),
      localElectronZip,
    ],
    { stdio: "inherit" },
  )
}

const [packagedDir] = await packager({
  dir: root,
  name: "digwis-panel",
  platform: "darwin",
  arch: "arm64",
  out: outDir,
  overwrite: true,
  prune: true,
  electronVersion,
  electronZipDir: localZipDir,
  icon: iconPath,
  appBundleId: "com.digwis.panel",
  appVersion: "0.01",
  buildVersion: "0.01",
  executableName: "digwis-panel",
  ignore: [
    /^\/dist($|\/)/,
    /^\/src($|\/)/,
    /^\/docs($|\/)/,
    /^\/\.git($|\/)/,
    /^\/\.codex($|\/)/,
    /^\/\.claw($|\/)/,
  ],
})

const appPath = packagedDir.endsWith(".app")
  ? packagedDir
  : path.join(packagedDir, "digwis-panel.app")
const resourcesDir = path.join(appPath, "Contents", "Resources")
const infoPlistPath = path.join(appPath, "Contents", "Info.plist")
const bundleIconPath = path.join(resourcesDir, "digwis-panel.icns")

fs.copyFileSync(iconPath, bundleIconPath)
fs.copyFileSync(aboutIconPng, path.join(resourcesDir, "digwis-panel.png"))
execFileSync("plutil", ["-replace", "CFBundleIconFile", "-string", "digwis-panel.icns", infoPlistPath])

console.log(appPath)
