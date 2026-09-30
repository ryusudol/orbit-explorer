// Owns the renderer, the animation loop and every worker. React starts it
// from one effect; the loop never goes through React. Summaries flow to the
// Zustand store at ~5 Hz; user intent flows back through store subscriptions.

import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

import { Propagator, gmst, illumination, loadEngine, sun_position_teme, teme_to_geodetic } from '../engine';
import { Category, Group, subset, type Catalog } from '../sim/catalog';
import { cityById } from '../sim/cities';
import { fibreLatencyMs, geodeticToEcef, greatCircleKm, vacuumLatencyMs } from '../sim/physics';
import { PropagationPool } from '../sim/propagationPool';
import { SimClock, jdToMs } from '../sim/time';
import { useStore, type Layers } from '../state/store';
import type { AnalysisResult } from '../workers/analysis.worker';
import { Earth } from './earth';
import { SegmentLayer, ThickPath } from './lines';
import { CoverageOverlay, visibilityCone } from './overlays';
import { SpriteLayer } from './sprites';

const R_EARTH = 6378.137;
const MIN_ELEV_DEG = 25;
const COVERAGE_GRID = { nlat: 90, nlon: 180 };
const TRAIL_SAMPLES = 240;
const MAX_ROUTE_POINTS = 64;

/** Series colours (dataviz reference palette, dark steps). */
export const GROUP_HEX = ['#3987e5', '#d95926', '#199e70'];
const GROUP_COLORS = GROUP_HEX.map((h) => new THREE.Color(h));
const GROUP_SIZE = [3.1, 3.3, 3.9];
const WHITE = new THREE.Color('#ffffff');
const ROUTE_COLOR = new THREE.Color('#fff1d6').multiplyScalar(2.2);
const LINK_COLOR = new THREE.Color('#86b6ef');
const SERIOUS = new THREE.Color('#ec835a');
const CONE_TINT = new THREE.Color('#5598e7');

let current: SceneController | null = null;
export const getController = () => current;

export class SceneController {
  private renderer!: THREE.WebGPURenderer;
  private pipeline!: THREE.RenderPipeline;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private clock = new SimClock();
  private pool!: PropagationPool;
  private prop!: Propagator;
  private analysis!: Worker;
  private conj!: Worker;
  private analysisBusy = false;
  private lastAnalysis = 0;
  private screenId = 0;

  private earth!: Earth;
  private sats!: SpriteLayer;
  private markers!: SpriteLayer;
  private packets!: SpriteLayer;
  private links!: SegmentLayer;
  private route!: ThickPath;
  private trail!: SegmentLayer;
  private coverage!: CoverageOverlay;
  private cones = new THREE.Group();
  private stars!: THREE.Points;

  readonly n: number;
  private pos: Float64Array;
  private valid: Uint8Array;
  private visibleMask: Uint8Array;
  private edges: Uint32Array | null = null;
  private routePath: Uint32Array | null = null;
  private routePoints = new Float64Array(MAX_ROUTE_POINTS * 3);
  private trailPoints = new Float64Array(TRAIL_SAMPLES * 3);
  private trailFor = -1;
  private trailAt = 0;
  private lastGmst: number | null = null;
  private lastSlot = -2;
  private colorsDirty = true;
  private lastTarget = new THREE.Vector3();

  private labelLayer: HTMLDivElement;
  private labels = new Map<string, HTMLDivElement>();
  private unsub: (() => void)[] = [];
  private frames = 0;
  private fpsT0 = performance.now();
  private lastStats = 0;
  private lastFrame = performance.now();
  private frameMs = 0;
  private interpMs = 0;
  private pointer = { down: false, x: 0, y: 0, moved: false, lastHover: 0 };
  private disposed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    labelLayer: HTMLDivElement,
    readonly catalog: Catalog,
  ) {
    this.labelLayer = labelLayer;
    this.n = catalog.count;
    this.pos = new Float64Array(3 * this.n);
    this.valid = new Uint8Array(this.n);
    this.visibleMask = new Uint8Array(this.n);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 3e6);
    this.camera.up.set(0, 0, 1);
    current = this;
  }

  async init() {
    const store = useStore.getState();
    store.set({ loadingStep: 'Loading physics engine' });
    await loadEngine();
    store.set({ loadingStep: 'Starting renderer' });
    this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    await this.renderer.init();
    const backend = (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL 2';

    store.set({ loadingStep: 'Loading Earth imagery' });
    const loader = new THREE.TextureLoader();
    const load = (url: string) =>
      loader.loadAsync(url).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        return t;
      });
    const [day, night] = await Promise.all([load('/textures/earth-day-2k.jpg'), load('/textures/earth-night-2k.jpg')]);
    this.earth = new Earth(day, night);
    this.scene.add(this.earth.group);
    // full-resolution imagery streams in after first paint: KTX2 (transcoded in a
    // worker, stays compressed on the GPU), JPEG if the transcoder is unavailable
    const ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(this.renderer);
    const loadKtx = (url: string) => ktx2.loadAsync(url).then((t) => ((t.colorSpace = THREE.SRGBColorSpace), (t.anisotropy = 8), t));
    Promise.all([loadKtx('/textures/earth-day.ktx2'), loadKtx('/textures/earth-night.ktx2')])
      .catch(() => Promise.all([load('/textures/earth-day.jpg'), load('/textures/earth-night.jpg')]))
      .then(([d, nt]) => !this.disposed && this.earth.setTextures(d, nt))
      .finally(() => ktx2.dispose());

    this.coverage = new CoverageOverlay(COVERAGE_GRID.nlat, COVERAGE_GRID.nlon);
    this.earth.group.add(this.coverage.mesh);
    this.earth.group.add(this.cones);

    this.sats = new SpriteLayer(this.n, 'glow', { renderOrder: 2 });
    this.markers = new SpriteLayer(16, 'ring', { renderOrder: 4, depthTest: true });
    this.packets = new SpriteLayer(48, 'glow', { renderOrder: 5 });
    this.links = new SegmentLayer(40_000, LINK_COLOR, 0.075);
    this.route = new ThickPath(MAX_ROUTE_POINTS, ROUTE_COLOR, 2.5);
    this.trail = new SegmentLayer(TRAIL_SAMPLES, WHITE, 0.9);
    this.stars = makeStars();
    this.scene.add(this.stars, this.links.object, this.trail.object, this.route.object, this.sats.object, this.packets.object, this.markers.object);

    // post-processing: scene -> bloom -> tone map
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    const scenePass = pass(this.scene, this.camera);
    const color = scenePass.getTextureNode('output');
    this.pipeline.outputNode = color.add(bloom(color, 0.85, 0.35, 0.22));

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = R_EARTH + 400;
    this.controls.maxDistance = 250_000;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    this.initialView();

    store.set({ loadingStep: 'Starting SGP4 workers' });
    this.prop = new Propagator(this.catalog.packed);
    const workers = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
    this.pool = new PropagationPool(this.catalog, workers);
    await this.pool.ready;
    this.startAnalysisWorkers();

    this.bindInput();
    this.bindStore();
    this.resize();
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    store.set({ perf: { ...store.perf, backend, workers } });
    this.renderer.setAnimationLoop(this.frame);
  }

  private onResize = () => {};

  private initialView() {
    // over the North Atlantic, framing London and New York
    const g = gmst(this.clock.jd);
    const p = new THREE.Vector3(...geodeticToEcef(38, -38, 0)).normalize().applyAxisAngle(new THREE.Vector3(0, 0, 1), g);
    this.camera.position.copy(p.multiplyScalar(24_000));
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private startAnalysisWorkers() {
    const starlink = subset(this.catalog, (i) => this.catalog.category[i] === Category.Starlink);
    this.analysis = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module', name: 'analysis' });
    this.analysis.onmessage = (e) => {
      if (e.data.type === 'result') this.onAnalysis(e.data as AnalysisResult);
      if (e.data.type === 'ready') this.analysisBusy = false;
    };
    this.analysisBusy = true;
    this.analysis.postMessage({ type: 'init', packed: starlink.packed, indices: starlink.indices }, [starlink.packed.buffer, starlink.indices.buffer]);

    this.conj = new Worker(new URL('../workers/conjunction.worker.ts', import.meta.url), { type: 'module', name: 'conjunctions' });
    this.conj.onmessage = (e) => this.onConjMessage(e.data);
    const packed = this.catalog.packed.slice();
    this.conj.postMessage({ type: 'init', packed }, [packed.buffer]);
  }

  // ------------------------------------------------------------------ frame

  private frame = () => {
    const now = performance.now();
    const dt = Math.min(now - this.lastFrame, 250);
    this.lastFrame = now;
    const s = useStore.getState();
    const layers = s.layers;

    if (s.jumpTo !== null) {
      this.clock.jump(s.jumpTo);
      this.pool.invalidate();
      s.set({ jumpTo: null });
    }
    this.clock.rate = s.rate;
    this.clock.paused = s.paused;
    this.clock.tick(dt);
    const jd = this.clock.jd;

    this.pool.update(jd, this.clock.paused ? 0 : this.clock.rate);
    const t0 = performance.now();
    const slot = this.pool.interpolate(jd, this.pos, this.valid);
    this.interpMs = this.interpMs * 0.9 + (performance.now() - t0) * 0.1;
    if (slot !== this.lastSlot) {
      this.lastSlot = slot;
      this.colorsDirty = true;
    }

    // selected object: exact SGP4 every frame (not interpolated)
    const sel = s.selected;
    if (sel !== null) {
      const st = this.prop.state_at(sel, jd);
      if (st.length) {
        this.pos[3 * sel] = st[0];
        this.pos[3 * sel + 1] = st[1];
        this.pos[3 * sel + 2] = st[2];
        this.valid[sel] = 1;
      }
    }

    // Earth orientation and lighting
    const g = gmst(jd);
    if (this.lastGmst !== null && layers.earthFixed && !s.follow) {
      const d = g - this.lastGmst;
      const axis = new THREE.Vector3(0, 0, 1);
      this.camera.position.applyAxisAngle(axis, d);
      this.controls.target.applyAxisAngle(axis, d);
    }
    this.lastGmst = g;
    this.earth.group.rotation.z = g;
    const sun = sun_position_teme(jd);
    const sunDir = new THREE.Vector3(sun[0], sun[1], sun[2]).normalize();
    this.earth.setSun(sunDir.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), -g));

    // follow mode: keep the camera's offset from the object fixed
    if (s.follow && sel !== null && this.valid[sel]) {
      const t = new THREE.Vector3(this.pos[3 * sel], this.pos[3 * sel + 1], this.pos[3 * sel + 2]);
      this.camera.position.add(t.clone().sub(this.lastTarget));
      this.controls.target.copy(t);
      this.lastTarget.copy(t);
    }
    this.controls.update();
    this.camera.updateMatrixWorld();
    const cam = this.camera.position;

    this.updateSatellites(cam, slot, layers, sel);
    this.updateLinks(cam, layers);
    this.updateRoute(cam, g, now, layers, s.src, s.dst);
    this.updateMarkers(cam, sel, s.conj.selected !== null ? s.conj.events[s.conj.selected] : undefined);
    this.updateTrail(cam, jd, sel, layers.trail);
    this.stars.position.copy(cam);
    this.updateLabels(g, s.src, s.dst, layers.route);

    if (!this.analysisBusy && now - this.lastAnalysis > 250) this.requestAnalysis(jd, s.src, s.dst, layers.coverage || s.tab === 'coverage');
    if (now - this.lastStats > 200) this.publish(now, jd, sel);

    this.pipeline.render();
    this.frameMs = this.frameMs * 0.9 + (performance.now() - now) * 0.1;
    this.frames++;
  };

  private updateSatellites(cam: THREE.Vector3, slot: number, layers: Layers, sel: number | null) {
    const n = this.n;
    const off = this.sats.offsets.array as Float32Array;
    const pos = this.pos;
    for (let i = 0; i < 3 * n; i += 3) {
      off[i] = pos[i] - cam.x;
      off[i + 1] = pos[i + 1] - cam.y;
      off[i + 2] = pos[i + 2] - cam.z;
    }
    if (this.colorsDirty) {
      const show = [layers.starlink, layers.debris, layers.payload];
      const illum = slot >= 0 ? this.pool.kf.illum.subarray(slot * n, (slot + 1) * n) : null;
      const group = this.catalog.group;
      let visible = 0;
      for (let i = 0; i < n; i++) {
        const gi = group[i];
        const on = show[gi] && this.valid[i] === 1;
        this.visibleMask[i] = on ? 1 : 0;
        if (!on) {
          this.sats.setColor(i, WHITE, 0);
          continue;
        }
        visible++;
        const lit = layers.eclipse && illum ? 0.22 + 0.78 * (illum[i] / 255) : 1;
        this.sats.setColor(i, GROUP_COLORS[gi], GROUP_SIZE[gi], 1.5 * lit);
      }
      if (sel !== null) this.sats.setColor(sel, WHITE, 7, 3);
      this.visibleCount = visible;
      this.colorsDirty = false;
      this.sats.commit(n, cam, true);
    } else {
      this.sats.commit(n, cam, false);
    }
  }
  private visibleCount = 0;

  private updateLinks(cam: THREE.Vector3, layers: Layers) {
    const e = this.edges;
    if (!layers.links || !e || !layers.starlink) {
      this.links.object.visible = false;
      return;
    }
    this.links.object.visible = true;
    const a = this.links.array;
    const pos = this.pos;
    let k = 0;
    const max = Math.min(e.length / 2, 40_000);
    for (let s = 0; s < max; s++) {
      const i = e[2 * s], j = e[2 * s + 1];
      if (!this.valid[i] || !this.valid[j]) continue;
      a[6 * k] = pos[3 * i] - cam.x;
      a[6 * k + 1] = pos[3 * i + 1] - cam.y;
      a[6 * k + 2] = pos[3 * i + 2] - cam.z;
      a[6 * k + 3] = pos[3 * j] - cam.x;
      a[6 * k + 4] = pos[3 * j + 1] - cam.y;
      a[6 * k + 5] = pos[3 * j + 2] - cam.z;
      k++;
    }
    this.links.commit(k, cam);
  }

  private stationTeme(id: string, g: number, heightKm = 0): THREE.Vector3 {
    const c = cityById(id);
    return new THREE.Vector3(...geodeticToEcef(c.lat, c.lon, heightKm)).applyAxisAngle(new THREE.Vector3(0, 0, 1), g);
  }

  private updateRoute(cam: THREE.Vector3, g: number, now: number, layers: Layers, src: string, dst: string) {
    const path = this.routePath;
    const count = this.packets;
    if (!layers.route || !path || path.length === 0) {
      this.route.update(this.routePoints, 0, cam);
      count.commit(0, cam);
      return;
    }
    const pts = this.routePoints;
    const a = this.stationTeme(src, g);
    const b = this.stationTeme(dst, g);
    let m = 0;
    const put = (x: number, y: number, z: number) => {
      pts[3 * m] = x;
      pts[3 * m + 1] = y;
      pts[3 * m + 2] = z;
      m++;
    };
    put(a.x, a.y, a.z);
    for (let k = 0; k < path.length && m < MAX_ROUTE_POINTS - 1; k++) {
      const i = path[k];
      put(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]);
    }
    put(b.x, b.y, b.z);
    this.route.update(pts, m, cam);

    // packets travelling hop by hop at a visible (not physical) speed
    const segLen: number[] = [];
    let total = 0;
    for (let k = 0; k < m - 1; k++) {
      const d = Math.hypot(pts[3 * k + 3] - pts[3 * k], pts[3 * k + 4] - pts[3 * k + 1], pts[3 * k + 5] - pts[3 * k + 2]);
      segLen.push(d);
      total += d;
    }
    const nPackets = 6;
    const phase = (now / 2600) % 1;
    for (let p = 0; p < nPackets; p++) {
      let d = ((phase + p / nPackets) % 1) * total;
      let k = 0;
      while (k < segLen.length - 1 && d > segLen[k]) d -= segLen[k++];
      const f = segLen[k] > 0 ? d / segLen[k] : 0;
      const x = pts[3 * k] + (pts[3 * k + 3] - pts[3 * k]) * f;
      const y = pts[3 * k + 1] + (pts[3 * k + 4] - pts[3 * k + 1]) * f;
      const z = pts[3 * k + 2] + (pts[3 * k + 5] - pts[3 * k + 2]) * f;
      count.setOffset(p, x, y, z, cam);
      count.setColor(p, WHITE, 9, 4);
    }
    // ground stations
    count.setOffset(nPackets, a.x, a.y, a.z, cam);
    count.setColor(nPackets, WHITE, 8, 2);
    count.setOffset(nPackets + 1, b.x, b.y, b.z, cam);
    count.setColor(nPackets + 1, WHITE, 8, 2);
    count.commit(nPackets + 2, cam);
  }

  private updateMarkers(cam: THREE.Vector3, sel: number | null, conj?: { a: number; b: number }) {
    let k = 0;
    const ring = (i: number, c: THREE.Color, size: number) => {
      if (!this.valid[i]) return;
      this.markers.setOffset(k, this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2], cam);
      this.markers.setColor(k, c, size, 2.2);
      k++;
    };
    if (sel !== null) ring(sel, WHITE, 22);
    if (conj) {
      ring(conj.a, SERIOUS, 26);
      ring(conj.b, SERIOUS, 26);
    }
    this.markers.commit(k, cam);
  }

  private updateTrail(cam: THREE.Vector3, jd: number, sel: number | null, on: boolean) {
    if (sel === null || !on) {
      this.trail.object.visible = false;
      this.trailFor = -1;
      return;
    }
    const now = performance.now();
    if (this.trailFor !== sel || now - this.trailAt > 500) {
      const info = this.prop.info(sel);
      const periodDays = Math.min(info[3], 1440) / 1440;
      const pts = this.prop.track(sel, jd - periodDays / 2, jd + periodDays / 2, TRAIL_SAMPLES);
      this.trailPoints.set(pts);
      if (this.trailFor !== sel) {
        const c = this.trail.colorArray;
        for (let k = 0; k < TRAIL_SAMPLES - 1; k++) {
          const w = 1 - Math.abs(k / (TRAIL_SAMPLES - 2) - 0.5) * 1.6; // brightest at the object
          for (let v = 0; v < 6; v++) c[6 * k + v] = Math.max(0.08, w);
        }
        this.trail.commit(0, cam, true);
      }
      this.trailFor = sel;
      this.trailAt = now;
    }
    const p = this.trailPoints;
    const a = this.trail.array;
    let k = 0;
    for (let s = 0; s < TRAIL_SAMPLES - 1; s++) {
      if (Number.isNaN(p[3 * s]) || Number.isNaN(p[3 * s + 3])) continue;
      a[6 * k] = p[3 * s] - cam.x;
      a[6 * k + 1] = p[3 * s + 1] - cam.y;
      a[6 * k + 2] = p[3 * s + 2] - cam.z;
      a[6 * k + 3] = p[3 * s + 3] - cam.x;
      a[6 * k + 4] = p[3 * s + 4] - cam.y;
      a[6 * k + 5] = p[3 * s + 5] - cam.z;
      k++;
    }
    this.trail.object.visible = true;
    this.trail.commit(k, cam);
  }

  // ------------------------------------------------------------ labels & picking

  private label(key: string, text: string): HTMLDivElement {
    let el = this.labels.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'scene-label';
      this.labelLayer.appendChild(el);
      this.labels.set(key, el);
    }
    if (el.textContent !== text) el.textContent = text;
    return el;
  }

  private occluded(p: THREE.Vector3): boolean {
    // does the segment camera -> p pass through the Earth?
    const c = this.camera.position;
    const d = p.clone().sub(c);
    const len2 = d.lengthSq();
    const t = Math.min(1, Math.max(0, -c.dot(d) / len2));
    const closest = c.clone().add(d.multiplyScalar(t));
    return closest.length() < 6356 && t < 0.999;
  }

  private toScreen(p: THREE.Vector3): { x: number; y: number; ok: boolean } {
    const v = p.clone().project(this.camera);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, ok: v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2 };
  }

  private updateLabels(g: number, src: string, dst: string, routeOn: boolean) {
    const place = (key: string, text: string, p: THREE.Vector3, show: boolean) => {
      const el = this.label(key, text);
      const s = this.toScreen(p);
      const visible = show && s.ok && !this.occluded(p);
      el.style.opacity = visible ? '1' : '0';
      if (visible) el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
    };
    place('src', cityById(src).name, this.stationTeme(src, g, 1), routeOn);
    place('dst', cityById(dst).name, this.stationTeme(dst, g, 1), routeOn);
  }

  /** Nearest visible object within `radiusPx` of a screen point. */
  pick(x: number, y: number, radiusPx = 12): number | null {
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const e = m.elements;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    let best = -1;
    let bestD = radiusPx * radiusPx;
    const p = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      if (!this.visibleMask[i]) continue;
      const px = this.pos[3 * i], py = this.pos[3 * i + 1], pz = this.pos[3 * i + 2];
      const cw = e[3] * px + e[7] * py + e[11] * pz + e[15];
      if (cw <= 0) continue;
      const sx = ((e[0] * px + e[4] * py + e[8] * pz + e[12]) / cw) * 0.5 + 0.5;
      const sy = -((e[1] * px + e[5] * py + e[9] * pz + e[13]) / cw) * 0.5 + 0.5;
      const dx = sx * w - x, dy = sy * h - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        p.set(px, py, pz);
        if (this.occluded(p)) continue;
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? best : null;
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.pointer = { ...this.pointer, down: true, x: e.clientX, y: e.clientY, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      if (this.pointer.down && Math.hypot(e.clientX - this.pointer.x, e.clientY - this.pointer.y) > 4) this.pointer.moved = true;
      const now = performance.now();
      if (this.pointer.down || now - this.pointer.lastHover < 60) return;
      this.pointer.lastHover = now;
      const r = c.getBoundingClientRect();
      const i = this.pick(e.clientX - r.left, e.clientY - r.top, 10);
      const s = useStore.getState();
      if (i === null) {
        if (s.hover) s.set({ hover: null });
        c.style.cursor = '';
      } else {
        s.set({ hover: { index: i, name: this.catalog.names[i], x: e.clientX - r.left, y: e.clientY - r.top } });
        c.style.cursor = 'pointer';
      }
    });
    c.addEventListener('pointerup', (e) => {
      const wasClick = this.pointer.down && !this.pointer.moved;
      this.pointer.down = false;
      if (!wasClick) return;
      const r = c.getBoundingClientRect();
      const i = this.pick(e.clientX - r.left, e.clientY - r.top, 14);
      if (i !== null) this.selectObject(i);
    });
    c.addEventListener('pointerleave', () => useStore.getState().set({ hover: null }));
  }

  selectObject(i: number | null, follow = false) {
    const s = useStore.getState();
    s.select(i);
    if (i !== null && this.valid[i]) {
      this.lastTarget.set(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]);
      if (follow) this.flyTo(i);
    }
    this.colorsDirty = true;
  }

  /** Chase camera: behind the object along its track and a little above, so the horizon is in view. */
  flyTo(i: number) {
    if (!this.valid[i]) return;
    const st = this.prop.state_at(i, this.clock.jd);
    const p = new THREE.Vector3(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]);
    const up = p.clone().normalize();
    const back = st.length ? new THREE.Vector3(st[3], st[4], st[5]).normalize().negate() : new THREE.Vector3(0, 0, 1);
    this.camera.position.copy(p.clone().add(back.multiplyScalar(320)).add(up.multiplyScalar(110)));
    this.controls.target.copy(p);
    this.lastTarget.copy(p);
    this.controls.minDistance = 20;
    useStore.getState().set({ follow: true });
  }

  resetView() {
    this.controls.minDistance = R_EARTH + 400;
    useStore.getState().set({ follow: false });
    this.initialView();
  }

  private bindStore() {
    this.unsub.push(
      useStore.subscribe((s, prev) => {
        if (s.layers !== prev.layers) {
          this.colorsDirty = true;
          this.coverage.mesh.visible = s.layers.coverage;
          this.cones.visible = s.layers.cones && s.layers.route;
        }
        if (s.selected !== prev.selected) this.colorsDirty = true;
        if (s.follow !== prev.follow && !s.follow) this.controls.minDistance = R_EARTH + 400;
        if (s.src !== prev.src || s.dst !== prev.dst) {
          this.routePath = null;
          s.set({ latency: [], route: null });
          this.rebuildCones(s.src, s.dst);
        }
      }),
    );
    const s = useStore.getState();
    this.rebuildCones(s.src, s.dst);
    this.cones.visible = s.layers.cones && s.layers.route;
    this.coverage.mesh.visible = s.layers.coverage;
  }

  private rebuildCones(src: string, dst: string) {
    for (const c of [...this.cones.children]) {
      this.cones.remove(c);
      c.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    for (const id of [src, dst]) {
      const c = cityById(id);
      this.cones.add(visibilityCone(c.lat, c.lon, 480, MIN_ELEV_DEG, CONE_TINT));
    }
  }

  // ------------------------------------------------------------ analysis

  private requestAnalysis(jd: number, src: string, dst: string, coverage: boolean) {
    const a = cityById(src), b = cityById(dst);
    this.analysisBusy = true;
    this.lastAnalysis = performance.now();
    this.analysis.postMessage({
      type: 'update',
      jd,
      src: { lat: a.lat, lon: a.lon },
      dst: { lat: b.lat, lon: b.lon },
      minElevDeg: MIN_ELEV_DEG,
      coverage: coverage ? COVERAGE_GRID : null,
    });
  }

  private onAnalysis(r: AnalysisResult) {
    this.analysisBusy = false;
    this.edges = r.edges;
    this.routePath = r.route?.path ?? null;
    const s = useStore.getState();
    const a = cityById(s.src), b = cityById(s.dst);
    const gc = greatCircleKm(a.lat, a.lon, b.lat, b.lon);
    const route = r.route
      ? {
          totalKm: r.route.totalKm,
          uplinkKm: r.route.uplinkKm,
          downlinkKm: r.route.downlinkKm,
          hops: r.route.path.length,
          latencyMs: vacuumLatencyMs(r.route.totalKm),
          fibreMs: fibreLatencyMs(gc),
          greatCircleKm: gc,
        }
      : null;
    const t = jdToMs(r.jd);
    const latency = [...s.latency.filter((x) => x.t < t), { t, sat: route ? route.latencyMs : null }].slice(-240);

    let coverageByLat = s.coverageByLat;
    let coverageFraction = s.coverageFraction;
    let coverageStats = s.coverageStats;
    if (r.coverage) {
      const { nlat, nlon } = COVERAGE_GRID;
      let maxC = 0;
      let minC = Infinity;
      let weighted = 0;
      coverageByLat = new Float32Array(nlat);
      let area = 0, covered = 0;
      for (let i = 0; i < nlat; i++) {
        let sum = 0;
        const w = Math.cos(((-90 + (i + 0.5) * (180 / nlat)) * Math.PI) / 180);
        for (let j = 0; j < nlon; j++) {
          const c = r.coverage[i * nlon + j];
          sum += c;
          if (c > maxC) maxC = c;
          if (c < minC) minC = c;
          weighted += w * c;
          area += w;
          if (c > 0) covered += w;
        }
        coverageByLat[i] = sum / nlon;
      }
      coverageFraction = covered / area;
      coverageStats = { min: minC, mean: weighted / area, max: maxC };
      this.coverage.update(r.coverage, Math.max(12, maxC));
    }
    s.set({
      route,
      latency,
      coverageByLat,
      coverageFraction,
      coverageStats,
      network: {
        edges: r.edges.length / 2,
        linked: r.linked,
        shells: r.shells,
        buildMs: r.timings.propagateBuildMs,
        routeMs: r.timings.routeMs,
        coverageMs: r.coverage ? r.timings.coverageMs : (s.network?.coverageMs ?? 0),
      },
    });
  }

  startScreening(hours: number, thresholdKm: number) {
    const id = ++this.screenId;
    const jd0 = this.clock.jd;
    const s = useStore.getState();
    s.set({ conj: { ...s.conj, status: 'running', progress: 0, elapsedMs: 0, total: 0, events: [], stats: null, hours, thresholdKm, startJd: jd0, selected: null } });
    this.conj.postMessage({ type: 'screen', id, jd0, hours, stepS: 60, thresholdKm });
  }

  runBenchmark() {
    useStore.getState().set({ benchRunning: true });
    this.conj.postMessage({ type: 'bench', jd: this.clock.jd });
  }

  private onConjMessage(m: { type: string; [k: string]: unknown }) {
    const s = useStore.getState();
    if (m.type === 'ready') {
      this.startScreening(s.conj.hours, s.conj.thresholdKm);
    } else if (m.type === 'progress' && m.id === this.screenId) {
      const progress = m.progress as number;
      s.set({
        conj: {
          ...s.conj,
          status: progress >= 1 ? 'done' : 'running',
          progress,
          elapsedMs: m.elapsedMs as number,
          total: m.total as number,
          events: m.events as never,
          stats: m.stats as never,
        },
      });
    } else if (m.type === 'bench') {
      const { type: _t, ...rest } = m;
      s.set({ bench: rest as never, benchRunning: false });
      // the benchmark cancels a running screen; restart it
      if (s.conj.status === 'running') this.startScreening(s.conj.hours, s.conj.thresholdKm);
    }
  }

  /** Distance between two objects over a window (for the conjunction chart). */
  rangeSeries(a: number, b: number, jd0: number, jd1: number, n: number): Float64Array {
    return this.prop.range_series(a, b, jd0, jd1, n);
  }

  // ------------------------------------------------------------ publishing

  private publish(now: number, jd: number, sel: number | null) {
    const s = useStore.getState();
    const fps = (this.frames * 1000) / (now - this.fpsT0);
    this.frames = 0;
    this.fpsT0 = now;
    this.lastStats = now;
    const st = this.pool.stats;
    const patch: Parameters<typeof s.set>[0] = {
      timeMs: this.clock.timeMs,
      perf: {
        ...s.perf,
        fps,
        frameMs: this.frameMs,
        interpMs: this.interpMs,
        keyframeMs: st.computeMs,
        keyframesPerSec: st.keyframesPerSec,
        spacingS: st.spacingS,
        visible: this.visibleCount,
      },
    };
    if (sel !== null && this.valid[sel]) {
      const st2 = this.prop.state_at(sel, jd);
      if (st2.length) {
        const geo = teme_to_geodetic(st2[0], st2[1], st2[2], jd);
        const info = this.prop.info(sel);
        patch.selectedInfo = {
          index: sel,
          name: this.catalog.names[sel],
          norad: this.catalog.ids[sel],
          group: this.catalog.group[sel] as Group,
          latDeg: geo[0],
          lonDeg: geo[1],
          altKm: geo[2],
          speedKms: Math.hypot(st2[3], st2[4], st2[5]),
          sunlit: illumination(st2[0], st2[1], st2[2], jd),
          periodMin: info[3],
          inclinationDeg: info[2],
          eccentricity: info[1],
          perigeeKm: info[4],
          apogeeKm: info[5],
          epochAgeH: (jd - this.catalog.packed[sel * 8]) * 24,
        };
      }
    }
    s.set(patch);
  }

  private resize() {
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth, h = parent.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.disposed = true;
    this.renderer?.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    this.unsub.forEach((u) => u());
    this.pool?.dispose();
    this.analysis?.terminate();
    this.conj?.terminate();
    this.controls?.dispose();
    this.labels.forEach((el) => el.remove());
    this.renderer?.dispose();
    if (current === this) current = null;
  }
}

function makeStars(): THREE.Points {
  // deterministic sky: 5,000 stars with a steep magnitude distribution
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const n = 5000;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = 1.5e6;
    const s = Math.sqrt(1 - u * u);
    pos.set([r * s * Math.cos(th), r * s * Math.sin(th), r * u], 3 * i);
    const b = 0.08 + Math.pow(rnd(), 6) * 0.7;
    const warm = rnd();
    col.set([b * (0.85 + 0.15 * warm), b * 0.9, b * (1.05 - 0.2 * warm)], 3 * i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsNodeMaterial({ vertexColors: true, depthWrite: false, sizeAttenuation: false });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = -1;
  return p;
}
