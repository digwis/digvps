# Regression Smoke Checklist

Run these checks after touching Electron main-process IPC, SSH/SFTP runtime, or renderer dependency surface.

## Build Gates

- `npm run typecheck`
- `npm run build`

## Desktop Launch

- Start with `npm run dev`
- Confirm the window opens without preload errors
- Confirm the renderer loads without blank screen or crash

## VPS Connections

- Open the VPS connection dialog
- Create or edit a connection and save it
- Run connection test and confirm status updates correctly
- Run environment inspection and confirm telemetry cards render

## Remote Files

- Browse a remote directory
- Open a small text file
- Save a text file change
- Create a directory
- Rename a file or directory
- Delete a file or directory
- Upload a file
- Download a file

## Project Actions

- Import a local project directory
- Load deploy profile and npm script list
- Open project remote details
- Open and save remote `.env`
- Rotate project secret
- Restart remote service when configured
- Run one deploy flow:
  - `local-npm-script` strategy if the project defines deploy scripts
  - `sftp` strategy if the project uses panel-managed upload

## Dependency Operations

- Inspect dependency usage
- Install one supported dependency in a test environment
- Start, stop, or restart a managed service where applicable
- Check system upgrade status

## Cleanup Notes

- If UI dependencies change, re-run a grep over `src/renderer/src/components/ui`
- If SSH/SFTP runtime changes, re-check `remote-exec.ts`, `remote-command.ts`, `ssh.ts`, and file-helper flows together
