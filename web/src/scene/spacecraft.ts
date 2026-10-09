// A 3D model of the selected object, drawn at true scale where it actually is.
//
// The catalogue has no shapes, so each object gets a stylised model of its
// class (Starlink by hardware generation, a generic satellite bus, a rocket
// stage, a fragment), plus a named one for Tiangong. The ISS and Hubble load NASA's own models (see
// ASSETS), with the stylised ones standing in until they arrive. Models are in metres and
// scaled to the scene's kilometres. Working spacecraft hold a nadir-pointing
// attitude (+X along track, +Z to the zenith) and turn their solar arrays to the
// Sun; rocket bodies, fragments and dead satellites tumble.

import * as THREE from 'three/webgpu';
import { color, float, mrt, normalView, positionView, uniform } from 'three/tsl';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Category, starlinkVersion } from '../sim/catalog';
import { highp } from './precision';

export type Kind = 'starlink-v1' | 'starlink-v2' | 'starlink-v3' | 'satellite' | 'derelict' | 'hubble' | 'iss' | 'tiangong' | 'rocket' | 'fragment';

export function kindOf(name: string, category: number, norad = 0): Kind {
  if (name.startsWith('ISS (')) return 'iss';
  if (name.startsWith('CSS (')) return 'tiangong';
  if (name === 'HST') return 'hubble';
  if (category === Category.RocketBody || /\bR\/B\b/.test(name)) return 'rocket';
  if (/\bDEB\b/.test(name)) return 'fragment';
  // the debris group also holds intact satellites that have died (COSMOS 2251, IRIDIUM 33)
  if (category === Category.Debris) return 'derelict';
  if (category === Category.Starlink) return `starlink-v${starlinkVersion(norad)}`;
  return 'satellite';
}

interface Model {
  root: THREE.Group;
  /** metres from the object's centre to its farthest point */
  radius: number;
  /** solar array mounts: turned about their Y axis so the cells (+Z) face the Sun */
  trackers: THREE.Object3D[];
  tumble: { axis: THREE.Vector3; rate: number; q0: THREE.Quaternion } | null;
  /** geometry belongs to a cached asset: not ours to dispose */
  shared?: boolean;
}

// ------------------------------------------------------------------ materials

/** Solar cells: a 4 × 4 grid of dark blue cells with silver busbars per 0.6 m tile. */
const CELL_TILE_M = 0.6;

function cellTexture(): THREE.Texture {
  const px = 128, n = 4, c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6d7586';
  g.fillRect(0, 0, px, px);
  const s = px / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const grad = g.createLinearGradient(i * s, j * s, (i + 1) * s, (j + 1) * s);
      grad.addColorStop(0, '#1b2f63');
      grad.addColorStop(1, '#0d1a3d');
      g.fillStyle = grad;
      g.fillRect(i * s + 1.5, j * s + 1.5, s - 3, s - 3);
      g.fillStyle = 'rgba(150, 165, 190, 0.35)';
      for (let k = 1; k < 4; k++) g.fillRect(i * s + 1.5, j * s + (k * s) / 4, s - 3, 0.6);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/**
 * 0 in sunlight, 1 in shadow: a faint rim keeps the silhouette readable against the night side.
 * Materials are shared between Spacecraft instances, so the value is read per mesh, from its owner.
 */
const shadowRim = uniform(0).onObjectUpdate(({ object }) => (object?.userData.shade as { rim: number } | undefined)?.rim ?? 0);

const facing = normalView.dot(positionView.negate().normalize()).abs();
const rim = color('#6f93d4').mul(float(1).sub(facing).pow(2).mul(1.3).add(0.07).mul(shadowRim));

/** Every model material: float64 model-view, out of the bloom pass (SceneController), rim in shadow. */
function nodeMaterial(p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardNodeMaterial {
  const x = new THREE.MeshStandardNodeMaterial(p);
  x.contextNode = highp();
  x.mrtNode = mrt({ bloom: float(0) });
  if (!p.emissiveMap) x.emissiveNode = rim;
  return x;
}

let mats: ReturnType<typeof makeMaterials> | null = null;
function makeMaterials() {
  const m = nodeMaterial;
  return {
    cells: m({ map: cellTexture(), roughness: 0.55, metalness: 0.15 }),
    backsheet: m({ color: '#b9b4a8', roughness: 0.85 }),
    frame: m({ color: '#8d8f93', roughness: 0.45, metalness: 0.5 }),
    /** multi-layer insulation, the crinkled foil on most spacecraft */
    gold: m({ color: '#d0a24e', roughness: 0.42, metalness: 0.45 }),
    silver: m({ color: '#c7cbd2', roughness: 0.35, metalness: 0.45 }),
    white: m({ color: '#e4e3de', roughness: 0.75 }),
    /** open shells (dishes, nozzles) are seen from both sides */
    whiteShell: m({ color: '#e4e3de', roughness: 0.75, side: THREE.DoubleSide }),
    darkShell: m({ color: '#2e3035', roughness: 0.55, metalness: 0.25, side: THREE.DoubleSide }),
    grey: m({ color: '#7b7e84', roughness: 0.6, metalness: 0.3 }),
    dark: m({ color: '#2e3035', roughness: 0.55, metalness: 0.25 }),
    black: m({ color: '#121316', roughness: 0.7 }),
  };
}
const M = () => (mats ??= makeMaterials());
type Mat = keyof ReturnType<typeof makeMaterials>;

// ------------------------------------------------------------------ primitives (metres)

function box(mat: Mat, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), M()[mat]);
  mesh.position.set(x, y, z);
  return mesh;
}

/** Cylinder along `axis`, centred at (x, y, z); rTop is the +axis end. */
function cyl(mat: Mat, r: number, len: number, axis: 'x' | 'y' | 'z', x = 0, y = 0, z = 0, rTop = r, segments = 32): THREE.Mesh {
  const g = new THREE.CylinderGeometry(rTop, r, len, segments);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(g, M()[mat]);
  mesh.position.set(x, y, z);
  return mesh;
}

/** A flat solar panel, cells on +Z. */
function panel(sx: number, sy: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const g = new THREE.BoxGeometry(sx, sy, 0.05);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * sx) / CELL_TILE_M, (uv.getY(i) * sy) / CELL_TILE_M);
  const m = M();
  const mesh = new THREE.Mesh(g, [m.frame, m.frame, m.frame, m.frame, m.cells, m.backsheet]);
  mesh.position.set(x, y, z);
  return mesh;
}

/** A parabolic dish opening towards `dir` (±1 along Z), rim radius r, depth d. */
function dish(r: number, d: number, dir: 1 | -1): THREE.Mesh {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const u = (i / 12) * r;
    pts.push(new THREE.Vector2(u, (d * u * u) / (r * r)));
  }
  const g = new THREE.LatheGeometry(pts, 40);
  g.rotateX(dir * (Math.PI / 2));
  return new THREE.Mesh(g, M().whiteShell);
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTumble(rand: () => number, minDegS: number, maxDegS: number): Model['tumble'] {
  const axis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
  const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 6.28, rand() * 6.28, rand() * 6.28));
  return { axis, q0, rate: THREE.MathUtils.degToRad(minDegS + (maxDegS - minDegS) * rand()) };
}

// ------------------------------------------------------------------ models

/** A Starlink array wing off the bus's `side` (±1) Y edge at `edge` m: a boom, then `panels` panels end to end. */
function starlinkWing(side: 1 | -1, edge: number, boom: number, w: number, l: number, panels: number): THREE.Group {
  const wing = new THREE.Group();
  wing.position.set(0, side * (edge + boom), 0.1);
  wing.add(box('frame', 0.12, boom, 0.12, 0, (-side * boom) / 2, 0));
  for (let k = 0; k < panels; k++) wing.add(panel(w, l, 0, side * (0.1 + l / 2 + k * (l + 0.2)), 0));
  return wing;
}

/** V1.0 and V1.5: a ~300 kg flat-pack with one 2.8 × 8.1 m array (the V1.5's laser terminals included). */
function starlinkV1(): Partial<Model> {
  const root = new THREE.Group();
  root.add(box('dark', 2.8, 1.4, 0.25));
  for (const [x, y] of [[-0.7, -0.35], [-0.7, 0.35], [0.7, -0.35], [0.7, 0.35]]) root.add(box('white', 1.2, 0.6, 0.05, x, y, -0.15));
  for (const x of [-0.9, 0.9]) root.add(cyl('silver', 0.12, 0.22, 'z', x, 0.35, 0.23));
  root.add(cyl('grey', 0.08, 0.25, 'x', -1.5, 0, 0, 0.12));
  const wing = starlinkWing(-1, 0.7, 0.9, 2.8, 8.1, 1);
  root.add(wing);
  return { root, trackers: [wing] };
}

/** V2 Mini (and its Optimized and Direct-to-Cell variants): ~800 kg, two ~50 m² panels on one boom. */
function starlinkV2(): Partial<Model> {
  const root = new THREE.Group();
  root.add(box('dark', 4.1, 2.7, 0.35));
  // phased-array antennas and laser terminals
  for (const [x, y] of [[-1.2, -0.6], [-1.2, 0.6], [1.2, -0.6], [1.2, 0.6]]) root.add(box('white', 1.3, 1.0, 0.06, x, y, -0.2));
  for (const x of [-1.5, 0, 1.5]) root.add(cyl('silver', 0.16, 0.3, 'z', x, -0.9, 0.32));
  root.add(cyl('grey', 0.12, 0.35, 'x', -2.2, 0, 0, 0.18));
  // one long array on a boom off the -Y edge
  const wing = starlinkWing(-1, 1.35, 1.55, 4.0, 12.4, 2);
  root.add(wing);
  return { root, trackers: [wing] };
}

/**
 * V3, launched by Starship: ~1.9 t, a 7-8 m bus and a ~60 m span. SpaceX hasn't
 * published its layout, so this is a scaled-up V2 Mini with a two-panel wing each side.
 */
function starlinkV3(): Partial<Model> {
  const root = new THREE.Group();
  root.add(box('dark', 7.4, 2.7, 0.6));
  for (const x of [-2.4, 0, 2.4]) for (const y of [-0.62, 0.62]) root.add(box('white', 2.2, 1.1, 0.06, x, y, -0.33));
  for (const x of [-3.0, -1.0, 1.0, 3.0]) root.add(cyl('silver', 0.2, 0.36, 'z', x, x < 0 ? -0.9 : 0.9, 0.48));
  for (const y of [-0.6, 0.6]) root.add(cyl('grey', 0.16, 0.45, 'x', -3.9, y, 0, 0.24));
  const wings = ([1, -1] as const).map((s) => starlinkWing(s, 1.35, 1.2, 4.4, 13.5, 2));
  root.add(...wings);
  return { root, trackers: wings };
}

function bus(rand: () => number): Partial<Model> {
  const root = new THREE.Group();
  const w = 1.4 + rand() * 0.8, h = 1.6 + rand() * 0.8;
  root.add(box('gold', w, w, h));
  root.add(box('silver', w * 1.02, w * 1.02, 0.08, 0, 0, h / 2));
  // Earth-facing dish and its feed
  const d = dish(w * 0.38, w * 0.1, -1);
  d.position.set(w * 0.1, 0, -h / 2 - 0.05);
  root.add(d, cyl('frame', 0.03, w * 0.25, 'z', w * 0.1, 0, -h / 2 - w * 0.12), cyl('grey', 0.06, 0.12, 'z', w * 0.1, 0, -h / 2 - w * 0.26));
  root.add(cyl('grey', 0.05, 0.6, 'z', -w * 0.3, w * 0.3, h / 2 + 0.3), cyl('dark', 0.1, 0.25, 'x', -w / 2 - 0.12, 0, 0, 0.06));
  const trackers: THREE.Object3D[] = [];
  const panels = 2 + Math.floor(rand() * 3), pw = 1.5 + rand() * 0.5, pl = 1.6 + rand() * 0.6;
  for (const s of [1, -1]) {
    const wing = new THREE.Group();
    wing.position.set(0, (s * w) / 2, 0);
    wing.add(box('frame', 0.06, 0.9, 0.06, 0, s * 0.45, 0));
    for (let k = 0; k < panels; k++) wing.add(panel(pw, pl, 0, s * (0.9 + pl / 2 + k * (pl + 0.06)), 0));
    root.add(wing);
    trackers.push(wing);
  }
  return { root, trackers };
}

function hubble(): Partial<Model> {
  const root = new THREE.Group();
  root.add(cyl('silver', 2.1, 8.7, 'x', 2.0, 0, 0)); // light shield and forward shell
  root.add(cyl('silver', 2.2, 4.4, 'x', -4.5, 0, 0)); // equipment section
  root.add(cyl('grey', 2.2, 0.15, 'x', -2.2, 0, 0));
  root.add(cyl('dark', 2.0, 0.6, 'x', -7.0, 0, 0, 2.2));
  const door = cyl('silver', 2.05, 0.12, 'x', 0, 0, 0, 2.05);
  door.position.set(6.6, 0, 2.15);
  door.rotation.y = -1.2;
  root.add(door);
  const trackers: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const wing = new THREE.Group();
    wing.position.set(-1.5, s * 2.25, 0);
    wing.add(box('frame', 0.08, 0.9, 0.08, 0, s * 0.45, 0), panel(2.6, 7.1, 0, s * 4.5, 0));
    root.add(wing);
    trackers.push(wing);
    const hga = dish(0.65, 0.18, 1);
    hga.position.set(-3.5, s * 2.8, 2.6);
    root.add(hga, box('frame', 0.06, 0.06, 2.4, -3.5, s * 2.8, 1.4));
  }
  return { root, trackers };
}

function iss(): Partial<Model> {
  const root = new THREE.Group();
  const Z_TRUSS = 4.6;
  // integrated truss along the orbit normal, modules strung along the track below it
  root.add(box('grey', 3.6, 92, 3.2, 0, 0, Z_TRUSS));
  root.add(box('grey', 2.6, 18, 2.6, 0, 52, Z_TRUSS), box('grey', 2.6, 18, 2.6, 0, -52, Z_TRUSS));
  for (let y = -44; y <= 44; y += 4) root.add(box('frame', 3.7, 0.2, 3.3, 0, y, Z_TRUSS));
  const modules: [number, number, number][] = [
    // x centre, length, radius
    [17.5, 7.2, 2.2], // Harmony
    [9.0, 8.5, 2.15], // Destiny
    [2.8, 5.5, 2.3], // Unity
    [-6.5, 12.6, 2.05], // Zarya
    [-19.5, 13.1, 2.07], // Zvezda
  ];
  for (const [x, len, r] of modules) root.add(cyl('white', r, len, 'x', x, 0, 0));
  root.add(cyl('white', 2.25, 6.9, 'y', 17.5, 6.0, 0), cyl('white', 2.2, 11.2, 'y', 17.5, -7.6, 0)); // Columbus, Kibo
  root.add(box('grey', 5.0, 4.8, 1.2, 17.5, -15.2, 0.6)); // Kibo exposed facility
  root.add(cyl('white', 1.4, 4.0, 'z', -6.5, 0, -3.8), cyl('white', 1.3, 6.5, 'z', -12.0, 0, -4.2)); // nadir docking modules
  root.add(cyl('white', 1.35, 7.0, 'x', -29.5, 0, 0, 1.1)); // Progress at the aft port
  // radiators hang from the inner truss
  for (const s of [1, -1]) for (let k = 0; k < 3; k++) root.add(box('white', 0.15, 3.4, 13, 2.8, s * (14 + k * 3.7), Z_TRUSS - 8.6));
  // Zvezda's own arrays
  const trackers: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const w = new THREE.Group();
    w.position.set(-21, s * 2.2, 0);
    w.add(panel(2.2, 10.5, 0, s * 5.6, 0));
    root.add(w);
    trackers.push(w);
  }
  // four photovoltaic modules, each with two 35 m wings; the alpha joints turn them to the Sun
  for (const y of [-56, -43, 43, 56]) {
    const pv = new THREE.Group();
    pv.position.set(0, y, Z_TRUSS);
    for (const s of [1, -1]) {
      pv.add(box('frame', 34, 0.25, 0.25, s * 18.5, 0, 0)); // mast
      pv.add(panel(34, 4.6, s * 18.5, 2.75, 0), panel(34, 4.6, s * 18.5, -2.75, 0));
    }
    root.add(pv);
    trackers.push(pv);
  }
  return { root, trackers };
}

function tiangong(): Partial<Model> {
  const root = new THREE.Group();
  root.add(cyl('white', 2.1, 10.5, 'x', -4.2, 0, 0), cyl('white', 1.4, 5.5, 'x', 3.8, 0, 0)); // Tianhe
  root.add(new THREE.Mesh(new THREE.SphereGeometry(1.45, 24, 16), M().white).translateX(7.4)); // node
  root.add(cyl('dark', 2.1, 0.3, 'x', -9.6, 0, 0));
  const trackers: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    root.add(cyl('white', 2.1, 15.5, 'y', 7.4, s * 9.3, 0)); // Wentian, Mengtian
    const pv = new THREE.Group();
    pv.position.set(7.4, s * 15.5, 0);
    for (const t of [1, -1]) pv.add(box('frame', 27, 0.2, 0.2, t * 15, 0, 0), panel(27, 4.2, t * 15, 0, 0.12));
    root.add(pv);
    trackers.push(pv);
  }
  return { root, trackers };
}

function rocket(rand: () => number): Partial<Model> {
  const root = new THREE.Group();
  const r = 1.2 + rand() * 0.6, len = 6 + rand() * 4;
  root.add(cyl('white', r, len, 'x'));
  root.add(cyl('dark', r * 1.01, len * 0.08, 'x', len * 0.22, 0, 0));
  root.add(cyl('gold', r * 0.75, 0.9, 'x', len / 2 + 0.45, 0, 0, r * 0.55)); // payload adapter
  root.add(cyl('grey', r, 0.4, 'x', -len / 2 - 0.2, 0, 0, r * 0.6)); // thrust structure
  const bell: THREE.Vector2[] = [];
  for (let i = 0; i <= 10; i++) bell.push(new THREE.Vector2(0.18 * r + 0.55 * r * (i / 10) ** 1.6, -1.6 * r * (i / 10)));
  const g = new THREE.LatheGeometry(bell, 36);
  g.rotateZ(Math.PI / 2);
  const nozzle = new THREE.Mesh(g, M().darkShell);
  nozzle.position.x = -len / 2 - 0.4;
  root.add(nozzle);
  return { root, trackers: [], tumble: randomTumble(rand, 0.5, 3) };
}

function fragment(rand: () => number): Partial<Model> {
  const root = new THREE.Group();
  let g: THREE.BufferGeometry = mergeVertices(new THREE.IcosahedronGeometry(1, 1).deleteAttribute('normal').deleteAttribute('uv'));
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.7 + 0.6 * rand()), p.getY(i) * (0.7 + 0.6 * rand()), p.getZ(i) * (0.7 + 0.6 * rand()));
  g = g.toNonIndexed();
  g.computeVertexNormals();
  const size = 0.15 + 0.6 * rand();
  g.scale(size, size * (0.4 + 0.4 * rand()), size * (0.1 + 0.25 * rand()));
  const mats: Mat[] = ['gold', 'silver', 'grey', 'dark'];
  root.add(new THREE.Mesh(g, M()[mats[Math.floor(rand() * mats.length)]]));
  if (rand() < 0.5) {
    const shard = panel(size * 0.9, size * 0.6);
    shard.position.set(size * 0.3, 0, size * 0.15);
    shard.rotation.set(rand(), rand(), rand());
    root.add(shard);
  }
  return { root, trackers: [], tumble: randomTumble(rand, 2, 12) };
}

function build(kind: Kind, seed: number): Model {
  const rand = mulberry32(seed * 2654435761);
  const parts =
    kind === 'starlink-v1' ? starlinkV1()
    : kind === 'starlink-v2' ? starlinkV2()
    : kind === 'starlink-v3' ? starlinkV3()
    : kind === 'iss' ? iss()
    : kind === 'tiangong' ? tiangong()
    : kind === 'hubble' ? hubble()
    : kind === 'rocket' ? rocket(rand)
    : kind === 'fragment' ? fragment(rand)
    : bus(rand);
  const root = parts.root!;
  let trackers = parts.trackers ?? [];
  let tumble = parts.tumble ?? null;
  if (kind === 'derelict') {
    // dead: arrays stuck wherever they stopped, the whole thing slowly turning
    for (const t of trackers) t.rotation.y = (rand() - 0.5) * 2;
    trackers = [];
    tumble = randomTumble(rand, 0.3, 2);
  }
  return { root, radius: radiusOf(root), trackers, tumble };
}

/** Distance from the root's origin to its farthest vertex. */
function radiusOf(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  let radius = 0;
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) radius = Math.max(radius, v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).length());
  });
  return radius;
}

// ------------------------------------------------------------------ NASA models

type Axis = [number, number, number];

interface Asset {
  url: string;
  metresPerUnit: number;
  /** where the file's x, y and z axes point in our frame (+X along track, +Y orbit normal, +Z zenith) */
  axes: [Axis, Axis, Axis];
  /** meshes to leave out, by name */
  drop?: RegExp;
  /** what turns about +Y to face the Sun: the meshes whose material matches, or the whole model */
  track?: RegExp | 'all';
  /** restyle by material name (first match wins), for files whose own materials are placeholders */
  restyle?: [RegExp, THREE.MeshStandardMaterialParameters][];
}

/**
 * Models from NASA 3D Resources (science.nasa.gov/3d-resources), free to use
 * without copyright under NASA's media guidelines.
 */
const ASSETS: Partial<Record<Kind, Asset>> = {
  // Hubble Space Telescope (A), DigitalSpace Corporation. Modelled in inches, long axis on
  // y, arrays spanning x and facing z. Laid along the orbit normal, it rolls to keep its
  // arrays on the Sun.
  hubble: {
    url: '/models/hubble.glb',
    metresPerUnit: 0.0254,
    axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    track: 'all',
  },
  // International Space Station (ISS) (B), Michael D. Carbajal. Truss on z (45.8 units for
  // its 109 m), modules on y, arrays facing x. Every material is the same grey, so parts
  // are restyled by material name. Seven small parts float ~100 m off the station: dropped.
  iss: {
    url: '/models/iss.glb',
    metresPerUnit: 109 / 45.8,
    axes: [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    drop: /^(bendedtru|pCylinder)/,
    track: /^lambert7SG/, // the eight main array wings, turned by the alpha joints about the truss
    restyle: [
      [/^lambert7SG/, { color: '#6e5130', roughness: 0.45, metalness: 0.35 }], // solar arrays
      [/^lambert3SG|^bendedtruss/, { color: '#8e9096', roughness: 0.5, metalness: 0.5 }], // truss
      [/^soyuz_blinn4SG/, { color: '#eef0f2', roughness: 0.6 }], // radiators
      [/./, { color: '#dcdbd5', roughness: 0.7 }], // modules: white thermal blankets
    ],
  },
};

let gltf: GLTFLoader | null = null;
const assets = new Map<string, Promise<THREE.Group>>();

/**
 * Load (once) and normalise an asset: our materials, metres, our axes, centred on
 * its bounding box. Sun-tracking parts sit under groups named 'tracker'.
 */
function loadAsset(cfg: Asset): Promise<THREE.Group> {
  let p = assets.get(cfg.url);
  if (p) return p;
  gltf ??= new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath('/draco/'));
  p = gltf.loadAsync(cfg.url).then(({ scene }) => {
    if (cfg.drop) scene.getObjectsByProperty('isMesh', true).filter((o) => cfg.drop!.test(o.name)).forEach((o) => o.removeFromParent());
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const convert = (m: THREE.Material) => {
        const s = m as THREE.MeshStandardMaterial;
        const style = cfg.restyle?.find(([re]) => re.test(s.name))?.[1];
        return nodeMaterial({
          name: s.name,
          side: s.side,
          ...(style ?? {
            color: s.color, map: s.map, normalMap: s.normalMap, roughness: s.roughness, metalness: s.metalness,
            roughnessMap: s.roughnessMap, metalnessMap: s.metalnessMap, emissive: s.emissive, emissiveMap: s.emissiveMap,
            transparent: s.transparent, opacity: s.opacity, alphaTest: s.alphaTest,
          }),
        });
      };
      o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
    });
    const unit = new THREE.Group();
    unit.add(scene);
    const [ax, ay, az] = cfg.axes.map((a) => new THREE.Vector3(...a));
    unit.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ax, ay, az));
    unit.scale.setScalar(cfg.metresPerUnit);
    unit.updateMatrixWorld(true);
    unit.position.sub(new THREE.Box3().setFromObject(unit).getCenter(new THREE.Vector3()));
    const root = new THREE.Group();
    root.add(unit);
    root.updateMatrixWorld(true);
    if (cfg.track) {
      const tracker = new THREE.Group();
      tracker.name = 'tracker';
      if (cfg.track === 'all') {
        tracker.add(unit);
      } else {
        const re = cfg.track;
        const parts = root.getObjectsByProperty('isMesh', true).filter((o) => [(o as THREE.Mesh).material].flat().some((m) => re.test(m.name)));
        // the pivot: the parts' centre, which for wings in opposed pairs lies on their joints' axis
        const box = new THREE.Box3();
        for (const o of parts) box.expandByObject(o);
        tracker.position.copy(box.getCenter(new THREE.Vector3()));
        root.updateMatrixWorld(true);
        for (const o of parts) tracker.attach(o);
      }
      root.add(tracker);
    }
    return root;
  });
  p.catch(() => assets.delete(cfg.url)); // a failed load can be retried on the next selection
  assets.set(cfg.url, p);
  return p;
}

// ------------------------------------------------------------------ scene object

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();

/** Orbital frame of a state vector: +X along track, +Y along the orbit normal, +Z to the zenith. */
export function orbitFrame(pos: THREE.Vector3, vel: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _z.copy(pos).normalize();
  _x.copy(vel).addScaledVector(_z, -vel.dot(_z)).normalize();
  _y.crossVectors(_z, _x);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

export class Spacecraft {
  /** sits at the object, unrotated; hosts the lights */
  readonly object = new THREE.Group();
  private body = new THREE.Group();
  private model: Model | null = null;
  private forIndex = -1;
  private sun = new THREE.DirectionalLight('#fff6ec', 3);
  private earthshine = new THREE.DirectionalLight('#9dbbf0', 0.6);
  private shade = { rim: 0 };
  private ambient = new THREE.AmbientLight('#c8d4ff', 0.18); // keeps a model in Earth's shadow readable

  constructor() {
    this.body.scale.setScalar(0.001); // m -> km
    this.sun.target = this.object;
    this.earthshine.target = this.object;
    this.object.add(this.body, this.sun, this.earthshine, this.ambient);
    this.object.visible = false;
    this.object.frustumCulled = false;
  }

  /** km from the object's centre to its farthest point (0 with nothing shown) */
  get radiusKm(): number {
    return this.model ? this.model.radius / 1000 : 0;
  }

  /** Build the model for catalogue object `index` (cached while it stays the same). */
  setObject(index: number | null, name = '', category = 0, norad = 0) {
    if (index === this.forIndex) return;
    this.forIndex = index ?? -1;
    if (index === null) return this.show(null);
    const kind = kindOf(name, category, norad);
    this.show(build(kind, norad || index + 1));
    // a NASA model replaces the stylised one when it arrives (usually during the fly-in)
    const asset = ASSETS[kind];
    if (asset)
      loadAsset(asset).then(
        (template) => {
          if (this.forIndex !== index) return;
          const root = template.clone();
          const trackers = root.getObjectsByProperty('name', 'tracker');
          this.show({ root, radius: radiusOf(root), trackers, tumble: null, shared: true });
        },
        (e) => console.warn(`spacecraft model ${asset.url} failed to load; keeping the stylised one`, e),
      );
  }

  private show(model: Model | null) {
    if (this.model) {
      this.body.remove(this.model.root);
      if (!this.model.shared) this.model.root.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
    }
    this.model = model;
    if (!model) return;
    model.root.traverse((o) => (o.userData.shade = this.shade));
    this.body.add(model.root);
  }

  /**
   * Place and light the model. `sunDir` is the unit vector to the Sun, `sunlit`
   * the fraction of the solar disc visible (0 in Earth's shadow), `simS` sim seconds.
   */
  update(pos: THREE.Vector3, vel: THREE.Vector3, sunDir: THREE.Vector3, sunlit: number, simS: number, visible: boolean) {
    const m = this.model;
    this.object.visible = visible && m !== null;
    if (!m || !this.object.visible) return;
    this.object.position.copy(pos);
    if (m.tumble) {
      this.body.quaternion.setFromAxisAngle(m.tumble.axis, (m.tumble.rate * simS) % (2 * Math.PI)).multiply(m.tumble.q0);
    } else {
      orbitFrame(pos, vel, this.body.quaternion);
    }
    // arrays: the Sun's direction in the body frame, projected on each mount's XZ plane
    _s.copy(sunDir).applyQuaternion(_q.copy(this.body.quaternion).invert());
    const theta = Math.atan2(_s.x, _s.z);
    for (const t of m.trackers) t.rotation.y = theta;

    this.sun.position.copy(sunDir);
    this.sun.intensity = 3 * sunlit;
    // in Earth's shadow over the night side a dark hull would vanish entirely
    this.shade.rim = 1 - sunlit;
    // light off the Earth below: strong over the day side, nothing over the night side
    const up = _z.copy(pos).normalize();
    this.earthshine.position.copy(up).negate();
    this.earthshine.intensity = 0.05 + 0.7 * Math.max(0, up.dot(sunDir));
  }
}
