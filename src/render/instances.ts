import * as THREE from 'three/webgpu';
import { Fn, attribute, dot, materialColor, max, normalLocal, positionLocal, vec4 } from 'three/tsl';

// per copy: the three columns of its rotation and scale, where it stands, and its tint
const STRIDE = 15;
const _x = new THREE.Vector3();

const place = Fn(() => {
  const a = attribute('ia', 'vec3'), b = attribute('ib', 'vec3'), c = attribute('ic', 'vec3');
  const n = a.mul(normalLocal.x.div(max(dot(a, a), 1e-8))).add(b.mul(normalLocal.y.div(max(dot(b, b), 1e-8)))).add(c.mul(normalLocal.z.div(max(dot(c, c), 1e-8))));
  normalLocal.assign(n.normalize());
  return a.mul(positionLocal.x).add(b.mul(positionLocal.y)).add(c.mul(positionLocal.z)).add(attribute('it', 'vec3'));
});

/** Makes a material draw `Instances`. `tinted` multiplies in each copy's own colour. */
export function instanced<T extends THREE.NodeMaterial>(material: T, tinted = false): T {
  material.positionNode = place();
  if (tinted) material.colorNode = materialColor.mul(vec4(attribute('icol', 'vec3'), 1));
  return material;
}

/**
 * Many copies of one shape in a single draw call, like three's InstancedMesh. The renderer builds a shader of
 * its own for every InstancedMesh it meets, a tenth of a second or more each time one first comes into view;
 * with a city of them arriving as the car drives, that was the game freezing. These are plain meshes whose
 * copies are placed by the material, so every one after the first reuses the shader already built.
 */
export class Instances extends THREE.Mesh<THREE.InstancedBufferGeometry> {
  /** set `needsUpdate` after `setMatrixAt`, as with InstancedMesh */
  readonly instanceMatrix: { needsUpdate: boolean };
  /** set once `dispose` has run */
  disposed = false;
  private data: Float32Array;
  private shape: THREE.BufferGeometry;

  constructor(shape: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], poses: THREE.Matrix4[], movable = false) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = shape.index;
    for (const name in shape.attributes) g.setAttribute(name, shape.attributes[name]);
    for (const { start, count, materialIndex } of shape.groups) g.addGroup(start, count, materialIndex);
    const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(poses.length * STRIDE), STRIDE);
    if (movable) buffer.setUsage(THREE.DynamicDrawUsage);
    ['ia', 'ib', 'ic', 'it', 'icol'].forEach((name, k) => g.setAttribute(name, new THREE.InterleavedBufferAttribute(buffer, 3, k * 3)));
    g.instanceCount = poses.length;
    super(g, material);
    this.shape = shape;
    this.data = buffer.array as Float32Array;
    this.instanceMatrix = {
      get needsUpdate() {
        return false;
      },
      set needsUpdate(v: boolean) {
        if (v) buffer.needsUpdate = true;
      },
    };
    if (!shape.boundingSphere) shape.computeBoundingSphere();
    const reach = shape.boundingSphere!.center.length() + shape.boundingSphere!.radius;
    const box = new THREE.Box3();
    let scale = 0;
    poses.forEach((m, i) => {
      this.setMatrixAt(i, m);
      this.data.fill(1, i * STRIDE + 12, i * STRIDE + 15);
      box.expandByPoint(_x.setFromMatrixPosition(m));
      scale = Math.max(scale, m.getMaxScaleOnAxis());
    });
    // Bounds cover every copy, padded for furniture that gets knocked about, so the renderer can skip the lot
    // when it is off screen or outside the shadow.
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    g.boundingSphere.radius += reach * scale + 25;
  }

  setMatrixAt(i: number, m: THREE.Matrix4) {
    const e = m.elements;
    this.data.set([e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]], i * STRIDE);
  }

  setColorAt(i: number, c: THREE.Color) {
    this.data.set([c.r, c.g, c.b], i * STRIDE + 12);
  }

  /** Frees this mesh's own data and leaves the shape, which every other copy of it still uses. */
  dispose() {
    const g = this.geometry;
    this.disposed = true;
    g.setIndex(null);
    for (const name in this.shape.attributes) g.deleteAttribute(name);
    g.dispose();
  }
}
