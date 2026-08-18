import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';

const TAU = Math.PI * 2;

function hash2(x, y, seed) {
  let h = Math.imul((x | 0) ^ Math.imul(y | 0, 374761393), 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function modInt(v, period) { const m = v % period; return m < 0 ? m + period : m; }
function valueNoisePeriodic(x, y, seed, period) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
  const sample = (px, py) => hash2(modInt(px, period), modInt(py, period), seed);
  const a = sample(ix, iy), b = sample(ix + 1, iy), c = sample(ix, iy + 1), d = sample(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
function fbmPeriodic(u, v, seed, baseCells = 8, octaves = 4) {
  let s = 0, w = 0.56, norm = 0, cells = Math.max(2, Math.round(baseCells));
  for (let i = 0; i < octaves; i++) {
    s += valueNoisePeriodic(u * cells, v * cells, seed + i * 101, cells) * w;
    norm += w; w *= 0.5; cells *= 2;
  }
  return s / norm;
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function textureFromRGBA(size, rgba, colorSpace = THREE.NoColorSpace, repeat = [1, 1], anisotropy = 4, name = '') {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d'); const image = ctx.createImageData(size, size); image.data.set(rgba); ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = name;
  texture.colorSpace = colorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat[0], repeat[1]);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  return texture;
}

function makeSurfacePack(baseHex, seed, opts = {}) {
  const size = opts.size ?? 256, colorVariation = opts.colorVariation ?? 0.12;
  const roughBase = opts.roughBase ?? 0.65, roughVariation = opts.roughVariation ?? 0.18;
  const repeat = opts.repeat ?? [1, 1], kind = opts.kind ?? 'stone';
  const base = new THREE.Color(baseHex).convertLinearToSRGB();
  const color = new Uint8ClampedArray(size * size * 4), rough = new Uint8ClampedArray(size * size * 4), bump = new Uint8ClampedArray(size * size * 4);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const macro = fbmPeriodic(u, v, seed, 8, 4);
    const fine = fbmPeriodic(u, v, seed + 41, 32, 2);
    const micro = fbmPeriodic(u, v, seed + 83, 64, 2);
    let h = macro;
    if (kind === 'plaster') {
      const pore = hash2(x, y, seed + 193) > 0.992 ? -0.28 : 0;
      h = clamp01(0.50 + (macro - 0.5) * 0.38 + (fine - 0.5) * 0.18 + (micro - 0.5) * 0.08 + pore);
    } else if (kind === 'concrete') {
      const aggregate = hash2(x, y, seed + 211);
      const chip = aggregate > 0.985 ? (aggregate - 0.985) * 12 : 0;
      h = clamp01(0.45 + (macro - 0.5) * 0.48 + (fine - 0.5) * 0.24 + (micro - 0.5) * 0.12 - chip * 0.24);
    } else if (kind === 'wood') {
      const warp = (fbmPeriodic(u, v, seed + 3, 4, 3) - 0.5) * 0.95;
      const grain = 0.5 + 0.5 * Math.sin((v * 18 + warp * 1.7 + Math.sin(TAU * u * 4) * 0.19) * TAU);
      h = clamp01(0.22 + grain * 0.52 + fine * 0.18 + micro * 0.08);
    } else if (kind === 'brushed') {
      const warp = (fbmPeriodic(u, v, seed + 9, 6, 2) - 0.5) * 0.45;
      const streak = 0.5 + 0.5 * Math.sin((u * 64 + warp) * TAU);
      h = clamp01(0.38 + streak * 0.20 + macro * 0.24 + fine * 0.12 + micro * 0.06);
    } else if (kind === 'fabric') {
      const weave = (Math.sin(TAU * u * 32) * Math.sin(TAU * v * 32) + 1) * 0.25;
      h = clamp01(macro * 0.40 + weave * 0.40 + fine * 0.14 + micro * 0.06);
    } else if (kind === 'ceramic') {
      h = clamp01(0.52 + (macro - 0.5) * 0.28 + (fine - 0.5) * 0.10 + (micro - 0.5) * 0.04);
    } else if (kind === 'tile') {
      const cells = opts.tileCells ?? 5;
      const fu = Math.abs((u * cells) % 1 - 0.5), fv = Math.abs((v * cells) % 1 - 0.5);
      const edge = Math.max(fu, fv);
      const grout = smooth(Math.max(0, (edge - 0.455) / 0.045));
      h = clamp01(0.57 + (macro - 0.5) * 0.10 - grout * 0.42 + (fine - 0.5) * 0.05);
    }
    heights[x + y * size] = h;
    const speckle = (micro - 0.5) * colorVariation * 0.18;
    const mottled = (h - 0.5) * colorVariation + speckle;
    const i = (x + y * size) * 4;
    color[i] = clamp01(base.r * (1 + mottled)) * 255;
    color[i + 1] = clamp01(base.g * (1 + mottled * 0.94)) * 255;
    color[i + 2] = clamp01(base.b * (1 + mottled * 0.86)) * 255; color[i + 3] = 255;
    const rv = clamp01(roughBase + (0.5 - h) * roughVariation + (fine - 0.5) * roughVariation * 0.30);
    rough[i] = rough[i + 1] = rough[i + 2] = Math.round(rv * 255); rough[i + 3] = 255;
    const bv = Math.round(clamp01(h) * 255); bump[i] = bump[i + 1] = bump[i + 2] = bv; bump[i + 3] = 255;
  }
  const normal = new Uint8ClampedArray(size * size * 4);
  const normalStrength = opts.normalStrength ?? (kind === 'concrete' ? 2.4 : kind === 'fabric' ? 1.7 : kind === 'wood' ? 1.35 : kind === 'plaster' ? 1.25 : 1.0);
  const sample = (x, y) => heights[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (sample(x + 1, y) - sample(x - 1, y)) * normalStrength;
    const dy = (sample(x, y + 1) - sample(x, y - 1)) * normalStrength;
    const inv = 1 / Math.hypot(dx, dy, 1);
    const i = (x + y * size) * 4;
    normal[i] = Math.round(((-dx * inv) * 0.5 + 0.5) * 255);
    normal[i + 1] = Math.round(((-dy * inv) * 0.5 + 0.5) * 255);
    normal[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
    normal[i + 3] = 255;
  }
  const label = opts.label ?? kind;
  return {
    map: textureFromRGBA(size, color, THREE.SRGBColorSpace, repeat, 4, `${label}-albedo`),
    roughnessMap: textureFromRGBA(size, rough, THREE.NoColorSpace, repeat, 4, `${label}-roughness`),
    normalMap: textureFromRGBA(size, normal, THREE.NoColorSpace, repeat, 4, `${label}-normal`),
  };
}

export const DAMAGE_PROFILES = Object.freeze({
  glass: { label: '玻璃', response: 'brittle', fractureThreshold: 1.0, integrity: 4.8, dentScale: 0.015, recovery: 0, damageRadius: 0.95, fractureRadius: 0.72, fragmentCount: [16, 30], fragmentScale: [0.05, 0.34], fragmentShape: 'glass', restitution: 0.24, friction: 0.76, dust: 8, crackLines: 9, color: 0xbfeaff },
  ceramic: { label: '陶瓷', response: 'brittle', fractureThreshold: 1.65, integrity: 6.8, dentScale: 0.025, recovery: 0, damageRadius: 0.8, fractureRadius: 0.56, fragmentCount: [10, 22], fragmentScale: [0.07, 0.42], fragmentShape: 'ceramic', restitution: 0.15, friction: 0.82, dust: 15, crackLines: 7, color: 0xe8e4d8 },
  plaster: { label: '石膏板', response: 'crumbly', fractureThreshold: 1.8, integrity: 8.0, dentScale: 0.13, recovery: 0, damageRadius: 0.9, fractureRadius: 0.6, fragmentCount: [8, 18], fragmentScale: [0.08, 0.34], fragmentShape: 'chunk', restitution: 0.08, friction: 0.88, dust: 28, crackLines: 4, color: 0xd4d0c6 },
  concrete: { label: '混凝土', response: 'crumbly', fractureThreshold: 3.1, integrity: 14.0, dentScale: 0.075, recovery: 0, damageRadius: 0.82, fractureRadius: 0.48, fragmentCount: [7, 15], fragmentScale: [0.09, 0.4], fragmentShape: 'chunk', restitution: 0.07, friction: 0.92, dust: 38, crackLines: 3, color: 0x8d918f },
  wood: { label: '木材', response: 'fibrous', fractureThreshold: 2.35, integrity: 10.0, dentScale: 0.1, recovery: 0.03, damageRadius: 0.8, fractureRadius: 0.5, fragmentCount: [8, 16], fragmentScale: [0.06, 0.48], fragmentShape: 'splinter', restitution: 0.12, friction: 0.84, dust: 12, crackLines: 4, color: 0xa86f3d },
  metal: { label: '金属', response: 'ductile', fractureThreshold: 8.5, integrity: 24.0, dentScale: 0.28, recovery: 0.005, damageRadius: 0.9, fractureRadius: 0.42, fragmentCount: [2, 7], fragmentScale: [0.08, 0.38], fragmentShape: 'flake', restitution: 0.3, friction: 0.68, dust: 1, crackLines: 0, color: 0x7f8a95 },
  plastic: { label: '塑料', response: 'ductile', fractureThreshold: 5.5, integrity: 16.0, dentScale: 0.36, recovery: 0.018, damageRadius: 1.0, fractureRadius: 0.5, fragmentCount: [4, 10], fragmentScale: [0.07, 0.38], fragmentShape: 'flake', restitution: 0.22, friction: 0.72, dust: 2, crackLines: 1, color: 0x2b82a8 },
  rubber: { label: '弹性体', response: 'elastic', fractureThreshold: 12.0, integrity: 32.0, dentScale: 0.55, recovery: 2.7, damageRadius: 1.1, fractureRadius: 0.35, fragmentCount: [1, 3], fragmentScale: [0.12, 0.3], fragmentShape: 'chunk', restitution: 0.68, friction: 0.8, dust: 0, crackLines: 0, color: 0x252a31 },
});

export function createMaterials(renderer) {
  const maxAniso = Math.min(12, renderer.capabilities.getMaxAnisotropy());
  const packs = {
    plaster: makeSurfacePack(0xe8e3da, 33, { size: 512, kind: 'plaster', label: 'plaster', roughBase: 0.82, roughVariation: 0.13, colorVariation: 0.10, normalStrength: 1.35 }),
    plasterWarm: makeSurfacePack(0xc8b69a, 34, { size: 512, kind: 'plaster', label: 'plaster-warm', roughBase: 0.80, roughVariation: 0.15, colorVariation: 0.12, normalStrength: 1.42 }),
    concrete: makeSurfacePack(0x8b908d, 21, { size: 512, kind: 'concrete', label: 'concrete', roughBase: 0.82, roughVariation: 0.22, colorVariation: 0.18, normalStrength: 2.25 }),
    concreteDark: makeSurfacePack(0x555d60, 22, { size: 512, kind: 'concrete', label: 'concrete-dark', roughBase: 0.78, roughVariation: 0.19, colorVariation: 0.16, normalStrength: 2.0 }),
    tile: makeSurfacePack(0xa6afb4, 43, { size: 512, kind: 'tile', label: 'tile', roughBase: 0.35, roughVariation: 0.15, colorVariation: 0.055, tileCells: 5, normalStrength: 1.9 }),
    carpet: makeSurfacePack(0x3e5261, 51, { kind: 'fabric', label: 'carpet', roughBase: 0.94, roughVariation: 0.10, colorVariation: 0.18 }),
    carpetWarm: makeSurfacePack(0x65534d, 52, { kind: 'fabric', label: 'carpet-warm', roughBase: 0.95, roughVariation: 0.08, colorVariation: 0.16 }),
    wood: makeSurfacePack(0x9b6036, 77, { size: 512, kind: 'wood', label: 'wood', roughBase: 0.50, roughVariation: 0.22, colorVariation: 0.21, normalStrength: 1.35 }),
    woodDark: makeSurfacePack(0x5f3823, 78, { size: 512, kind: 'wood', label: 'wood-dark', roughBase: 0.57, roughVariation: 0.20, colorVariation: 0.20, normalStrength: 1.25 }),
    metal: makeSurfacePack(0xabb6bf, 91, { kind: 'brushed', label: 'metal', roughBase: 0.28, roughVariation: 0.16, colorVariation: 0.055 }),
    metalDark: makeSurfacePack(0x354049, 92, { kind: 'brushed', label: 'metal-dark', roughBase: 0.34, roughVariation: 0.18, colorVariation: 0.07 }),
    ceramic: makeSurfacePack(0xe9e4d9, 105, { kind: 'ceramic', label: 'ceramic', roughBase: 0.28, roughVariation: 0.10, colorVariation: 0.055 }),
    ceramicBlue: makeSurfacePack(0x1b5878, 106, { kind: 'ceramic', label: 'ceramic-blue', roughBase: 0.25, roughVariation: 0.10, colorVariation: 0.075 }),
    plastic: makeSurfacePack(0x2780a2, 117, { kind: 'ceramic', label: 'plastic', roughBase: 0.34, roughVariation: 0.10, colorVariation: 0.055 }),
    plasticOrange: makeSurfacePack(0xc96d27, 118, { kind: 'ceramic', label: 'plastic-orange', roughBase: 0.38, roughVariation: 0.12, colorVariation: 0.07 }),
  };
  for (const pack of Object.values(packs)) for (const tex of Object.values(pack)) tex.anisotropy = maxAniso;

  const standard = (params) => new THREE.MeshStandardMaterial({ envMapIntensity: 0.94, ...params });
  const physical = (params) => new THREE.MeshPhysicalMaterial({ envMapIntensity: 1.08, ...params });
  const mapped = (pack, normalScale, extra = {}) => ({ ...pack, color: 0xffffff, normalScale: new THREE.Vector2(normalScale, normalScale), ...extra });
  const tagMapped = (material, metersPerTile) => { material.userData.worldUvMetersPerTile = metersPerTile; material.userData.proceduralPBR = true; material.userData.tileableTextures = true; return material; };
  const standardMapped = (pack, normalScale, metersPerTile, extra = {}) => tagMapped(standard(mapped(pack, normalScale, extra)), metersPerTile);
  const physicalMapped = (pack, normalScale, metersPerTile, extra = {}) => tagMapped(physical(mapped(pack, normalScale, extra)), metersPerTile);

  return {
    wall: standardMapped(packs.plaster, 0.34, 2.6, { roughness: 0.82, metalness: 0 }),
    wallWarm: standardMapped(packs.plasterWarm, 0.36, 2.6, { roughness: 0.80, metalness: 0 }),
    concrete: standardMapped(packs.concrete, 0.72, 2.2, { roughness: 0.84, metalness: 0 }),
    concreteDark: standardMapped(packs.concreteDark, 0.66, 2.2, { roughness: 0.76, metalness: 0 }),
    tile: physicalMapped(packs.tile, 0.58, 4.5, { roughness: 0.37, metalness: 0.02, clearcoat: 0.16, clearcoatRoughness: 0.31, specularIntensity: 0.68 }),
    carpet: physicalMapped(packs.carpet, 0.76, 1.8, { roughness: 0.92, metalness: 0, sheen: 0.34, sheenColor: new THREE.Color(0x6f8794), sheenRoughness: 0.82 }),
    carpetWarm: physicalMapped(packs.carpetWarm, 0.76, 1.8, { roughness: 0.93, metalness: 0, sheen: 0.30, sheenColor: new THREE.Color(0x8c6f64), sheenRoughness: 0.84 }),
    ceiling: standard({ color: 0xd9dddd, roughness: 0.78, metalness: 0 }),
    wood: standardMapped(packs.wood, 0.54, 2.0, { roughness: 0.50, metalness: 0 }),
    woodDark: standardMapped(packs.woodDark, 0.50, 2.0, { roughness: 0.56, metalness: 0 }),
    metal: physicalMapped(packs.metal, 0.74, 1.6, { roughness: 0.30, metalness: 0.92, anisotropy: 0.72, anisotropyRotation: Math.PI * 0.5, clearcoat: 0.035, clearcoatRoughness: 0.48 }),
    metalDark: physicalMapped(packs.metalDark, 0.66, 1.6, { roughness: 0.38, metalness: 0.89, anisotropy: 0.66, anisotropyRotation: Math.PI * 0.5, clearcoat: 0.025, clearcoatRoughness: 0.50 }),
    black: physical({ color: 0x252b30, roughness: 0.52, metalness: 0.12, clearcoat: 0.08, clearcoatRoughness: 0.62, envMapIntensity: 0.82 }),
    glass: physical({ color: 0xd7f2ff, roughness: 0.055, metalness: 0, transmission: 0.93, thickness: 0.10, ior: 1.48, transparent: false, opacity: 1, side: THREE.DoubleSide, clearcoat: 0.18, clearcoatRoughness: 0.10, envMapIntensity: 1.2 }),
    glassDark: physical({ color: 0x8fb3c1, roughness: 0.09, metalness: 0, transmission: 0.78, thickness: 0.14, ior: 1.48, transparent: false, opacity: 1, side: THREE.DoubleSide, clearcoat: 0.12, clearcoatRoughness: 0.12, envMapIntensity: 1.12 }),
    ceramic: physicalMapped(packs.ceramic, 0.42, 1.0, { roughness: 0.34, metalness: 0, clearcoat: 0.28, clearcoatRoughness: 0.24, ior: 1.52, specularIntensity: 0.72 }),
    ceramicBlue: physicalMapped(packs.ceramicBlue, 0.44, 1.0, { roughness: 0.31, metalness: 0, clearcoat: 0.31, clearcoatRoughness: 0.22, ior: 1.52, specularIntensity: 0.76 }),
    plastic: physicalMapped(packs.plastic, 0.34, 1.0, { roughness: 0.39, metalness: 0, clearcoat: 0.13, clearcoatRoughness: 0.38, ior: 1.46, specularIntensity: 0.62 }),
    plasticOrange: physicalMapped(packs.plasticOrange, 0.36, 1.0, { roughness: 0.43, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.40, ior: 1.46, specularIntensity: 0.60 }),
    rubber: standard({ color: 0x242a30, roughness: 0.88, metalness: 0, envMapIntensity: 0.66 }),
    fabric: standard({ color: 0x556b79, roughness: 0.96, metalness: 0, envMapIntensity: 0.65 }),
    fabricWarm: standard({ color: 0x7e665e, roughness: 0.96, metalness: 0, envMapIntensity: 0.65 }),
    screen: physical({ color: 0x07151d, emissive: 0x1784ae, emissiveIntensity: 0.72, roughness: 0.28, metalness: 0.05, clearcoat: 0.42, clearcoatRoughness: 0.18, envMapIntensity: 0.7 }),
    lightPanel: standard({ color: 0xfff4dc, emissive: 0xffe5b4, emissiveIntensity: 3.2, roughness: 0.52, metalness: 0 }),
    red: standard({ color: 0x9d3c34, roughness: 0.54, metalness: 0 }),
    green: standard({ color: 0x37795d, roughness: 0.58, metalness: 0 }),
  };
}
