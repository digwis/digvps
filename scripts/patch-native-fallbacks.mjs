import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const lightningcssIndex = path.join(root, "node_modules", "lightningcss", "node", "index.js")
const rollupNativeIndex = path.join(root, "node_modules", "rollup", "dist", "native.js")

if (fs.existsSync(lightningcssIndex)) {
  const source = fs.readFileSync(lightningcssIndex, "utf8")
  const marker = "native = require('lightningcss-wasm');"

  if (!source.includes(marker)) {
    const pattern =
      /let native;\ntry {\n\s+native = require\(`lightningcss-\$\{parts\.join\('-'\)\}`\);\n} catch \(err\) {\n\s+native = require\(`\.\.\/lightningcss\.\$\{parts\.join\('-'\)\}\.node`\);\n}\n/
    const replacement = `let native;\ntry {\n  native = require(\`lightningcss-\${parts.join('-')}\`);\n} catch (err) {\n  try {\n    native = require(\`../lightningcss.\${parts.join('-')}.node\`);\n  } catch {\n    native = require('lightningcss-wasm');\n  }\n}\n`

    if (!pattern.test(source)) {
      throw new Error("Unexpected lightningcss loader format; patch was not applied.")
    }

    fs.writeFileSync(lightningcssIndex, source.replace(pattern, replacement))
  }
}

if (fs.existsSync(rollupNativeIndex)) {
  const source = fs.readFileSync(rollupNativeIndex, "utf8")
  const marker = "require('@rollup/wasm-node/dist/native.js')"

  if (!source.includes(marker)) {
    const pattern =
      /const requireWithFriendlyError = id => \{\n(?:.|\n)+?\n\};/
    const replacement = `const requireWithFriendlyError = id => {\n\ttry {\n\t\treturn require(id);\n\t} catch (error) {\n\t\tif (\n\t\t\tplatform === 'win32' &&\n\t\t\terror instanceof Error &&\n\t\t\terror.code === 'ERR_DLOPEN_FAILED' &&\n\t\t\terror.message.includes('The specified module could not be found')\n\t\t) {\n\t\t\tconst msvcDownloadLink = \`https://aka.ms/vs/17/release/\${msvcLinkFilenameByArch[arch]}\`;\n\t\t\tthrow new Error(\n\t\t\t\t\`Failed to load module \${id}. \` +\n\t\t\t\t\t'Required DLL was not found. ' +\n\t\t\t\t\t'This error usually happens when Microsoft Visual C++ Redistributable is not installed. ' +\n\t\t\t\t\t\`You can download it from \${msvcDownloadLink}\`,\n\t\t\t\t{ cause: error }\n\t\t\t);\n\t\t}\n\n\t\tif (error instanceof Error && error.code === 'ERR_DLOPEN_FAILED') {\n\t\t\treturn require('@rollup/wasm-node/dist/native.js');\n\t\t}\n\n\t\tthrow new Error(\n\t\t\t\`Cannot find module \${id}. \` +\n\t\t\t\t\`npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). \` +\n\t\t\t\t'Please try \`npm i\` again after removing both package-lock.json and node_modules directory.',\n\t\t\t{ cause: error }\n\t\t);\n\t}\n};`

    if (!pattern.test(source)) {
      throw new Error("Unexpected rollup loader format; patch was not applied.")
    }

    fs.writeFileSync(rollupNativeIndex, source.replace(pattern, replacement))
  }
}
