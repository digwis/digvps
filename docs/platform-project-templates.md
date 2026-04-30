# Platform Project Templates

`digwis-panel` now includes a first-pass project scaffold flow for the "Next-centered platform" direction.

## Goal

Let the panel create a reusable project shell instead of only importing existing repositories.

The scaffold is intentionally split into:

- `digwis-panel`: project generator, lifecycle manager, deploy console
- `Next.js`: primary product shell, SSR/SEO, admin web, BFF
- `Python / Go / Rust`: optional service modules attached to the project when needed

## Current Templates

### `next-core`

Creates:

- `apps/web` with a minimal Next app
- `packages/ui` and `packages/config` placeholders
- `digwis-project.json` panel contract
- root workspace files

Use this when the project should start as a clean Next platform with no CMS selected yet.

### `next-payload`

Creates the same base as `next-core`, plus:

- `digwis-project.json` marks `payload` as the CMS runtime
- root `package.json` exposes `payload:types` and `payload:importmap`
- root and `apps/web` `.env.example` include `DATABASE_URL` and `PAYLOAD_SECRET`
- `apps/web/payload.config.ts`
- `apps/web/collections/Users.ts`
- `apps/web/collections/Media.ts`
- `apps/web/app/(payload)/layout.tsx`
- `apps/web/app/(payload)/admin/[[...segments]]/page.tsx`
- `apps/web/app/(payload)/api/[...slug]/route.ts`

This first pass now generates a minimal runnable Payload layout inside the Next app. It is still intentionally small: the goal is to start from a correct runtime shape and then extend collections, auth, and editor customizations in later iterations.

### `next-directus`

Creates the same base as `next-core`, plus:

- `digwis-project.json` marks `directus` as the CMS contract
- root script aliases: `directus:dev` / `directus:start`
- `services/directus/package.json` with Directus runtime dependency
- `services/directus/.env.example` with base Directus config
- `services/directus/README.md` quick-start

This keeps Directus as an attachable sidecar service rather than baking it into the Next app.

## Optional Service Modules

The scaffold dialog can add:

- `python-ai`
- `python-data`
- `go-worker`
- `rust-worker`

Each module creates only a minimal health-check service shell. This is deliberate: the panel should define the service boundary and the generated repo should remain independent from the panel after creation.

## Project Contract

Generated projects receive a `digwis-project.json` file with:

- template
- package manager
- database choice
- runtime modules
- service modules
- web app commands
- panel preview/admin URLs

The panel should depend on this contract rather than guessing a repository structure.

## Intended Evolution

Near-term follow-up work:

1. Add richer template families such as `next-core + auth`, `next-core + dashboard`, and `next-core + queue`.
2. Add incremental "install module into existing project" flows.
3. Add real Payload bootstrapping and Directus sidecar provisioning.
4. Attach generated templates to the deploy protocol automatically.
