const query = new URLSearchParams(window.location.search);
const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);

// Filled after the first Cloudflare deployment. `?api=https://...` remains available for local
// staging and does not require rebuilding the GitHub Pages bundle.
const PRODUCTION_API_BASE = 'https://web-openworld-state.web-openworld.workers.dev';

function validHttpOrigin(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

export const WORLD_CONFIG = Object.freeze({
  apiBase: validHttpOrigin(query.get('api')) || (isLocal ? 'http://127.0.0.1:8787' : validHttpOrigin(PRODUCTION_API_BASE)),
  worldId: 'safehouse-main-v1',
  flushIntervalMs: 2500,
  reconnectMaxMs: 15000,
});
