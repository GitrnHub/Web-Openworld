import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';
import { DAMAGE_PROFILES } from './materials.js';
import { RigidShapeWorld, rigidShapeFromMesh } from './rigid_body.js';

const EPS = 1e-6;
const UP = new THREE.Vector3(0, 1, 0);
const TETRA = [
  [0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6],
  [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6],
];
const TET_EDGES = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];

export const PROJECTILE_TYPES = Object.freeze([
  { id: 'sphere', label: '球形', speed: 142, mass: 0.26, radius: 0.088, shape: 'sphere', damageScale: 1.00, color: 0xffb257 },
  { id: 'disc', label: '飞盘', speed: 76, mass: 0.31, half: [0.16, 0.026, 0.16], shape: 'disc', damageScale: 0.88, color: 0xe8f3ff },
  { id: 'mud', label: '泥巴', speed: 58, mass: 0.56, radius: 0.115, shape: 'sphere', damageScale: 0.0, color: 0x65412c, mud: true },
  { id: 'bomb', label: '炸弹', speed: 22, mass: 0.92, radius: 0.13, shape: 'sphere', damageScale: 0.0, color: 0x25282b, bomb: true, fuse: 2.6, blastRadius: 6.2, craterRadius: 6.6, craterDepth: 2.8 },
]);

const XPBD_PROFILES = Object.freeze({
  glass:    { compliance: 1.2e-8, yield: 0.030, fracture: 0.075, plasticity: 0.00, toughness: 0.70, density: 0.82, carve: 1.22, crater: 1.05, depth: 1.45, cracks: 9 },
  ceramic:  { compliance: 2.0e-8, yield: 0.025, fracture: 0.095, plasticity: 0.00, toughness: 0.92, density: 0.92, carve: 0.78, crater: 0.92, depth: 1.18, cracks: 7 },
  plaster:  { compliance: 8.0e-7, yield: 0.060, fracture: 0.18,  plasticity: 0.04, toughness: 0.90, density: 0.55, carve: 1.05, crater: 0.95, depth: 0.85, cracks: 5 },
  concrete: { compliance: 1.2e-7, yield: 0.045, fracture: 0.13,  plasticity: 0.02, toughness: 1.35, density: 1.00, carve: 0.72, crater: 0.72, depth: 0.66, cracks: 4 },
  wood:     { compliance: 5.5e-7, yield: 0.080, fracture: 0.24,  plasticity: 0.09, toughness: 1.00, density: 0.52, carve: 0.62, crater: 0.80, depth: 1.05, cracks: 4 },
  metal:    { compliance: 1.4e-7, yield: 0.075, fracture: 0.42,  plasticity: 0.42, toughness: 2.20, density: 1.25, carve: 0.22, crater: 0.72, depth: 0.52, cracks: 0 },
  plastic:  { compliance: 1.6e-6, yield: 0.085, fracture: 0.34,  plasticity: 0.30, toughness: 1.25, density: 0.62, carve: 0.38, crater: 0.86, depth: 0.68, cracks: 1 },
  rubber:   { compliance: 7.0e-6, yield: 0.55,  fracture: 1.50,  plasticity: 0.00, toughness: 3.00, density: 0.44, carve: 0.00, crater: 0.95, depth: 0.35, cracks: 0 },
});

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep01(v) { const x = clamp(v, 0, 1); return x * x * (3 - 2 * x); }
function hash01(n) { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453123; return x - Math.floor(x); }
function randRange(a, b) { return a + Math.random() * (b - a); }
function nextPow2(v) { let n = 1; while (n < v) n <<= 1; return n; }

function materialId(name) {
  return ['glass','ceramic','plaster','concrete','wood','metal','plastic','rubber'].indexOf(name);
}

function floorForY(y) {
  if (y >= 8.1) return 8.4;
  if (y >= 3.9) return 4.2;
  return 0;
}

function landingSurfaceFor(position, previousY, verticalExtent, horizontalRadius, staticColliders = []) {
  // Dynamic fragments must collide with real finite supports (pedestals/tables) before the
  // building floor. We only solve top-face contacts here: it is cheap, stable, and fixes the
  // visually important case where an unsupported upper section should land on the plinth below.
  const floor = floorForY(Math.max(previousY, position.y));
  let best = floor;
  const prevBottom = previousY - verticalExtent;
  const currBottom = position.y - verticalExtent;
  const currTop = position.y + verticalExtent;
  const pad = Math.max(0.025, Math.min(horizontalRadius * 0.42, 0.42));
  for (const entry of staticColliders) {
    const box = entry?.box;
    if (!box || box.isEmpty?.()) continue;
    const top = box.max.y;
    if (!(top > best + 1e-4)) continue;
    // A support above the previous fragment top cannot have been crossed this frame.
    if (top > previousY + verticalExtent + 0.06) continue;
    if (position.x < box.min.x - pad || position.x > box.max.x + pad ||
        position.z < box.min.z - pad || position.z > box.max.z + pad) continue;
    const crossed = prevBottom >= top - 0.055 && currBottom <= top + 0.055;
    const penetratingFromAbove = currBottom < top && currTop > top && previousY >= top - verticalExtent * 0.28;
    const restingNear = Math.abs(currBottom - top) <= 0.055;
    if (crossed || penetratingFromAbove || restingNear) best = top;
  }
  return best;
}

function transformDirection(v, matrixWorldInverse) {
  const o = new THREE.Vector3(0, 0, 0).applyMatrix4(matrixWorldInverse);
  const p = v.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrixWorldInverse));
  if (p.lengthSq() < EPS) return v.clone().normalize();
  return p.normalize();
}

function vaseRadiusAt(y, height, radius) {
  const t = clamp(y / height + 0.5, 0, 1);
  const body = Math.sin(Math.PI * t) * 0.24 + 0.12;
  const neck = t > 0.72 ? -0.13 * ((t - 0.72) / 0.28) : 0;
  const foot = t < 0.12 ? 0.06 * (1 - t / 0.12) : 0;
  return Math.max(radius * 0.25, radius * (body / 0.36 + neck + foot));
}

function makeShapeSdf(shape, bounds, options = {}) {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const half = size.clone().multiplyScalar(0.5);
  if (shape === 'vase') {
    const height = options.height ?? size.y;
    const radius = options.radius ?? Math.max(size.x, size.z) * 0.5;
    const thickness = options.thickness ?? Math.max(0.075, radius * 0.18);
    return (x, y, z) => {
      const ly = y - center.y;
      const radial = Math.hypot(x - center.x, z - center.z);
      // `radius` is the visible outer radius. Build a real shell between outer and inner
      // surfaces so a partial impact exposes a crater wall instead of the far side.
      const outerR = vaseRadiusAt(ly, height, radius);
      const innerR = Math.max(0.018, outerR - thickness);
      const shell = Math.min(outerR - radial, radial - innerR, half.y - Math.abs(ly));
      // Close only the foot with a shallow disk; the mouth remains naturally open.
      const baseY = ly + half.y;
      const baseDisk = Math.min(outerR - radial, baseY, thickness * 0.62 - baseY);
      return Math.max(shell, baseDisk);
    };
  }
  if (shape === 'sphere') {
    const radius = options.radius ?? Math.min(size.x, size.y, size.z) * 0.5;
    return (x, y, z) => radius - Math.hypot(x-center.x, y-center.y, z-center.z);
  }
  if (shape === 'cylinder') {
    const radius = options.radius ?? Math.min(size.x, size.z) * 0.5;
    const h = options.height ?? size.y;
    return (x, y, z) => Math.min(radius - Math.hypot(x - center.x, z - center.z), h * 0.5 - Math.abs(y - center.y));
  }
  if (shape === 'shellBox') {
    const thickness = options.thickness ?? Math.max(0.04, Math.min(size.x, size.y, size.z) * 0.35);
    const innerHalf = new THREE.Vector3(Math.max(0, half.x - thickness), Math.max(0, half.y - thickness), Math.max(0, half.z - thickness));
    return (x, y, z) => {
      const dx = half.x - Math.abs(x - center.x);
      const dy = half.y - Math.abs(y - center.y);
      const dz = half.z - Math.abs(z - center.z);
      const inside = Math.min(dx, dy, dz);
      const ix = innerHalf.x - Math.abs(x - center.x);
      const iy = innerHalf.y - Math.abs(y - center.y);
      const iz = innerHalf.z - Math.abs(z - center.z);
      const inner = Math.min(ix, iy, iz);
      return Math.min(inside, -inner);
    };
  }
  return (x, y, z) => Math.min(half.x - Math.abs(x - center.x), half.y - Math.abs(y - center.y), half.z - Math.abs(z - center.z));
}

function createShardGeometry(profileName) {
  if (profileName === 'glass') return new THREE.TetrahedronGeometry(0.5, 0);
  if (profileName === 'ceramic') return new THREE.IcosahedronGeometry(0.5, 0);
  if (profileName === 'wood') return new THREE.BoxGeometry(1.0, 0.12, 0.18);
  if (profileName === 'metal' || profileName === 'plastic') return new THREE.BoxGeometry(0.85, 0.10, 0.62);
  return new THREE.DodecahedronGeometry(0.5, 0);
}

function decorateDamageMaterial(material, profileName) {
  // Voxel-generated surfaces do not have stable UVs. Add a tiny object-space variation to
  // roughness/base color so freshly exposed fracture faces do not look like flat white plastic.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDamageObjectPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDamageObjectPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vDamageObjectPos;\nfloat damageHash(vec3 p){p=fract(p*0.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\nfloat damageGrainColor = damageHash(floor(vDamageObjectPos * ${profileName === 'ceramic' ? '34.0' : profileName === 'concrete' ? '18.0' : '24.0'}));\ndiffuseColor.rgb *= mix(0.94, 1.055, damageGrainColor);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nfloat damageGrainRough = damageHash(floor(vDamageObjectPos * ${profileName === 'ceramic' ? '34.0' : profileName === 'concrete' ? '18.0' : '24.0'}));\nroughnessFactor = clamp(roughnessFactor * mix(0.88, 1.12, damageGrainRough), 0.045, 1.0);`);
  };
  material.customProgramCacheKey = () => `damage-micro-v2-${profileName}`;
  material.needsUpdate = true;
  return material;
}

function averageTextureColor(texture) {
  const image = texture?.image;
  if (!image) return null;
  try {
    let data = null, width = image.width || 0, height = image.height || 0;
    if (image.data && width && height) data = image.data;
    else if (typeof image.getContext === 'function' && width && height) data = image.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    if (!data || !width || !height || data.length < 4) return null;
    const pixels = width * height;
    const step = Math.max(1, Math.floor(pixels / 96));
    let r = 0, g = 0, b = 0, n = 0;
    for (let px = 0; px < pixels; px += step) {
      const i = px * 4;
      r += data[i] ?? 255; g += data[i + 1] ?? 255; b += data[i + 2] ?? 255; n++;
    }
    if (!n) return null;
    return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
  } catch { return null; }
}

function captureMaterialAppearance(material, profileName) {
  const fallback = new THREE.Color(DAMAGE_PROFILES[profileName]?.color ?? 0xffffff);
  const color = material?.color?.clone?.() ?? fallback;
  const sampled = averageTextureColor(material?.map);
  if (sampled) color.multiply(sampled);
  const q = (v, d) => Number.isFinite(v) ? v : d;
  const appearance = {
    profileName,
    color: color.getHex(THREE.SRGBColorSpace),
    physical: Boolean(material?.isMeshPhysicalMaterial),
    roughness: q(material?.roughness, profileName === 'ceramic' ? 0.34 : 0.72),
    metalness: q(material?.metalness, profileName === 'metal' ? 0.85 : 0),
    envMapIntensity: q(material?.envMapIntensity, 0.95),
    clearcoat: q(material?.clearcoat, 0), clearcoatRoughness: q(material?.clearcoatRoughness, 0),
    ior: q(material?.ior, 1.5), transmission: q(material?.transmission, 0), thickness: q(material?.thickness, 0),
    specularIntensity: q(material?.specularIntensity, 1), anisotropy: q(material?.anisotropy, 0),
    anisotropyRotation: q(material?.anisotropyRotation, 0), sheen: q(material?.sheen, 0),
    sheenRoughness: q(material?.sheenRoughness, 1),
    sheenColor: material?.sheenColor?.getHex?.(THREE.SRGBColorSpace) ?? 0xffffff,
    map: material?.map ?? null, roughnessMap: material?.roughnessMap ?? null, normalMap: material?.normalMap ?? null,
    metalnessMap: material?.metalnessMap ?? null, bumpMap: material?.bumpMap ?? null,
    normalScaleX: q(material?.normalScale?.x, 1), normalScaleY: q(material?.normalScale?.y, 1),
  };
  appearance.key = [profileName, appearance.color.toString(16), appearance.physical ? 1 : 0,
    appearance.roughness.toFixed(3), appearance.metalness.toFixed(3), appearance.clearcoat.toFixed(3),
    appearance.transmission.toFixed(3)].join(':');
  return appearance;
}

function createShardMaterial(profileName, appearance = null, useMaps = false) {
  const p = DAMAGE_PROFILES[profileName];
  if (appearance) {
    const Params = appearance.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const m = new Params({
      color: useMaps ? 0xffffff : appearance.color, roughness: appearance.roughness, metalness: appearance.metalness,
      flatShading: false, envMapIntensity: appearance.envMapIntensity,
      map: useMaps ? appearance.map : null, roughnessMap: useMaps ? appearance.roughnessMap : null,
      normalMap: useMaps ? appearance.normalMap : null, metalnessMap: useMaps ? appearance.metalnessMap : null,
      bumpMap: useMaps ? appearance.bumpMap : null,
    });
    if (useMaps && appearance.normalMap) m.normalScale = new THREE.Vector2(appearance.normalScaleX, appearance.normalScaleY);
    if ('clearcoat' in m) { m.clearcoat = appearance.clearcoat; m.clearcoatRoughness = appearance.clearcoatRoughness; }
    if ('ior' in m) m.ior = appearance.ior;
    if ('transmission' in m) { m.transmission = appearance.transmission; m.thickness = appearance.thickness; m.opacity = 1; m.transparent = false; }
    if ('specularIntensity' in m) m.specularIntensity = appearance.specularIntensity;
    if ('anisotropy' in m) { m.anisotropy = appearance.anisotropy; m.anisotropyRotation = appearance.anisotropyRotation; }
    if ('sheen' in m) { m.sheen = appearance.sheen; m.sheenRoughness = appearance.sheenRoughness; m.sheenColor = new THREE.Color(appearance.sheenColor); }
    m.side = profileName === 'glass' ? THREE.DoubleSide : THREE.FrontSide;
    return decorateDamageMaterial(m, profileName);
  }
  const physical = profileName === 'ceramic' || profileName === 'glass' || profileName === 'metal' || profileName === 'plastic';
  const Params = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const m = new Params({
    color: p.color,
    roughness: profileName === 'glass' ? 0.08 : profileName === 'metal' ? 0.34 : profileName === 'ceramic' ? 0.42 : 0.78,
    metalness: profileName === 'metal' ? 0.82 : 0,
    flatShading: false,
    envMapIntensity: profileName === 'ceramic' ? 1.0 : 0.86,
  });
  if (profileName === 'ceramic') { m.clearcoat = 0.18; m.clearcoatRoughness = 0.32; }
  if (profileName === 'plastic') { m.clearcoat = 0.10; m.clearcoatRoughness = 0.38; }
  if (profileName === 'glass') {
    m.transmission = 0.82; m.thickness = 0.05; m.ior = 1.48; m.opacity = 1; m.transparent = false; m.side = THREE.DoubleSide;
  }
  return decorateDamageMaterial(m, profileName);
}

class DebrisPool {
  constructor(scene, capacityPerMaterial = 320) {
    this.scene = scene;
    this.capacity = capacityPerMaterial;
    this.pools = new Map();
    this.total = 0;
  }
  get(name, appearance = null) {
    const key = appearance?.key ? `${name}|${appearance.key}` : name;
    if (this.pools.has(key)) return this.pools.get(key);
    const mesh = new THREE.InstancedMesh(createShardGeometry(name), createShardMaterial(name, appearance), this.capacity);
    mesh.count = 0; mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(mesh);
    const pool = { mesh, cursor: 0, count: 0 };
    this.pools.set(key, pool);
    return pool;
  }
  addTransform(name, position, quaternion, scaleVector, appearance = null) {
    const p = this.get(name, appearance);
    const mat = new THREE.Matrix4().compose(position, quaternion, scaleVector);
    p.mesh.setMatrixAt(p.cursor, mat);
    p.cursor = (p.cursor + 1) % this.capacity;
    p.count = Math.min(this.capacity, p.count + 1);
    p.mesh.count = p.count;
    p.mesh.instanceMatrix.needsUpdate = true;
    this.total = 0; for (const x of this.pools.values()) this.total += x.count;
  }
  add(name, position, direction, scale = 0.12, appearance = null) {
    const p = this.get(name, appearance);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, direction.clone().normalize().add(new THREE.Vector3(randRange(-0.4,0.4),randRange(-0.2,0.5),randRange(-0.4,0.4))).normalize());
    const s = new THREE.Vector3(scale * randRange(0.55, 1.45), scale * randRange(0.45, 1.35), scale * randRange(0.55, 1.45));
    const pos = position.clone().add(new THREE.Vector3(randRange(-scale,scale), randRange(-scale,scale), randRange(-scale,scale)));
    const mat = new THREE.Matrix4().compose(pos, q, s);
    p.mesh.setMatrixAt(p.cursor, mat);
    p.cursor = (p.cursor + 1) % this.capacity;
    p.count = Math.min(this.capacity, p.count + 1);
    p.mesh.count = p.count;
    p.mesh.instanceMatrix.needsUpdate = true;
    this.total = 0; for (const x of this.pools.values()) this.total += x.count;
  }
  reset() {
    this.total = 0;
    for (const p of this.pools.values()) { p.cursor = 0; p.count = 0; p.mesh.count = 0; p.mesh.instanceMatrix.needsUpdate = true; }
  }
}


class StaticFragmentMerger {
  constructor(scene, maxVerticesPerMaterial = 210000) {
    this.scene = scene;
    this.maxVerticesPerMaterial = maxVerticesPerMaterial;
    this.groups = new Map();
    this.totalPieces = 0;
  }
  group(profileName, appearance = null) {
    const key = appearance?.key ? `${profileName}|${appearance.key}` : profileName;
    let g = this.groups.get(key);
    if (g) return g;
    const geometry = new THREE.BufferGeometry();
    const material = createShardMaterial(profileName, appearance, true);
    material.flatShading = false;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    this.scene.add(mesh);
    g = { mesh, pieces: [], vertices: 0, dirty: false };
    this.groups.set(key, g);
    return g;
  }
  addMesh(profileName, mesh, appearance = null) {
    mesh.updateMatrixWorld(true);
    let source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    const pos = source.getAttribute('position');
    if (!pos || pos.count < 3) { source.dispose(); return; }
    if (!source.getAttribute('normal')) source.computeVertexNormals();
    const normal = source.getAttribute('normal');
    const uv = source.getAttribute('uv');
    const matrix = mesh.matrixWorld.clone();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const pp = new Float32Array(pos.count * 3);
    const nn = new Float32Array(pos.count * 3);
    const uu = uv ? new Float32Array(pos.count * 2) : null;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      pp[i*3] = v.x; pp[i*3+1] = v.y; pp[i*3+2] = v.z;
      v.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      nn[i*3] = v.x; nn[i*3+1] = v.y; nn[i*3+2] = v.z;
      if (uu) { uu[i*2] = uv.getX(i); uu[i*2+1] = uv.getY(i); }
    }
    source.dispose();
    const g = this.group(profileName, appearance);
    g.pieces.push({ positions: pp, normals: nn, uvs: uu, vertices: pos.count });
    g.vertices += pos.count;
    while (g.vertices > this.maxVerticesPerMaterial && g.pieces.length > 1) {
      const old = g.pieces.shift(); g.vertices -= old.vertices;
    }
    g.dirty = true;
    this.totalPieces = 0; for (const x of this.groups.values()) this.totalPieces += x.pieces.length;
  }
  rebuildDirty() {
    for (const g of this.groups.values()) {
      if (!g.dirty) continue;
      g.dirty = false;
      const positions = new Float32Array(g.vertices * 3);
      const normals = new Float32Array(g.vertices * 3);
      const hasUvs = g.pieces.some((piece) => piece.uvs);
      const uvs = hasUvs ? new Float32Array(g.vertices * 2) : null;
      let cursor = 0;
      for (const piece of g.pieces) {
        positions.set(piece.positions, cursor * 3);
        normals.set(piece.normals, cursor * 3);
        if (uvs && piece.uvs) uvs.set(piece.uvs, cursor * 2);
        cursor += piece.vertices;
      }
      const old = g.mesh.geometry;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geometry.computeBoundingSphere();
      g.mesh.geometry = geometry;
      old.dispose();
    }
  }
  reset() {
    this.totalPieces = 0;
    for (const g of this.groups.values()) {
      g.pieces.length = 0; g.vertices = 0; g.dirty = false;
      const old = g.mesh.geometry;
      g.mesh.geometry = new THREE.BufferGeometry();
      old.dispose();
    }
  }
}

class RealFragmentSystem {
  constructor(scene, staticMerger, maxActive = 72) {
    this.scene = scene;
    this.staticMerger = staticMerger;
    this.maxActive = maxActive;
    this.items = [];
    this.rebuildTimer = 0;
    this.system = null;
    this.maxSecondaryGeneration = 2;
  }
  forceLand(item) {
    if (!item) return;
    // Capacity pressure must never freeze a fragment in mid-air.  If we absolutely have to
    // retire an old chunk, snap it to the current building floor first and only then merge it.
    const floor = floorForY(item.mesh.position.y);
    const r = Math.min(0.75, Math.max(0.025, item.halfHeight ?? item.radius));
    item.mesh.position.y = Math.max(floor + r, item.mesh.position.y > floor + r ? floor + r : item.mesh.position.y);
    item.velocity.set(0, 0, 0); item.spin.set(0, 0, 0);
    if (item.rigid) { item.rigid.position.copy(item.mesh.position); item.rigid.velocity.set(0,0,0); item.rigid.angularVelocity.set(0,0,0); item.rigid.sleeping = true; }
    item.mesh.updateMatrixWorld(true);
  }
  makeRoom() {
    if (this.items.length < this.maxActive) return;
    let index = this.items.findIndex((it) => it.sleeping && (!it.persistent || it.generation >= this.maxSecondaryGeneration));
    if (index < 0) index = this.items.findIndex((it) => it.sleeping);
    if (index < 0) index = this.items.findIndex((it) => !it.persistent || it.generation >= this.maxSecondaryGeneration);
    if (index < 0) index = 0;
    const [old] = this.items.splice(index, 1);
    if (!old.sleeping) this.forceLand(old);
    this.retire(old);
  }
  spawn(profileName, geometry, sourceMatrixWorld, direction, severity, sourceVelocity = null, motion = {}) {
    if (!geometry || !geometry.getAttribute('position') || geometry.getAttribute('position').count < 3) {
      geometry?.dispose?.(); return null;
    }
    this.makeRoom();
    geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    const localCenter = geometry.boundingSphere?.center?.clone() ?? new THREE.Vector3();
    const centerWorld = localCenter.clone().applyMatrix4(sourceMatrixWorld);
    geometry.translate(-localCenter.x, -localCenter.y, -localCenter.z); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    const fragmentMaterial = createShardMaterial(profileName, motion.appearance ?? null, true);
    const mesh = new THREE.Mesh(geometry, fragmentMaterial);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const sourcePosition = new THREE.Vector3(), sourceQuaternion = new THREE.Quaternion(), sourceScale = new THREE.Vector3();
    sourceMatrixWorld.decompose(sourcePosition, sourceQuaternion, sourceScale);
    mesh.position.copy(centerWorld); mesh.quaternion.copy(sourceQuaternion); mesh.scale.copy(sourceScale);
    this.scene.add(mesh);
    let spray;
    if (motion.collapse) {
      spray = direction.clone().normalize().multiplyScalar(randRange(0.04, 0.28));
      spray.add(new THREE.Vector3(randRange(-0.18, 0.18), randRange(-0.03, 0.18), randRange(-0.18, 0.18)));
    } else {
      const axial = severity > .82 ? randRange(-0.25, 0.68) : randRange(-0.88, -0.38);
      spray = direction.clone().normalize().multiplyScalar((1.15 + severity * 4.8) * axial);
      spray.add(new THREE.Vector3(randRange(-1.15, 1.15), randRange(0.28, 1.85), randRange(-1.15, 1.15)));
    }
    if (sourceVelocity) spray.addScaledVector(sourceVelocity, motion.collapse ? 0.72 : 0.58);
    const bboxSize = geometry.boundingBox?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(0.1, 0.1, 0.1);
    const payload = motion.voxelPayload?.grid && motion.voxelPayload?.nodes?.length ? {
      grid: motion.voxelPayload.grid,
      nodes: Array.from(motion.voxelPayload.nodes),
    } : null;
    const generation = motion.generation ?? 0;
    const item = {
      profileName, mesh, centerLocal: localCenter.clone(), voxelPayload: payload,
      surfaceAppearance: motion.appearance ?? null,
      generation,
      persistent: Boolean(motion.persistent ?? motion.collapse) && Boolean(payload) && generation < this.maxSecondaryGeneration,
      sleeping: false,
      radius: Math.max(0.035, geometry.boundingSphere.radius * Math.max(mesh.scale.x, mesh.scale.y, mesh.scale.z)),
      halfHeight: Math.max(0.025, bboxSize.y * Math.abs(mesh.scale.y) * 0.5),
      // Kept only as source/support metadata.  Detached fragments do NOT collide with this
      // infinite plane; otherwise a vase that started on a 0.9 m pedestal leaves debris hovering
      // at 0.9 m even after it has flown off the pedestal.  Runtime collision uses floorForY().
      sourceSupportY: Number.isFinite(motion.floorY) ? motion.floorY : null,
      velocity: spray,
      spin: new THREE.Vector3(randRange(-5.5, 5.5), randRange(-5.5, 5.5), randRange(-5.5, 5.5)).multiplyScalar(motion.collapse ? 0.28 : 1),
      age: 0, sleep: 0,
    };
    if (motion.collapse) {
      // A released structural island should visibly lose support immediately.  Give it only a
      // slight tipping moment; gravity supplies the main motion instead of an explosion impulse.
      const sx = bboxSize.x * Math.abs(mesh.scale.x), sz = bboxSize.z * Math.abs(mesh.scale.z);
      const tipAxis = sx > sz ? 'z' : 'x';
      item.spin.set(0, 0, 0);
      item.spin[tipAxis] = randRange(-0.9, 0.9);
      item.velocity.y = Math.min(item.velocity.y, 0.08);
    }
    const profile = DAMAGE_PROFILES[profileName] ?? DAMAGE_PROFILES.concrete;
    const scaledVolume = Math.max(0.0005, bboxSize.x * bboxSize.y * bboxSize.z * Math.abs(mesh.scale.x * mesh.scale.y * mesh.scale.z));
    item.rigid = this.system?.rigidWorld?.addBody({
      mesh, shape: rigidShapeFromMesh(mesh, 'box', 0.004), mass: clamp(scaledVolume * (XPBD_PROFILES[profileName]?.density ?? 1) * 8.5, 0.08, 28),
      velocity: item.velocity, angularVelocity: item.spin, friction: profile.friction ?? 0.78, restitution: profile.restitution ?? 0.08, dynamicPairs: true,
      userData: item, tag: `fragment:${profileName}`,
    }) ?? null;
    if (item.rigid) { item.velocity = item.rigid.velocity; item.spin = item.rigid.angularVelocity; }
    mesh.userData.realFragmentItem = item;
    this.items.push(item);
    return item;
  }
  retire(item) {
    if (!item) return;
    this.system?.rigidWorld?.removeBody(item.rigid); item.rigid = null;
    item.mesh.userData.realFragmentItem = null;
    this.staticMerger.addMesh(item.profileName, item.mesh, item.surfaceAppearance);
    this.scene.remove(item.mesh);
    item.mesh.geometry.dispose(); item.mesh.material.dispose();
  }
  removeWithoutMerge(item) {
    if (!item) return;
    const index = this.items.indexOf(item); if (index >= 0) this.items.splice(index, 1);
    this.system?.rigidWorld?.removeBody(item.rigid); item.rigid = null;
    item.mesh.userData.realFragmentItem = null;
    this.scene.remove(item.mesh); item.mesh.geometry.dispose(); item.mesh.material.dispose();
  }
  settle(item) {
    if (item.persistent && item.voxelPayload && item.generation < this.maxSecondaryGeneration) {
      item.sleeping = true; item.sleep = 0; item.velocity.set(0, 0, 0); item.spin.set(0, 0, 0);
      if (item.rigid) { item.rigid.sleeping = true; item.rigid.sleepTime = 1; }
      return true;
    }
    this.retire(item); return false;
  }
  colliderMeshes() { return this.items.map((item) => item.mesh); }
  targetDescription(item) {
    const p = DAMAGE_PROFILES[item.profileName];
    return `${p?.label ?? item.profileName}坠落块 · ${item.sleeping ? '已落稳，可继续击碎' : '运动中，可继续击碎'}`;
  }
  splitPayload(item, worldPoint, worldDir, severity) {
    const payload = item.voxelPayload; if (!payload) return [];
    const { grid, nodes } = payload;
    if (nodes.length < 18) return [];
    item.mesh.updateMatrixWorld(true);
    const inverse = item.mesh.matrixWorld.clone().invert();
    const hitLocal = worldPoint.clone().applyMatrix4(inverse);
    const hitSource = hitLocal.add(item.centerLocal);
    const dir = transformDirection(worldDir, inverse);
    const ta = new THREE.Vector3();
    if (Math.abs(dir.y) < .88) ta.crossVectors(dir, UP).normalize(); else ta.crossVectors(dir, new THREE.Vector3(1, 0, 0)).normalize();
    const tb = new THREE.Vector3().crossVectors(dir, ta).normalize();
    const phase = hash01(nodes.length * 37 + item.generation * 91 + Math.floor(item.age * 17)) * Math.PI;
    const n1 = ta.clone().multiplyScalar(Math.cos(phase)).addScaledVector(tb, Math.sin(phase)).addScaledVector(dir, 0.16).normalize();
    const n2 = ta.clone().multiplyScalar(Math.cos(phase + 1.18)).addScaledVector(tb, Math.sin(phase + 1.18)).addScaledVector(dir, -0.10).normalize();
    const groups = [[], [], [], []];
    const pos = new THREE.Vector3(), rel = new THREE.Vector3();
    const off1 = (hash01(nodes.length * 11 + item.generation * 7) - .5) * grid.h * 1.25;
    const off2 = (hash01(nodes.length * 19 + item.generation * 13) - .5) * grid.h * 1.25;
    for (const i of nodes) {
      const o = i * 3; pos.set(grid.local[o], grid.local[o + 1], grid.local[o + 2]); rel.subVectors(pos, hitSource);
      const micro = (hash01(i * 53 + item.generation * 109) - .5) * grid.h * (.28 + severity * .22);
      const a = rel.dot(n1) + micro - off1 >= 0 ? 1 : 0;
      const b = rel.dot(n2) - micro - off2 >= 0 ? 2 : 0;
      groups[a | b].push(i);
    }
    const minNodes = Math.max(7, Math.floor(nodes.length * .055));
    let pieces = groups.map((group) => largestConnectedSubset(grid, group)).filter((group) => group.length >= minNodes);
    if (pieces.length < 2) {
      // Fallback: bisect through the payload centroid. This keeps secondary fracture robust
      // even when the projectile hits close to one corner of an already irregular chunk.
      const center = new THREE.Vector3();
      for (const i of nodes) { const o = i * 3; center.x += grid.local[o]; center.y += grid.local[o + 1]; center.z += grid.local[o + 2]; }
      center.multiplyScalar(1 / nodes.length);
      const aa = [], bb = [];
      const splitN = ta.clone().multiplyScalar(.72).addScaledVector(tb, .41).addScaledVector(dir, .18).normalize();
      for (const i of nodes) { const o = i * 3; pos.set(grid.local[o], grid.local[o + 1], grid.local[o + 2]); (pos.sub(center).dot(splitN) >= 0 ? aa : bb).push(i); }
      pieces = [largestConnectedSubset(grid, aa), largestConnectedSubset(grid, bb)].filter((group) => group.length >= minNodes);
    }
    pieces.sort((a, b) => b.length - a.length);
    return pieces.slice(0, 4);
  }
  absorb(item, speed = 58) {
    if (!item || !this.items.includes(item)) return { fractured: false, severity: 0, mud: true };
    item.hardened = false; item.age = Math.min(item.age, item.harden * 0.22);
    item.finalScale.x *= 1.08; item.finalScale.y *= 1.06; item.finalScale.z *= 1.03;
    item.startScale.copy(item.mesh.scale);
    item.spread = 0.18; item.harden = 1.55;
    const m = item.mesh.material; m.roughness = 0.31; if ('clearcoat' in m) { m.clearcoat = 0.20; m.clearcoatRoughness = 0.17; }
    return { fractured: false, severity: clamp(speed / 120, 0.08, 0.45), realFragments: 0, mud: true, wet: true, stuck: true };
  }
  impact(item, worldPoint, worldDir, speed) {
    if (!item || !this.items.includes(item)) return { fractured: false, severity: 0, realFragments: 0 };
    const severity = clamp((speed - 26) / 126, .18, 1);
    item.sleeping = false; item.sleep = 0; this.system?.rigidWorld?.wake(item.rigid);
    const pieces = item.generation < this.maxSecondaryGeneration ? this.splitPayload(item, worldPoint, worldDir, severity) : [];
    if (pieces.length < 2) {
      item.velocity.addScaledVector(worldDir, 1.4 + severity * 4.2);
      item.velocity.y += .35 + severity * .85;
      item.spin.add(new THREE.Vector3(randRange(-2.5, 2.5), randRange(-2.5, 2.5), randRange(-2.5, 2.5)));
      return { fractured: false, severity, realFragments: 0, secondary: true };
    }
    item.mesh.updateMatrixWorld(true);
    const sourceMatrix = item.mesh.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(-item.centerLocal.x, -item.centerLocal.y, -item.centerLocal.z));
    const parentNodes = item.voxelPayload.nodes.length;
    const profileName = item.profileName, sourceSupportY = item.sourceSupportY, sourceVelocity = item.velocity.clone(), generation = item.generation + 1;
    const children = [];
    for (const nodes of pieces) {
      const phi = nodesToPositiveField(item.voxelPayload.grid, nodes);
      const geometry = topologyToGeometry(buildSurfaceTopology(item.voxelPayload.grid, phi), this.system?.qualityScale >= 1.28 ? 2 : 1, item.voxelPayload.grid.sourceBounds);
      if (!geometry) continue;
      const persistent = generation < this.maxSecondaryGeneration && nodes.length >= Math.max(18, parentNodes * .18);
      const child = this.spawn(profileName, geometry, sourceMatrix, worldDir, severity, sourceVelocity, {
        floorY: sourceSupportY, generation, persistent, appearance: item.surfaceAppearance,
        voxelPayload: { grid: item.voxelPayload.grid, nodes },
      });
      if (child) children.push(child);
    }
    this.removeWithoutMerge(item);
    this.system?.activeShards?.spawn(profileName, worldPoint, worldDir, Math.max(1, Math.round(1 + severity * 2)), .035, 1.1 + severity * 1.8, item.surfaceAppearance);
    this.system?.dust?.spawn(worldPoint, worldDir, Math.round((DAMAGE_PROFILES[profileName]?.dust ?? 2) * .18));
    return { fractured: children.length >= 2, severity, realFragments: children.length, secondary: true };
  }
  update(dt) {
    const keep = [];
    this.rebuildTimer += dt;
    for (const item of this.items) {
      item.age += dt;
      if (item.sleeping) { keep.push(item); continue; }
      if (item.rigid?.sleeping) item.sleep += dt; else item.sleep = 0;
      if (item.sleep > 0.22) {
        if (this.settle(item)) keep.push(item);
      } else keep.push(item);
    }
    this.items = keep;
    if (this.rebuildTimer > 0.35) { this.rebuildTimer = 0; this.staticMerger.rebuildDirty(); }
  }
  reset() {
    for (const item of this.items) {
      this.system?.rigidWorld?.removeBody(item.rigid);
      this.scene.remove(item.mesh); item.mesh.geometry.dispose(); item.mesh.material.dispose();
    }
    this.items = [];
    this.staticMerger.reset();
  }
  get count() { return this.items.length; }
  get sleepingInteractiveCount() { let n = 0; for (const item of this.items) if (item.sleeping) n++; return n; }
}

class ActiveShardSystem {
  constructor(scene, sleepingPool, maxActive = 120) {
    this.scene = scene; this.sleepingPool = sleepingPool; this.maxActive = maxActive; this.items = [];
  }
  forceLandAndSleep(item) {
    if (!item) return;
    // Capacity pressure drops the oldest airborne chip instead of freezing it in mid-air.
    this.system?.rigidWorld?.removeBody(item.rigid); item.rigid=null;
    this.scene.remove(item.mesh); item.mesh.geometry.dispose(); item.mesh.material.dispose();
  }
  spawn(profileName, position, direction, count, baseScale, impulse = 3, appearance = null) {
    for (let n = 0; n < count; n++) {
      if (this.items.length >= this.maxActive) {
        const groundedIndex = this.items.findIndex((it) => it.grounded);
        const index = groundedIndex >= 0 ? groundedIndex : 0;
        const [old] = this.items.splice(index, 1);
        if (old.grounded) this.sleepOne(old); else this.forceLandAndSleep(old);
      }
      const mesh = new THREE.Mesh(createShardGeometry(profileName), createShardMaterial(profileName, appearance));
      mesh.castShadow = true; mesh.receiveShadow = true;
      const s = baseScale * randRange(0.55, 1.55);
      const scale = profileName === 'wood'
        ? new THREE.Vector3(s * randRange(1.2, 2.4), s * randRange(0.35, 0.7), s * randRange(0.45, 0.85))
        : new THREE.Vector3(s * randRange(0.65, 1.5), s * randRange(0.55, 1.35), s * randRange(0.65, 1.5));
      mesh.scale.copy(scale);
      mesh.position.copy(position).add(new THREE.Vector3(randRange(-s,s),randRange(-s,s),randRange(-s,s)));
      mesh.rotation.set(randRange(0,Math.PI),randRange(0,Math.PI),randRange(0,Math.PI));
      this.scene.add(mesh);
      const spray = direction.clone().multiplyScalar(impulse * randRange(0.45, 1.25));
      spray.add(new THREE.Vector3(randRange(-1.6,1.6),randRange(0.3,2.2),randRange(-1.6,1.6)));
      const spin = new THREE.Vector3(randRange(-7,7),randRange(-7,7),randRange(-7,7));
      const item = { profileName, appearance, mesh, scale, velocity: spray, spin, age:0, sleep:0, grounded:false, rigid:null };
      const rr = Math.max(scale.x, scale.y, scale.z) * 0.44;
      const profile = DAMAGE_PROFILES[profileName] ?? DAMAGE_PROFILES.concrete;
      item.rigid = this.system?.rigidWorld?.addBody({ mesh, shape:{type:'sphere',radius:Math.max(.012,rr)}, mass:clamp(rr*rr*rr*18,.015,.65), velocity:spray, angularVelocity:spin, friction:profile.friction??.78, restitution:profile.restitution??.08, dynamicPairs:false, userData:item, tag:`chip:${profileName}` }) ?? null;
      if(item.rigid){item.velocity=item.rigid.velocity;item.spin=item.rigid.angularVelocity;}
      this.items.push(item);
    }
  }
  sleepOne(item) {
    if (!item) return;
    this.system?.rigidWorld?.removeBody(item.rigid); item.rigid=null;
    item.mesh.updateMatrixWorld(true);
    this.sleepingPool.addTransform(item.profileName, item.mesh.position.clone(), item.mesh.quaternion.clone(), item.mesh.scale.clone(), item.appearance);
    this.scene.remove(item.mesh); item.mesh.geometry.dispose(); item.mesh.material.dispose();
  }
  update(dt) {
    const keep=[];
    for(const item of this.items) {
      item.age += dt;
      if(item.rigid?.sleeping) item.sleep += dt; else item.sleep=0;
      if(item.sleep>0.18) this.sleepOne(item); else keep.push(item);
    }
    this.items=keep;
  }
  reset() {
    for(const item of this.items) { this.system?.rigidWorld?.removeBody(item.rigid); this.scene.remove(item.mesh); item.mesh.geometry.dispose(); item.mesh.material.dispose(); }
    this.items=[];
  }
  get count(){ return this.items.length; }
}

class DustSystem {
  constructor(scene, max = 2200) {
    this.max = max; this.cursor = 0; this.active = 0;
    this.positions = new Float32Array(max * 3);
    this.velocity = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    for (let i=0;i<max;i++) this.positions[i*3+1] = -9999;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.PointsMaterial({ color: 0xbeb6a7, size: 0.055, transparent: true, opacity: 0.35, depthWrite: false });
    this.points = new THREE.Points(g, m); this.points.frustumCulled = false; scene.add(this.points);
  }
  spawn(pos, dir, count) {
    for (let n=0;n<count;n++) {
      const i=this.cursor; this.cursor=(this.cursor+1)%this.max; const o=i*3;
      this.positions[o]=pos.x+randRange(-.06,.06); this.positions[o+1]=pos.y+randRange(-.06,.06); this.positions[o+2]=pos.z+randRange(-.06,.06);
      this.velocity[o]=dir.x*randRange(.25,1.1)+randRange(-.7,.7); this.velocity[o+1]=dir.y*randRange(.25,1.1)+randRange(.15,1.2); this.velocity[o+2]=dir.z*randRange(.25,1.1)+randRange(-.7,.7);
      this.life[i]=randRange(.35,1.2);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
  update(dt) {
    let active=0, dirty=false;
    for (let i=0;i<this.max;i++) {
      if (this.life[i]<=0) continue;
      active++; dirty=true; this.life[i]-=dt; const o=i*3;
      if (this.life[i]<=0) { this.positions[o+1]=-9999; continue; }
      const d=Math.exp(-2.2*dt); this.velocity[o]*=d; this.velocity[o+1]=this.velocity[o+1]*d-1.6*dt; this.velocity[o+2]*=d;
      this.positions[o]+=this.velocity[o]*dt; this.positions[o+1]+=this.velocity[o+1]*dt; this.positions[o+2]+=this.velocity[o+2]*dt;
    }
    this.active=active; if (dirty) this.points.geometry.attributes.position.needsUpdate=true;
  }
  reset() { this.life.fill(0); this.active=0; for(let i=0;i<this.max;i++) this.positions[i*3+1]=-9999; this.points.geometry.attributes.position.needsUpdate=true; }
}


class MudSystem {
  constructor(scene, system, maxPatches = 40) {
    this.scene = scene; this.system = system; this.maxPatches = maxPatches; this.items = [];
    this.Z = new THREE.Vector3(0, 0, 1);
  }
  makeGeometry(seed = 1) {
    const g = new THREE.SphereGeometry(1, 28, 18);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const n = 0.88 + hash01(i * 17 + seed * 131) * 0.22;
      p.setXYZ(i, x * n, y * (0.94 + (n - 0.88) * 0.35), z * (0.94 + (n - 0.88) * 0.20));
    }
    p.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere(); return g;
  }
  makeMaterial() {
    return new THREE.MeshPhysicalMaterial({
      color: 0x5c3b28, roughness: 0.30, metalness: 0, clearcoat: 0.22, clearcoatRoughness: 0.15,
      ior: 1.39, envMapIntensity: 0.82,
    });
  }
  splat(targetMesh, worldPoint, worldNormal, speed = 58) {
    if (!targetMesh) return null;
    while (this.items.length >= this.maxPatches) this.remove(this.items[0]);
    const radius = clamp(0.14 + speed * 0.0012, 0.16, 0.24);
    const mesh = new THREE.Mesh(this.makeGeometry(this.items.length + 7), this.makeMaterial());
    mesh.castShadow = true; mesh.receiveShadow = true;
    const n = worldNormal.clone().normalize();
    mesh.position.copy(worldPoint).addScaledVector(n, radius * 0.035);
    mesh.quaternion.setFromUnitVectors(this.Z, n);
    const flatten = clamp(0.34 - speed * 0.0018, 0.20, 0.31);
    const finalScale = new THREE.Vector3(radius * 1.42, radius * 1.18, radius * flatten);
    const startScale = new THREE.Vector3(radius * 0.78, radius * 0.72, radius * 0.62);
    mesh.scale.copy(startScale);
    this.scene.add(mesh); targetMesh.updateMatrixWorld(true); targetMesh.attach(mesh);
    const item = { mesh, targetMesh, age: 0, spread: 0.24, harden: 1.55, hardened: false, radius, normal: n.clone(), appearance: null, startScale, finalScale };
    mesh.userData.mudPatchItem = item; this.items.push(item); return item;
  }
  absorb(item, speed = 58) {
    if (!item || !this.items.includes(item)) return { fractured:false, severity:0, realFragments:0, mud:true };
    // Multiple wet blobs merge into the existing patch instead of calling an undefined helper.
    // Keep scale values bounded so continuous 5 Hz fire cannot grow one patch to NaN/Infinity.
    const gain=clamp(1.02 + speed*0.00055,1.02,1.065);
    item.finalScale.x=clamp(item.finalScale.x*gain,0.08,0.62);
    item.finalScale.y=clamp(item.finalScale.y*gain,0.08,0.56);
    item.finalScale.z=clamp(item.finalScale.z*0.94,0.012,0.18);
    item.startScale.copy(item.mesh.scale);
    item.age=0; item.hardened=false;
    const m=item.mesh.material; m.roughness=0.30; if('clearcoat' in m){m.clearcoat=0.22;m.clearcoatRoughness=0.15;}
    return { fractured:false,severity:0.12,realFragments:0,mud:true,wet:true,stuck:true };
  }

  remove(item) {
    if (!item) return;
    const i = this.items.indexOf(item); if (i >= 0) this.items.splice(i, 1);
    item.mesh.userData.mudPatchItem = null;
    item.mesh.parent?.remove(item.mesh); item.mesh.geometry.dispose(); item.mesh.material.dispose();
  }
  impact(item, worldPoint, worldDir, speed) {
    if (!item || !this.items.includes(item)) return { fractured: false, severity: 0, realFragments: 0, mud: true };
    if (!item.hardened) {
      // Wet mud absorbs the hit and spreads a little more instead of shattering.
      item.mesh.scale.x *= 1.08; item.mesh.scale.y *= 1.06; item.mesh.scale.z *= 0.82;
      item.age = Math.max(0, item.age - 0.22);
      return { fractured: false, severity: 0.15, realFragments: 0, mud: true, wet: true };
    }
    const severity = clamp((speed - 24) / 115, 0.18, 1);
    if (severity < 0.30) return { fractured: false, severity, realFragments: 0, mud: true, hardened: true };
    item.mesh.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3(); item.mesh.getWorldPosition(worldPos);
    const appearance = item.appearance ?? captureMaterialAppearance(item.mesh.material, 'ceramic');
    const count = Math.max(3, Math.round(3 + severity * 5));
    this.system.activeShards.spawn('ceramic', worldPos, worldDir, count, item.radius * 0.32, 1.1 + severity * 2.2, appearance);
    this.system.dust.spawn(worldPoint, worldDir, Math.round(2 + severity * 4));
    this.remove(item);
    return { fractured: true, severity, realFragments: count, mud: true, hardened: true };
  }
  update(dt) {
    for (const item of this.items) {
      item.age += dt;
      const spreadT = smoothstep01(item.age / item.spread);
      item.mesh.scale.lerpVectors(item.startScale, item.finalScale, spreadT);
      const t = smoothstep01(item.age / item.harden);
      const m = item.mesh.material;
      m.roughness = lerp(0.30, 0.78, t);
      if ('clearcoat' in m) { m.clearcoat = lerp(0.22, 0.025, t); m.clearcoatRoughness = lerp(0.15, 0.62, t); }
      m.color.setRGB(lerp(0.36, 0.43, t), lerp(0.23, 0.30, t), lerp(0.15, 0.21, t), THREE.SRGBColorSpace);
      if (!item.hardened && t >= 0.999) { item.hardened = true; item.appearance = captureMaterialAppearance(m, 'ceramic'); }
    }
  }
  colliderMeshes() { return this.items.map((x) => x.mesh); }
  targetDescription(item) { return item?.hardened ? '硬化泥巴 · 已与表面结合，可击碎' : '湿泥巴 · 正在硬化'; }
  reset() { for (const item of [...this.items]) this.remove(item); }
}

class ImpactAudio {
  constructor() { this.ctx = null; }
  enable() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx && AC) this.ctx = new AC();
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(()=>{});
  }
  hit(profileName, severity) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now=this.ctx.currentTime, osc=this.ctx.createOscillator(), gain=this.ctx.createGain();
    const brittle = XPBD_PROFILES[profileName].fracture < 0.2;
    osc.type = brittle ? 'triangle' : profileName === 'metal' ? 'sine' : 'square';
    const base = profileName==='glass'?760:profileName==='ceramic'?560:profileName==='metal'?170:95;
    osc.frequency.setValueAtTime(base*randRange(.88,1.12),now); osc.frequency.exponentialRampToValueAtTime(Math.max(38,base*.26),now+.12);
    gain.gain.setValueAtTime(Math.min(.12,.015+severity*.018),now); gain.gain.exponentialRampToValueAtTime(.0001,now+.16);
    osc.connect(gain).connect(this.ctx.destination); osc.start(now); osc.stop(now+.18);
  }
}

function makeGridForBody(mesh, profileName, options, globalParticleStart) {
  const geometry = mesh.geometry;
  geometry.computeBoundingBox();
  const sourceBounds = geometry.boundingBox.clone();
  const size = sourceBounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const shape = options.shape ?? 'box';
  const baseTarget = options.voxelResolution ?? (shape === 'vase' ? 28 : maxDim > 8 ? 10 : maxDim > 3 ? 13 : profileName === 'glass' ? 22 : 18);
  const requestedQuality = clamp(options.qualityScale ?? 1, 0.85, 1.55);
  // High-detail assets get the full quality multiplier. Large architectural pieces are only
  // nudged upward so the global XPBD graph does not explode cubically.
  const localQuality = baseTarget >= 18 || shape === 'vase' ? requestedQuality : 1 + (requestedQuality - 1) * 0.35;
  const targetMax = Math.max(6, Math.round(baseTarget * localQuality));
  const baseStep = maxDim / Math.max(6, targetMax - 3);
  // Thin walls need multiple samples through their thickness, but must not inherit a huge
  // isotropic padding from their long axis. Keep the volume anisotropic and bounded.
  const margin = new THREE.Vector3(
    Math.min(baseStep * 0.75, Math.max(0.035, size.x * 0.80)),
    Math.min(baseStep * 0.75, Math.max(0.035, size.y * 0.80)),
    Math.min(baseStep * 0.75, Math.max(0.035, size.z * 0.80)),
  );
  const min = sourceBounds.min.clone().sub(margin);
  const max = sourceBounds.max.clone().add(margin);
  const ext = max.clone().sub(min);
  const cap = requestedQuality >= 1.42 ? 68 : requestedQuality >= 1.28 ? 60 : requestedQuality >= 1.12 ? 52 : 44;
  const nx = clamp(Math.round(size.x / baseStep) + 3, 5, cap);
  const ny = clamp(Math.round(size.y / baseStep) + 3, 5, cap + 4);
  const nz = clamp(Math.round(size.z / baseStep) + 3, 5, cap);
  const step = new THREE.Vector3(ext.x/(nx-1), ext.y/(ny-1), ext.z/(nz-1));
  const sdf = makeShapeSdf(shape, sourceBounds, options);
  const count = nx*ny*nz;
  const local = new Float32Array(count*3);
  const basePhi = new Float32Array(count);
  const damage = new Float32Array(count);
  const active = new Uint8Array(count);
  const idx=(x,y,z)=>x+nx*(y+ny*z);
  const maxStep=Math.max(step.x,step.y,step.z);
  const characteristicStep=Math.cbrt(Math.max(EPS, step.x*step.y*step.z));
  for(let z=0;z<nz;z++) for(let y=0;y<ny;y++) for(let x=0;x<nx;x++) {
    const i=idx(x,y,z); const px=min.x+x*step.x, py=min.y+y*step.y, pz=min.z+z*step.z;
    local[i*3]=px; local[i*3+1]=py; local[i*3+2]=pz;
    const phi=sdf(px,py,pz); basePhi[i]=phi;
    active[i]=phi > -maxStep*1.35 ? 1 : 0;
  }
  return { nx,ny,nz,count,min,max,step,h:characteristicStep,maxStep,local,basePhi,damage,active,idx,particleStart:globalParticleStart,sourceBounds,shape };
}

function buildSurfaceTopology(grid, effectivePhi) {
  const {nx,ny,nz,local,particleStart} = grid;
  const positions=[]; const refsA=[]; const refsB=[]; const refsT=[]; const indices=[];
  const edgeVertex=new Map();
  const cube = new Int32Array(8);
  const cornerIndex=(x,y,z)=>grid.idx(x,y,z);
  const getVertex=(a,b)=>{
    const lo=Math.min(a,b), hi=Math.max(a,b); const key=`${lo}:${hi}`;
    let vi=edgeVertex.get(key); if(vi!==undefined) return vi;
    const va=effectivePhi[a], vb=effectivePhi[b]; let t=va/(va-vb); if(!Number.isFinite(t)) t=.5; t=clamp(t,.001,.999);
    const ao=a*3, bo=b*3;
    positions.push(lerp(local[ao],local[bo],t),lerp(local[ao+1],local[bo+1],t),lerp(local[ao+2],local[bo+2],t));
    refsA.push(particleStart+a); refsB.push(particleStart+b); refsT.push(t);
    vi=refsA.length-1; edgeVertex.set(key,vi); return vi;
  };
  const vertexAt=(vi,out)=>out.set(positions[vi*3],positions[vi*3+1],positions[vi*3+2]);
  const ta=new THREE.Vector3(),tb=new THREE.Vector3(),tc=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3(),normal=new THREE.Vector3();
  const emitTri=(a,b,c,outward)=>{
    vertexAt(a,ta); vertexAt(b,tb); vertexAt(c,tc);
    ab.subVectors(tb,ta); ac.subVectors(tc,ta); normal.crossVectors(ab,ac);
    // effectivePhi is positive inside, so the correct visible normal points from
    // the positive (solid) centroid toward the negative (air) centroid.
    if(normal.dot(outward)<0) indices.push(a,c,b); else indices.push(a,b,c);
  };
  const centroidFor=(ids,out)=>{
    out.set(0,0,0);
    for(const id of ids){const o=id*3;out.x+=local[o];out.y+=local[o+1];out.z+=local[o+2];}
    return out.multiplyScalar(1/Math.max(1,ids.length));
  };
  const insideCenter=new THREE.Vector3(),outsideCenter=new THREE.Vector3(),outward=new THREE.Vector3();
  const emitTet=(tet)=>{
    const ids=tet.map(k=>cube[k]); const inside=ids.map(i=>effectivePhi[i]>=0);
    const inIdx=[], outIdx=[]; for(let i=0;i<4;i++) (inside[i]?inIdx:outIdx).push(i);
    if(inIdx.length===0||inIdx.length===4) return;
    const inIds=inIdx.map(i=>ids[i]), outIds=outIdx.map(i=>ids[i]);
    centroidFor(inIds,insideCenter); centroidFor(outIds,outsideCenter); outward.subVectors(outsideCenter,insideCenter).normalize();
    if(inIdx.length===1||inIdx.length===3) {
      const pivotInside=inIdx.length===1; const pivot=(pivotInside?inIdx:outIdx)[0]; const others=pivotInside?outIdx:inIdx;
      const v0=getVertex(ids[pivot],ids[others[0]]), v1=getVertex(ids[pivot],ids[others[1]]), v2=getVertex(ids[pivot],ids[others[2]]);
      emitTri(v0,v1,v2,outward); return;
    }
    const i0=inIdx[0], i1=inIdx[1], o0=outIdx[0], o1=outIdx[1];
    const a=getVertex(ids[i0],ids[o0]); const b=getVertex(ids[i0],ids[o1]); const c=getVertex(ids[i1],ids[o1]); const d=getVertex(ids[i1],ids[o0]);
    emitTri(a,b,c,outward); emitTri(a,c,d,outward);
  };
  for(let z=0;z<nz-1;z++) for(let y=0;y<ny-1;y++) for(let x=0;x<nx-1;x++) {
    cube[0]=cornerIndex(x,y,z); cube[1]=cornerIndex(x+1,y,z); cube[2]=cornerIndex(x+1,y+1,z); cube[3]=cornerIndex(x,y+1,z);
    cube[4]=cornerIndex(x,y,z+1); cube[5]=cornerIndex(x+1,y,z+1); cube[6]=cornerIndex(x+1,y+1,z+1); cube[7]=cornerIndex(x,y+1,z+1);
    let pos=0,neg=0; for(let k=0;k<8;k++){ if(effectivePhi[cube[k]]>=0)pos++;else neg++; }
    if(pos===0||neg===0) continue;
    for(const tet of TETRA) emitTet(tet);
  }
  return {positions:new Float32Array(positions), refsA:new Uint32Array(refsA), refsB:new Uint32Array(refsB), refsT:new Float32Array(refsT), indices:new Uint32Array(indices)};
}


function solidComponents(grid, effectivePhi, detachedMask = null) {
  const solid = new Uint8Array(grid.count);
  let solidCount = 0;
  for (let i=0;i<grid.count;i++) {
    if ((!detachedMask || !detachedMask[i]) && effectivePhi[i] > 0) { solid[i]=1; solidCount++; }
  }
  const visited = new Uint8Array(grid.count);
  const components = [];
  const q = new Int32Array(grid.count);
  const {nx,ny,nz}=grid;
  const pushNeighbor=(ni,tailRef)=>{};
  for (let seed=0;seed<grid.count;seed++) {
    if (!solid[seed] || visited[seed]) continue;
    let head=0,tail=0; q[tail++]=seed; visited[seed]=1; const nodes=[];
    while(head<tail){
      const i=q[head++]; nodes.push(i);
      const z=Math.floor(i/(nx*ny)); const rem=i-z*nx*ny; const y=Math.floor(rem/nx); const x=rem-y*nx;
      const ns=[];
      if(x>0)ns.push(i-1); if(x+1<nx)ns.push(i+1);
      if(y>0)ns.push(i-nx); if(y+1<ny)ns.push(i+nx);
      if(z>0)ns.push(i-nx*ny); if(z+1<nz)ns.push(i+nx*ny);
      for(const ni of ns){ if(solid[ni]&&!visited[ni]){visited[ni]=1;q[tail++]=ni;} }
    }
    components.push(nodes);
  }
  components.sort((a,b)=>b.length-a.length);
  return {components,solidCount};
}

function largestConnectedSubset(grid, nodes) {
  if (!nodes || nodes.length <= 1) return nodes ? [...nodes] : [];
  const allowed = new Set(nodes);
  const visited = new Set();
  let best = [];
  const { nx, ny, nz } = grid;
  for (const seed of nodes) {
    if (visited.has(seed)) continue;
    const q = [seed]; visited.add(seed); const comp = [];
    for (let head = 0; head < q.length; head++) {
      const i = q[head]; comp.push(i);
      const z = Math.floor(i / (nx * ny)); const rem = i - z * nx * ny; const y = Math.floor(rem / nx); const x = rem - y * nx;
      const ns = [];
      if (x > 0) ns.push(i - 1); if (x + 1 < nx) ns.push(i + 1);
      if (y > 0) ns.push(i - nx); if (y + 1 < ny) ns.push(i + nx);
      if (z > 0) ns.push(i - nx * ny); if (z + 1 < nz) ns.push(i + nx * ny);
      for (const ni of ns) if (allowed.has(ni) && !visited.has(ni)) { visited.add(ni); q.push(ni); }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

function blurGridScalar(grid, source, passes=2, selfWeight=2.4) {
  let a = new Float32Array(source);
  const { nx, ny, nz } = grid;
  for (let pass = 0; pass < passes; pass++) {
    const b = new Float32Array(grid.count);
    for (let i = 0; i < grid.count; i++) {
      const z = Math.floor(i / (nx * ny)); const rem = i - z * nx * ny; const y = Math.floor(rem / nx); const x = rem - y * nx;
      let sum = a[i] * selfWeight, w = selfWeight;
      if (x > 0) { sum += a[i-1]; w++; } if (x+1 < nx) { sum += a[i+1]; w++; }
      if (y > 0) { sum += a[i-nx]; w++; } if (y+1 < ny) { sum += a[i+nx]; w++; }
      if (z > 0) { sum += a[i-nx*ny]; w++; } if (z+1 < nz) { sum += a[i+nx*ny]; w++; }
      b[i] = sum / w;
    }
    a = b;
  }
  return a;
}

function smoothComponentField(grid, componentNodes, effectivePhi=null, passes=2) {
  const occupancy = new Float32Array(grid.count);
  for (const i of componentNodes) occupancy[i] = 1;
  const smooth = blurGridScalar(grid, occupancy, passes, 2.1);
  const phi = new Float32Array(grid.count);
  const scale = grid.maxStep * 3.25;
  for (let i = 0; i < grid.count; i++) {
    const edgeBand = 1 - Math.min(1, Math.abs(smooth[i] - 0.5) * 2.4);
    const micro = (hash01(i * 47 + grid.nx * 11 + grid.ny * 17) - 0.5) * grid.maxStep * 0.16 * edgeBand;
    const maskPhi = (smooth[i] - 0.36) * scale + micro;
    const exteriorPhi = effectivePhi ? Math.min(grid.basePhi[i] + grid.maxStep * 0.10, effectivePhi[i] + grid.maxStep * 0.06) : grid.basePhi[i] + grid.maxStep * 0.10;
    phi[i] = Math.min(exteriorPhi, maskPhi);
  }
  return phi;
}

function componentField(grid, effectivePhi, componentNodes) {
  return smoothComponentField(grid, componentNodes, effectivePhi, 2);
}

function nodesToPositiveField(grid, nodes) {
  return smoothComponentField(grid, nodes, null, 2);
}

function buildDisplayPhi(grid, damage, detachedMask) {
  const damageSmooth = blurGridScalar(grid, damage, 2, 3.0);
  const support = new Float32Array(grid.count);
  let hasDetached = false;
  for (let i = 0; i < grid.count; i++) { support[i] = detachedMask?.[i] ? 0 : 1; if (detachedMask?.[i]) hasDetached = true; }
  const supportSmooth = hasDetached ? blurGridScalar(grid, support, 2, 2.0) : support;
  const out = new Float32Array(grid.count);
  for (let i = 0; i < grid.count; i++) {
    const d = Math.max(damage[i] * 0.74, damageSmooth[i] * 0.92);
    const damagedPhi = grid.basePhi[i] - d;
    const fractureBand = Math.max(clamp(d / Math.max(grid.maxStep, EPS), 0, 1), hasDetached ? clamp((1 - supportSmooth[i]) * 1.7, 0, 1) : 0);
    const micro = (hash01(i * 61 + grid.nz * 23) - 0.5) * grid.maxStep * 0.12 * fractureBand;
    const cutPhi = hasDetached ? (supportSmooth[i] - 0.34) * grid.maxStep * 3.2 + micro : grid.maxStep * 4;
    out[i] = Math.min(damagedPhi + micro * 0.45, cutPhi);
    if (detachedMask?.[i]) out[i] = Math.min(out[i], -grid.maxStep * 0.16);
  }
  return out;
}


function buildStructuralPhi(grid, damage, detachedMask, effectivePhi) {
  // Structural connectivity must agree with what the player can actually see.  The rendered
  // fracture surface uses a smoothed damage field; analysing only raw basePhi-damage can leave a
  // one-voxel/sub-voxel bridge that is invisible on screen but still keeps two halves in the same
  // support island.  Intersect the physical field with the display field so a visible through-cut
  // is also a broken support path.
  const displayPhi = buildDisplayPhi(grid, damage, detachedMask);
  const out = new Float32Array(grid.count);
  const neckBias = grid.maxStep * 0.015;
  for (let i = 0; i < grid.count; i++) {
    out[i] = Math.min(effectivePhi[i] - neckBias, displayPhi[i]);
    if (detachedMask?.[i]) out[i] = -grid.maxStep * 2;
  }
  return out;
}

function relaxGeneratedGeometry(geometry, iterations = 1) {
  // Marching tetrahedra already interpolates the scalar field, but a coarse voxel lattice can
  // still leave staircase-like silhouettes. A small Taubin-style two-pass relaxation reduces
  // grid-axis facets without the strong shrinkage of ordinary Laplacian smoothing. This is CPU
  // work only when topology changes, never per frame.
  const pos = geometry.getAttribute('position'), index = geometry.index;
  if (!pos || !index || pos.count < 8 || iterations <= 0) return geometry;
  const n = pos.count, ids = index.array;
  const src = new Float32Array(pos.array), tmp = new Float32Array(src.length);
  const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n), count = new Uint32Array(n);
  const pass = (input, output, weight) => {
    sx.fill(0); sy.fill(0); sz.fill(0); count.fill(0);
    const add = (a,b) => { const o=b*3; sx[a]+=input[o]; sy[a]+=input[o+1]; sz[a]+=input[o+2]; count[a]++; };
    for (let k=0;k<ids.length;k+=3) {
      const a=ids[k], b=ids[k+1], c=ids[k+2];
      add(a,b); add(a,c); add(b,a); add(b,c); add(c,a); add(c,b);
    }
    for (let i=0;i<n;i++) {
      const o=i*3, c=count[i];
      if (!c) { output[o]=input[o]; output[o+1]=input[o+1]; output[o+2]=input[o+2]; continue; }
      const ax=sx[i]/c, ay=sy[i]/c, az=sz[i]/c;
      output[o]=input[o] + (ax-input[o])*weight;
      output[o+1]=input[o+1] + (ay-input[o+1])*weight;
      output[o+2]=input[o+2] + (az-input[o+2])*weight;
    }
  };
  let a=src, b=tmp;
  for (let i=0;i<iterations;i++) { pass(a,b,0.24); [a,b]=[b,a]; pass(a,b,-0.245); [a,b]=[b,a]; }
  pos.array.set(a); pos.needsUpdate=true;
  return geometry;
}

function addBoxProjectedUVs(geometry, sourceBounds = null) {
  const pos = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  if (!pos || !normal) return;
  const bounds = sourceBounds?.clone?.() ?? geometry.boundingBox?.clone?.() ?? new THREE.Box3().setFromBufferAttribute(pos);
  const size = bounds.getSize(new THREE.Vector3());
  size.x = Math.max(size.x, 1e-5); size.y = Math.max(size.y, 1e-5); size.z = Math.max(size.z, 1e-5);
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x=pos.getX(i), y=pos.getY(i), z=pos.getZ(i), ax=Math.abs(normal.getX(i)), ay=Math.abs(normal.getY(i)), az=Math.abs(normal.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u=(x-bounds.min.x)/size.x; v=(z-bounds.min.z)/size.z; }
    else if (ax >= az) { u=(z-bounds.min.z)/size.z; v=(y-bounds.min.y)/size.y; }
    else { u=(x-bounds.min.x)/size.x; v=(y-bounds.min.y)/size.y; }
    uv[i*2]=u; uv[i*2+1]=v;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function topologyToGeometry(top, smoothIterations = 1, sourceBounds = null) {
  if (!top || top.positions.length < 9 || top.indices.length < 3) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(top.positions,3));
  g.setIndex(new THREE.BufferAttribute(top.indices,1));
  relaxGeneratedGeometry(g, smoothIterations);
  g.computeVertexNormals(); g.computeBoundingBox(); addBoxProjectedUVs(g, sourceBounds); g.computeBoundingSphere();
  return g;
}

function addConstraint(list, a, b, rest, xpbd, kind=0) {
  list.push({a,b,rest,lambda:0,damage:0,active:1,compliance:xpbd.compliance,yield:xpbd.yield,fracture:xpbd.fracture,plasticity:xpbd.plasticity,toughness:xpbd.toughness,kind});
}

function buildConstraintsForGrid(grid, worldPositions, xpbd, constraints) {
  const {nx,ny,nz,active,particleStart}=grid; const id=grid.idx;
  const p=(local)=>particleStart+local;
  const dist=(ia,ib)=>{
    const a=(p(ia))*3,b=(p(ib))*3; const dx=worldPositions[a]-worldPositions[b],dy=worldPositions[a+1]-worldPositions[b+1],dz=worldPositions[a+2]-worldPositions[b+2]; return Math.hypot(dx,dy,dz);
  };
  const maybe=(ia,ib,kind)=>{ if(active[ia]&&active[ib]&&(grid.basePhi[ia]>-grid.maxStep*.15||grid.basePhi[ib]>-grid.maxStep*.15)) addConstraint(constraints,p(ia),p(ib),dist(ia,ib),xpbd,kind); };
  for(let z=0;z<nz;z++) for(let y=0;y<ny;y++) for(let x=0;x<nx;x++) {
    const a=id(x,y,z); if(!active[a]) continue;
    if(x+1<nx) maybe(a,id(x+1,y,z),0);
    if(y+1<ny) maybe(a,id(x,y+1,z),0);
    if(z+1<nz) maybe(a,id(x,y,z+1),0);
  }
  // Body diagonals add shear stiffness without introducing volumetric FEM complexity.
  for(let z=0;z<nz-1;z++) for(let y=0;y<ny-1;y++) for(let x=0;x<nx-1;x++) {
    const c=[id(x,y,z),id(x+1,y,z),id(x,y+1,z),id(x+1,y+1,z),id(x,y,z+1),id(x+1,y,z+1),id(x,y+1,z+1),id(x+1,y+1,z+1)];
    maybe(c[0],c[7],1); maybe(c[1],c[6],1); maybe(c[2],c[5],1); maybe(c[3],c[4],1);
  }
}

function colorConstraints(constraints, particleCount) {
  const masks = new Uint32Array(particleCount);
  const groups=[];
  for(const c of constraints) {
    const forbidden=masks[c.a]|masks[c.b]; let color=0;
    while(color<31 && (forbidden & (1<<color))) color++;
    if(color>=31) color=30;
    c.color=color; const bit=(1<<color)>>>0; masks[c.a]|=bit; masks[c.b]|=bit;
    if(!groups[color]) groups[color]=[]; groups[color].push(c);
  }
  return groups.filter(Boolean);
}

function packConstraintGroup(group) {
  // 64 bytes / constraint: vec4<u32> + 3 vec4<f32>
  const stride=64, buffer=new ArrayBuffer(group.length*stride), dv=new DataView(buffer);
  for(let i=0;i<group.length;i++) {
    const c=group[i], o=i*stride;
    dv.setUint32(o,c.a,true); dv.setUint32(o+4,c.b,true); dv.setUint32(o+8,c.active,true); dv.setUint32(o+12,c.kind,true);
    dv.setFloat32(o+16,c.rest,true); dv.setFloat32(o+20,0,true); dv.setFloat32(o+24,0,true); dv.setFloat32(o+28,c.compliance,true);
    dv.setFloat32(o+32,c.yield,true); dv.setFloat32(o+36,c.fracture,true); dv.setFloat32(o+40,c.plasticity,true); dv.setFloat32(o+44,c.toughness,true);
    dv.setFloat32(o+48,0,true); dv.setFloat32(o+52,0,true); dv.setFloat32(o+56,0,true); dv.setFloat32(o+60,0,true);
  }
  return buffer;
}

class WebGPUXPBDSolver {
  constructor() {
    this.device=null; this.adapter=null; this.ready=false; this.particleCount=0; this.constraintGroups=[]; this.latestPositions=null; this.readbacks=[]; this.readbackCursor=0;
    this.lastReadbackAt=0; this.readbackInterval=1/30; this.pendingImpacts=[]; this.gpuName='WebGPU'; this.iterations=4; this.onReadback=null;
  }
  async init(particleArrayBuffer, particleCount, groups) {
    if(!navigator.gpu) throw new Error('当前浏览器没有暴露 WebGPU。请使用新版 Edge/Chrome，或在 WebView2 中使用虚拟 HTTPS 主机/localhost。');
    this.adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!this.adapter) throw new Error('WebGPU adapter 初始化失败。');
    this.device=await this.adapter.requestDevice();
    this.device.lost.then(info=>console.error('WebGPU device lost:',info));
    this.particleCount=particleCount;
    this.initialParticleData=particleArrayBuffer.slice(0);
    this.latestPositions=new Float32Array(particleCount*4);
    try { const info=await this.adapter.requestAdapterInfo?.(); if(info?.description||info?.device) this.gpuName=info.description||info.device; } catch {}
    const d=this.device;
    this.particleBuffer=d.createBuffer({size:particleArrayBuffer.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    d.queue.writeBuffer(this.particleBuffer,0,particleArrayBuffer);
    this.positionOut=d.createBuffer({size:particleCount*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    this.stepUniform=d.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.impactUniform=d.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.constraintGroups=groups.map(group=>{
      const packed=packConstraintGroup(group);
      const buffer=d.createBuffer({size:Math.max(64,packed.byteLength),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      if(packed.byteLength) d.queue.writeBuffer(buffer,0,packed);
      return {buffer,count:group.length,initialData:packed.slice(0)};
    });
    for(let i=0;i<3;i++) this.readbacks.push({buffer:d.createBuffer({size:particleCount*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),state:'free'});
    await this.createPipelines();
    this.ready=true;
  }
  async createPipelines() {
    const d=this.device;
    const common=`
struct Particle { pos: vec4<f32>, prev: vec4<f32>, vel: vec4<f32>, state: vec4<f32> };
struct Constraint { ids: vec4<u32>, data0: vec4<f32>, data1: vec4<f32>, data2: vec4<f32> };
struct Step { dt:f32, gravity:f32, damping:f32, sleepSpeed:f32, sleepDelay:f32, floorFriction:f32, pad0:f32, pad1:f32, extra0:vec4<f32>, extra1:vec4<f32> };
@group(0) @binding(0) var<storage,read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> step: Step;
`;
    const integrateCode=common+`
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid:vec3<u32>){
 let i=gid.x; if(i>=arrayLength(&particles)){return;} var p=particles[i]; if(p.pos.w<=0.0){return;}
 p.prev=vec4<f32>(p.pos.xyz,p.prev.w);
 if(p.state.w>0.5){ particles[i]=p; return; }
 p.vel.y += step.gravity*step.dt;
 p.vel=vec4<f32>(p.vel.xyz*exp(-step.damping*step.dt),p.vel.w);
 p.pos=vec4<f32>(p.pos.xyz+p.vel.xyz*step.dt,p.pos.w);
 particles[i]=p;
}`;
    const finalizeCode=common+`
@group(0) @binding(2) var<storage,read_write> outputPos:array<vec4<f32>>;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid:vec3<u32>){
 let i=gid.x; if(i>=arrayLength(&particles)){return;} var p=particles[i];
 if(p.pos.w>0.0){
   let floorY=p.prev.w;
   if(p.pos.y<floorY){p.pos.y=floorY; if(p.vel.y<0.0){p.vel.y=-p.vel.y*0.12;}p.vel.x*=step.floorFriction; p.vel.z*=step.floorFriction;}
   if(step.dt>0.0){p.vel=vec4<f32>((p.pos.xyz-p.prev.xyz)/step.dt,p.vel.w);}
   let sp=length(p.vel.xyz);
   if(sp<step.sleepSpeed){p.vel.w+=step.dt;}else{p.vel.w=0.0; p.state.w=0.0;}
   if(p.vel.w>step.sleepDelay){p.state.w=1.0; p.vel=vec4<f32>(vec3<f32>(0.0),p.vel.w);}
   p.state.z*=exp(-3.5*step.dt);
   particles[i]=p;
 }
 outputPos[i]=vec4<f32>(p.pos.xyz,1.0);
}`;
    const impactCode=common+`
struct Impact { pos:vec4<f32>, dir:vec4<f32>, params:vec4<f32>, more:vec4<f32> };
@group(0) @binding(2) var<uniform> impact:Impact;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid:vec3<u32>){
 let i=gid.x; if(i>=arrayLength(&particles)){return;} var p=particles[i]; if(p.pos.w<=0.0){return;}
 let bodyId=impact.more.x; if(abs(p.state.x-bodyId)>0.25){return;}
 p.state.w=0.0; p.vel.w=0.0;
 let rel=p.pos.xyz-impact.pos.xyz; let along=dot(rel,impact.dir.xyz); let perp=rel-impact.dir.xyz*along; let r=length(perp);
 let radius=impact.params.x; let depth=impact.params.y;
 if(along>-radius*0.35 && along<depth && r<radius){
   let wr=1.0-smoothstep(radius*0.2,radius,r); let wd=1.0-smoothstep(depth*0.15,depth,max(along,0.0)); let w=wr*wd;
   p.vel=vec4<f32>(p.vel.xyz + impact.dir.xyz*(impact.params.z*w*p.pos.w) + normalize(rel+vec3<f32>(0.0001))*impact.params.z*w*0.13*p.pos.w,p.vel.w);
   p.state.z=max(p.state.z, impact.params.w*w);
 }
 particles[i]=p;
}`;
    const constraintCommon=common+`
@group(0) @binding(2) var<storage,read_write> constraints:array<Constraint>;
`;
    const resetCode=constraintCommon+`
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid:vec3<u32>){let i=gid.x;if(i>=arrayLength(&constraints)){return;}var c=constraints[i];c.data0.y=0.0;constraints[i]=c;}`;
    const solveCode=constraintCommon+`
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid:vec3<u32>){
 let i=gid.x;if(i>=arrayLength(&constraints)){return;}var c=constraints[i];if(c.ids.z==0u){return;}
 let ia=c.ids.x;let ib=c.ids.y;var a=particles[ia];var b=particles[ib];let wa=a.pos.w;let wb=b.pos.w;if(wa+wb<=0.0){return;}
 let d=a.pos.xyz-b.pos.xyz;let len=length(d);if(len<1e-6){return;}let n=d/len;var rest=c.data0.x;let strain=abs(len-rest)/max(rest,1e-5);
 let impact=max(a.state.z,b.state.z);let fracture=c.data1.y;let toughness=max(c.data1.w,0.01);
 if(impact>0.18 && strain>fracture*0.46){
   c.data0.z += step.dt*(max(0.0,strain-fracture*0.42)*7.2 + impact*1.65)/toughness;
   if(c.data0.z>=1.0){c.ids.z=0u;constraints[i]=c;return;}
 }
 if(strain>c.data1.x && strain<fracture){let rate=c.data1.z; rest=mix(rest,len,clamp(rate*step.dt,0.0,0.25));c.data0.x=rest;}
 let C=len-rest;let alpha=c.data0.w/(step.dt*step.dt+1e-8);let dl=(-C-alpha*c.data0.y)/(wa+wb+alpha);c.data0.y+=dl;
 a.pos=vec4<f32>(a.pos.xyz+n*(wa*dl),a.pos.w); b.pos=vec4<f32>(b.pos.xyz-n*(wb*dl),b.pos.w); particles[ia]=a;particles[ib]=b;constraints[i]=c;
}`;
    const compileModule = async (code, label) => {
      const shader = d.createShaderModule({ code, label });
      if (typeof shader.getCompilationInfo === 'function') {
        const info = await shader.getCompilationInfo();
        const errors = info.messages.filter((m) => m.type === 'error');
        if (errors.length) {
          const details = errors.map((m) => {
            const where = m.lineNum ? `${m.lineNum}:${m.linePos || 1}` : '?:?';
            return `${where} ${m.message}`;
          }).join('\n');
          throw new Error(`WGSL 编译失败 [${label}]\n${details}`);
        }
      }
      return shader;
    };
    const make = async (code, label) => {
      const shader = await compileModule(code, label);
      return d.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
    };
    this.integratePipeline=await make(integrateCode,'xpbd-integrate');
    this.finalizePipeline=await make(finalizeCode,'xpbd-finalize');
    this.impactPipeline=await make(impactCode,'xpbd-impact');
    this.resetPipeline=await make(resetCode,'xpbd-reset-lambda');
    this.solvePipeline=await make(solveCode,'xpbd-solve');
    this.particleBind=d.createBindGroup({layout:this.integratePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.particleBuffer}},{binding:1,resource:{buffer:this.stepUniform}}]});
    this.finalBind=d.createBindGroup({layout:this.finalizePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.particleBuffer}},{binding:1,resource:{buffer:this.stepUniform}},{binding:2,resource:{buffer:this.positionOut}}]});
    this.impactBind=d.createBindGroup({layout:this.impactPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.particleBuffer}},{binding:1,resource:{buffer:this.stepUniform}},{binding:2,resource:{buffer:this.impactUniform}}]});
    this.constraintGroups.forEach(g=>{
      g.resetBind=d.createBindGroup({layout:this.resetPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.particleBuffer}},{binding:1,resource:{buffer:this.stepUniform}},{binding:2,resource:{buffer:g.buffer}}]});
      g.solveBind=d.createBindGroup({layout:this.solvePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.particleBuffer}},{binding:1,resource:{buffer:this.stepUniform}},{binding:2,resource:{buffer:g.buffer}}]});
    });
  }
  reset(){
    if(!this.ready) return;
    this.pendingImpacts.length=0;
    this.device.queue.writeBuffer(this.particleBuffer,0,this.initialParticleData);
    for(const g of this.constraintGroups) if(g.initialData?.byteLength) this.device.queue.writeBuffer(g.buffer,0,g.initialData);
    this.latestPositions.fill(0);
  }
  queueImpact(evt){ this.pendingImpacts.push(evt); }
  step(dt, nowSeconds) {
    if(!this.ready) return;
    const d=this.device, step=new Float32Array(16);
    step[0]=clamp(dt,1/240,1/30); step[1]=0.0; step[2]=0.72; step[3]=0.045; step[4]=1.35; step[5]=0.58;
    d.queue.writeBuffer(this.stepUniform,0,step);
    const impact=this.pendingImpacts.shift();
    if(impact){
      const u=new Float32Array(16); u.set([impact.position.x,impact.position.y,impact.position.z,1],0); u.set([impact.direction.x,impact.direction.y,impact.direction.z,0],4);
      u.set([impact.radius,impact.depth,impact.impulse,impact.damage],8); u.set([impact.bodyId,0,0,0],12); d.queue.writeBuffer(this.impactUniform,0,u);
    }
    const enc=d.createCommandEncoder({label:'xpbd-frame'});
    const run=(pipeline,bind,count)=>{if(count<=0)return;const pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil(count/128));pass.end();};
    run(this.integratePipeline,this.particleBind,this.particleCount);
    if(impact) run(this.impactPipeline,this.impactBind,this.particleCount);
    for(const g of this.constraintGroups) run(this.resetPipeline,g.resetBind,g.count);
    for(let it=0;it<this.iterations;it++) for(const g of this.constraintGroups) run(this.solvePipeline,g.solveBind,g.count);
    run(this.finalizePipeline,this.finalBind,this.particleCount);
    let slot=null;
    if(nowSeconds-this.lastReadbackAt>=this.readbackInterval){
      for(let k=0;k<this.readbacks.length;k++){const s=this.readbacks[(this.readbackCursor+k)%this.readbacks.length];if(s.state==='free'){slot=s;this.readbackCursor=(this.readbackCursor+k+1)%this.readbacks.length;break;}}
      if(slot){enc.copyBufferToBuffer(this.positionOut,0,slot.buffer,0,this.particleCount*16);slot.state='submitted';this.lastReadbackAt=nowSeconds;}
    }
    d.queue.submit([enc.finish()]);
    if(slot){
      slot.state='mapping';
      slot.buffer.mapAsync(GPUMapMode.READ).then(()=>{
        const mapped=slot.buffer.getMappedRange(); this.latestPositions.set(new Float32Array(mapped)); slot.buffer.unmap(); slot.state='free'; this.onReadback?.(this.latestPositions);
      }).catch(()=>{try{slot.buffer.unmap();}catch{}slot.state='free';});
    }
  }
}

export class VoxelBody {
  constructor(system, mesh, profileName, options, id) {
    this.system=system; this.mesh=mesh; this.profileName=profileName; this.profile=DAMAGE_PROFILES[profileName]; this.options=options; this.id=id; this.stateId=options.stateId??`body-${id}`;
    const base=XPBD_PROFILES[profileName];
    this.xpbd={...base,fracture:base.fracture*(options.thresholdScale??1),toughness:base.toughness*(options.integrityScale??1)};
    this.label=options.label||this.profile.label; this.destroyed=false; this.hitCount=0; this.totalDamage=0; this.lastImpactTime=-999;
    this.awake=false; this.surfaceUpdateFrames=0; this.topologyDirty=false; this.renderMode='embedded'; this.surfaceRefs=null; this.embedding=null;
    mesh.updateMatrixWorld(true); this.matrixWorld=mesh.matrixWorld.clone(); this.inverseWorld=mesh.matrixWorld.clone().invert();
    const worldBounds = new THREE.Box3().setFromObject(mesh);
    this.restBottomY = worldBounds.min.y;
    this.floorY=options.floorY ?? floorForY(worldBounds.min.y+.04);
    this.supportPlaneY = options.supportPlaneY ?? (options.anchor === 'base' ? (options.floorY ?? this.restBottomY) : this.floorY);
    this.grid=null; this.effectivePhi=null; this.originalMaterial=mesh.material; this.surfaceAppearance=captureMaterialAppearance(mesh.material, profileName); this.restGeometry=mesh.geometry.clone(); this.detachedMask=null; this.initialSolidCount=0;
    this.generatedMaterial=null;
    mesh.userData.destructibleBody=this; mesh.userData.stateId=this.stateId; mesh.userData.noBatch=true;
  }
  buildGrid(globalParticleStart){
    this.grid=makeGridForBody(this.mesh,this.profileName,{...this.options,qualityScale:this.system.qualityScale??1},globalParticleStart);
    this.effectivePhi=new Float32Array(this.grid.count); this.detachedMask=new Uint8Array(this.grid.count); this.initialSolidCount=0;
    for(let i=0;i<this.grid.count;i++)if(this.grid.basePhi[i]>0)this.initialSolidCount++;
    this.refreshEffectivePhi(); this.buildRenderEmbedding(); return this.grid;
  }
  buildRenderEmbedding(){
    const attr=this.mesh.geometry.getAttribute('position'); if(!attr||!this.grid)return;
    const count=attr.count, nodes=new Uint32Array(count*8), weights=new Float32Array(count*8), rest=new Float32Array(count*3);
    const {min,step,nx,ny,nz,particleStart}=this.grid;
    const clampCell=(v,n)=>Math.max(0,Math.min(n-2,v));
    for(let i=0;i<count;i++){
      const x=attr.getX(i),y=attr.getY(i),z=attr.getZ(i); rest[i*3]=x;rest[i*3+1]=y;rest[i*3+2]=z;
      const gx=(x-min.x)/step.x, gy=(y-min.y)/step.y, gz=(z-min.z)/step.z;
      const x0=clampCell(Math.floor(gx),nx),y0=clampCell(Math.floor(gy),ny),z0=clampCell(Math.floor(gz),nz);
      const tx=clamp(gx-x0,0,1),ty=clamp(gy-y0,0,1),tz=clamp(gz-z0,0,1);
      const ids=[this.grid.idx(x0,y0,z0),this.grid.idx(x0+1,y0,z0),this.grid.idx(x0,y0+1,z0),this.grid.idx(x0+1,y0+1,z0),this.grid.idx(x0,y0,z0+1),this.grid.idx(x0+1,y0,z0+1),this.grid.idx(x0,y0+1,z0+1),this.grid.idx(x0+1,y0+1,z0+1)];
      const ws=[(1-tx)*(1-ty)*(1-tz),tx*(1-ty)*(1-tz),(1-tx)*ty*(1-tz),tx*ty*(1-tz),(1-tx)*(1-ty)*tz,tx*(1-ty)*tz,(1-tx)*ty*tz,tx*ty*tz];
      for(let k=0;k<8;k++){nodes[i*8+k]=particleStart+ids[k];weights[i*8+k]=ws[k];}
    }
    this.embedding={nodes,weights,rest,count};
  }
  restoreRestRenderGeometry(){
    const old=this.mesh.geometry; this.mesh.geometry=this.restGeometry.clone(); if(old&&old!==this.mesh.geometry)old.dispose?.();
    if(this.mesh.material!==this.originalMaterial){this.mesh.material?.dispose?.();this.mesh.material=this.originalMaterial;}
    this.generatedMaterial=null; this.renderMode='embedded'; this.surfaceRefs=null; this.mesh.visible=true; this.mesh.castShadow=true;this.mesh.receiveShadow=true;
    this.buildRenderEmbedding();
  }
  refreshEffectivePhi(){for(let i=0;i<this.grid.count;i++)this.effectivePhi[i]=this.detachedMask?.[i]?-this.grid.maxStep*2.0:this.grid.basePhi[i]-this.grid.damage[i];}
  generatedSurfaceMaterial(){
    // Voxel fracture geometry has no stable authored UVs. Preserve the original material's
    // measured base appearance and PBR scalar parameters instead of dropping its map while
    // leaving color=white (the old behavior that made blue glaze turn white after impact).
    return createShardMaterial(this.profileName, this.surfaceAppearance, true);
  }
  buildSurface(){
    this.refreshEffectivePhi(); const solid=this.countSolidNodes();
    if(solid < 8) {
      this.mesh.visible=false; this.renderMode='depleted'; this.awake=false; this.surfaceUpdateFrames=0; this.surfaceRefs=null;
      return true;
    }
    const displayPhi = buildDisplayPhi(this.grid, this.grid.damage, this.detachedMask);
    const top=buildSurfaceTopology(this.grid,displayPhi);
    if(top.positions.length<36||top.indices.length<36) {
      if (solid < Math.max(18, Math.floor(this.initialSolidCount * 0.04))) { this.mesh.visible=false; this.renderMode='depleted'; return true; }
      return false;
    }
    const g=topologyToGeometry(top, this.system.qualityScale >= 1.28 ? 2 : 1, this.grid.sourceBounds);
    if(!g)return false;
    if(!g.boundingSphere||!Number.isFinite(g.boundingSphere.radius)||g.boundingSphere.radius<this.grid.h*.5){g.dispose();return false;}
    const oldGeometry=this.mesh.geometry; this.mesh.geometry=g; if(oldGeometry&&oldGeometry!==g)oldGeometry.dispose?.();
    if(this.mesh.material===this.originalMaterial||!this.generatedMaterial){if(this.mesh.material!==this.originalMaterial)this.mesh.material?.dispose?.();this.generatedMaterial=this.generatedSurfaceMaterial();this.mesh.material=this.generatedMaterial;}
    this.surfaceRefs=top; this.renderMode='voxel'; this.awake=false; this.surfaceUpdateFrames=0;
    this.mesh.castShadow=true;this.mesh.receiveShadow=true;this.mesh.visible=true;this.mesh.userData.destructibleBody=this;
    return true;
  }
  updateEmbeddedSurface(globalPositions,recomputeNormals=true){
    if(!this.embedding||!globalPositions||this.renderMode!=='embedded')return;
    const attr=this.mesh.geometry.getAttribute('position'); if(!attr||attr.count!==this.embedding.count)return;
    const out=attr.array,{nodes,weights,rest,count}=this.embedding;
    this.mesh.updateMatrixWorld(true);this.inverseWorld.copy(this.mesh.matrixWorld).invert();
    const restWorld=new THREE.Vector3(),curWorld=new THREE.Vector3(),delta=new THREE.Vector3(),local=new THREE.Vector3();
    const response=this.profile.response; const maxDisp=Math.max(this.grid.h*(response==='elastic'?2.2:response==='ductile'?1.8:.78), response==='elastic'?.16:response==='ductile'?.12:.055);
    for(let i=0;i<count;i++){
      let wx=0,wy=0,wz=0;
      for(let k=0;k<8;k++){const n=nodes[i*8+k]*4,w=weights[i*8+k];wx+=globalPositions[n]*w;wy+=globalPositions[n+1]*w;wz+=globalPositions[n+2]*w;}
      restWorld.set(rest[i*3],rest[i*3+1],rest[i*3+2]).applyMatrix4(this.matrixWorld);curWorld.set(wx,wy,wz);delta.subVectors(curWorld,restWorld);
      const dl=delta.length();if(dl>maxDisp)delta.multiplyScalar(maxDisp/dl);local.copy(restWorld).add(delta).applyMatrix4(this.inverseWorld);
      out[i*3]=local.x;out[i*3+1]=local.y;out[i*3+2]=local.z;
    }
    attr.needsUpdate=true;if(recomputeNormals)this.mesh.geometry.computeVertexNormals();this.mesh.geometry.computeBoundingBox();this.mesh.geometry.computeBoundingSphere();
    if(this.surfaceUpdateFrames>0)this.surfaceUpdateFrames--;if(this.surfaceUpdateFrames<=0)this.awake=false;
  }
  updateSurface(globalPositions,recomputeNormals=true){
    // The high-resolution authored mesh is embedded in the voxel cage while topology is intact.
    // After a fracture we freeze the freshly rebuilt volumetric surface; this avoids letting
    // detached GPU particles pull the cut boundary into needle-like triangles.
    if(this.renderMode==='embedded')this.updateEmbeddedSurface(globalPositions,recomputeNormals);
  }
  targetDescription(){return `${this.label} · ${this.profile.label} · ${this.renderMode==='embedded'?'高面数原始表面':this.renderMode==='depleted'?'主体已脱离':'高精度体素断裂表面'}`;}
  countSolidNodes(){let n=0;for(let i=0;i<this.grid.count;i++)if(!this.detachedMask[i]&&this.grid.basePhi[i]-this.grid.damage[i]>0)n++;return n;}
  fragmentDilatedNodes(nodes,passes=1){
    let set=new Set(nodes);const {nx,ny,nz}=this.grid;
    for(let pass=0;pass<passes;pass++){
      const next=new Set(set);
      for(const i of set){const z=Math.floor(i/(nx*ny)),rem=i-z*nx*ny,y=Math.floor(rem/nx),x=rem-y*nx;const ns=[];
        if(x>0)ns.push(i-1);if(x+1<nx)ns.push(i+1);if(y>0)ns.push(i-nx);if(y+1<ny)ns.push(i+nx);if(z>0)ns.push(i-nx*ny);if(z+1<nz)ns.push(i+nx*ny);
        for(const ni of ns)if(this.grid.basePhi[ni]>-this.grid.h*.46)next.add(ni);
      }set=next;
    }return [...set];
  }
  detachImpactChunks(worldPoint,worldDir,severity){
    const threshold={glass:.16,ceramic:.34,plaster:.30,concrete:.42,wood:.38,metal:.76,plastic:.62,rubber:2}[this.profileName]??.5;
    if(severity<threshold)return {pieces:0,nodes:0};
    const p=worldPoint.clone().applyMatrix4(this.inverseWorld),dir=transformDirection(worldDir,this.inverseWorld),h=this.grid.h;
    const radius=h*({glass:5.4,ceramic:4.9,plaster:4.5,concrete:4.0,wood:4.2,metal:3.2,plastic:3.5}[this.profileName]??4.0)*(0.72+severity*.48)*(this.options.radiusScale??1);
    const depthMax=h*({glass:4.4,ceramic:4.0,plaster:3.5,concrete:3.0,wood:4.0,metal:2.2,plastic:2.6}[this.profileName]??3.2)*(0.72+severity*.55);
    const ta=new THREE.Vector3();if(Math.abs(dir.y)<.88)ta.crossVectors(dir,UP).normalize();else ta.crossVectors(dir,new THREE.Vector3(1,0,0)).normalize();const tb=new THREE.Vector3().crossVectors(dir,ta).normalize();
    const candidates=[];const lp=new THREE.Vector3(),rel=new THREE.Vector3(),perp=new THREE.Vector3();
    for(let i=0;i<this.grid.count;i++){
      if(this.detachedMask[i]||this.grid.basePhi[i]<=0)continue;const o=i*3;lp.set(this.grid.local[o],this.grid.local[o+1],this.grid.local[o+2]);rel.subVectors(lp,p);const depth=rel.dot(dir);if(depth<-h*.75||depth>depthMax)continue;
      perp.copy(rel).addScaledVector(dir,-depth);const r=perp.length();if(r>radius)continue;const radial=1-smoothstep01(r/radius),axial=1-smoothstep01(Math.max(0,depth)/depthMax);const score=radial*.72+axial*.28+hash01(i*29+this.hitCount*71)*.06;if(score>.24)candidates.push({i,score,angle:Math.atan2(perp.dot(tb),perp.dot(ta))});
    }
    if(candidates.length<5)return {pieces:0,nodes:0};
    const current=this.countSolidNodes(),maxDetach=Math.max(5,Math.min(candidates.length,Math.floor(current*(.045+severity*.095))));
    candidates.sort((a,b)=>b.score-a.score);const chosen=candidates.slice(0,maxDetach);
    let targetPieces=this.profileName==='glass'?Math.round(3+severity*4):this.profileName==='ceramic'?Math.round(2+severity*2):this.profileName==='concrete'?Math.round(1+severity*2):this.profileName==='wood'?Math.round(1+severity*2):Math.round(1+severity*2);
    targetPieces=clamp(targetPieces,1,7);const phase=hash01(this.id*113+this.hitCount*17)*Math.PI*2;const bins=Array.from({length:targetPieces},()=>[]);
    for(const e of chosen){let a=e.angle+phase;while(a<0)a+=Math.PI*2;while(a>=Math.PI*2)a-=Math.PI*2;bins[Math.min(targetPieces-1,Math.floor(a/(Math.PI*2)*targetPieces))].push(e.i);}
    const minNodes=this.profileName==='glass'?4:this.profileName==='ceramic'?6:8;let pieces=0,nodes=0;this.mesh.updateMatrixWorld(true);const worldMatrix=this.mesh.matrixWorld.clone();
    for(const bin of bins){
      const core=largestConnectedSubset(this.grid,bin);if(core.length<minNodes)continue;
      for(const i of core)this.detachedMask[i]=1;nodes+=core.length;
      const meshNodes=this.fragmentDilatedNodes(core,this.profileName==='ceramic'?1:0);const phi=nodesToPositiveField(this.grid,meshNodes);const top=buildSurfaceTopology(this.grid,phi);const geometry=topologyToGeometry(top, this.system.qualityScale >= 1.28 ? 2 : 1, this.grid.sourceBounds);
      if(geometry){
        const persistent = core.length >= Math.max(14, Math.floor(this.initialSolidCount * .055));
        this.system.realFragments?.spawn(this.profileName,geometry,worldMatrix,worldDir,severity,null,{
          floorY:this.supportPlaneY, persistent, generation:0, appearance:this.surfaceAppearance, voxelPayload:{grid:this.grid,nodes:core}
        });pieces++;
      }
    }
    if(nodes>0)this.topologyDirty=true;return {pieces,nodes};
  }
  isSupportNode(i){
    const anchor=this.options.anchor;
    if(!anchor)return false;
    const {nx,ny,nz,step,sourceBounds,local}=this.grid; const o=i*3; const x=local[o],y=local[o+1],z=local[o+2];
    if(anchor==='base') return y <= sourceBounds.min.y + Math.max(step.y*1.65, this.grid.h*1.35);
    if(anchor==='edges') {
      const tx=Math.max(step.x*1.5,.03),ty=Math.max(step.y*1.5,.03),tz=Math.max(step.z*1.5,.03);
      const nearX=(Math.abs(x-sourceBounds.min.x)<tx||Math.abs(x-sourceBounds.max.x)<tx);
      const nearY=(Math.abs(y-sourceBounds.min.y)<ty||Math.abs(y-sourceBounds.max.y)<ty);
      const nearZ=(Math.abs(z-sourceBounds.min.z)<tz||Math.abs(z-sourceBounds.max.z)<tz);
      return (nearX?1:0)+(nearY?1:0)+(nearZ?1:0)>=2;
    }
    return false;
  }
  componentHasSupport(comp){
    if(!this.options.anchor)return false;
    for(const i of comp)if(this.isSupportNode(i))return true;
    return false;
  }
  splitDetachedComponents(worldDir,severity){
    this.refreshEffectivePhi();
    const structuralPhi=buildStructuralPhi(this.grid,this.grid.damage,this.detachedMask,this.effectivePhi);
    const analysis=solidComponents(this.grid,structuralPhi,this.detachedMask);
    if(analysis.components.length===0)return {pieces:0,nodes:0,collapsed:0};
    const anchored=Boolean(this.options.anchor);
    const supportFlags=analysis.components.map(c=>this.componentHasSupport(c));
    // For unanchored decorative bodies preserve the old behaviour: keep the largest component.
    // For anchored bodies, structural support is authoritative; if the base/edge connection is gone,
    // even the largest remaining component becomes a dynamic falling chunk.
    if(!anchored) supportFlags[0]=true;
    const minNodes=this.profileName==='glass'||this.profileName==='ceramic'?5:8;
    const maxPieces=this.profileName==='glass'?7:this.profileName==='ceramic'?6:4;
    let pieces=0,detachedNodes=0,collapsed=0;
    // Any raw-solid node which no longer belongs to the visible/structural field is part of the
    // opened crack gap.  Retire it from future connectivity so a severed body cannot magically
    // reconnect through an invisible sliver on the next hit.
    for(let i=0;i<this.grid.count;i++){
      if(!this.detachedMask[i] && this.effectivePhi[i]>0 && structuralPhi[i]<=0){this.detachedMask[i]=1;detachedNodes++;}
    }
    this.mesh.updateMatrixWorld(true);const worldMatrix=this.mesh.matrixWorld.clone();
    for(let ci=0;ci<analysis.components.length;ci++){
      const comp=analysis.components[ci];
      if(supportFlags[ci])continue;
      for(const i of comp)this.detachedMask[i]=1; detachedNodes+=comp.length;
      if(comp.length<minNodes||pieces>=maxPieces)continue;
      const phi=componentField(this.grid,structuralPhi,comp),top=buildSurfaceTopology(this.grid,phi),geometry=topologyToGeometry(top, this.system.qualityScale >= 1.28 ? 2 : 1, this.grid.sourceBounds);
      if(geometry){
        const collapse = anchored && !supportFlags[ci];
        this.system.realFragments?.spawn(this.profileName,geometry,worldMatrix,worldDir,severity,null,{
          collapse,floorY:this.supportPlaneY,persistent:true,generation:0,appearance:this.surfaceAppearance,voxelPayload:{grid:this.grid,nodes:comp}
        });
        pieces++; if(collapse)collapsed++;
      }
    }
    if(detachedNodes>0)this.topologyDirty=true;
    return {pieces,nodes:detachedNodes,collapsed};
  }
  applyCpuDamage(worldPoint,worldDir,severity,high){
    if(!high||this.xpbd.carve<=0)return {topologyChanged:false,removed:0,ejectedNodes:[]};
    // Ductile materials should normally stay on the high-resolution embedded mesh and dent.
    // Only very high-energy hits are allowed to turn into an actual tear/perforation.
    if(this.profileName==='metal'&&severity<.72)return {topologyChanged:false,removed:0,ejectedNodes:[]};
    if(this.profileName==='plastic'&&severity<.58)return {topologyChanged:false,removed:0,ejectedNodes:[]};
    if(this.profileName==='rubber')return {topologyChanged:false,removed:0,ejectedNodes:[]};
    const p=worldPoint.clone().applyMatrix4(this.inverseWorld),dir=transformDirection(worldDir,this.inverseWorld),h=this.grid.h;
    const bodySize=this.grid.sourceBounds.getSize(new THREE.Vector3()),minDim=Math.max(h*3,Math.min(bodySize.x,bodySize.y,bodySize.z));
    const rawRadius=h*(1.7+severity*3.6)*this.xpbd.crater*(this.options.radiusScale??1),radius=Math.min(rawRadius,Math.max(h*2.0,minDim*(this.grid.shape==='vase'?.62:.50)));
    const maxDepth=Math.min(h*(1.25+severity*5.4)*this.xpbd.depth,Math.max(h*1.7,bodySize.length()*.48));const currentSolid=this.countSolidNodes();let changed=0,maxCarve=0;const touched=[];
    const tangentA=new THREE.Vector3();if(Math.abs(dir.y)<.88)tangentA.crossVectors(dir,UP).normalize();else tangentA.crossVectors(dir,new THREE.Vector3(1,0,0)).normalize();const tangentB=new THREE.Vector3().crossVectors(dir,tangentA).normalize();const crackDirs=[];
    for(let k=0;k<this.xpbd.cracks;k++){const a=(k/Math.max(1,this.xpbd.cracks))*Math.PI*2+(hash01(this.id*19+k+this.hitCount*31)*.34-.17);crackDirs.push(tangentA.clone().multiplyScalar(Math.cos(a)).addScaledVector(tangentB,Math.sin(a)).normalize());}
    const lp=new THREE.Vector3(),rel=new THREE.Vector3(),perp=new THREE.Vector3();
    for(let i=0;i<this.grid.count;i++){
      if(this.detachedMask[i])continue;const o=i*3;lp.set(this.grid.local[o],this.grid.local[o+1],this.grid.local[o+2]);rel.subVectors(lp,p);const depth=rel.dot(dir);if(depth<-h*.65||depth>maxDepth)continue;perp.copy(rel).addScaledVector(dir,-depth);const r=perp.length();if(r>radius*1.16)continue;
      let w=(1-smoothstep01(r/radius))*(1-smoothstep01(Math.max(0,depth)/maxDepth));
      if(crackDirs.length&&depth<h*(2.4+severity*1.7)&&r>h*.65){const pn=perp.lengthSq()>EPS?perp.clone().normalize():tangentA;let best=10;for(const cd of crackDirs)best=Math.min(best,Math.acos(clamp(pn.dot(cd),-1,1)));const crackWidth=.055+.055*severity;if(best<crackWidth)w=Math.max(w,(1-best/crackWidth)*(.48+severity*.22)*(1-smoothstep01(r/(radius*1.42))));}
      let carve=h*this.xpbd.carve*(.48+severity*4.2)*w;
      if(this.grid.shape==='vase'&&this.options.thickness){const wall=this.options.thickness;const capFactor=severity<.62?(.16+severity*.52):(.50+(severity-.62)*1.30);carve=Math.min(carve,wall*capFactor);}
      if(carve<=0)continue;const old=this.grid.damage[i],proposed=Math.max(old,carve);if(proposed>old+h*.035)touched.push([i,old,proposed]);this.grid.damage[i]=proposed;
    }
    const retainFraction=lerp(.94,.72,severity),minAfter=Math.max(12,Math.floor(currentSolid*retainFraction));let after=this.countSolidNodes();
    if(after<minAfter&&touched.length){let lo=0,hi=1,best=0;for(let it=0;it<8;it++){const f=(lo+hi)*.5;for(const [i,old,proposed] of touched)this.grid.damage[i]=old+(proposed-old)*f;const n=this.countSolidNodes();if(n>=minAfter){best=f;lo=f;}else hi=f;}for(const [i,old,proposed] of touched)this.grid.damage[i]=old+(proposed-old)*best;after=this.countSolidNodes();}
    const ejectedNodes=[];for(const [i,old] of touched){if(this.grid.damage[i]>old+h*.035){changed++;maxCarve=Math.max(maxCarve,this.grid.damage[i]);if(this.grid.basePhi[i]-old>0&&this.grid.basePhi[i]-this.grid.damage[i]<=0)ejectedNodes.push(i);}}
    if(changed){this.topologyDirty=true;this.totalDamage+=changed/this.grid.count;}return {topologyChanged:changed>0,removed:Math.max(0,currentSolid-after),maxCarve,ejectedNodes};
  }
  impact(worldPoint,worldDir,speed,high,charge){
    this.hitCount++;this.awake=true;this.surfaceUpdateFrames=high?18:75;const severity=clamp((speed-(high?28:8))/(high?120:25),0,1);
    if(!high){
      const radius=this.grid.h*(1.7+severity*1.6)*(this.options.radiusScale??1),depth=this.grid.h*(1.4+severity*1.2),impulse=.52*(.55+severity*1.15)/this.xpbd.density;
      this.system.solver?.queueImpact({bodyId:this.id,position:worldPoint.clone(),direction:worldDir.clone().normalize(),radius,depth,impulse,damage:0.04});
      return {fractured:false,destroyed:false,severity,crater:0,realFragments:0,detachedNodes:0,ejectedNodes:0};
    }
    const response=this.applyCpuDamage(worldPoint,worldDir,severity,true);const chunks=this.detachImpactChunks(worldPoint,worldDir,severity);const split=this.splitDetachedComponents(worldDir,severity);
    let rebuilt=false;if(this.topologyDirty){this.topologyDirty=false;rebuilt=this.buildSurface();}
    const radius=this.grid.h*(2.1+severity*3.9)*(this.options.radiusScale??1),depth=this.grid.h*(1.8+severity*5.2),impulse=2.6*(.65+severity*1.65)/this.xpbd.density;
    const fractureArmed=response.topologyChanged||chunks.nodes>0||split.nodes>0;
    const damage=fractureArmed?clamp(.24+severity*.82,.24,1.05):.12;
    this.system.solver?.queueImpact({bodyId:this.id,position:worldPoint.clone(),direction:worldDir.clone().normalize(),radius,depth,impulse,damage});
    const realFragments=chunks.pieces+split.pieces;const chipCount=(response.topologyChanged||realFragments)?Math.max(0,Math.round(1+severity*(this.profileName==='glass'?5:this.profileName==='ceramic'?3:2)-realFragments)):0;
    if(chipCount)this.system.activeShards.spawn(this.profileName,worldPoint,worldDir,chipCount,Math.max(.022,this.grid.h*.42),.8+severity*2.0,this.surfaceAppearance);if(high)this.system.dust.spawn(worldPoint,worldDir,Math.round((this.profile.dust||2)*(.18+severity*.5)));
    return {fractured:rebuilt||realFragments>0,destroyed:false,severity,crater:response.removed,realFragments,detachedNodes:chunks.nodes+split.nodes,ejectedNodes:response.ejectedNodes.length};
  }
  reset(){
    this.grid.damage.fill(0);this.detachedMask?.fill(0);this.totalDamage=0;this.hitCount=0;this.destroyed=false;this.awake=false;this.surfaceUpdateFrames=0;this.topologyDirty=false;this.restoreRestRenderGeometry();
  }
}

function buildParticleBuffer(bodies) {
  let count=0; for(const b of bodies)count+=b.grid.count;
  const stride=64, ab=new ArrayBuffer(count*stride), dv=new DataView(ab), worldPositions=new Float32Array(count*3); let global=0;
  const temp=new THREE.Vector3();
  for(const body of bodies){
    body.grid.particleStart=global; const g=body.grid;
    for(let i=0;i<g.count;i++){
      const o=i*3; temp.set(g.local[o],g.local[o+1],g.local[o+2]).applyMatrix4(body.matrixWorld); const pi=global+i, base=pi*stride;
      worldPositions[pi*3]=temp.x;worldPositions[pi*3+1]=temp.y;worldPositions[pi*3+2]=temp.z;
      let invMass=g.active[i]?1/body.xpbd.density:0;
      if(invMass>0 && body.options.anchor==='edges'){
        const lx=g.local[o], ly=g.local[o+1], lz=g.local[o+2], b=g.sourceBounds;
        const tx=Math.max(g.step.x*1.4,0.025), ty=Math.max(g.step.y*1.4,0.025), tz=Math.max(g.step.z*1.4,0.025);
        const nearX=(Math.abs(lx-b.min.x)<tx||Math.abs(lx-b.max.x)<tx);
        const nearY=(Math.abs(ly-b.min.y)<ty||Math.abs(ly-b.max.y)<ty);
        const nearZ=(Math.abs(lz-b.min.z)<tz||Math.abs(lz-b.max.z)<tz);
        if((nearX?1:0)+(nearY?1:0)+(nearZ?1:0)>=2) invMass=0;
      }
      if(invMass>0 && body.options.anchor==='base'){
        const ly=g.local[o], b=g.sourceBounds;
        if(ly <= b.min.y + Math.max(g.step.y*1.25,0.035)) invMass=0;
      }
      dv.setFloat32(base,temp.x,true);dv.setFloat32(base+4,temp.y,true);dv.setFloat32(base+8,temp.z,true);dv.setFloat32(base+12,invMass,true);
      dv.setFloat32(base+16,temp.x,true);dv.setFloat32(base+20,temp.y,true);dv.setFloat32(base+24,temp.z,true);dv.setFloat32(base+28,body.floorY,true);
      dv.setFloat32(base+32,0,true);dv.setFloat32(base+36,0,true);dv.setFloat32(base+40,0,true);dv.setFloat32(base+44,0,true);
      dv.setFloat32(base+48,body.id,true);dv.setFloat32(base+52,materialId(body.profileName),true);dv.setFloat32(base+56,0,true);dv.setFloat32(base+60,1,true);
    }
    global+=g.count;
  }
  return {ab,count,worldPositions};
}

export class VoxelXPBDSystem {
  constructor(scene,camera,options={}){
    this.scene=scene;this.camera=camera;this.options=options;this.qualityScale=clamp(options.qualityScale??1.22,.85,1.55);this.bodies=[];this.bodiesByStateId=new Map();this.bodyMeshes=[];this.staticColliders=[];this.solver=null;this.initialized=false;this.initializing=false;this.initError=null;
    this.rigidWorld=new RigidShapeWorld({gravity:-9.81,solverIterations:4,maxSubsteps:5});this.rigidWorld.setStaticBoxes([],true);
    this.projectileTypeIndex=0;this.projectiles=[];this.maxProjectiles=options.maxProjectiles??32;
    this.projectileResources={
      sphere:{geometry:new THREE.SphereGeometry(.088,24,16),material:new THREE.MeshPhysicalMaterial({color:0xffb257,roughness:.18,metalness:.48,clearcoat:.12,clearcoatRoughness:.25,emissive:0x3c1605,emissiveIntensity:.32})},
      disc:{geometry:new THREE.CylinderGeometry(.16,.16,.052,36,2),material:new THREE.MeshPhysicalMaterial({color:0xe6eef2,roughness:.22,metalness:.76,anisotropy:.68,anisotropyRotation:Math.PI*.5})},
      mud:{geometry:new THREE.SphereGeometry(.115,24,16),material:new THREE.MeshPhysicalMaterial({color:0x60402d,roughness:.30,metalness:0,clearcoat:.20,clearcoatRoughness:.16})},
      bomb:{geometry:new THREE.SphereGeometry(.13,22,14),material:new THREE.MeshPhysicalMaterial({color:0x25282b,roughness:.36,metalness:.78,emissive:0xff5a18,emissiveIntensity:.18,clearcoat:.08})},
    };
    this.raycaster=new THREE.Raycaster();this.debris=new DebrisPool(scene,options.sleepingDebrisPerMaterial??360);this.activeShards=new ActiveShardSystem(scene,this.debris,Math.max(40,Math.floor((options.maxActiveFragments??140)*.6)));this.activeShards.system=this;this.staticFragmentMerger=new StaticFragmentMerger(scene,options.maxMergedFragmentVertices??240000);this.realFragments=new RealFragmentSystem(scene,this.staticFragmentMerger,options.maxRealFragments??84);this.realFragments.system=this;this.dust=new DustSystem(scene,options.maxDust??2600);this.audio=new ImpactAudio();this.mud=new MudSystem(scene,this,44);
    this.terrain=null;this.explosions=[];this.latestPositions=null;this.surfaceFrame=0;this.positionVersion=0;this.appliedPositionVersion=-1;this.stats={particles:0,constraints:0,colors:0,projectiles:0,activeFragments:0,realFragments:0,sleepingInteractive:0,mergedFragments:0,debris:0,dust:0,rigidBodies:0,gpu:'initializing'};
  }
  enableAudio(){this.audio.enable();}
  getProjectileType(){return PROJECTILE_TYPES[this.projectileTypeIndex]??PROJECTILE_TYPES[0];}
  cycleProjectile(step=1){this.projectileTypeIndex=(this.projectileTypeIndex+(step>=0?1:-1)+PROJECTILE_TYPES.length)%PROJECTILE_TYPES.length;return this.getProjectileType();}
  setProjectileType(id){const i=PROJECTILE_TYPES.findIndex((p)=>p.id===id);if(i>=0)this.projectileTypeIndex=i;return this.getProjectileType();}
  setStaticColliders(colliders=[]){
    this.staticColliders=colliders.filter((c)=>c?.box&&!c.body).map((c)=>({mesh:c.mesh,box:c.box.clone()}));
    this.rigidWorld.setStaticBoxes(this.staticColliders,true);
  }
  setTerrain(terrain){this.terrain=terrain||null;this.rigidWorld.setHeightfield(this.terrain);}
  register(mesh,profileName,options={}){
    if(this.initialized||this.initializing) throw new Error('VoxelXPBDSystem.register() must be called before initialize().');
    const body=new VoxelBody(this,mesh,profileName,options,this.bodies.length+1);
    if(this.bodiesByStateId.has(body.stateId))throw new Error(`Duplicate destructible state id: ${body.stateId}`);
    this.bodies.push(body);this.bodiesByStateId.set(body.stateId,body);this.bodyMeshes.push(mesh);return body;
  }
  async initialize({cpuOnly=false}={}){
    if(this.initialized||this.initializing)return;this.initializing=true;
    try{
      let start=0; for(const body of this.bodies){const g=body.buildGrid(start);start+=g.count;}
      const particles=buildParticleBuffer(this.bodies);
      const constraints=[]; for(const body of this.bodies) buildConstraintsForGrid(body.grid,particles.worldPositions,body.xpbd,constraints);
      const groups=colorConstraints(constraints,particles.count);
      if(!cpuOnly){this.solver=new WebGPUXPBDSolver();this.solver.onReadback=(positions)=>{this.latestPositions=positions;this.positionVersion++;};await this.solver.init(particles.ab,particles.count,groups);}
      this.stats.particles=particles.count;this.stats.constraints=constraints.length;this.stats.colors=groups.length;this.stats.gpu=cpuOnly?'CPU visual preview':this.solver.gpuName;this.initialized=true;
    }catch(err){this.initError=err;throw err;}finally{this.initializing=false;}
  }
  raycastTargets(){return this.bodyMeshes.concat(this.realFragments.colliderMeshes(),this.mud.colliderMeshes());}
  raycastFromCamera(maxDistance=60){
    this.raycaster.setFromCamera(new THREE.Vector2(0,0),this.camera);this.raycaster.far=maxDistance;
    const hits=this.raycaster.intersectObjects(this.raycastTargets(),false);
    return hits.find(h=>h.object.userData?.destructibleBody||h.object.userData?.realFragmentItem||h.object.userData?.mudPatchItem)||null;
  }
  shoot(){
    const config=this.getProjectileType(),cameraDir=new THREE.Vector3(0,0,-1).applyQuaternion(this.camera.quaternion).normalize();
    const res=this.projectileResources[config.id];const mesh=new THREE.Mesh(res.geometry,res.material);mesh.castShadow=true;mesh.receiveShadow=true;
    mesh.position.copy(this.camera.position).addScaledVector(cameraDir,.58);
    let velocity=cameraDir.clone().multiplyScalar(config.speed), angularVelocity=new THREE.Vector3(randRange(-2,2),randRange(-2,2),randRange(-2,2));
    if(config.id==='disc'){
      // Frisbee orientation: the platter stays approximately horizontal; its normal points mostly
      // upward with a small nose-up component instead of facing the direction of travel like a coin.
      const horizontal=new THREE.Vector3(cameraDir.x,0,cameraDir.z); if(horizontal.lengthSq()<EPS)horizontal.set(0,0,-1); else horizontal.normalize();
      const normal=UP.clone().addScaledVector(horizontal,0.10).normalize(); mesh.quaternion.setFromUnitVectors(UP,normal);
      velocity=cameraDir.clone().multiplyScalar(config.speed).addScaledVector(UP,1.15); angularVelocity=normal.multiplyScalar(48);
    }else if(config.bomb){
      // Hand-thrown arc: preserve horizontal aim, add a fixed upward component. Gravity in the
      // rigid solver generates the parabola.
      const horizontal=new THREE.Vector3(cameraDir.x,0,cameraDir.z); if(horizontal.lengthSq()<EPS)horizontal.set(0,0,-1); else horizontal.normalize();
      velocity=horizontal.multiplyScalar(config.speed).addScaledVector(UP,8.8+cameraDir.y*5.0);
      angularVelocity.set(randRange(-3.5,3.5),randRange(-3.5,3.5),randRange(-3.5,3.5));
    }
    this.scene.add(mesh);
    const shape=config.shape==='sphere'?{type:'sphere',radius:config.radius}:{type:'box',halfExtents:new THREE.Vector3(...config.half)};
    const rigid=this.rigidWorld.addBody({mesh,shape,mass:config.mass,velocity,angularVelocity,friction:config.mud?.88:config.bomb?.72:.52,restitution:config.mud?.02:config.bomb?.12:.28,linearDamping:config.mud?.18:config.id==='disc'?.012:.018,angularDamping:config.id==='disc'?.025:.08,dynamicPairs:true,tag:`projectile:${config.id}`});
    const p={config,mesh,rigid,previous:rigid.position.clone(),age:0};this.projectiles.push(p);
    while(this.projectiles.length>this.maxProjectiles){const old=this.projectiles.shift();this.removeProjectile(old);}
    this.options.onShot?.({type:config.id,label:config.label,speed:config.speed});return p;
  }
  removeProjectile(p){if(!p)return;this.rigidWorld.removeBody(p.rigid);this.scene.remove(p.mesh);}
  prepareProjectiles(){for(const p of this.projectiles)p.previous.copy(p.rigid.position);}
  hitWorldNormal(hit, fallbackDir){
    if(hit.normal?.isVector3)return hit.normal.clone().normalize();
    if(hit.face?.normal){const n=hit.face.normal.clone();const nm=new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);return n.applyMatrix3(nm).normalize();}
    return fallbackDir.clone().multiplyScalar(-1).normalize();
  }
  handleProjectileHit(p,hit){
    const config=p.config,dir=p.rigid.velocity.lengthSq()>EPS?p.rigid.velocity.clone().normalize():new THREE.Vector3(0,0,-1).applyQuaternion(this.camera.quaternion).normalize(),speed=p.rigid.velocity.length();
    const normal=this.hitWorldNormal(hit,dir),mudItem=hit.object.userData?.mudPatchItem,fragmentItem=hit.object.userData?.realFragmentItem,body=hit.object.userData?.destructibleBody;
    let result=null,targetInfo=null;
    if(config.mud){
      if(mudItem) result=this.mud.absorb(mudItem,speed);
      else { const patch=this.mud.splat(hit.object,hit.point,normal,speed);result={fractured:false,severity:.12,realFragments:0,mud:true,stuck:Boolean(patch)}; }
      targetInfo={profileName:'ceramic',label:'泥巴附着'};
    }else if(mudItem){
      result=this.mud.impact(mudItem,hit.point,dir,speed*config.damageScale);targetInfo={profileName:'ceramic',label:'硬化泥巴'};
    }else if(fragmentItem){
      result=this.realFragments.impact(fragmentItem,hit.point,dir,speed*config.damageScale);targetInfo={profileName:fragmentItem.profileName,label:`${DAMAGE_PROFILES[fragmentItem.profileName]?.label??'材料'}坠落块`};
      this.audio.hit(fragmentItem.profileName,result.severity);
    }else if(body){
      result=body.impact(hit.point,dir,speed*config.damageScale,true,1);targetInfo=body;this.audio.hit(body.profileName,result.severity);
      this.options.onMutation?.({kind:'impact',payload:{bodyId:body.stateId,point:hit.point.toArray(),direction:dir.toArray(),speed:speed*config.damageScale}});
    }
    if(result)this.options.onImpact?.({body:targetInfo,result,projectile:config});
  }
  spawnExplosionFx(point){
    const geo=new THREE.SphereGeometry(1,14,9),mat=new THREE.MeshBasicMaterial({color:0xff9a3b,transparent:true,opacity:.78,blending:THREE.AdditiveBlending,depthWrite:false});
    const mesh=new THREE.Mesh(geo,mat);mesh.position.copy(point);mesh.scale.setScalar(.28);this.scene.add(mesh);
    const light=new THREE.PointLight(0xff7a30,620,16,2);light.position.copy(point);this.scene.add(light);
    this.explosions.push({mesh,light,age:0});
  }
  updateExplosions(dt){
    const keep=[];for(const e of this.explosions){e.age+=dt;const t=e.age/.42;if(t>=1){this.scene.remove(e.mesh,e.light);e.mesh.geometry.dispose();e.mesh.material.dispose();continue;}e.mesh.scale.setScalar(.28+5.0*t);e.mesh.material.opacity=(1-t)*.78;e.light.intensity=620*(1-t)*(1-t);keep.push(e);}this.explosions=keep;
  }
  explodeBomb(p,point){
    const cfg=p.config,r=cfg.blastRadius??6.2;this.spawnExplosionFx(point);this.dust.spawn(point,UP,42);
    if(this.terrain?.contains?.(point.x,point.z)) this.terrain.crater(point,cfg.craterRadius??6.6,cfg.craterDepth??2.8);
    let primary=null;
    const center=new THREE.Vector3(),box=new THREE.Box3(),hitPoint=new THREE.Vector3();
    for(const body of this.bodies){
      if(body.destroyed||body.renderMode==='depleted')continue;body.mesh.updateMatrixWorld(true);box.setFromObject(body.mesh);box.getCenter(center);const dist=center.distanceTo(point);if(dist>r)continue;
      box.clampPoint(point,hitPoint);const dir=center.clone().sub(point);if(dir.lengthSq()<EPS)dir.copy(UP);else dir.normalize();
      const strength=clamp(1-dist/r,.12,1),result=body.impact(hitPoint,dir,72+105*strength,true,1);
      if(!primary&&result)primary={body,result};
    }
    for(const item of [...this.realFragments.items]){
      const wp=new THREE.Vector3();item.mesh.getWorldPosition(wp);const dist=wp.distanceTo(point);if(dist>r)continue;const dir=wp.clone().sub(point);if(dir.lengthSq()<EPS)dir.copy(UP);else dir.normalize();this.realFragments.impact(item,wp,dir,75+90*(1-dist/r));
    }
    for(const b of this.rigidWorld.bodies){if(b===p.rigid||b.staticBody)continue;const d=b.position.distanceTo(point);if(d>r)continue;const dir=b.position.clone().sub(point);if(dir.lengthSq()<EPS)dir.copy(UP);else dir.normalize();const impulse=(1-d/r)*18/Math.max(.16,b.mass);b.velocity.addScaledVector(dir,impulse);b.velocity.y+=impulse*.35;this.rigidWorld.wake(b);}
    const reported = primary?.result ? {...primary.result, explosion:true} : {fractured:true,severity:1,realFragments:0,explosion:true};
    this.options.onImpact?.({body:primary?.body??{label:'地形'},result:reported,projectile:cfg});
    this.options.onMutation?.({kind:'blast',payload:{point:point.toArray(),blastRadius:r,craterRadius:cfg.craterRadius??6.6,craterDepth:cfg.craterDepth??2.8}});
  }
  applySharedMutation(event){
    const payload=event?.payload;
    if(event?.kind==='impact'&&payload&&Array.isArray(payload.point)&&Array.isArray(payload.direction)){
      const body=this.bodiesByStateId.get(payload.bodyId);if(!body||body.destroyed||body.renderMode==='depleted')return false;
      const point=new THREE.Vector3(...payload.point),direction=new THREE.Vector3(...payload.direction);if(direction.lengthSq()<EPS)direction.copy(UP);else direction.normalize();
      body.impact(point,direction,clamp(Number(payload.speed)||0,0,260),true,1);return true;
    }
    if(event?.kind==='blast'&&payload&&Array.isArray(payload.point)){
      const point=new THREE.Vector3(...payload.point),radius=clamp(Number(payload.blastRadius)||6.2,1,18);
      this.spawnExplosionFx(point);this.dust.spawn(point,UP,24);
      this.terrain?.crater?.(point,clamp(Number(payload.craterRadius)||6.6,.5,18),clamp(Number(payload.craterDepth)||2.8,.1,9),event.id||event.eventId||'');
      const center=new THREE.Vector3(),box=new THREE.Box3(),hitPoint=new THREE.Vector3();
      for(const body of this.bodies){
        if(body.destroyed||body.renderMode==='depleted')continue;body.mesh.updateMatrixWorld(true);box.setFromObject(body.mesh);box.getCenter(center);const distance=center.distanceTo(point);if(distance>radius)continue;
        box.clampPoint(point,hitPoint);const direction=center.clone().sub(point);if(direction.lengthSq()<EPS)direction.copy(UP);else direction.normalize();const strength=clamp(1-distance/radius,.12,1);
        body.impact(hitPoint,direction,72+105*strength,true,1);
      }
      return true;
    }
    return false;
  }
  updateProjectiles(dt){
    const keep=[],seg=new THREE.Vector3();
    for(const p of this.projectiles){
      p.age+=dt;
      if(p.config.id==='disc'&&!p.rigid.sleeping){
        // Cheap aerodynamic lift: enough to read visually as a frisbee while keeping the same
        // rigid-body contact path. Lift fades automatically as horizontal speed is lost.
        const hs=Math.hypot(p.rigid.velocity.x,p.rigid.velocity.z);p.rigid.velocity.y+=clamp(hs*.022,0,.95)*dt;
      }
      seg.subVectors(p.rigid.position,p.previous);const len=seg.length();let hit=null;
      if(len>EPS){this.raycaster.set(p.previous,seg.clone().normalize());this.raycaster.far=len+p.rigid.boundingRadius*.72;const hits=this.raycaster.intersectObjects(this.raycastTargets(),false);hit=hits.find(h=>h.object.userData?.destructibleBody||h.object.userData?.realFragmentItem||h.object.userData?.mudPatchItem);}
      if(p.config.mud&&!hit&&this.terrain?.mesh&&this.terrain.contains?.(p.rigid.position.x,p.rigid.position.z)){
        const terrainH=this.terrain.heightAt?.(p.rigid.position.x,p.rigid.position.z);
        if(terrainH!=null&&p.rigid.position.y-p.rigid.boundingRadius<=terrainH+0.045){
          hit={object:this.terrain.mesh,point:new THREE.Vector3(p.rigid.position.x,terrainH,p.rigid.position.z),normal:this.terrain.normalAt?.(p.rigid.position.x,p.rigid.position.z,new THREE.Vector3())??UP.clone()};
        }
      }
      if(p.config.bomb){
        const terrainH=this.terrain?.heightAt?.(p.rigid.position.x,p.rigid.position.z);
        const terrainTouch=terrainH!=null && p.rigid.position.y-p.rigid.boundingRadius<=terrainH+0.08;
        if(hit||p.rigid.contactCount>0||terrainTouch||p.age>(p.config.fuse??2.6)){
          const point=hit?.point?.clone?.()??p.rigid.position.clone();
          if(terrainTouch && !hit) point.y=terrainH;
          this.explodeBomb(p,point);this.removeProjectile(p);continue;
        }
        if(p.age<6&&p.rigid.position.length()<320)keep.push(p);else this.removeProjectile(p);continue;
      }
      if(hit){this.handleProjectileHit(p,hit);this.removeProjectile(p);continue;}
      if(p.age<5&&!p.rigid.sleeping&&p.rigid.position.length()<260&&p.rigid.velocity.length()>0.45)keep.push(p);else this.removeProjectile(p);
    }
    this.projectiles=keep;
  }
  update(dt,elapsed){
    this.prepareProjectiles();
    this.rigidWorld.step(dt);
    this.updateProjectiles(dt);this.activeShards.update(dt);this.realFragments.update(dt);this.mud.update(dt);this.dust.update(dt);this.updateExplosions(dt);
    if(this.initialized&&this.solver){
      this.solver.step(dt,elapsed);
      if(this.latestPositions&&this.appliedPositionVersion!==this.positionVersion){this.appliedPositionVersion=this.positionVersion;this.surfaceFrame++;const normals=this.surfaceFrame%2===0;for(const body of this.bodies){if(body.awake)body.updateSurface(this.latestPositions,normals);}}
    }
    const rs=this.rigidWorld.stats();this.stats.projectiles=this.projectiles.length;this.stats.activeFragments=this.activeShards.count;this.stats.realFragments=this.realFragments.count;this.stats.sleepingInteractive=this.realFragments.sleepingInteractiveCount;this.stats.mergedFragments=this.staticFragmentMerger.totalPieces;this.stats.debris=this.debris.total;this.stats.dust=this.dust.active;this.stats.rigidBodies=rs.dynamic;
  }
  reset(){
    for(const p of this.projectiles)this.removeProjectile(p);this.projectiles=[];for(const e of this.explosions){this.scene.remove(e.mesh,e.light);e.mesh.geometry.dispose();e.mesh.material.dispose();}this.explosions=[];this.activeShards.reset();this.realFragments.reset();this.mud.reset();this.debris.reset();this.dust.reset();this.rigidWorld.bodies.length=0;this.terrain?.reset?.();this.solver?.reset();this.latestPositions=null;this.positionVersion=0;this.appliedPositionVersion=-1;for(const body of this.bodies)body.reset();
  }
  getStats(){return {...this.stats};}
}
