# Web Openworld

Browser-based 3D / WebGPU experiments.

## OfficeWalk3D WebGPU Terrain v0.9.4

**Live site:** https://gitrnhub.github.io/Web-Openworld/

The current demo is an OfficeWalk3D first-person WebGPU destruction sandbox with voxel XPBD, Sphere/OBB rigid-body projectiles, procedural PBR materials, and destructible Elevated-inspired terrain.

### Controls

- `W A S D`: move
- `Shift`: sprint
- `Space`: jump
- Mouse: look
- Mouse wheel: sphere / disc / mud / bomb
- Left click / hold: fire
- `1 / 2 / 3`: floors
- `R`: reset
- `H`: hide/show help
- `Esc`: release pointer lock

### Browser requirements

Use a current browser with WebGPU enabled. The GitHub Pages deployment is served over HTTPS, which provides the secure context WebGPU expects.

## Repository layout

```text
.site-source/           Complete v0.9.4 live-site payload (split text-safe ZIP)
.github/workflows/      Rebuild + GitHub Pages deployment
README_zh_CN.md         v0.9.4 feature / control notes
THIRD_PARTY_NOTICES.md  Three.js + Elevated attribution/licensing notes
VERSION.txt             Demo version
```

The original ChatGPT-generated archive is reconstructed by GitHub Actions into the deployable `index.html`, `styles.css`, and `src/` tree. The split payload is an API-safe storage detail; users do not need to handle it manually.

For the hosted build, Three.js is pinned to `0.160.0` (r160) through a versioned jsDelivr URL rather than vendoring the original ~670 KB copy. The application and physics/world code otherwise remain the v0.9.4 live site.

## Deployment

`.github/workflows/pages.yml` concatenates and decodes the site payload, validates key files, uploads the resulting `_site` directory as a Pages artifact, and deploys it with GitHub Pages.

After GitHub Pages is enabled for this repository with **Source: GitHub Actions**, pushes that change `.site-source/**` or the Pages workflow redeploy automatically; the workflow can also be run manually from the Actions tab.
