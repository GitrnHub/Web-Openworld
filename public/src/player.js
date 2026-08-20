import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';

const UP = new THREE.Vector3(0, 1, 0);
const EYE_HEIGHT = 1.68;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class FirstPersonPlayer {
  constructor(camera, world, domElement, options = {}) {
    this.camera = camera;
    this.world = world;
    this.domElement = domElement;
    this.moveSpeed = options.moveSpeed ?? 5.2;
    this.sprintSpeed = options.sprintSpeed ?? 9.0;
    this.jumpSpeed = options.jumpSpeed ?? 5.3;
    this.gravity = options.gravity ?? 15.5;
    this.radius = options.radius ?? 0.34;
    this.sensitivity = options.sensitivity ?? 0.00205;

    this.yaw = Math.PI;
    this.pitch = -0.03;
    this.verticalVelocity = 0;
    this.onGround = true;
    this.keys = new Set();
    this._releaseTimers = new Map();
    this.enabled = true;
    this._locked = false;
    this._keyboardMode = false;

    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this._candidate = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

    this.camera.position.copy(this.world.spawnForFloor(0));
    this.applyLook();

    this._onMouseMove = (event) => {
      if (!this._locked || !this.enabled) return;
      this.yaw -= event.movementX * this.sensitivity;
      this.pitch -= event.movementY * this.sensitivity;
      this.pitch = clamp(this.pitch, -Math.PI * 0.49, Math.PI * 0.49);
      this.applyLook();
    };

    this._onKeyDown = (event) => {
      const releaseTimer = this._releaseTimers.get(event.code);
      if (releaseTimer) { window.clearTimeout(releaseTimer); this._releaseTimers.delete(event.code); }
      this.keys.add(event.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space'].includes(event.code)) {
        event.preventDefault();
      }
      if (event.code === 'Space' && this.onGround && this.locked) {
        this.verticalVelocity = this.jumpSpeed;
        this.onGround = false;
      }
      if (event.code === 'Escape' && this._keyboardMode) {
        this._keyboardMode = false;
        this.dispatchLockEvent();
      }
    };

    this._onKeyUp = (event) => {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) {
        const timer = window.setTimeout(() => { this.keys.delete(event.code); this._releaseTimers.delete(event.code); }, 75);
        this._releaseTimers.set(event.code, timer);
      } else {
        this.keys.delete(event.code);
      }
    };

    this._onBlur = () => {
      for (const timer of this._releaseTimers.values()) window.clearTimeout(timer);
      this._releaseTimers.clear(); this.keys.clear();
    };

    this._onPointerLockChange = () => {
      const wasLocked = this._locked;
      this._locked = document.pointerLockElement === this.domElement;
      if (this._locked || wasLocked) this._keyboardMode = false;
      this.dispatchLockEvent();
    };

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    window.addEventListener('blur', this._onBlur);
  }

  get locked() {
    return this._locked || this._keyboardMode;
  }

  requestLock() {
    const enableKeyboardMode = () => {
      this._keyboardMode = true;
      this.domElement.tabIndex = 0;
      this.domElement.focus({ preventScroll: true });
      this.dispatchLockEvent();
    };
    if (!this.domElement.requestPointerLock) { enableKeyboardMode(); return; }
    const fallback = () => {
      try {
        const result = this.domElement.requestPointerLock();
        if (result && typeof result.catch === 'function') result.catch(enableKeyboardMode);
      } catch {
        enableKeyboardMode();
      }
    };
    try {
      const result = this.domElement.requestPointerLock({ unadjustedMovement: true });
      if (result && typeof result.catch === 'function') result.catch(fallback);
    } catch {
      fallback();
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
    if (this._keyboardMode) {
      this._keyboardMode = false;
      this.dispatchLockEvent();
    }
  }

  dispatchLockEvent() {
    window.dispatchEvent(new CustomEvent('safehouse:pointerlock', { detail: { locked: this.locked, keyboardMode: this._keyboardMode } }));
  }

  applyLook() {
    this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this._euler);
  }

  setLookAt(target) {
    const direction = target.clone().sub(this.camera.position).normalize();
    this.pitch = Math.asin(clamp(direction.y, -1, 1));
    this.yaw = Math.atan2(-direction.x, -direction.z);
    this.applyLook();
  }

  teleport(floorIndex, lookAt = null) {
    this.camera.position.copy(this.world.spawnForFloor(floorIndex));
    this.verticalVelocity = 0;
    this.onGround = true;
    if (lookAt) this.setLookAt(lookAt);
    else {
      this.yaw = Math.PI;
      this.pitch = -0.03;
      this.applyLook();
    }
  }

  tryMoveAxis(axis, amount) {
    if (Math.abs(amount) < 1e-8) return;
    this._candidate.copy(this.camera.position);
    this._candidate[axis] += amount;
    const ground = this.world.groundHeight(this._candidate.x, this._candidate.z, this._candidate.y);
    const groundedY = ground + EYE_HEIGHT;
    const verticalTolerance = this.onGround ? 0.42 : 0.12;
    if (this._candidate.y < groundedY - verticalTolerance) this._candidate.y = groundedY;
    if (!this.world.isBlocked(this._candidate, this.radius)) {
      this.camera.position[axis] = this._candidate[axis];
    }
  }

  update(dt) {
    if (!this.enabled) return;
    const grounded = this.world.groundHeight(this.camera.position.x, this.camera.position.z, this.camera.position.y);
    const desiredEyeY = grounded + EYE_HEIGHT;

    if (this.locked) {
      this._forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this._forward.y = 0;
      if (this._forward.lengthSq() > 1e-8) this._forward.normalize();
      this._right.crossVectors(this._forward, UP).normalize();
      this._move.set(0, 0, 0);
      if (this.keys.has('KeyW')) this._move.add(this._forward);
      if (this.keys.has('KeyS')) this._move.sub(this._forward);
      if (this.keys.has('KeyD')) this._move.add(this._right);
      if (this.keys.has('KeyA')) this._move.sub(this._right);
      if (this._move.lengthSq() > 0) {
        this._move.normalize();
        const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? this.sprintSpeed : this.moveSpeed;
        const delta = this._move.multiplyScalar(speed * dt);
        if (this.world.resolvePlayerMove) {
          const resolved = this.world.resolvePlayerMove(this.camera.position, delta, this.radius, 0.52);
          this.camera.position.x = resolved.x; this.camera.position.z = resolved.z;
        } else {
          this.tryMoveAxis('x', delta.x); this.tryMoveAxis('z', delta.z);
        }
      }
    }

    const updatedGround = this.world.groundHeight(this.camera.position.x, this.camera.position.z, this.camera.position.y);
    const updatedEyeY = updatedGround + EYE_HEIGHT;
    if (!this.onGround || this.verticalVelocity > 0 || this.camera.position.y > updatedEyeY + 0.015) {
      this.verticalVelocity -= this.gravity * dt;
      this.camera.position.y += this.verticalVelocity * dt;
      if (this.camera.position.y <= updatedEyeY) {
        this.camera.position.y = updatedEyeY;
        this.verticalVelocity = 0;
        this.onGround = true;
      }
    } else {
      this.camera.position.y += (updatedEyeY - this.camera.position.y) * Math.min(1, dt * 18);
      this.verticalVelocity = 0;
      this.onGround = true;
    }

    if (this.camera.position.y < desiredEyeY - 1.2) {
      this.camera.position.y = desiredEyeY;
      this.verticalVelocity = 0;
      this.onGround = true;
    }
  }

  dispose() {
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    window.removeEventListener('blur', this._onBlur);
    this._onBlur();
  }
}
