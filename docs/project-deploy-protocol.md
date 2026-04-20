# Project Deploy Protocol

`digwis-panel` supports a reusable project-side deploy contract so different repos can be onboarded with minimal adaptation.

## Goal

Let the panel handle:

- project discovery
- VPS connection storage
- script launching
- logs and deploy result recording

Let each project handle:

- build steps
- upload strategy
- restart strategy
- health checks

## Minimal Project Integration

Every project should provide:

1. A `package.json` script named `deploy:panel`
2. An optional `digwis-panel.deploy.json` file in the project root
3. A non-interactive deploy script that accepts environment variables from the panel
4. Optionally, an `init` section so the panel can bootstrap a brand-new server

## Recommended `package.json`

```json
{
  "scripts": {
    "deploy:panel": "bash script/deploy-code-to-vps.sh"
  }
}
```

## `digwis-panel.deploy.json`

```json
{
  "version": 1,
  "deploy": {
    "strategy": "local-npm-script",
    "script": "deploy:panel",
    "remoteAppDir": "/var/www/my-app",
    "remoteService": "my-app.service",
    "publicCheckUrl": "https://example.com"
  },
  "init": {
    "remotePackages": ["rsync", "curl", "nodejs", "npm"],
    "envTemplate": "NODE_ENV=production\nPORT=5000",
    "systemdUnit": "[Unit]\nDescription=My App\nAfter=network.target\n..."
  }
}
```

## Supported Fields

- `version`: must be `1`
- `deploy.strategy`: `local-npm-script` or `sftp`
- `deploy.script`: preferred npm script name
- `deploy.remoteAppDir`: default remote app directory
- `deploy.remoteService`: default systemd service name
- `deploy.publicCheckUrl`: optional health-check URL
- `deploy.env`: extra environment variables injected when the panel runs the script
- `init.remotePackages`: remote OS packages to install during first-run bootstrap
- `init.envTemplate`: `.env` template written only when the file does not already exist
- `init.systemdUnit`: optional unit file content written to `/etc/systemd/system/<remoteService>`

If `init.envTemplate` contains placeholder values such as `SESSION_SECRET=CHANGE_ME...` or a
`DATABASE_URL` password containing `CHANGE_ME`, the panel will replace them with random values
before writing the remote `.env` for the first time.

## Environment Variables Injected By Panel

When the panel runs a project deploy script, it injects:

- `DIGWIS_PANEL=1`
- `DIGWIS_PANEL_PROJECT_ID`
- `DIGWIS_PANEL_PROJECT_PATH`
- `VPS_CONNECTION_NAME`
- `VPS_HOST`
- `VPS_PORT`
- `VPS_USER`
- `VPS_AUTH_TYPE`
- `VPS_PASSWORD` for password-based connections
- `VPS_PRIVATE_KEY` for key-based connections
- `VPS_PASSPHRASE` when available
- `REMOTE_APP_DIR` when configured
- `REMOTE_SERVICE` when configured
- `PUBLIC_CHECK_URL` when configured

## Script Requirements

Deploy scripts should:

- run without interactive prompts when `DIGWIS_PANEL=1`
- fail fast with clear messages when required variables are missing
- print compact step markers like `[1/4] Syncing code...`
- verify both local and remote prerequisites before making changes
- keep project-specific logic inside the project repository

## Suggested Local Checks

- `ssh`
- `rsync`
- `curl`
- `sshpass` only if password-based auth is used

## Suggested Remote Checks

- `rsync`
- `node`
- `npm`
- `systemctl`

## Migration Path For Existing Projects

1. Keep the existing deploy script.
2. Add `deploy:panel` as an alias to that script.
3. Add `digwis-panel.deploy.json`.
4. Remove interactive prompts in panel mode.
5. Read VPS settings from environment variables first, and `.vps.env` as fallback.

## Current Example

`../digwis` is now the first project adapted to this protocol:

- [`package.json`](/Users/zhao/Documents/Projects/test/TS/digwis/package.json)
- [`digwis-panel.deploy.json`](/Users/zhao/Documents/Projects/test/TS/digwis/digwis-panel.deploy.json)
- [`script/deploy-code-to-vps.sh`](/Users/zhao/Documents/Projects/test/TS/digwis/script/deploy-code-to-vps.sh)
