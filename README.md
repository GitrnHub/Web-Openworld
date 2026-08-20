# Web Openworld

A shared, browser-based destruction sandbox built with Three.js and Cloudflare Durable Objects.

**Live site:** https://gitrnhub.github.io/Web-Openworld/

## What is included

- A three-storey safe house inspired by Fallingwater's stacked terraces, central stone core, corner glazing, and close relationship with the site. It is an original low-poly scene, not a replica.
- Destructible terrain and architecture. Damage is applied immediately in the browser, batched about every 2.5 seconds, persisted in a SQLite-backed Durable Object, then shared with other visitors.
- Deterministic, seamless terrain chunks around the player. Three geometry LODs, chunk recycling, distance fog, terrain skirts, and safe-house interior/detail culling keep the open world bounded in memory and draw cost.
- A low shelf and stream valley around the safe house, gradually rising terrain at middle distance, and seeded variation farther away.

## Controls

- `W A S D`: move
- `Shift`: sprint
- `Space`: jump
- Mouse: look
- Mouse wheel: choose projectile
- Left click / hold: fire
- `1 / 2 / 3`: move to a safe-house floor
- `H`: toggle help
- `Esc`: release pointer lock

WebGPU is used for the fracture solver, so use a current browser on the HTTPS-hosted Pages site.

## Architecture

```text
GitHub Pages (public/)
       |
       | HTTPS + WebSocket
       v
Cloudflare Worker
       |
       | one object per world ID
       v
SQLite Durable Object
```

The client first pages through persisted events, opens a hibernatable WebSocket, and then sends idempotent mutation batches. The Durable Object commits each batch before broadcasting it. Reopening the page rebuilds the same terrain craters and damaged safe-house bodies from the event log.

## Local development

Requirements: Node.js and pnpm.

```bash
pnpm install
pnpm run check
pnpm run dev
```

Serve `public/` separately on `http://127.0.0.1:4173`. Local clients automatically use the Worker at `http://127.0.0.1:8787`; `?api=https://example.workers.dev` overrides it.

## Deployment

1. Run `pnpm wrangler login` and `pnpm run deploy` to deploy the Worker and its declarative SQLite Durable Object.
2. If you deploy under a different Worker name or account, update `PRODUCTION_API_BASE` in `public/src/config.js`.
3. Enable GitHub Pages with **Source: GitHub Actions**. `.github/workflows/pages.yml` publishes `public/` directly.

The Worker allows only the Pages origin and listed local development origins. There is intentionally no account login: the world is public and shared. For a production community, add identity, rate limits, moderation, snapshots, and event compaction before opening write access broadly.

## Layout

```text
public/                 Static Three.js client deployed to GitHub Pages
worker/                 Cloudflare Worker and Durable Object
test/                   Workers Vitest integration tests
wrangler.jsonc          Worker, CORS, and Durable Object configuration
.github/workflows/      GitHub Pages deployment
```

Safe-house design reference: [Fallingwater — Designing Fallingwater](https://fallingwater.org/history/the-kaufmanns-fallingwater/designing-fallingwater/).
