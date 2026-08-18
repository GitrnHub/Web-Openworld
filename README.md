# Web Openworld

Browser-based 3D / WebGPU experiments.

## OfficeWalk3D WebGPU Terrain v0.9.4

**Live site:** https://gitrnhub.github.io/Web-Openworld/

The current demo is an OfficeWalk3D first-person WebGPU destruction sandbox with voxel XPBD, rigid-body projectiles, procedural materials, and destructible elevated terrain.

### Controls

- `W A S D`: move
- `Shift`: sprint
- `Space`: jump
- Mouse: look
- Mouse wheel: switch projectile type
- Left click / hold: fire
- `1 / 2 / 3`: floors
- `R`: reset
- `H`: hide/show help
- `Esc`: release pointer lock

### Browser requirements

Use a current browser with WebGPU enabled. The GitHub Pages deployment uses HTTPS, which provides the secure context WebGPU expects.

## Repository layout

```text
index.html              Live entry page
styles.css              UI / HUD styles
src/                    WebGPU / physics / world source
legacy_reference/       Earlier native / JS reference implementation
tests/                  Validation and regression tests
tools/                  Local helper scripts
README_zh_CN.md         Original v0.9.4 Chinese documentation
THIRD_PARTY_NOTICES.md  Third-party notices
VERSION.txt             Demo version
.github/workflows/      GitHub Pages deployment
```

For the hosted build, Three.js is pinned to `0.160.0` through jsDelivr. This keeps the repository/deployment smaller while matching the original bundled Three.js revision (r160).

## Deployment

Every push to `main` runs the GitHub Pages workflow. Only the live site files (`index.html`, `styles.css`, `src/`, `VERSION.txt`) are published; tests and reference material remain in the repository but are not part of the deployed site.
