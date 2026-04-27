import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import type { VpsConnectionInput, SshKeySetupResult } from "../../shared/vps"
import { runRemoteShellCommand } from "./remote-exec"
import { ensureSshConfigCandidateForConnection } from "./discovery"

const execFileAsync = promisify(execFile)

function sanitizeFileSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "")
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function resolveKeyFilePath(payload: VpsConnectionInput) {
  const hostSegment = sanitizeFileSegment(payload.host) || "server"
  const portSegment = payload.port && payload.port !== 22 ? `_${payload.port}` : ""
  return path.join(os.homedir(), ".ssh", `id_ed25519_${hostSegment}${portSegment}`)
}

async function ensureKeyPair(keyPath: string, comment: string) {
  const publicKeyPath = `${keyPath}.pub`
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 })

  const hasPrivateKey = fs.existsSync(keyPath)
  const hasPublicKey = fs.existsSync(publicKeyPath)
  if (!hasPrivateKey || !hasPublicKey) {
    await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-f", keyPath, "-N", "", "-C", comment])
  }

  fs.chmodSync(keyPath, 0o600)
  if (fs.existsSync(publicKeyPath)) {
    fs.chmodSync(publicKeyPath, 0o644)
  }

  const privateKey = fs.readFileSync(keyPath, "utf8")
  const publicKey = fs.readFileSync(publicKeyPath, "utf8").trim()
  return {
    keyPath,
    publicKeyPath,
    privateKey,
    publicKey,
    created: !hasPrivateKey || !hasPublicKey,
  }
}

async function installAuthorizedKey(payload: VpsConnectionInput, publicKey: string) {
  const command = `
set -eu
umask 077
mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
KEY_LINE=${shellSingleQuote(publicKey)}
if ! grep -Fqx "$KEY_LINE" ~/.ssh/authorized_keys 2>/dev/null; then
  printf '%s\\n' "$KEY_LINE" >> ~/.ssh/authorized_keys
fi
`
  const result = await runRemoteShellCommand(payload, command, { timeoutMs: 60_000 })
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "公钥安装失败")
  }
}

export async function createAndInstallSshKey(payload: VpsConnectionInput): Promise<SshKeySetupResult> {
  if (payload.authType !== "password" || !payload.password) {
    throw new Error("需要先提供可用的 SSH 密码，才能一键创建私钥")
  }

  const keyPath = resolveKeyFilePath(payload)
  const comment = `${payload.username.trim()}@${payload.host.trim()} ${new Date().toISOString().slice(0, 10)}`
  const localKey = await ensureKeyPair(keyPath, comment)
  await installAuthorizedKey(payload, localKey.publicKey)
  const config = ensureSshConfigCandidateForConnection({
    name: payload.name.trim() || payload.host.trim(),
    host: payload.host.trim(),
    port: payload.port,
    username: payload.username.trim(),
    identityFilePath: localKey.keyPath,
  })

  return {
    ok: true,
    keyPath: localKey.keyPath,
    publicKeyPath: localKey.publicKeyPath,
    configPath: config.configPath,
    privateKey: localKey.privateKey,
    publicKey: localKey.publicKey,
    created: localKey.created,
    message: localKey.created ? "已生成新私钥并写入服务器" : "已复用本地私钥并确认服务器公钥已安装",
  }
}
