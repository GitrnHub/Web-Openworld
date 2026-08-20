import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';
import { createMaterials } from './materials.js';
import { VoxelXPBDSystem } from './voxel_xpbd.js';
import { SafehouseWorld, createStudioEnvironment } from './world.js';
import { FirstPersonPlayer } from './player.js';
import { SharedWorldClient } from './multiplayer.js';
import { WORLD_CONFIG } from './config.js';

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const query = new URLSearchParams(window.location.search);
const previewMode = query.has('preview');
const testMode = query.has('selftest');
const cpuViewMode = query.has('cpuview');

const ui = {
  app: $('app'), startPanel: $('start-panel'), startButton: $('start-button'), initText: $('init-text'),
  floor: $('floor-label'), target: $('target-label'), renderer: $('renderer-label'), controls: $('controls'),
  fps: $('fps-value'), projectiles: $('projectile-value'), particles: $('particle-value'), constraints: $('constraint-value'),
  fragments: $('fragment-value'), sleeping: $('sleep-value'), rigid: $('rigid-value'), draws: $('draw-value'), weapon: $('weapon-label'), hitMarker: $('hit-marker'),
  toast: $('toast'), fatal: $('fatal-error'), quality: $('quality-select'), qualityValue: $('quality-value'),
  terrainQuality: $('terrain-quality-select'), terrainQualityValue: $('terrain-quality-value'), sync: $('sync-label'),
};

const qualityName = query.get('quality') || localStorage.getItem('safehouse.fractureQuality') || 'high';
const qualityPresets = {
  standard: { scale: 1.00, label: '标准' },
  fine: { scale: 1.12, label: '精细' },
  high: { scale: 1.22, label: '高精度' },
  ultra: { scale: 1.42, label: '极高' },
};
const qualityPreset = qualityPresets[qualityName] || qualityPresets.high;
if (ui.quality) {
  ui.quality.value = qualityPresets[qualityName] ? qualityName : 'high';
  ui.quality.addEventListener('change', () => {
    localStorage.setItem('safehouse.fractureQuality', ui.quality.value);
    const next = new URL(window.location.href); next.searchParams.set('quality', ui.quality.value); window.location.href = next.href;
  });
}
if (ui.qualityValue) ui.qualityValue.textContent = `${qualityPreset.label} · ${qualityPreset.scale.toFixed(2)}×`;

const terrainQualityName = query.get('terrainQuality') || localStorage.getItem('safehouse.terrainQuality') || 'high';
const terrainQualityPresets = {
  balanced: { viewRadius: 3, nearSegments: 24, midSegments: 12, farSegments: 6, label: '平衡', description: '3 区块视距 / 自适应 LOD' },
  high: { viewRadius: 4, nearSegments: 32, midSegments: 16, farSegments: 8, label: '高精度', description: '4 区块视距 / 自适应 LOD' },
  ultra: { viewRadius: 5, nearSegments: 40, midSegments: 20, farSegments: 10, label: '极高', description: '5 区块视距 / 自适应 LOD' },
};
const terrainQualityPreset = terrainQualityPresets[terrainQualityName] || terrainQualityPresets.high;
if (ui.terrainQuality) {
  ui.terrainQuality.value = terrainQualityPresets[terrainQualityName] ? terrainQualityName : 'high';
  ui.terrainQuality.addEventListener('change', () => {
    localStorage.setItem('safehouse.terrainQuality', ui.terrainQuality.value);
    const next = new URL(window.location.href); next.searchParams.set('terrainQuality', ui.terrainQuality.value); window.location.href = next.href;
  });
}
if (ui.terrainQualityValue) ui.terrainQualityValue.textContent = `${terrainQualityPreset.label} · ${terrainQualityPreset.description}`;

let toastTimer = 0;
function toast(message, duration = 1450) {
  window.clearTimeout(toastTimer); ui.toast.textContent = message; ui.toast.classList.add('show');
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), duration);
}
function flashHit() { ui.hitMarker.classList.remove('flash'); void ui.hitMarker.offsetWidth; ui.hitMarker.classList.add('flash'); }
function showFatal(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}\n\n${error.stack || ''}` : String(error);
  ui.fatal.hidden = false;
  ui.fatal.textContent = `Web Openworld 安全屋无法启动\n\n${text}\n\n体素求解器要求 WebGPU。请使用新版 Edge / Chrome，并通过 HTTPS 或 localhost 打开。`;
  console.error(error);
}
window.addEventListener('error', (event) => { if (event.error) showFatal(event.error); });
window.addEventListener('unhandledrejection', (event) => showFatal(event.reason));

function addSafehouseLights(scene) {
  const spots = [
    [-8.0, -3.0, 0xffe6cb, 460],
    [3.0, 2.0, 0xe5f4ff, 520],
    [11.0, 3.0, 0xffe5c0, 420],
  ];
  spots.forEach(([x, z, color, intensity], index) => {
    const light = new THREE.SpotLight(color, intensity, 12, 0.72, 0.62, 2);
    light.position.set(x, 3.62, z - 0.1); light.castShadow = index === 1;
    light.shadow.mapSize.set(index === 1 ? 1536 : 512, index === 1 ? 1536 : 512); light.shadow.bias = -0.00018; light.shadow.normalBias = 0.035;
    light.shadow.camera.near = 0.25; light.shadow.camera.far = 13;
    light.target.position.set(x, 0.78, z); scene.add(light, light.target);
  });
  const fill = new THREE.PointLight(0x9fd8ff, 62, 20, 2); fill.position.set(8, 2.35, 6); scene.add(fill);
}

async function initialize() {
  if (!ui.app) throw new Error('Missing #app container.');
  if (!navigator.gpu && !cpuViewMode) throw new Error('navigator.gpu 不可用：当前页面没有 WebGPU 上下文。');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.42)); renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = 1.06;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = true;
  ui.app.appendChild(renderer.domElement);

  const visibilityPresets = {
    balanced: { fogNear: 122, fogFar: 214, cameraFar: 244 },
    high: { fogNear: 165, fogFar: 274, cameraFar: 304 },
    ultra: { fogNear: 205, fogFar: 334, cameraFar: 370 },
  };
  const visibility = visibilityPresets[terrainQualityName] || visibilityPresets.high;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x607d91); scene.fog = new THREE.Fog(0x617d8d, visibility.fogNear, visibility.fogFar);
  // The previous 67 degree view exaggerated near objects; 52 degrees is closer to a natural first-person lens.
  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.045, visibility.cameraFar); camera.rotation.order = 'YXZ';

  const materials = createMaterials(renderer); scene.environment = createStudioEnvironment(renderer);
  const hemi = new THREE.HemisphereLight(0xc9def5, 0x403b39, 0.54);
  const ambient = new THREE.AmbientLight(0xb9c7d2, 0.075); scene.add(hemi, ambient);
  const sun = new THREE.DirectionalLight(0xffd1a1, 2.32); sun.position.set(-70, 54, -38); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -42; sun.shadow.camera.right = 42; sun.shadow.camera.top = 38; sun.shadow.camera.bottom = -38;
  sun.shadow.camera.near = 2; sun.shadow.camera.far = 120; sun.shadow.bias = -0.00012; sun.shadow.normalBias = 0.032;
  scene.add(sun, sun.target); sun.target.position.set(0, 3.5, 0); addSafehouseLights(scene);

  let sharedWorld = null;
  const destruction = new VoxelXPBDSystem(scene, camera, {
    maxProjectiles: 24, maxActiveFragments: 120, sleepingDebrisPerMaterial: 440, maxDust: 2400, qualityScale: qualityPreset.scale,
    onShot: ({ label, speed }) => toast(`${label}弹体 · ${Math.round(speed)} m/s`, 650),
    onImpact: ({ body, result }) => {
      flashHit();
      if (result.explosion) toast('炸弹爆炸 · 地形与附近结构受到冲击', 1000);
      else if (result.mud && result.stuck) toast('泥巴已贴合表面 · 正在硬化', 900);
      else if (result.mud && result.wet) toast('湿泥继续摊开 · 暂不破裂', 800);
      else if (result.mud && result.hardened && result.fractured) toast(`硬化泥层破碎 · ${result.realFragments || 0} 块`, 900);
      else if (result.fractured) toast(`${body?.label ?? '目标'} · ${result.secondary ? '二次破碎' : '局部体素损伤'}${result.realFragments ? ` / 分离 ${result.realFragments} 块` : ' / 坑蚀'}${!result.secondary && result.severity > 0.72 ? ' / 可能穿孔' : ''}`, 1200);
      else toast(`${body?.label ?? '目标'} · ${result.secondary ? '受到冲量，未继续分裂' : '冲击未形成可见断裂'}`, 850);
    },
    onMutation: (mutation) => sharedWorld?.queueMutation(mutation),
  });

  const world = new SafehouseWorld(scene, materials, destruction, { terrain: terrainQualityPreset });
  // Non-destructible scene colliders become full static rigid shapes. Detached chunks and
  // projectiles resolve face/edge contacts against them instead of using a top-plane shortcut.
  destruction.setStaticColliders(world.colliders);
  destruction.setTerrain(world.terrain);
  if (ui.initText) ui.initText.textContent = '正在生成流式山地、体素化安全屋并编译 WebGPU XPBD…';
  if (ui.startButton) { ui.startButton.disabled = true; ui.startButton.textContent = '初始化 WebGPU…'; }
  await destruction.initialize({ cpuOnly: cpuViewMode });

  if (testMode) {
    const stats = destruction.getStats();
    document.body.dataset.selftest = 'pass';
    document.body.dataset.particles = String(stats.particles);
    document.body.dataset.constraints = String(stats.constraints);
    document.body.dataset.gpu = stats.gpu || 'WebGPU';
    document.title = 'WEB_OPENWORLD_SELFTEST_PASS';
    window.__WEB_OPENWORLD_READY__ = true;
    return;
  }

  const player = new FirstPersonPlayer(camera, world, renderer.domElement);
  const gl = renderer.getContext(); const rendererName = gl.getParameter(gl.RENDERER) || 'GPU';
  ui.renderer.textContent = `Three.js / ${rendererName} · WebGPU XPBD · 无限区块 LOD：${terrainQualityPreset.label} · 断口：${qualityPreset.label}`;
  if (ui.weapon) ui.weapon.textContent = `弹体：${destruction.getProjectileType().label}`;
  if (ui.initText) ui.initText.textContent = `安全屋就绪：${destruction.getStats().particles.toLocaleString()} 个体素节点；共享破坏每 2.5 秒批量保存。`;
  if (ui.startButton) { ui.startButton.disabled = false; ui.startButton.textContent = '进入场景'; }

  sharedWorld = new SharedWorldClient({
    ...WORLD_CONFIG,
    applyMutation: (event) => destruction.applySharedMutation(event),
    onStatus: ({ state, detail, pending }) => {
      if (ui.sync) ui.sync.textContent = `共享世界：${detail || state}${pending ? ` · 待同步 ${pending}` : ''}`;
      document.body.dataset.sync = state;
    },
  });
  void sharedWorld.start();

  let controlsHidden = false, fireHeld = false, fireAccumulator = 0;
  const fireNow = () => { destruction.enableAudio(); destruction.shoot(); };
  const stopFiring = () => { fireHeld = false; fireAccumulator = 0; };
  function setStartPanelVisible(visible) { if (previewMode) { ui.startPanel.classList.add('hidden'); return; } ui.startPanel.classList.toggle('hidden', !visible); }
  ui.startButton.addEventListener('click', () => { destruction.enableAudio(); player.requestLock(); });
  window.addEventListener('safehouse:pointerlock', (event) => { const locked = Boolean(event.detail?.locked); if (!locked) stopFiring(); setStartPanelVisible(!locked); });
  renderer.domElement.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return; event.preventDefault();
    if (!player.locked && !previewMode) { destruction.enableAudio(); player.requestLock(); return; }
    fireHeld = true; fireAccumulator = 0; fireNow();
  });
  document.addEventListener('mouseup', (event) => { if (event.button === 0) stopFiring(); });
  window.addEventListener('blur', stopFiring);
  renderer.domElement.addEventListener('wheel', (event) => {
    if (!player.locked && !previewMode) return;
    event.preventDefault();
    const type = destruction.cycleProjectile(event.deltaY >= 0 ? 1 : -1);
    if (ui.weapon) ui.weapon.textContent = `弹体：${type.label}`;
    toast(`已切换：${type.label}`, 650);
  }, { passive: false });
  renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (event.code === 'KeyH') { controlsHidden = !controlsHidden; ui.controls.classList.toggle('hidden', controlsHidden); }
    else if (event.code === 'Digit1' || event.code === 'Digit2' || event.code === 'Digit3') { const floor = Number(event.code.at(-1)) - 1; player.teleport(floor); toast(`已前往 ${floor + 1}F`); }
  });

  function updateTarget() {
    const hit = destruction.raycastFromCamera(52); if (!hit) { ui.target.textContent = '准星目标：—'; return; }
    const body = hit.object.userData.destructibleBody; const fragment = hit.object.userData.realFragmentItem; const mud = hit.object.userData.mudPatchItem;
    ui.target.textContent = body ? `准星目标：${body.targetDescription()}` : mud ? `准星目标：${destruction.mud.targetDescription(mud)}` : `准星目标：${destruction.realFragments.targetDescription(fragment)}`;
  }

  let elapsed = 0, lastTime = performance.now(), statsTime = lastTime, frames = 0, targetTime = 0;
  if (previewMode) { setStartPanelVisible(false); ui.controls.classList.add('hidden'); if (query.has('outdoor')) { camera.position.set(43, world.groundHeight(43, 58, 2) + 1.68, 58); player.setLookAt(new THREE.Vector3(0, 5, 0)); } else { camera.position.set(-2, 1.72, -8); player.setLookAt(new THREE.Vector3(7, 2.2, 4)); } }
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000)); lastTime = now; elapsed += dt;
    if (fireHeld) { fireAccumulator += dt; let guard = 0; while (fireAccumulator >= 0.2 && guard++ < 3) { fireAccumulator -= 0.2; fireNow(); } }
    player.update(dt); world.update(dt, elapsed, camera.position); destruction.update(dt, elapsed);
    targetTime += dt; if (targetTime >= 0.12) { targetTime = 0; updateTarget(); ui.floor.textContent = world.floorName(camera.position.y, camera.position.x, camera.position.z); }
    renderer.render(scene, camera); frames++;
    if (now - statsTime >= 500) {
      const span = Math.max(1, now - statsTime); ui.fps.textContent = String(Math.round((frames * 1000) / span)); frames = 0; statsTime = now;
      const stats = destruction.getStats(); ui.projectiles.textContent = String(stats.projectiles); ui.particles.textContent = stats.particles.toLocaleString(); ui.constraints.textContent = stats.constraints.toLocaleString();
      ui.fragments.textContent = String((stats.activeFragments || 0) + (stats.realFragments || 0)); ui.sleeping.textContent = String((stats.sleepingInteractive || 0) + (stats.debris || 0) + (stats.mergedFragments || 0)); if (ui.rigid) ui.rigid.textContent = String(stats.rigidBodies || 0); ui.draws.textContent = String(renderer.info.render.calls);
    }
  }
  renderer.setAnimationLoop(frame);
  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.42)); renderer.setSize(window.innerWidth, window.innerHeight); });

  window.safehouseDemo = { THREE, renderer, scene, camera, materials, destruction, world, player, shoot: () => destruction.shoot(), cycleProjectile: (step=1) => destruction.cycleProjectile(step), setProjectileType: (id) => destruction.setProjectileType(id) };
  window.__WEB_OPENWORLD_READY__ = true; if (!previewMode) setStartPanelVisible(true);
}
initialize().catch(showFatal);
