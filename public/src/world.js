import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';
import { InfiniteTerrain } from './elevated_terrain.js';

const FLOOR_HEIGHT = 4;
const EYE_HEIGHT = 1.68;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function applyWorldScaledBoxUVs(geometry, metersPerTile = 2) {
  const position = geometry?.attributes?.position;
  const normal = geometry?.attributes?.normal;
  const uv = geometry?.attributes?.uv;
  if (!position || !normal || !uv || !(metersPerTile > 0)) return geometry;
  const inverse = 1 / metersPerTile;
  for (let i = 0; i < position.count; i++) {
    const px = position.getX(i), py = position.getY(i), pz = position.getZ(i);
    const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i)), nz = Math.abs(normal.getZ(i));
    if (nx >= ny && nx >= nz) uv.setXY(i, pz * inverse, py * inverse);
    else if (ny >= nx && ny >= nz) uv.setXY(i, px * inverse, pz * inverse);
    else uv.setXY(i, px * inverse, py * inverse);
  }
  uv.needsUpdate = true;
  return geometry;
}

export function createStudioEnvironment(renderer) {
  const environment = new THREE.Scene();
  environment.background = new THREE.Color(0x18232a);
  const panel = (x, y, z, sx, sy, color, intensity) => {
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, 1); mesh.lookAt(0, 0, 0); environment.add(mesh);
  };
  panel(-7, 6, -5, 8, 5, 0xe3f2ff, 1.2);
  panel(7, 3, 1, 5, 6, 0xffd0a8, 0.82);
  panel(0, 8, 2, 7, 5, 0xffffff, 0.84);
  panel(0, 1, 8, 9, 5, 0x668ca0, 0.38);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(environment, 0.038, 0.1, 42);
  pmrem.dispose();
  environment.traverse((object) => { object.geometry?.dispose?.(); object.material?.dispose?.(); });
  return target.texture;
}

function makeSignTexture(title, subtitle) {
  const canvas = document.createElement('canvas');
  canvas.width = 768; canvas.height = 192;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, '#121a1d'); gradient.addColorStop(1, '#253b3d');
  context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#d3a96b'; context.lineWidth = 5; context.strokeRect(8, 8, 752, 176);
  context.fillStyle = '#f5eee3'; context.font = '800 56px Segoe UI, Microsoft YaHei'; context.fillText(title, 34, 78);
  context.fillStyle = '#d7bd91'; context.font = '600 23px Segoe UI, Microsoft YaHei'; context.fillText(subtitle, 34, 145);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function within(x, z, halfX, halfZ, centerX = 0, centerZ = 0) {
  return Math.abs(x - centerX) <= halfX && Math.abs(z - centerZ) <= halfZ;
}

export class SafehouseWorld {
  constructor(scene, materials, destruction, options = {}) {
    this.scene = scene;
    this.materials = materials;
    this.destruction = destruction;
    this.options = options;
    this.colliders = [];
    this.dynamicBodies = [];
    this.interiorGroup = new THREE.Group();
    this.interiorGroup.name = 'safehouse-interior-details';
    this.structureGroup = new THREE.Group();
    this.structureGroup.name = 'safehouse-structure';
    this.siteGroup = new THREE.Group();
    this.siteGroup.name = 'safehouse-site-details';
    this.scene.add(this.structureGroup, this.interiorGroup, this.siteGroup);
    this.interiorVisible = true;
    this.terrain = new InfiniteTerrain(this.scene, options.terrain || {});
    this.build();
  }

  addCollider(mesh, body = null, padding = 0) {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (padding) box.expandByScalar(padding);
    this.colliders.push({ mesh, box, body });
  }

  box({
    id = '', x = 0, y = 0, z = 0, w = 1, h = 1, d = 1,
    material = this.materials.wall, parent = this.structureGroup,
    rotationY = 0, castShadow = true, receiveShadow = true,
    collider = false, profile = null, label = '', segments = null,
    thresholdScale = 1, integrityScale = 1, radiusScale = 1,
    voxelResolution = null, anchor = null,
  }) {
    const geometry = new THREE.BoxGeometry(w, h, d, segments?.[0] ?? 1, segments?.[1] ?? 1, segments?.[2] ?? 1);
    const metersPerTile = material?.userData?.worldUvMetersPerTile;
    if (metersPerTile) applyWorldScaledBoxUVs(geometry, metersPerTile);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.rotation.y = rotationY;
    mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
    parent.add(mesh); parent.updateMatrixWorld(true);
    let body = null;
    if (profile) {
      if (!id) throw new Error(`Destructible object requires a stable id: ${label || profile}`);
      const shell = profile === 'metal' || profile === 'plastic';
      body = this.destruction.register(mesh, profile, {
        stateId: id, label, thresholdScale, integrityScale, radiusScale,
        shape: shell ? 'shellBox' : 'box',
        thickness: shell ? Math.max(0.055, Math.min(w, h, d) * 0.34) : undefined,
        voxelResolution: voxelResolution ?? (Math.max(w, h, d) > 10 ? 9 : Math.max(w, h, d) > 4 ? 11 : 15),
        anchor: anchor ?? (collider ? 'base' : false),
      });
      this.dynamicBodies.push(body);
    }
    if (collider) this.addCollider(mesh, body);
    return mesh;
  }

  cylinder({ id = '', x, y, z, radius, height, material, profile = null, label = '', parent = this.interiorGroup, collider = false }) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 20, 4), material);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh); parent.updateMatrixWorld(true);
    let body = null;
    if (profile) {
      body = this.destruction.register(mesh, profile, { stateId: id, label, shape: 'cylinder', radius, height, voxelResolution: 16, anchor: collider ? 'base' : false });
      this.dynamicBodies.push(body);
    }
    if (collider) this.addCollider(mesh, body);
    return mesh;
  }

  addFloor(level, width, depth, centerX = 0, centerZ = 0, material = this.materials.tile) {
    const base = level * FLOOR_HEIGHT;
    this.box({ x: centerX, y: base - 0.12, z: centerZ, w: width, h: 0.24, d: depth, material, receiveShadow: true });
  }

  addCantilever({ id, x, y, z, w, d, label }) {
    return this.box({
      id, x, y, z, w, h: 0.34, d,
      material: this.materials.concrete, profile: 'concrete', label,
      integrityScale: 3.1, thresholdScale: 1.25, radiusScale: 0.78,
      segments: [Math.max(6, Math.round(w / 1.8)), 2, Math.max(4, Math.round(d / 1.8))], anchor: 'edges',
    });
  }

  glassPanel({ id, x, y, z, w, h = 3.15, d, rotationY = 0, label }) {
    return this.box({
      id, x, y, z, w, h, d, rotationY,
      material: this.materials.glass, profile: 'glass', label,
      castShadow: false, integrityScale: 1.45, thresholdScale: 1.08,
      segments: [Math.max(4, Math.round(w * 1.2)), 5, Math.max(1, Math.round(d * 1.2))], anchor: 'edges',
    });
  }

  stoneWall({ id, x, y, z, w, h = 3.45, d, label, collider = true }) {
    return this.box({
      id, x, y, z, w, h, d, material: this.materials.concreteDark,
      profile: 'concrete', label, collider, integrityScale: 3.4,
      thresholdScale: 1.22, segments: [Math.max(5, Math.round(w / 1.3)), 6, Math.max(2, Math.round(d / 1.3))],
    });
  }

  buildShell() {
    this.addFloor(0, 36, 23, -1, 0, this.materials.tile);
    this.addFloor(1, 27, 19, -2, 0.8, this.materials.wood);
    this.addFloor(2, 22, 17, 0, 1.5, this.materials.woodDark);

    this.addCantilever({ id: 'slab-2f-west', x: -18.5, y: 3.86, z: 1, w: 10, d: 13, label: '二层西侧悬挑露台' });
    this.addCantilever({ id: 'slab-2f-east', x: 15.5, y: 3.86, z: 1.8, w: 11, d: 18, label: '二层溪谷悬挑露台' });
    this.addCantilever({ id: 'slab-3f-view', x: 16.5, y: 7.86, z: 2.5, w: 18, d: 12, label: '三层观景台悬挑板' });

    for (let floor = 0; floor < 3; floor++) {
      const base = floor * FLOOR_HEIGHT;
      this.stoneWall({ id: `core-${floor}-west`, x: -7.8, y: base + 1.8, z: 2.5, w: 0.65, d: 11, label: `${floor + 1}层石质核心西墙` });
      this.stoneWall({ id: `core-${floor}-east`, x: 0.2, y: base + 1.8, z: 2.5, w: 0.65, d: 11, label: `${floor + 1}层石质核心东墙` });
      this.stoneWall({ id: `core-${floor}-north`, x: -3.8, y: base + 1.8, z: 8, w: 8.6, d: 0.65, label: `${floor + 1}层石质核心北墙` });
    }

    // Ground floor: sheltered lobby with an open southern arrival and glazing toward the stream.
    this.stoneWall({ id: 'lobby-west-wall', x: -17.4, y: 1.8, z: 1, w: 0.6, d: 16, label: '一层大厅西墙' });
    this.stoneWall({ id: 'lobby-north-wall', x: -12, y: 1.8, z: 10.8, w: 11.5, d: 0.6, label: '一层大厅北墙' });
    this.glassPanel({ id: 'lobby-east-glass-a', x: 6, y: 1.9, z: 10.7, w: 11, d: 0.08, label: '一层溪谷侧转角玻璃' });
    this.glassPanel({ id: 'lobby-east-glass-b', x: 12, y: 1.9, z: 4.7, w: 0.08, d: 12, label: '一层溪谷侧玻璃幕墙' });
    this.glassPanel({ id: 'lobby-south-glass', x: 8, y: 1.9, z: -10.7, w: 12, d: 0.08, label: '一层入口侧玻璃' });

    // Second floor: living and bedroom zone, wrapped by long horizontal window bands.
    this.stoneWall({ id: 'living-west-wall', x: -15, y: 5.8, z: 0.5, w: 0.65, d: 14, label: '二层居住区石墙' });
    this.glassPanel({ id: 'living-south-glass', x: 1.5, y: 5.9, z: -8.55, w: 23, d: 0.08, label: '二层起居室横向玻璃' });
    this.glassPanel({ id: 'living-east-glass', x: 11.8, y: 5.9, z: 1.4, w: 0.08, d: 17.5, label: '二层溪谷侧转角玻璃' });
    this.stoneWall({ id: 'bedroom-north-wall', x: -8.5, y: 5.8, z: 10, w: 13, d: 0.6, label: '二层卧室北墙' });

    // Third floor: compact retreat plus an oversized observation terrace.
    this.stoneWall({ id: 'retreat-west-wall', x: -10.8, y: 9.8, z: 2, w: 0.65, d: 13, label: '三层居住区西墙' });
    this.stoneWall({ id: 'retreat-north-wall', x: -3.5, y: 9.8, z: 9.8, w: 14, d: 0.6, label: '三层居住区北墙' });
    this.glassPanel({ id: 'retreat-south-glass', x: 0, y: 9.9, z: -6.7, w: 20, d: 0.08, label: '三层休息室玻璃' });
    this.glassPanel({ id: 'retreat-east-glass', x: 10.6, y: 9.9, z: 1.6, w: 0.08, d: 16, label: '三层观景台玻璃' });

    // Roof plates exaggerate the low horizontal sheltering line.
    this.box({ x: -2, y: 3.91, z: 0.5, w: 29, h: 0.18, d: 21, material: this.materials.concrete, castShadow: true });
    this.box({ x: 0, y: 7.91, z: 1.5, w: 24, h: 0.18, d: 19, material: this.materials.concrete, castShadow: true });
    this.box({ x: 1, y: 11.92, z: 1.5, w: 24, h: 0.22, d: 19, material: this.materials.concreteDark, castShadow: true });
  }

  sofa(id, x, base, z, rotation = 0, warm = true) {
    const material = warm ? this.materials.fabricWarm : this.materials.fabric;
    const group = new THREE.Group(); group.position.set(x, base, z); group.rotation.y = rotation; this.interiorGroup.add(group);
    const seat = this.box({ id: `${id}-seat`, x: 0, y: 0.38, z: 0, w: 2.7, h: 0.48, d: 1.05, material, parent: group, profile: 'plastic', label: '软包沙发主体', integrityScale: 1.2 });
    this.box({ x: 0, y: 0.95, z: 0.42, w: 2.7, h: 0.75, d: 0.22, material, parent: group });
    for (const armX of [-1.22, 1.22]) this.box({ x: armX, y: 0.60, z: 0, w: 0.25, h: 0.68, d: 1.06, material, parent: group });
    this.addCollider(seat, seat.userData?.destructibleBody || null);
  }

  bed(id, x, base, z, rotation = 0) {
    const group = new THREE.Group(); group.position.set(x, base, z); group.rotation.y = rotation; this.interiorGroup.add(group);
    this.box({ id: `${id}-frame`, x: 0, y: 0.28, z: 0, w: 2.2, h: 0.42, d: 3.6, material: this.materials.woodDark, parent: group, profile: 'wood', label: '木质床架', integrityScale: 1.45 });
    this.box({ x: 0, y: 0.57, z: 0.15, w: 2.0, h: 0.34, d: 3.1, material: this.materials.fabric, parent: group });
    this.box({ x: 0, y: 1.05, z: 1.72, w: 2.25, h: 1.25, d: 0.18, material: this.materials.wood, parent: group });
  }

  table(id, x, base, z, w = 2.2, d = 1.0) {
    const top = this.box({ id, x, y: base + 0.78, z, w, h: 0.14, d, material: this.materials.wood, parent: this.interiorGroup, profile: 'wood', label: '实木桌面', integrityScale: 1.35, segments: [7, 1, 4] });
    for (const dx of [-w * 0.4, w * 0.4]) for (const dz of [-d * 0.36, d * 0.36]) {
      this.box({ x: x + dx, y: base + 0.38, z: z + dz, w: 0.09, h: 0.72, d: 0.09, material: this.materials.metalDark, parent: this.interiorGroup });
    }
    return top;
  }

  buildInteriors() {
    this.box({ id: 'lobby-desk', x: -2, y: 0.62, z: -6.3, w: 6.2, h: 1.22, d: 0.95, material: this.materials.woodDark, parent: this.interiorGroup, profile: 'wood', label: '安全屋接待台', collider: true, integrityScale: 1.6 });
    this.sofa('lobby-sofa', 7.8, 0, 4.2, Math.PI * 0.5, false);
    this.table('lobby-table', 5.4, 0, 4.2, 1.6, 0.9);

    this.sofa('living-sofa', 2.2, FLOOR_HEIGHT, -2.8, Math.PI, true);
    this.table('living-table', 2.2, FLOOR_HEIGHT, -0.9, 2.4, 1.1);
    this.bed('bedroom-2f', -9.8, FLOOR_HEIGHT, 4.5, Math.PI * 0.5);
    this.box({ id: 'kitchen-island', x: 6.7, y: FLOOR_HEIGHT + 0.55, z: 5, w: 4.4, h: 1.1, d: 1.25, material: this.materials.concreteDark, parent: this.interiorGroup, profile: 'concrete', label: '二层石质厨房岛台', collider: true, integrityScale: 1.9 });

    this.bed('bedroom-3f', -5.5, FLOOR_HEIGHT * 2, 3.5, 0);
    this.sofa('view-sofa', 5, FLOOR_HEIGHT * 2, 1, -Math.PI * 0.5, false);
    this.table('view-table', 14.5, FLOOR_HEIGHT * 2, 2.6, 2.0, 0.9);

    const signs = [
      ['1F', 'LOBBY / SPAWN', -4, 2.75, -7.0],
      ['2F', 'LIVING / BEDROOM', -4, 6.75, -7.0],
      ['3F', 'RETREAT / VIEW DECK', -4, 10.75, -5.9],
    ];
    for (const [title, subtitle, x, y, z] of signs) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(3.7, 0.92), new THREE.MeshBasicMaterial({ map: makeSignTexture(title, subtitle), toneMapped: false }));
      panel.position.set(x, y, z); this.interiorGroup.add(panel);
    }

    const lightLocations = [[-5, 3.35, -4], [6, 3.35, 3], [-5, 7.35, -3], [6, 7.35, 4], [-3, 11.35, 2], [12, 9.7, 2]];
    for (const [x, y, z] of lightLocations) {
      const light = new THREE.PointLight(0xffdfb6, 34, 15, 2); light.position.set(x, y, z); this.interiorGroup.add(light);
      this.box({ x, y: y + 0.38, z, w: 1.7, h: 0.06, d: 0.3, material: this.materials.lightPanel, parent: this.interiorGroup, castShadow: false });
    }
  }

  buildStairs() {
    const steps = 20;
    for (let i = 0; i < steps; i++) {
      const z = 1.2 + i * 0.43;
      const top = ((i + 1) / steps) * FLOOR_HEIGHT;
      this.box({ x: -12.5, y: top - 0.1, z, w: 2.2, h: 0.2, d: 0.45, material: this.materials.concrete, parent: this.structureGroup });
    }
    this.box({ x: -10.6, y: 3.9, z: 9.7, w: 6, h: 0.2, d: 1.5, material: this.materials.concrete });
    for (let i = 0; i < steps; i++) {
      const z = 9.2 - i * 0.43;
      const top = FLOOR_HEIGHT + ((i + 1) / steps) * FLOOR_HEIGHT;
      this.box({ x: -8.6, y: top - 0.1, z, w: 2.2, h: 0.2, d: 0.45, material: this.materials.concrete, parent: this.structureGroup });
    }
    this.box({ x: -10.5, y: 7.9, z: 0.4, w: 6.2, h: 0.2, d: 1.5, material: this.materials.concrete });
  }

  buildStream() {
    const segments = 76, width = 3.2;
    const positions = [], indices = [];
    for (let i = 0; i <= segments; i++) {
      const z = -145 + (i / segments) * 290;
      const x = this.terrain.streamCenterX(z);
      const y = this.terrain.baseHeightAt(x, z) + 0.16;
      positions.push(x - width, y, z, x + width, y, z);
      if (i < segments) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    const material = new THREE.MeshPhysicalMaterial({ color: 0x487f91, roughness: 0.16, metalness: 0.05, transparent: true, opacity: 0.72, transmission: 0.18, depthWrite: false });
    const stream = new THREE.Mesh(geometry, material); stream.name = 'safehouse-stream'; stream.renderOrder = 2; this.siteGroup.add(stream);
  }

  buildLandscapeProps() {
    const rockGeometry = new THREE.DodecahedronGeometry(1, 1);
    const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x565954, roughness: 0.96, metalness: 0 });
    const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, 42);
    const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3();
    for (let i = 0; i < 42; i++) {
      const angle = i * 2.39996, radius = 28 + (i % 9) * 7.2;
      const x = Math.cos(angle) * radius + Math.sin(i * 7.1) * 5;
      const z = Math.sin(angle) * radius + Math.cos(i * 3.7) * 7;
      const y = this.terrain.heightAt(x, z);
      rotation.setFromEuler(new THREE.Euler(i * 0.17, i * 0.61, i * 0.11));
      scale.set(1.1 + (i % 5) * 0.44, 0.55 + (i % 4) * 0.27, 1.0 + (i % 3) * 0.58);
      matrix.compose(position.set(x, y + scale.y * 0.45, z), rotation, scale); rocks.setMatrixAt(i, matrix);
    }
    rocks.receiveShadow = true; rocks.castShadow = false; this.siteGroup.add(rocks);
  }

  build() {
    this.buildShell();
    this.buildStairs();
    this.buildInteriors();
    this.buildStream();
    this.buildLandscapeProps();
  }

  update(_dt, _elapsed, playerPosition = null) {
    if (!playerPosition) return;
    this.terrain.update(playerPosition.x, playerPosition.z);
    const distance = Math.hypot(playerPosition.x, playerPosition.z);
    const shouldShowInterior = this.interiorVisible ? distance < 132 : distance < 108;
    if (shouldShowInterior !== this.interiorVisible) {
      this.interiorVisible = shouldShowInterior;
      this.interiorGroup.visible = shouldShowInterior;
    }
    this.siteGroup.visible = distance < 235;
  }

  groundHeight(x, z, cameraY) {
    const currentGround = cameraY - EYE_HEIGHT;
    if (x >= -13.7 && x <= -11.3 && z >= 1.2 && z <= 9.8 && currentGround < 4.6) return FLOOR_HEIGHT * ((z - 1.2) / 8.6);
    if (x >= -9.8 && x <= -7.4 && z >= 0.6 && z <= 9.2 && currentGround > 3.4) return FLOOR_HEIGHT + FLOOR_HEIGHT * ((9.2 - z) / 8.6);
    if (x >= -13.9 && x <= -7.2 && z >= 9.0 && z <= 10.6 && currentGround > 2.0 && currentGround < 6.1) return FLOOR_HEIGHT;
    if (x >= -13.7 && x <= -7.1 && z >= -0.4 && z <= 1.5 && currentGround > 5.8) return FLOOR_HEIGHT * 2;
    if (currentGround > 6.1 && within(x, z, 17.5, 10.5, 4, 2)) return FLOOR_HEIGHT * 2;
    if (currentGround > 2.0 && within(x, z, 21, 12, -0.5, 1)) return FLOOR_HEIGHT;
    if (within(x, z, 18, 11.5, -1, 0)) return 0;
    return this.terrain.heightAt(x, z);
  }

  groundNormal(x, z, cameraY = EYE_HEIGHT) {
    const ground = this.groundHeight(x, z, cameraY);
    if (ground === 0 || ground === FLOOR_HEIGHT || ground === FLOOR_HEIGHT * 2) return new THREE.Vector3(0, 1, 0);
    return this.terrain.normalAt(x, z, new THREE.Vector3());
  }

  isBlocked(position, radius = 0.34) {
    const feet = position.y - EYE_HEIGHT, head = position.y + 0.12;
    for (const collider of this.colliders) {
      if (collider.body?.destroyed || collider.body?.renderMode === 'depleted') continue;
      if (collider.body) {
        collider.mesh.updateMatrixWorld(true);
        collider.box.setFromObject(collider.mesh);
      }
      const box = collider.box;
      if (head < box.min.y || feet > box.max.y) continue;
      if (position.x + radius > box.min.x && position.x - radius < box.max.x && position.z + radius > box.min.z && position.z - radius < box.max.z) return true;
    }
    return false;
  }

  resolvePlayerMove(position, delta, radius = 0.34, maxStep = 0.52) {
    const result = position.clone();
    const distance = Math.hypot(delta.x, delta.z);
    const steps = Math.max(1, Math.ceil(distance / 0.18));
    const stepX = delta.x / steps, stepZ = delta.z / steps;
    for (let i = 0; i < steps; i++) {
      const currentGround = this.groundHeight(result.x, result.z, result.y);
      const full = result.clone(); full.x += stepX; full.z += stepZ;
      const nextGround = this.groundHeight(full.x, full.z, full.y);
      const normal = this.groundNormal(full.x, full.z, full.y);
      if (normal.y > 0.58 && nextGround - currentGround <= maxStep && !this.isBlocked(full, radius)) { result.copy(full); continue; }
      const onlyX = result.clone(); onlyX.x += stepX;
      const onlyZ = result.clone(); onlyZ.z += stepZ;
      const xGround = this.groundHeight(onlyX.x, onlyX.z, onlyX.y), zGround = this.groundHeight(onlyZ.x, onlyZ.z, onlyZ.y);
      const xOkay = this.groundNormal(onlyX.x, onlyX.z, onlyX.y).y > 0.58 && xGround - currentGround <= maxStep && !this.isBlocked(onlyX, radius);
      const zOkay = this.groundNormal(onlyZ.x, onlyZ.z, onlyZ.y).y > 0.58 && zGround - currentGround <= maxStep && !this.isBlocked(onlyZ, radius);
      if (xOkay && zOkay) result.copy(Math.abs(stepX) >= Math.abs(stepZ) ? onlyX : onlyZ);
      else if (xOkay) result.copy(onlyX);
      else if (zOkay) result.copy(onlyZ);
    }
    return result;
  }

  floorName(cameraY, x = 0, z = 0) {
    if (Math.hypot(x, z) > 42) return '室外 · 无限流式山地';
    if (cameraY < 3.7) return '1F · 安全屋大厅 / 出生点';
    if (cameraY < 7.7) return '2F · 起居与卧室';
    return '3F · 休息室与观景台';
  }

  spawnForFloor(index) {
    const floor = clamp(index, 0, 2);
    const positions = [new THREE.Vector3(-2, EYE_HEIGHT, -6), new THREE.Vector3(2, FLOOR_HEIGHT + EYE_HEIGHT, -4), new THREE.Vector3(4, FLOOR_HEIGHT * 2 + EYE_HEIGHT, -2)];
    return positions[floor].clone();
  }
}
