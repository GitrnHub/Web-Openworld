import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';

const EPS = 1e-7;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const AXES = [X, Y, Z];

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function qAxis(quaternion, axis) { return axis.clone().applyQuaternion(quaternion).normalize(); }
function shapeRadius(shape) {
  if (shape.type === 'sphere') return shape.radius;
  const e = shape.halfExtents; return Math.hypot(e.x, e.y, e.z);
}
function shapeHalfExtents(shape) {
  if (shape.type === 'sphere') return new THREE.Vector3(shape.radius, shape.radius, shape.radius);
  return shape.halfExtents;
}
function bodyAxes(body) { return [qAxis(body.quaternion, X), qAxis(body.quaternion, Y), qAxis(body.quaternion, Z)]; }
function supportPoint(body, dir) {
  if (body.shape.type === 'sphere') return body.position.clone().addScaledVector(dir, body.shape.radius);
  const axes = bodyAxes(body), e = body.shape.halfExtents, out = body.position.clone();
  const dots = [dir.dot(axes[0]), dir.dot(axes[1]), dir.dot(axes[2])];
  const ext = [e.x, e.y, e.z];
  // A face has infinitely many support points. Choosing an arbitrary corner when the
  // direction is perpendicular to an axis injects bogus torque into face contacts.
  // Keep perpendicular coordinates at the body center; use an edge/corner only when
  // the SAT/contact normal genuinely has a component along that axis.
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dots[i]) > 1e-5) out.addScaledVector(axes[i], dots[i] > 0 ? ext[i] : -ext[i]);
  }
  return out;
}
function aabbForBody(body, out = new THREE.Box3()) {
  if (body.shape.type === 'sphere') {
    const r = body.shape.radius; return out.set(body.position.clone().addScalar(-r), body.position.clone().addScalar(r));
  }
  const axes = bodyAxes(body), e = body.shape.halfExtents;
  const ex = Math.abs(axes[0].x) * e.x + Math.abs(axes[1].x) * e.y + Math.abs(axes[2].x) * e.z;
  const ey = Math.abs(axes[0].y) * e.x + Math.abs(axes[1].y) * e.y + Math.abs(axes[2].y) * e.z;
  const ez = Math.abs(axes[0].z) * e.x + Math.abs(axes[1].z) * e.y + Math.abs(axes[2].z) * e.z;
  return out.set(new THREE.Vector3(body.position.x - ex, body.position.y - ey, body.position.z - ez), new THREE.Vector3(body.position.x + ex, body.position.y + ey, body.position.z + ez));
}
function closestOnBox(point, boxBody, out = new THREE.Vector3()) {
  const axes = bodyAxes(boxBody), e = boxBody.shape.halfExtents;
  const d = point.clone().sub(boxBody.position); out.copy(boxBody.position);
  const ex = [e.x, e.y, e.z];
  for (let i = 0; i < 3; i++) out.addScaledVector(axes[i], clamp(d.dot(axes[i]), -ex[i], ex[i]));
  return out;
}

function sphereSphere(a, b) {
  const delta = b.position.clone().sub(a.position), dist2 = delta.lengthSq(), sum = a.shape.radius + b.shape.radius;
  if (dist2 >= sum * sum) return null;
  let dist = Math.sqrt(Math.max(dist2, EPS));
  const normal = dist > 1e-5 ? delta.multiplyScalar(1 / dist) : new THREE.Vector3(1, 0, 0);
  const penetration = sum - dist;
  const point = a.position.clone().addScaledVector(normal, a.shape.radius - penetration * 0.5);
  return { normal, penetration, point };
}

function sphereBox(sphere, box) {
  const closest = closestOnBox(sphere.position, box);
  const delta = closest.clone().sub(sphere.position); // sphere -> box
  const dist2 = delta.lengthSq(), r = sphere.shape.radius;
  if (dist2 > r * r) return null;
  if (dist2 > 1e-10) {
    const dist = Math.sqrt(dist2); return { normal: delta.multiplyScalar(1 / dist), penetration: r - dist, point: closest };
  }
  // Sphere center is inside the box. Choose the nearest face. The collision normal must point
  // from the sphere toward the box interior so `sphere -= normal * penetration` ejects it.
  const axes = bodyAxes(box), e = box.shape.halfExtents, local = sphere.position.clone().sub(box.position);
  const c = [local.dot(axes[0]), local.dot(axes[1]), local.dot(axes[2])], ex = [e.x, e.y, e.z];
  let best = 0, gap = ex[0] - Math.abs(c[0]);
  for (let i = 1; i < 3; i++) { const g = ex[i] - Math.abs(c[i]); if (g < gap) { gap = g; best = i; } }
  const outward = axes[best].clone().multiplyScalar(c[best] >= 0 ? 1 : -1);
  const normal = outward.multiplyScalar(-1);
  const point = sphere.position.clone().addScaledVector(outward, gap);
  return { normal, penetration: r + Math.max(0, gap), point };
}

function boxBox(a, b) {
  const A = bodyAxes(a), B = bodyAxes(b), ea = a.shape.halfExtents, eb = b.shape.halfExtents;
  const ae = [ea.x, ea.y, ea.z], be = [eb.x, eb.y, eb.z];
  const R = Array.from({ length: 3 }, () => [0, 0, 0]), AR = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { R[i][j] = A[i].dot(B[j]); AR[i][j] = Math.abs(R[i][j]) + 1e-6; }
  const dWorld = b.position.clone().sub(a.position);
  const t = [dWorld.dot(A[0]), dWorld.dot(A[1]), dWorld.dot(A[2])];
  let minPen = Infinity, bestNormal = null;
  const consider = (overlap, axis, sign) => {
    const len = axis.length(); if (len < 1e-7) return true;
    const pen = overlap / len; if (pen < 0) return false;
    if (pen < minPen) { minPen = pen; bestNormal = axis.clone().multiplyScalar(sign / len); }
    return true;
  };
  for (let i = 0; i < 3; i++) {
    const ra = ae[i], rb = be[0] * AR[i][0] + be[1] * AR[i][1] + be[2] * AR[i][2];
    const dist = Math.abs(t[i]); if (!consider(ra + rb - dist, A[i], t[i] >= 0 ? 1 : -1)) return null;
  }
  for (let j = 0; j < 3; j++) {
    const ra = ae[0] * AR[0][j] + ae[1] * AR[1][j] + ae[2] * AR[2][j], rb = be[j];
    const proj = t[0] * R[0][j] + t[1] * R[1][j] + t[2] * R[2][j], dist = Math.abs(proj);
    if (!consider(ra + rb - dist, B[j], proj >= 0 ? 1 : -1)) return null;
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const i1 = (i + 1) % 3, i2 = (i + 2) % 3, j1 = (j + 1) % 3, j2 = (j + 2) % 3;
    const ra = ae[i1] * AR[i2][j] + ae[i2] * AR[i1][j];
    const rb = be[j1] * AR[i][j2] + be[j2] * AR[i][j1];
    const dist = Math.abs(t[i2] * R[i1][j] - t[i1] * R[i2][j]);
    const axis = A[i].clone().cross(B[j]);
    const sign = dWorld.dot(axis) >= 0 ? 1 : -1;
    if (!consider(ra + rb - dist, axis, sign)) return null;
  }
  if (!bestNormal || !Number.isFinite(minPen)) return null;
  // Keep the contact convention consistent: every normal points from A toward B.
  if (bestNormal.dot(dWorld) < 0) bestNormal.multiplyScalar(-1);
  const pa = supportPoint(a, bestNormal), pb = supportPoint(b, bestNormal.clone().multiplyScalar(-1));
  return { normal: bestNormal, penetration: Math.max(0, minPen), point: pa.add(pb).multiplyScalar(0.5) };
}

function stableBoxBoxContact(a, b, sat = null) {
  sat = sat ?? boxBox(a, b); if (!sat) return null;
  const aa = aabbForBody(a, new THREE.Box3()), bb = b.aabb ?? aabbForBody(b, new THREE.Box3());
  const ovMin = new THREE.Vector3(Math.max(aa.min.x, bb.min.x), Math.max(aa.min.y, bb.min.y), Math.max(aa.min.z, bb.min.z));
  const ovMax = new THREE.Vector3(Math.min(aa.max.x, bb.max.x), Math.min(aa.max.y, bb.max.y), Math.min(aa.max.z, bb.max.z));
  const overlaps = [ovMax.x - ovMin.x, ovMax.y - ovMin.y, ovMax.z - ovMin.z];
  if (overlaps.some((v) => v <= 0)) return null;
  let axis = 0; if (overlaps[1] < overlaps[axis]) axis = 1; if (overlaps[2] < overlaps[axis]) axis = 2;
  const n = new THREE.Vector3(), names = ['x','y','z'], key = names[axis];
  n[key] = a.position[key] <= b.position[key] ? 1 : -1;
  const point = ovMin.clone().add(ovMax).multiplyScalar(0.5);
  return { normal: n, penetration: overlaps[axis], point };
}

function collide(a, b) {
  if (a.shape.type === 'sphere' && b.shape.type === 'sphere') return sphereSphere(a, b);
  if (a.shape.type === 'sphere' && b.shape.type === 'box') return sphereBox(a, b);
  if (a.shape.type === 'box' && b.shape.type === 'sphere') {
    const c = sphereBox(b, a); if (!c) return null; c.normal.multiplyScalar(-1); return c;
  }
  return stableBoxBoxContact(a, b);
}

// Static scene colliders are axis-aligned boxes. SAT is used to reject false positives, but a
// single SAT support point is not a full contact manifold; on a broad floor it can let a rotating
// box accumulate downward velocity. For static contacts choose the minimum AABB overlap axis as a
// stable manifold normal after the OBB-vs-box overlap has been confirmed.
function collideStatic(a, b) {
  if (a.shape.type === 'sphere') return sphereBox(a, b);
  return stableBoxBoxContact(a, b);
}

function integrateQuaternion(q, angular, dt) {
  const speed = angular.length(); if (speed < 1e-7) return;
  const dq = new THREE.Quaternion().setFromAxisAngle(angular.clone().multiplyScalar(1 / speed), speed * dt);
  q.premultiply(dq).normalize();
}

export class RigidShapeWorld {
  constructor(options = {}) {
    this.gravity = options.gravity ?? -9.81;
    this.bodies = [];
    this.staticBodies = [];
    this.nextId = 1;
    this.solverIterations = options.solverIterations ?? 3;
    this.maxSubsteps = options.maxSubsteps ?? 3;
    this._tmpAabb = new THREE.Box3();
    this.heightfield = null;
  }

  clearStatics() { this.staticBodies.length = 0; }
  setHeightfield(provider) { this.heightfield = provider || null; }
  setStaticBoxes(entries = [], addFloors = true) {
    this.clearStatics();
    for (const entry of entries) {
      const box = entry?.box; if (!box || box.isEmpty()) continue;
      const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      const st=this._makeBody({ position: center, shape: { type: 'box', halfExtents: size.multiplyScalar(0.5) }, mass: 0, friction: 0.76, restitution: 0.06, staticBody: true, tag: entry.mesh?.name || 'static' }); st.aabb=box.clone(); this.staticBodies.push(st);
    }
    if (addFloors) {
      for (const y of [0, 4.2, 8.4]) {
        const st=this._makeBody({ position: new THREE.Vector3(0, y - 0.10, 0), shape: { type: 'box', halfExtents: new THREE.Vector3(36, 0.10, 25) }, mass: 0, friction: 0.84, restitution: 0.04, staticBody: true, tag: `floor-${y}` }); st.aabb=aabbForBody(st,new THREE.Box3()); this.staticBodies.push(st);
      }
    }
  }

  _makeBody(desc) {
    const shape = desc.shape.type === 'sphere'
      ? { type: 'sphere', radius: Math.max(0.005, desc.shape.radius) }
      : { type: 'box', halfExtents: desc.shape.halfExtents.clone().max(new THREE.Vector3(0.005, 0.005, 0.005)) };
    const mass = Math.max(0, desc.mass ?? 1), radius = shapeRadius(shape);
    const inertia = mass > 0 ? Math.max(1e-5, (shape.type === 'sphere' ? 0.4 : 0.34) * mass * radius * radius) : Infinity;
    return {
      id: this.nextId++, mesh: desc.mesh ?? null, tag: desc.tag ?? '', userData: desc.userData ?? null,
      shape, position: desc.position?.clone?.() ?? desc.mesh?.position?.clone?.() ?? new THREE.Vector3(),
      quaternion: desc.quaternion?.clone?.() ?? desc.mesh?.quaternion?.clone?.() ?? new THREE.Quaternion(),
      velocity: desc.velocity?.clone?.() ?? new THREE.Vector3(), angularVelocity: desc.angularVelocity?.clone?.() ?? new THREE.Vector3(),
      mass, invMass: mass > 0 ? 1 / mass : 0, invInertia: mass > 0 ? 1 / inertia : 0,
      friction: clamp(desc.friction ?? 0.72, 0, 2), restitution: clamp(desc.restitution ?? 0.08, 0, 1),
      linearDamping: desc.linearDamping ?? 0.10, angularDamping: desc.angularDamping ?? 0.16,
      dynamicPairs: desc.dynamicPairs !== false, sleeping: false, sleepTime: 0, contactCount: 0,
      staticBody: Boolean(desc.staticBody || mass === 0), boundingRadius: radius,
    };
  }

  heightfieldContact(body) {
    const hf=this.heightfield; if(!hf?.contains?.(body.position.x,body.position.z)) return null;
    const h=hf.heightAt(body.position.x,body.position.z); if(h==null) return null;
    const aabb=aabbForBody(body,new THREE.Box3()); if(aabb.min.y>=h) return null;
    const up=hf.normalAt?.(body.position.x,body.position.z,new THREE.Vector3()) ?? new THREE.Vector3(0,1,0);
    const normal=up.clone().multiplyScalar(-1).normalize();
    return {normal,penetration:h-aabb.min.y,point:new THREE.Vector3(body.position.x,h,body.position.z)};
  }

  addBody(desc) { const body = this._makeBody(desc); this.bodies.push(body); this.syncMesh(body); return body; }
  removeBody(body) { const i = this.bodies.indexOf(body); if (i >= 0) this.bodies.splice(i, 1); }
  wake(body) { if (!body || body.staticBody) return; body.sleeping = false; body.sleepTime = 0; }
  syncMesh(body) { if (!body?.mesh) return; body.mesh.position.copy(body.position); body.mesh.quaternion.copy(body.quaternion); body.mesh.updateMatrixWorld(); }

  resolve(a, b, contact) {
    if (!contact || contact.penetration < 0) return;
    const totalInv = a.invMass + b.invMass; if (totalInv <= 0) return;
    const n = contact.normal, slop = 0.0015;
    const correction = Math.max(0, contact.penetration - slop) * 0.72 / totalInv;
    if (a.invMass) a.position.addScaledVector(n, -correction * a.invMass);
    if (b.invMass) b.position.addScaledVector(n, correction * b.invMass);
    const p = contact.point;
    const ra = p.clone().sub(a.position), rb = p.clone().sub(b.position);
    const va = a.velocity.clone().add(new THREE.Vector3().crossVectors(a.angularVelocity, ra));
    const vb = b.velocity.clone().add(new THREE.Vector3().crossVectors(b.angularVelocity, rb));
    const rv = vb.sub(va); const vn = rv.dot(n);
    if (vn < 0) {
      const ran = new THREE.Vector3().crossVectors(ra, n), rbn = new THREE.Vector3().crossVectors(rb, n);
      const denom = totalInv + a.invInertia * ran.lengthSq() + b.invInertia * rbn.lengthSq();
      if (denom > EPS) {
        const e = Math.min(a.restitution, b.restitution), j = -(1 + e) * vn / denom, impulse = n.clone().multiplyScalar(j);
        if (a.invMass) { a.velocity.addScaledVector(impulse, -a.invMass); a.angularVelocity.addScaledVector(new THREE.Vector3().crossVectors(ra, impulse), -a.invInertia); }
        if (b.invMass) { b.velocity.addScaledVector(impulse, b.invMass); b.angularVelocity.addScaledVector(new THREE.Vector3().crossVectors(rb, impulse), b.invInertia); }
        const va2 = a.velocity.clone().add(new THREE.Vector3().crossVectors(a.angularVelocity, ra));
        const vb2 = b.velocity.clone().add(new THREE.Vector3().crossVectors(b.angularVelocity, rb));
        const rv2 = vb2.sub(va2); const tangent = rv2.addScaledVector(n, -rv2.dot(n));
        const tl = tangent.length();
        if (tl > 1e-6) {
          tangent.multiplyScalar(1 / tl);
          const rat = new THREE.Vector3().crossVectors(ra, tangent), rbt = new THREE.Vector3().crossVectors(rb, tangent);
          const denomT = totalInv + a.invInertia * rat.lengthSq() + b.invInertia * rbt.lengthSq();
          if (denomT > EPS) {
            const jtRaw = -rv2.dot(tangent) / denomT, mu = Math.sqrt(a.friction * b.friction), jt = clamp(jtRaw, -j * mu, j * mu), fi = tangent.multiplyScalar(jt);
            if (a.invMass) { a.velocity.addScaledVector(fi, -a.invMass); a.angularVelocity.addScaledVector(new THREE.Vector3().crossVectors(ra, fi), -a.invInertia); }
            if (b.invMass) { b.velocity.addScaledVector(fi, b.invMass); b.angularVelocity.addScaledVector(new THREE.Vector3().crossVectors(rb, fi), b.invInertia); }
          }
        }
      }
    }
    // A one-point manifold is deliberately cheap. Remove any residual COM closing speed
    // after the angular impulse so stacks and broad face contacts cannot accumulate penetration.
    const rvLinear = b.velocity.clone().sub(a.velocity).dot(n);
    if (rvLinear < -1e-5) {
      const jLinear = -rvLinear / totalInv;
      if (a.invMass) a.velocity.addScaledVector(n, -jLinear * a.invMass);
      if (b.invMass) b.velocity.addScaledVector(n, jLinear * b.invMass);
    }
    if (!a.staticBody) { a.contactCount++; if (b.sleeping === false && b.invMass) this.wake(a); }
    if (!b.staticBody) { b.contactCount++; if (a.sleeping === false && a.invMass) this.wake(b); }
  }

  step(dt) {
    if (!(dt > 0)) return;
    let fastest = 0; for (const b of this.bodies) if (!b.sleeping) fastest = Math.max(fastest, b.velocity.length());
    const substeps = clamp(Math.ceil(fastest * dt / 0.38), 1, this.maxSubsteps), h = dt / substeps;
    for (let sub = 0; sub < substeps; sub++) {
      for (const b of this.bodies) {
        b.contactCount = 0; if (b.sleeping || b.staticBody) continue;
        b.velocity.y += this.gravity * h;
        b.velocity.multiplyScalar(Math.exp(-b.linearDamping * h));
        b.angularVelocity.multiplyScalar(Math.exp(-b.angularDamping * h));
        b.position.addScaledVector(b.velocity, h); integrateQuaternion(b.quaternion, b.angularVelocity, h);
      }
      for (let it = 0; it < this.solverIterations; it++) {
        for (const a of this.bodies) {
          if (a.sleeping || a.staticBody) continue;
          const aa = aabbForBody(a, this._tmpAabb);
          for (const b of this.staticBodies) {
            const bb = b.aabb; if (!bb || !aa.intersectsBox(bb)) continue;
            const c = collideStatic(a, b); if (c) { this.resolve(a, b, c); const vn = a.velocity.dot(c.normal); if (vn > 0) a.velocity.addScaledVector(c.normal, -vn); }
          }
          const hc=this.heightfieldContact(a);
          if(hc){
            // Ephemeral zero-mass body: the height field participates in the same impulse/friction
            // path as rigid boxes, but follows the local terrain normal and crater deformation.
            const ground={position:hc.point.clone(),invMass:0,invInertia:0,velocity:new THREE.Vector3(),angularVelocity:new THREE.Vector3(),friction:.88,restitution:.03,staticBody:true,sleeping:true};
            this.resolve(a,ground,hc); const vn=a.velocity.dot(hc.normal); if(vn>0)a.velocity.addScaledVector(hc.normal,-vn);
          }
        }
        for (let i = 0; i < this.bodies.length; i++) {
          const a = this.bodies[i]; if (a.staticBody || !a.dynamicPairs) continue;
          for (let j = i + 1; j < this.bodies.length; j++) {
            const b = this.bodies[j]; if (b.staticBody || !b.dynamicPairs || (a.sleeping && b.sleeping)) continue;
            const rr = a.boundingRadius + b.boundingRadius; if (a.position.distanceToSquared(b.position) > rr * rr * 1.15) continue;
            const c = collide(a, b); if (c) { if (a.sleeping) this.wake(a); if (b.sleeping) this.wake(b); this.resolve(a, b, c); }
          }
        }
      }
    }
    for (const b of this.bodies) {
      if (b.staticBody) continue;
      // Approximate rolling/contact friction for the single-manifold solver. This prevents tiny
      // contact torques from keeping rubble spinning forever while preserving free-flight motion.
      if (b.contactCount > 0 && !b.sleeping) {
        const lateral = Math.exp(-2.8 * dt), spin = Math.exp(-4.6 * dt);
        b.velocity.x *= lateral; b.velocity.z *= lateral; b.angularVelocity.multiplyScalar(spin);
      }
      const lin = b.velocity.lengthSq(), ang = b.angularVelocity.lengthSq();
      if (b.contactCount > 0 && lin < 0.018 && ang < 0.18) b.sleepTime += dt;
      else if (b.contactCount > 0 && lin < 0.32 && ang < 2.25) b.sleepTime += dt * 0.38;
      else b.sleepTime = 0;
      if (b.sleepTime > 0.58) { b.sleeping = true; b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0); }
      this.syncMesh(b);
    }
  }

  stats() { let sleeping = 0; for (const b of this.bodies) if (b.sleeping) sleeping++; return { dynamic: this.bodies.length, sleeping, static: this.staticBodies.length }; }
}

export function rigidShapeFromMesh(mesh, mode = 'box', padding = 0) {
  mesh.geometry.computeBoundingBox(); const box = mesh.geometry.boundingBox.clone();
  const size = box.getSize(new THREE.Vector3()); const s = mesh.scale;
  if (mode === 'sphere') return { type: 'sphere', radius: Math.max(0.01, Math.max(size.x * Math.abs(s.x), size.y * Math.abs(s.y), size.z * Math.abs(s.z)) * 0.5 + padding) };
  return { type: 'box', halfExtents: new THREE.Vector3(size.x * Math.abs(s.x) * 0.5 + padding, size.y * Math.abs(s.y) * 0.5 + padding, size.z * Math.abs(s.z) * 0.5 + padding) };
}
