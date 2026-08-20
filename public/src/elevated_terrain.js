import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';

const DEFAULTS = Object.freeze({
  chunkSize: 64,
  viewRadius: 4,
  nearSegments: 64,
  midSegments: 32,
  farSegments: 16,
  skirtDepth: 12,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};
const smoothRange = (edge0, edge1, value) => smooth01((value - edge0) / (edge1 - edge0));
const fract = (value) => value - Math.floor(value);

function hash2(x, z, seed = 0) {
  return fract(Math.sin(x * 127.1 + z * 311.7 + seed * 74.7) * 43758.5453123);
}

function valueNoise(x, z, seed = 0) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz) * 2 - 1;
}

function fbm(x, z, seed = 0, octaves = 6) {
  let amplitude = 0.55, frequency = 1, total = 0, normalizer = 0;
  for (let octave = 0; octave < octaves; octave++) {
    total += valueNoise(x * frequency, z * frequency, seed + octave * 17) * amplitude;
    normalizer += amplitude;
    frequency *= 2.03;
    amplitude *= 0.51;
  }
  return total / normalizer;
}

function ridgedFbm(x, z, seed = 0, octaves = 7) {
  let amplitude = 0.58, frequency = 1, total = 0, normalizer = 0, previous = 1;
  for (let octave = 0; octave < octaves; octave++) {
    let ridge = 1 - Math.abs(valueNoise(x * frequency, z * frequency, seed + octave * 19));
    ridge *= ridge;
    ridge *= 0.56 + previous * 0.44;
    total += ridge * amplitude;
    normalizer += amplitude;
    previous = ridge;
    frequency *= 2.04;
    amplitude *= 0.53;
  }
  return total / normalizer;
}

function chunkKey(x, z) {
  return `${x}:${z}`;
}

function boxDistance(x, z, halfX, halfZ) {
  const dx = Math.max(Math.abs(x) - halfX, 0);
  const dz = Math.max(Math.abs(z) - halfZ, 0);
  return Math.hypot(dx, dz);
}

export class InfiniteTerrain {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.options = { ...DEFAULTS, ...options };
    this.chunkSize = this.options.chunkSize;
    this.viewRadius = this.options.viewRadius;
    this.chunks = new Map();
    this.pendingChunks = [];
    this.cratersByChunk = new Map();
    this.craterIds = new Set();
    this.lastCenterX = Number.NaN;
    this.lastCenterZ = Number.NaN;

    this.mesh = new THREE.Group();
    this.mesh.name = 'InfiniteTerrainChunks';
    this.mesh.userData.terrain = true;
    this.scene.add(this.mesh);

    this.materials = [0, 1, 2].map((lod) => {
      const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: lod === 0 ? 0.84 : 0.9,
      metalness: 0.01,
      envMapIntensity: lod === 0 ? 0.82 : 0.58,
      flatShading: false,
      });
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainWorldPosition;')
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTerrainWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
varying vec3 vTerrainWorldPosition;
float terrainHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float terrainGrain(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(terrainHash(i), terrainHash(i + vec2(1.0, 0.0)), f.x), mix(terrainHash(i + vec2(0.0, 1.0)), terrainHash(i + vec2(1.0)), f.x), f.y);
}`)
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
float terrainBump = terrainGrain(vTerrainWorldPosition.xz * 0.36) * 0.74 + terrainGrain(vTerrainWorldPosition.xz * 1.10) * 0.26;
vec3 terrainSigmaX = dFdx(vTerrainWorldPosition);
vec3 terrainSigmaY = dFdy(vTerrainWorldPosition);
vec3 terrainR1 = cross(terrainSigmaY, normal);
vec3 terrainR2 = cross(normal, terrainSigmaX);
float terrainDet = dot(terrainSigmaX, terrainR1);
vec3 terrainGradient = sign(terrainDet) * (dFdx(terrainBump) * terrainR1 + dFdy(terrainBump) * terrainR2);
normal = normalize(abs(terrainDet) * normal - terrainGradient * ${lod === 0 ? '0.34' : lod === 1 ? '0.22' : '0.12'});`)
          .replace('#include <color_fragment>', `#include <color_fragment>
float terrainFine = terrainGrain(vTerrainWorldPosition.xz * 0.33) * 0.075 + terrainGrain(vTerrainWorldPosition.xz * 1.45) * 0.025;
diffuseColor.rgb *= 0.955 + terrainFine;`);
      };
      material.customProgramCacheKey = () => 'alpine-terrain-v2';
      return material;
    });
    this.palette = {
      moss: new THREE.Color(0x4e634e),
      earth: new THREE.Color(0x655d53),
      rock: new THREE.Color(0x555b60),
      rockLight: new THREE.Color(0x858882),
      snow: new THREE.Color(0xe8eef4),
    };
    this.colorScratch = new THREE.Color();
    this.normalScratch = new THREE.Vector3();
    this.update(0, 0, true);
  }

  contains() {
    return true;
  }

  streamCenterX(z) {
    return 7 + Math.sin(z * 0.018) * 6 + Math.sin(z * 0.051) * 2.5;
  }

  baseHeightAt(x, z) {
    const distance = Math.hypot(x * 0.92, z);
    const warpA = fbm(x * 0.0028, z * 0.0028, 41, 4);
    const warpB = fbm(x * 0.0028 + 19.7, z * 0.0028 - 11.4, 73, 4);
    const warpedX = x + warpA * 66;
    const warpedZ = z + warpB * 66;
    const macro = fbm(warpedX * 0.0045, warpedZ * 0.0045, 11, 7);
    const massif = ridgedFbm(warpedX * 0.0082, warpedZ * 0.0082, 29, 8);
    const shoulders = ridgedFbm(warpedX * 0.0155, warpedZ * 0.0155, 67, 6);
    const detail = fbm(x * 0.038, z * 0.038, 97, 5);
    const crags = Math.pow(ridgedFbm(warpedX * 0.026, warpedZ * 0.026, 113, 5), 2.05);
    const micro = fbm(x * 0.092, z * 0.092, 181, 4);

    const nearValley = -0.35 + macro * 4.8 + massif * 3.5 + detail * 1.05;
    const alpine = 9 + (macro + 0.18) * 24 + Math.pow(massif, 1.24) * 70 + shoulders * 16 + crags * 15 + detail * 5.4 + micro * 1.7;
    const mountainBlend = smoothRange(56, 154, distance);
    let height = lerp(nearValley, alpine, mountainBlend);

    // Only the structural footprint is prepared. Outside it the rock shelves return quickly.
    const foundationDistance = boxDistance(x, z, 20, 13.5);
    height = lerp(-0.32, height, smoothRange(1.5, 17, foundationDistance));

    // A shallow stream valley passes under the eastern cantilevers. It is inspired by the site's
    // relationship with water and rock, without copying Fallingwater's building or floor plan.
    const streamDistance = Math.abs(x - this.streamCenterX(z));
    const streamInfluence = Math.exp(-(streamDistance * streamDistance) / 150) * (1 - smoothRange(245, 365, distance));
    height -= streamInfluence * (2.1 + mountainBlend * 13 + Math.max(0, detail) * 1.2);

    // Barely stepped rock close to the house; the effect fades before the alpine ring begins.
    const shelfBlend = (1 - smoothRange(27, 82, distance)) * 0.075;
    const shelf = Math.floor((height + 0.28) / 1.45) * 1.45;
    return lerp(height, shelf, shelfBlend);
  }

  craterBucket(x, z) {
    return chunkKey(Math.floor(x / this.chunkSize), Math.floor(z / this.chunkSize));
  }

  deformedHeightAt(x, z) {
    let height = this.baseHeightAt(x, z);
    const craters = this.cratersByChunk.get(this.craterBucket(x, z));
    if (!craters) return height;
    for (const crater of craters) {
      const distance = Math.hypot(x - crater.x, z - crater.z);
      if (distance >= crater.radius) continue;
      const t = 1 - distance / crater.radius;
      const bowl = t * t * (3 - 2 * t);
      const rim = Math.exp(-Math.pow((distance / crater.radius - 0.86) / 0.12, 2));
      height += rim * crater.depth * 0.12 - bowl * crater.depth;
    }
    return height;
  }

  heightAt(x, z) {
    return this.deformedHeightAt(x, z);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const epsilon = 0.72;
    const left = this.deformedHeightAt(x - epsilon, z);
    const right = this.deformedHeightAt(x + epsilon, z);
    const down = this.deformedHeightAt(x, z - epsilon);
    const up = this.deformedHeightAt(x, z + epsilon);
    return out.set(left - right, epsilon * 2, down - up).normalize();
  }

  colorAt(x, z, height, suppliedNormal = null) {
    const normal = suppliedNormal || this.normalAt(x, z, this.normalScratch);
    const slope = 1 - normal.y;
    const streamDistance = Math.abs(x - this.streamCenterX(z));
    const nearStream = 1 - smoothRange(4, 15, streamDistance);
    const vegetation = nearStream * (1 - smoothRange(9, 18, height)) * smoothRange(0.42, 0.9, normal.y);
    const distance = Math.hypot(x * 0.92, z);
    const base = this.colorScratch.copy(this.palette.earth).lerp(this.palette.rock, smoothRange(72, 170, distance) * 0.42).lerp(this.palette.moss, vegetation * 0.78);
    const rockAmount = clamp(slope * 3.35 + smoothRange(8, 24, height) * 0.38, 0, 1);
    base.lerp(this.palette.rock, rockAmount);
    base.lerp(this.palette.rockLight, smoothRange(0.15, 0.5, slope) * 0.23);
    const snowLine = 11.5 + fbm(x * 0.009, z * 0.009, 313, 3) * 2.8;
    const snow = smoothRange(snowLine - 2.8, snowLine + 4.8, height) * smoothRange(0.2, 0.75, normal.y);
    base.lerp(this.palette.snow, clamp(snow, 0, 0.96));
    const grain = 0.94 + hash2(Math.floor(x * 0.62), Math.floor(z * 0.62), 211) * 0.12;
    return base.multiplyScalar(grain);
  }

  segmentsForOffset(dx, dz) {
    const ring = Math.max(Math.abs(dx), Math.abs(dz));
    if (ring <= 1) return { segments: this.options.nearSegments, lod: 0 };
    if (ring <= 3) return { segments: this.options.midSegments, lod: 1 };
    return { segments: this.options.farSegments, lod: 2 };
  }

  createChunk(chunkX, chunkZ, segments, lod) {
    const size = this.chunkSize;
    const vertices = [], colors = [], normals = [], indices = [];
    const row = segments + 1;
    const startX = chunkX * size, startZ = chunkZ * size;
    for (let iz = 0; iz <= segments; iz++) {
      for (let ix = 0; ix <= segments; ix++) {
        const x = startX + (ix / segments) * size;
        const z = startZ + (iz / segments) * size;
        const y = this.deformedHeightAt(x, z);
        const normal = this.normalAt(x, z, new THREE.Vector3());
        const color = this.colorAt(x, z, y, normal);
        vertices.push(x, y, z);
        colors.push(color.r, color.g, color.b);
        normals.push(normal.x, normal.y, normal.z);
      }
    }
    for (let iz = 0; iz < segments; iz++) {
      for (let ix = 0; ix < segments; ix++) {
        const a = iz * row + ix, b = a + 1, c = a + row, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    // Vertical skirts hide cracks where neighbouring chunks use different LODs.
    const edge = [];
    for (let ix = 0; ix <= segments; ix++) edge.push(ix);
    for (let iz = 1; iz <= segments; iz++) edge.push(iz * row + segments);
    for (let ix = segments - 1; ix >= 0; ix--) edge.push(segments * row + ix);
    for (let iz = segments - 1; iz > 0; iz--) edge.push(iz * row);
    const skirtStart = vertices.length / 3;
    for (const index of edge) {
      vertices.push(vertices[index * 3], vertices[index * 3 + 1] - this.options.skirtDepth, vertices[index * 3 + 2]);
      colors.push(colors[index * 3] * 0.74, colors[index * 3 + 1] * 0.74, colors[index * 3 + 2] * 0.74);
      normals.push(normals[index * 3], normals[index * 3 + 1], normals[index * 3 + 2]);
    }
    for (let i = 0; i < edge.length; i++) {
      const next = (i + 1) % edge.length;
      const topA = edge[i], topB = edge[next], lowA = skirtStart + i, lowB = skirtStart + next;
      indices.push(topA, lowA, topB, topB, lowA, lowB);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.materials[lod]);
    mesh.name = `terrain-${chunkX}-${chunkZ}-lod${lod}`;
    mesh.receiveShadow = lod === 0;
    mesh.castShadow = false;
    mesh.userData.terrain = true;
    mesh.userData.chunkX = chunkX;
    mesh.userData.chunkZ = chunkZ;
    mesh.userData.lod = lod;
    this.mesh.add(mesh);
    return { mesh, chunkX, chunkZ, segments, lod };
  }

  removeChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.mesh.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    this.chunks.delete(key);
  }

  rebuildChunk(chunkX, chunkZ) {
    const key = chunkKey(chunkX, chunkZ);
    const current = this.chunks.get(key);
    if (!current) return;
    this.mesh.remove(current.mesh);
    current.mesh.geometry.dispose();
    this.chunks.set(key, this.createChunk(chunkX, chunkZ, current.segments, current.lod));
  }

  update(playerX, playerZ, force = false) {
    const centerX = Math.floor(playerX / this.chunkSize);
    const centerZ = Math.floor(playerZ / this.chunkSize);
    const centerChanged = force || centerX !== this.lastCenterX || centerZ !== this.lastCenterZ;
    if (centerChanged) {
      this.lastCenterX = centerX;
      this.lastCenterZ = centerZ;
      const desired = new Map();
      for (let dz = -this.viewRadius; dz <= this.viewRadius; dz++) {
        for (let dx = -this.viewRadius; dx <= this.viewRadius; dx++) {
          if (Math.hypot(dx, dz) > this.viewRadius + 0.35) continue;
          const chunkX = centerX + dx, chunkZ = centerZ + dz;
          desired.set(chunkKey(chunkX, chunkZ), { key: chunkKey(chunkX, chunkZ), chunkX, chunkZ, distance: Math.hypot(dx, dz), ...this.segmentsForOffset(dx, dz) });
        }
      }
      for (const key of [...this.chunks.keys()]) if (!desired.has(key)) this.removeChunk(key);
      this.pendingChunks = [...desired.values()]
        .filter((request) => this.chunks.get(request.key)?.segments !== request.segments)
        .sort((a, b) => a.distance - b.distance);
    }
    this.processChunkQueue(force ? 12 : 4);
  }

  processChunkQueue(budget) {
    for (let count = 0; count < budget && this.pendingChunks.length; count++) {
      const request = this.pendingChunks.shift();
      const current = this.chunks.get(request.key);
      if (current?.segments === request.segments) continue;
      const replacement = this.createChunk(request.chunkX, request.chunkZ, request.segments, request.lod);
      if (current) this.removeChunk(request.key);
      this.chunks.set(request.key, replacement);
    }
  }

  crater(point, radius = 6.6, depth = 2.8, id = '') {
    const safeRadius = clamp(Number(radius) || 0, 0.5, 18);
    const safeDepth = clamp(Number(depth) || 0, 0.1, 9);
    const craterId = id || `${point.x.toFixed(3)}:${point.z.toFixed(3)}:${safeRadius.toFixed(2)}:${safeDepth.toFixed(2)}`;
    if (this.craterIds.has(craterId)) return 0;
    this.craterIds.add(craterId);
    const crater = { id: craterId, x: point.x, z: point.z, radius: safeRadius, depth: safeDepth };
    const minX = Math.floor((point.x - safeRadius) / this.chunkSize);
    const maxX = Math.floor((point.x + safeRadius) / this.chunkSize);
    const minZ = Math.floor((point.z - safeRadius) / this.chunkSize);
    const maxZ = Math.floor((point.z + safeRadius) / this.chunkSize);
    let rebuilt = 0;
    for (let chunkZ = minZ; chunkZ <= maxZ; chunkZ++) {
      for (let chunkX = minX; chunkX <= maxX; chunkX++) {
        const key = chunkKey(chunkX, chunkZ);
        if (!this.cratersByChunk.has(key)) this.cratersByChunk.set(key, []);
        this.cratersByChunk.get(key).push(crater);
        if (this.chunks.has(key)) {
          this.rebuildChunk(chunkX, chunkZ);
          rebuilt++;
        }
      }
    }
    return rebuilt;
  }

  reset() {
    this.cratersByChunk.clear();
    this.craterIds.clear();
    for (const chunk of [...this.chunks.values()]) this.rebuildChunk(chunk.chunkX, chunk.chunkZ);
  }
}
