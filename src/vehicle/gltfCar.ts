import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type CarSpec, axleHeight, restLength, rideHeight } from './cars.ts';
import type { CarModel, CarWheel } from './carModel.ts';

// Both models name their wheel groups the same way; three.js turns the spaces into underscores.
const WHEEL_NAMES = ['3DWheel_Front_L', '3DWheel_Front_R', '3DWheel_Rear_L', '3DWheel_Rear_R'];
const CALLIPER_NAMES = ['CalliperBody_Front_L', 'CalliperBody_Front_R', 'CalliperBody_Rear_L', 'CalliperBody_Rear_R'];

/**
 * Replaces everything under `root` with one mesh per material, in the space of `into`.
 * The Sián arrives as about 1,300 separate parts; drawn one by one, four times a frame
 * (depth pass, colour pass, shadow cascades), that alone would cost more than the city.
 */
function mergeInto(root: THREE.Object3D, into: THREE.Object3D) {
  root.updateWorldMatrix(true, true);
  into.updateWorldMatrix(true, false);
  const toLocal = new THREE.Matrix4().copy(into.matrixWorld).invert();
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const m = new THREE.Matrix4();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    let g = mesh.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (g.index) g = g.toNonIndexed();
    m.multiplyMatrices(toLocal, mesh.matrixWorld);
    g.applyMatrix4(m);
    if (m.determinant() < 0) {
      // A mirrored part (the right-hand wheels are the left ones flipped) comes out inside-out: rewind it.
      for (const attr of Object.values(g.attributes)) {
        const a = attr.array, n = attr.itemSize;
        for (let i = 0; i < attr.count; i += 3) {
          for (let k = 0; k < n; k++) {
            const t = a[(i + 1) * n + k];
            a[(i + 1) * n + k] = a[(i + 2) * n + k];
            a[(i + 2) * n + k] = t;
          }
        }
      }
    }
    const list = byMaterial.get(mesh.material) ?? [];
    list.push(g);
    byMaterial.set(mesh.material, list);
  });
  root.removeFromParent();
  for (const [material, list] of byMaterial) {
    const merged = mergeGeometries(list);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = material.name;
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = !material.transparent;
    into.add(mesh);
  }
}

function tuneMaterials(root: THREE.Object3D) {
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(material)) continue;
      seen.add(material);
      const mat = material as THREE.MeshPhysicalMaterial;
      if (mat.transmission > 0) {
        // Real refraction needs an extra pass over the whole scene; tinted alpha looks the same on car glass.
        mat.transmission = 0;
        mat.transparent = true;
        mat.opacity = Math.max(mat.opacity < 1 ? mat.opacity : 0, 0.38);
        mat.roughness = Math.min(mat.roughness, 0.06);
        mat.depthWrite = false;
      }
      if (/paint|coloured/i.test(mat.name) && mat.isMeshPhysicalMaterial) {
        mat.clearcoat = 1;
        mat.clearcoatRoughness = 0.05;
      }
    }
  });
}

/** Loads a car from public/models/<folder>/scene.gltf, sized to its real length and standing on y = 0. */
export async function loadGltfCar(base: CarSpec): Promise<CarModel> {
  const url = `${import.meta.env.BASE_URL}models/${base.model}/scene.gltf`;
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  tuneMaterials(root);

  // The files are a hundredth of life size; scale by the one number that is published for certain.
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  root.scale.multiplyScalar(base.length / size.z);
  box.setFromObject(root);
  const centre = box.getCenter(new THREE.Vector3());
  root.position.set(-centre.x, -box.min.y, -centre.z);
  root.updateWorldMatrix(true, true);

  // Measure the wheels before the model is flattened, so physics and picture agree.
  const measured = WHEEL_NAMES.map((name) => {
    const node = root.getObjectByName(name);
    if (!node) throw new Error(`${base.name}: no wheel group called ${name}`);
    const b = new THREE.Box3().setFromObject(node);
    return { node, centre: b.getCenter(new THREE.Vector3()), radius: (b.max.y - b.min.y) / 2 };
  });
  const [fl, fr, rl, rr] = measured;
  const spec: CarSpec = {
    ...base,
    track: (fl.centre.x - fr.centre.x + rl.centre.x - rr.centre.x) / 4,
    axleFront: (fl.centre.z + fr.centre.z) / 2,
    axleRear: (rl.centre.z + rr.centre.z) / 2,
    wheelRadius: (fl.radius + fr.radius + rl.radius + rr.radius) / 4,
    height: box.max.y - box.min.y,
  };

  const group = new THREE.Group();
  group.name = `car-${base.id}`;
  const body = new THREE.Group();
  body.position.y = -rideHeight(spec);
  group.add(body);

  const wheels: CarWheel[] = measured.map((w, i) => {
    const pivot = new THREE.Group();
    const spin = new THREE.Group();
    const x = i % 2 === 0 ? spec.track : -spec.track;
    const z = i < 2 ? spec.axleFront : spec.axleRear;
    const lift = w.radius - spec.wheelRadius;
    pivot.position.set(x, axleHeight(spec) - restLength(spec) + lift, z);
    pivot.add(spin);
    group.add(pivot);
    // Re-express the wheel's parts relative to its own centre, so it can roll and steer about it.
    const holder = new THREE.Group();
    holder.position.copy(w.centre);
    mergeInto(w.node, holder);
    spin.add(...holder.children);
    // brake callipers steer and ride with the wheel, but do not roll
    const calliper = root.getObjectByName(CALLIPER_NAMES[i]);
    if (calliper) {
      mergeInto(calliper, holder);
      pivot.add(...holder.children);
    }
    return { pivot, spin, lift };
  });

  const flat = new THREE.Group();
  mergeInto(root, flat);
  body.add(flat);

  // Lamp lenses: one atlas material per model, lit as a whole.
  const lenses: THREE.MeshStandardMaterial[] = [];
  group.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (mat?.isMeshStandardMaterial && /light/i.test(mat.name) && !lenses.includes(mat)) {
      if (!mat.emissiveMap) mat.emissive.setHex(0xfff0dc);
      lenses.push(mat);
    }
  });
  const glow0 = lenses.map((m) => m.emissiveIntensity);
  return {
    spec, group, wheels,
    setBraking() {},
    setLights(on) {
      lenses.forEach((m, i) => (m.emissiveIntensity = on ? Math.max(glow0[i], 1) * 3 : m.emissiveMap ? glow0[i] : 0));
    },
  };
}
