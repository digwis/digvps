import type { Client, ConnectConfig } from "ssh2"
import type { VpsConnectionInput } from "../../shared/vps"

export function resolveSshConnectConfig(payload: VpsConnectionInput): ConnectConfig {
  const base: ConnectConfig = {
    host: payload.host.trim(),
    port: payload.port,
    username: payload.username.trim(),
  }

  if (payload.authType === "password") {
    return {
      ...base,
      password: payload.password,
      tryKeyboard: true,
    }
  }

  return {
    ...base,
    privateKey: payload.privateKey,
    passphrase: payload.passphrase,
  }
}

export function attachKeyboardInteractiveFallback(connection: Client, payload: VpsConnectionInput) {
  if (payload.authType !== "password" || !payload.password) {
    return connection
  }

  connection.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
    finish(prompts.map(() => payload.password!))
  })

  return connection
}
