# Third-party notices

## Three.js

- Hosted runtime version: `0.160.0` / r160
- Runtime URL is pinned to the versioned jsDelivr package path.
- Copyright: Three.js Authors
- License: MIT
- Project: `https://github.com/mrdoob/three.js`

The original OfficeWalk3D v0.9.4 archive bundled `vendor/three/three.module.min.js` locally. The GitHub Pages edition uses the same r160 release through a pinned CDN URL to avoid vendoring the ~670 KB library in this repository.

## Elevated / ShaderToy MdX3Rr

Outdoor terrain logic in the OfficeWalk3D v0.9.4 source is a walkable geometry adaptation inspired by **Elevated**, created by Inigo Quilez (iq), ShaderToy id `MdX3Rr`.

- Original ShaderToy: `https://www.shadertoy.com/view/MdX3Rr`
- Public Unity/HLSL adaptation consulted during implementation: `https://github.com/przemyslawzaworski/Unity3D-CG-programming/blob/master/elevated.shader`
- License stated by that consulted Unity/HLSL repository: Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported (CC BY-NC-SA 3.0)
- License URI: `https://creativecommons.org/licenses/by-nc-sa/3.0/`

The OfficeWalk3D version does not embed the original screen-space raymarch shader verbatim. It reimplements the derivative-damped procedural height-field idea as real walkable mesh geometry so collision and terrain deformation can share the same surface. Because this implementation was derived with reference to that CC BY-NC-SA source, attribution and the non-commercial/share-alike restriction are preserved for this outdoor terrain portion.

## Physics layer

The Sphere/OBB rigid-body and voxel fracture implementations are project code. No Rapier/PhysX runtime is bundled.
