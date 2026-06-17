import { describe, expect, test } from "vitest"
import {
  chooseProjectPath,
  parseNginxProxyServers,
} from "../remote-managed-projects"

describe("parseNginxProxyServers", () => {
  test("extracts server_name and proxy_pass from nginx config", () => {
    const config = `server {
  server_name app.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
  }
}`
    const result = parseNginxProxyServers("/etc/nginx/conf.d/app.conf", config)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      domain: "app.example.com",
      nginxConfigPath: "/etc/nginx/conf.d/app.conf",
      proxyTarget: "http://127.0.0.1:3000",
    })
  })

  test("ignores blocks without proxy_pass", () => {
    const config = `server {
  server_name static.example.com;
  root /var/www/static;
}`
    expect(parseNginxProxyServers("/etc/nginx/sites-enabled/static", config)).toEqual([])
  })

  test("captures multiple proxy_pass server blocks", () => {
    const config = `server {
  server_name a.example.com;
  location / { proxy_pass http://127.0.0.1:3001; }
}
server {
  server_name b.example.com;
  location / { proxy_pass http://127.0.0.1:3002; }
}`
    const result = parseNginxProxyServers("/etc/nginx/conf.d/multi.conf", config)
    expect(result.map((item) => item.domain)).toEqual([
      "a.example.com",
      "b.example.com",
    ])
    expect(result.map((item) => item.proxyTarget)).toEqual([
      "http://127.0.0.1:3001",
      "http://127.0.0.1:3002",
    ])
  })
})

describe("chooseProjectPath", () => {
  test("prefers systemd over pm2 and docker", () => {
    expect(
      chooseProjectPath({
        systemdPath: "/srv/app",
        pm2Path: "/var/www/app",
        dockerPath: "/opt/app",
        heuristicPath: "/home/deploy/app",
      }),
    ).toEqual({
      projectPath: "/srv/app",
      pathSource: "systemd",
    })
  })

  test("falls back to docker when systemd and pm2 are absent", () => {
    expect(
      chooseProjectPath({
        dockerPath: "/opt/app",
        heuristicPath: "/var/www/app",
      }),
    ).toEqual({
      projectPath: "/opt/app",
      pathSource: "docker",
    })
  })

  test("returns unknown when no source provides a path", () => {
    expect(chooseProjectPath({})).toEqual({ pathSource: "unknown" })
  })
})