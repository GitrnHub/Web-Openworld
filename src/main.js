import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';
import { createMaterials } from './materials.js';
import { VoxelXPBDSystem } from './voxel_xpbd.js';
import { OfficeWorld, createStudioEnvironment } from './world.js';
import { FirstPersonPlayer } from './player.js';

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
  terrainQuality: $('terrain-quality-select'), terrainQualityValue: $('terrain-quality-value'),
};

const qualityName = query.get('quality') || localStorage.getItem('officewalk.fractureQuality') || 'high';
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
    localStorage.setItem('officewalk.fractureQuality', ui.quality.value);
    const next = new URL(window.location.href); next.searchParams.set('quality', ui.quality.value); window.location.href = next.href;
  });
}
if (ui.qualityValue) ui.qualityValue.textContent = `${qualityPreset.label} · ${qualityPreset.scale.toFixed(2)}×`;

const terrainQualityName = query.get('terrainQuality') || localStorage.getItem('officewalk.terrainQuality') || 'high';
const terrainQualityPresets = {
  balanced: { nx: 513, nz: 513, detailOctaves: 10, label: '平衡', description: '513² / 10-oct' },
  high: { nx: 641, nz: 641, detailOctaves: 12, label: '高精度', description: '641² / 12-oct' },
  ultra: { nx: 769, nz: 769, detailOctaves: 15, label: '极高', description: '769² / 15-oct' },
};
const terrainQualityPreset = terrainQualityPresets[terrainQualityName] || terrainQualityPresets.high;
if (ui.terrainQuality) {
  ui.terrainQuality.value = terrainQualityPresets[terrainQualityName] ? terrainQualityName : 'high';
  ui.terrainQuality.addEventListener('change', () => {
    localStorage.setItem('officewalk.terrainQuality', ui.terrainQuality.value);
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
  ui.fatal.textContent = `OfficeWalk3D 无法启动\n\n${text}\n\n本版 XPBD 求解器要求 WebGPU。请使用 START_DEMO.bat，以新版 Edge/Chrome 打开；WebView2 请映射为 localhost 或虚拟 HTTPS 主机。`;
  console.error(error);
}
window.addEventListener('error', (event) => { if (event.error) showFatal(event.error); });
window.addEventListener('unhandledrejection', (event) => showFatal(event.reason));

function addLabShadowLights(scene) {
  const spots = [
    [-28.0, -1.1, 0xffe6cb, 520],
    [-20.0, -1.1, 0xe5f4ff, 610],
    [-12.0, -1.1, 0xffe5c0, 500],
  ];
  spots.forEach(([x, z, color, intensity], index) => {
    const light = new THREE.SpotLight(color, intensity, 12, 0.72, 0.62, 2);
    light.position.set(x, 3.62, z - 0.1); light.castShadow = index === 1;
    light.shadow.mapSize.set(index === 1 ? 1536 : 512, index === 1 ? 1536 : 512); light.shadow.bias = -0.00018; light.shadow.normalBias = 0.035;
    light.shadow.camera.near = 0.25; light.shadow.camera.far = 13;
    light.target.position.set(x, 0.78, z); scene.add(light, light.target);
  });
  const fill = new THREE.PointLight(0x9fd8ff, 72, 18, 2); fill.position.set(-20, 2.35, -6.2); scene.add(fill);
}

async function initialize() {
  if (!ui.app) throw new Error('Missing #app container.');
  if (!navigator.gpu && !cpuViewMode) throw new Error('navigator.gpu 不可用：当前页面没有 WebGPU 上下文。');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.42)); renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = 1.06;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = true;
  if ('useLegacyLights' in renderer) renderer.useLegacyLights = false;
  ui.app.appendChild(renderer.domElement);

  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x467db4); scene.fog = new THREE.Fog(0x436fa5, 250, 920);
  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.045, 980); camera.rotation.order = 'YXZ';

  const materials = createMaterials(renderer); scene.environment = createStudioEnvironment(renderer);
  const hemi = new THREE.HemisphereLight(0xc9def5, 0x403b39, 0.54);
  const ambient = new THREE.AmbientLight(0xb9c7d2, 0.075); scene.add(hemi, ambient);
  const sun = new THREE.DirectionalLight(0xffd1a1, 2.48); sun.position.set(-80, 40, -30); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -38; sun.shadow.camera.right = 38; sun.shadow.camera.top = 31; sun.shadow.camera.bottom = -31;
  sun.shadow.camera.near = 2; sun.shadow.camera.far = 120; sun.shadow.bias = -0.00012; sun.shadow.normalBias = 0.032;
  scene.add(sun, sun.target); sun.target.position.set(0, 3.5, 0); addLabShadowLights(scene);

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
  });

  const world = new OfficeWorld(scene, materials, destruction, { terrain: terrainQualityPreset });
  destruction.setStaticColliders(world.colliders);
  destruction.setTerrain(world.terrain);
  if (ui.initText) ui.initText.textContent = '正在体素化场景并编译 WebGPU XPBD compute pipeline…';
  if (ui.startButton) { ui.startButton.disabled = true; ui.startButton.textContent = '初始化 WebGPU…'; }
  await destruction.initialize({ cpuOnly: cpuViewMode });

  if (testMode) {
    const stats = destruction.getStats();
    document.body.dataset.selftest = 'pass';
    document.body.dataset.particles = String(stats.particles);
    document.body.dataset.constraints = String(stats.constraints);
    document.body.dataset.gpu = stats.gpu || 'WebGPU';
    document.title = 'OFFICEWALK_SELFTEST_PASS';
    window.__OFFICEWALK_READY__ = true;
    return;
  }

  const player = new FirstPersonPlayer(camera, world, renderer.domElement);
  const gl = renderer.getContext(); const rendererName = gl.getParameter(gl.RENDERER) || 'GPU';
  ui.renderer.textContent = `渲染：Three.js WebGL2 / AgX PBR · 贴图：tileable PBR + metric UV · 物理：WebGPU XPBD + rigid shapes · Elevated HQ + 176×156m 平坦庭院 · 地形：${terrainQualityPreset.label} ${terrainQualityPreset.description} · 断口：${qualityPreset.label}`;
  if (ui.weapon) ui.weapon.textContent = `弹体：${destruction.getProjectileType().label}`;
  if (ui.initText) ui.initText.textContent = `WebGPU 就绪：${destruction.getStats().particles.toLocaleString()} 个体素节点，${destruction.getStats().constraints.toLocaleString()} 条约束。`;
  if (ui.startButton) { ui.startButton.disabled = false; ui.startButton.textContent = '进入场景'; }

  let controlsHidden = false, fireHeld = false, fireAccumulator = 0;
  const fireNow = () => { destruction.enableAudio(); destruction.shoot(); };
  const stopFiring = () => { fireHeld = false; fireAccumulator = 0; };
  function setStartPanelVisible(visible) { if (previewMode) { ui.startPanel.classList.add('hidden'); return; } ui.startPanel.classList.toggle('hidden', !visible); }
  ui.startButton.addEventListener('click', () => { destruction.enableAudio(); player.requestLock(); });
  window.addEventListener('officewalk:pointerlock', (event) => { const locked = Boolean(event.detail?.locked); if (!locked) stopFiring(); setStartPanelVisible(!locked); });
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
    if (event.code === 'KeyR') { destruction.reset(); toast('体素损伤、刚体、泥巴与弹体已重置'); }
    else if (event.code === 'KeyH') { controlsHidden = !controlsHidden; ui.controls.classList.toggle('hidden', controlsHidden); }
    else if (event.code === 'Digit1' || event.code === 'Digit2' || event.code === 'Digit3') { const floor = Number(event.code.at(-1)) - 1; player.teleport(floor); toast(`已前往 ${floor + 1}F`); }
  });

  function updateTarget() {
    const hit = destruction.raycastFromCamera(52); if (!hit) { ui.target.textContent = '准星目标：—'; return; }
    const body = hit.object.userData.destructibleBody; const fragment = hit.object.userData.realFragmentItem; const mud = hit.object.userData.mudPatchItem;
    ui.target.textContent = body ? `准星目标：${body.targetDescription()}` : mud ? `准星目标：${destruction.mud.targetDescription(mud)}` : `准星目标：${destruction.realFragments.targetDescription(fragment)}`;
  }

  let elapsed = 0, lastTime = performance.now(), statsTime = lastTime, frames = 0, targetTime = 0;
  if (previewMode) { setStartPanelVisible(false); ui.controls.classList.add('hidden'); if (query.has('outdoor')) { camera.position.set(18.5, world.groundHeight(18.5, 42, 2) + 1.68, 42); player.setLookAt(new THREE.Vector3(8, 22, 178)); } else { camera.position.set(-7.2, 1.72, -12.2); player.setLookAt(new THREE.Vector3(-20.5, 1.50, -1.2)); } }
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000)); lastTime = now; elapsed += dt;
    if (fireHeld) { fireAccumulator += dt; let guard = 0; while (fireAccumulator >= 0.2 && guard++ < 3) { fireAccumulator -= 0.2; fireNow(); } }
    player.update(dt); world.update(dt, elapsed); destruction.update(dt, elapsed);
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

  window.officeWalkDemo = { THREE, renderer, scene, camera, materials, destruction, world, player, reset: () => destruction.reset(), shoot: () => destruction.shoot(), cycleProjectile: (step=1) => destruction.cycleProjectile(step), setProjectileType: (id) => destruction.setProjectileType(id) };
  window.__OFFICEWALK_READY__ = true; if (!previewMode) setStartPanelVisible(true);
}
initialize().catch(showFatal);
