// Owns the renderer, the animation loop and every worker. React starts it
// from one effect; the loop never goes through React. Summaries flow to the
// Zustand store at ~5 Hz; user intent flows back through store subscriptions.

import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

import { Propagator, gmst, illumination, loadEngine, sun_position_teme, teme_to_geodetic } from '../engine';
import { GROUP_HEX } from '../palette';
import { Category, Group, subset, type Catalog } from '../sim/catalog';
import { cityById } from '../sim/cities';
import { fibreLatencyMs, geodeticToEcef, greatCircleKm, vacuumLatencyMs } from '../sim/physics';
import { PropagationPool } from '../sim/propagationPool';
import { SimClock, jdToMs } from '../sim/time';
import { useStore, type Layers } from '../state/store';
import type { AnalysisResult } from '../workers/analysis.worker';
import { Earth } from './earth';
import { OrbitPath, SegmentLayer, ThickPath } from './lines';
import { CoverageOverlay, visibilityCone } from './overlays';
import { Sky, decodeStars } from './sky';
import { SpriteLayer } from './sprites';
import { ALL_TILES, loadInOrder } from './tiles';

const R_EARTH = 6378.137;
const MIN_ELEV_DEG = 25;
const COVERAGE_GRID = { nlat: 90, nlon: 180 };
const ORBIT_SAMPLES = 361;
const MAX_ROUTE_POINTS = 64;

export { GROUP_HEX };
const GROUP_COLORS = GROUP_HEX.map((h) => new THREE.Color(h));
/**
 * Point brightness per group. Tol's dark blue is only ~2:1 against black space,
 * so it is lifted to a floor luminance; the scheme's lightness order (blue <
 * red < yellow) is kept, and with it the hue.
 */
const GROUP_GAIN = GROUP_COLORS.map((c) => 1.5 * Math.max(1, 0.13 / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b)));
const GROUP_SIZE = [3.1, 3.3, 3.9];
const WHITE = new THREE.Color('#ffffff');
const ROUTE_COLOR = new THREE.Color('#fff1d6').multiplyScalar(2.2);
const LINK_COLOR = new THREE.Color('#86b6ef');
const SERIOUS = new THREE.Color('#ec835a');
const ORBIT_COLOR = new THREE.Color('#dfe9ff');
const PARTNER_ORBIT_COLOR = new THREE.Color('#ff9a62');
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Texture tier for this display. UHD (16k Earth and sky, as tiles) only where it shows:
 * a fine pointer and at least ~2560 device pixels across. `?quality=` overrides.
 */
function textureTier(): 'uhd' | 'standard' {
  const q = new URLSearchParams(location.search).get('quality');
  if (q === 'uhd' || q === 'standard') return q;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const px = Math.max(screen.width, screen.height) * Math.min(window.devicePixelRatio, 2);
  return !coarse && memory >= 8 && px >= 2560 ? 'uhd' : 'standard';
}

const easeInOutCubic = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

/** A camera move: eased, about the Earth's centre so it never cuts through the planet. */
interface Flight {
  t0: number;
  dur: number;
  fromPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPos: THREE.Vector3;
  toTarget: THREE.Vector3;
  /** moving destination: refresh toPos/toTarget each frame */
  track?: () => void;
  /** destination fixed to the ground (turns with the Earth in Earth-fixed view) */
  earthFixed: boolean;
  done?: () => void;
}
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
  private orbits!: [OrbitPath, OrbitPath];
  private coverage!: CoverageOverlay;
  private cones = new THREE.Group();
  private sky = new Sky();

  readonly n: number;
  private pos: Float64Array;
  private valid: Uint8Array;
  private visibleMask: Uint8Array;
  private edges: Uint32Array | null = null;
  private routePath: Uint32Array | null = null;
  private routePoints = new Float64Array(MAX_ROUTE_POINTS * 3);
  /** cached one-period tracks, resampled twice a second */
  private tracks = [0, 1].map(() => ({ for: -1, at: 0, pts: new Float64Array(ORBIT_SAMPLES * 3) }));
  private flight: Flight | null = null;
  private lastGmst: number | null = null;
  private lastSlot = -2;
  private colorsDirty = true;
  private lastTarget = new THREE.Vector3();
  private sunDir = new THREE.Vector3(1, 0, 0);

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
  /** camera distance the zoom buttons are easing towards */
  private zoomGoal: number | null = null;
  /** screen area covered by UI panels, so the globe can centre in what's left */
  private insets = { left: 0, right: 0, top: 0, bottom: 0 };
  private insetsSet = false;
  private viewShift = { x: 0, y: 0 };
  private viewShiftGoal = { x: 0, y: 0 };

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
    this.loadImagery(load);

    this.coverage = new CoverageOverlay(COVERAGE_GRID.nlat, COVERAGE_GRID.nlon);
    this.earth.group.add(this.coverage.mesh);
    this.earth.group.add(this.cones);

    this.sats = new SpriteLayer(this.n, 'glow', { renderOrder: 2 });
    this.markers = new SpriteLayer(16, 'ring', { renderOrder: 4, depthTest: true });
    this.packets = new SpriteLayer(48, 'glow', { renderOrder: 5 });
    this.links = new SegmentLayer(40_000, LINK_COLOR, 0.075);
    this.route = new ThickPath(MAX_ROUTE_POINTS, ROUTE_COLOR, 2.5);
    this.orbits = [new OrbitPath(ORBIT_SAMPLES, 1.6), new OrbitPath(ORBIT_SAMPLES, 1.6)];
    this.scene.add(...this.sky.objects, this.links.object, ...this.orbits.map((o) => o.object), this.route.object, this.sats.object, this.packets.object, this.markers.object);

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

  /**
   * Imagery streams in after first paint, sharper each step: 2k JPEG, then 4k
   * KTX2 (transcoded in a worker, block-compressed on the GPU), then on UHD
   * displays a 16k grid of tiles, those facing the camera first. JPEG stands in
   * if the transcoder is unavailable. The sky is decoration: it follows the Earth
   * and may fail quietly.
   */
  private loadImagery(load: (url: string) => Promise<THREE.Texture>) {
    const tier = textureTier();
    const ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(this.renderer);
    const loadKtx = (url: string) => ktx2.loadAsync(url).then((t) => ((t.colorSpace = THREE.SRGBColorSpace), (t.anisotropy = 8), t));
    /** tiles sorted by how squarely they face the camera now */
    const byView = (centre: (c: number, r: number) => THREE.Vector3, toward: THREE.Vector3) =>
      [...ALL_TILES].sort((p, q) => centre(q[0], q[1]).dot(toward) - centre(p[0], p[1]).dot(toward));

    const earth = Promise.all([loadKtx('/textures/earth-day.ktx2'), loadKtx('/textures/earth-night.ktx2')])
      .catch(() => Promise.all([load('/textures/earth-day.jpg'), load('/textures/earth-night.jpg')]))
      .then(([d, n]) => !this.disposed && this.earth.setTextures(d, n));
    const water = earth
      .then(() => loadKtx('/textures/earth-water.ktx2'))
      .then((t) => {
        t.colorSpace = THREE.NoColorSpace;
        if (!this.disposed) this.earth.setWater(t);
      })
      .catch((err) => console.warn('Ocean mask unavailable', err));
    const sky = water
      .then(() => loadKtx('/textures/milkyway.ktx2').catch(() => load('/textures/milkyway.jpg')))
      .then((t) => !this.disposed && this.sky.setMilkyWay(t))
      .catch((err) => console.warn('Milky Way map unavailable', err));

    const uhd = sky.then(async () => {
      if (tier !== 'uhd' || this.disposed) return;
      // the camera's direction from the Earth's centre, in the Earth-fixed frame
      const g = gmst(this.clock.jd);
      const up = this.camera.position.clone().normalize();
      const earthFailed = await loadInOrder(byView(Earth.tileCentre, up.clone().applyAxisAngle(Z_AXIS, -g)), async (c, r) => {
        const [d, n] = await Promise.all([loadKtx(`/textures/earth-day-uhd-${c}-${r}.ktx2`), loadKtx(`/textures/earth-night-uhd-${c}-${r}.ktx2`)]);
        if (!this.disposed) this.earth.setTile(c, r, d, n);
      });
      // the sky behind the globe is what the camera looks at: away from itself
      const skyFailed = await loadInOrder(byView(Sky.tileCentre, up.negate()), async (c, r) => {
        const t = await loadKtx(`/textures/milkyway-uhd-${c}-${r}.ktx2`);
        if (!this.disposed) this.sky.setMilkyWayTile(c, r, t);
      });
      if (earthFailed + skyFailed) console.warn(`UHD imagery: ${earthFailed} Earth and ${skyFailed} sky tiles unavailable; those areas stay at 4k`);
    });
    uhd.finally(() => ktx2.dispose());

    fetch('/data/stars.bin')
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`stars: HTTP ${r.status}`))))
      .then((buf) => !this.disposed && this.scene.add(this.sky.setStars(decodeStars(buf), this.renderer.getPixelRatio())))
      .catch((err) => console.warn('Star catalogue unavailable', err));
  }

  /** Over the North Atlantic, framing London and New York. */
  private homePosition(): THREE.Vector3 {
    const g = gmst(this.clock.jd);
    return new THREE.Vector3(...geodeticToEcef(38, -38, 0)).normalize().applyAxisAngle(Z_AXIS, g).multiplyScalar(this.fitDistance());
  }

  private initialView() {
    this.camera.position.copy(this.homePosition());
    this.controls.target.set(0, 0, 0);
    this.zoomGoal = null;
    this.flight = null;
    this.controls.update();
  }

  /** Distance at which the Earth plus the Starlink shells fill most of the uncovered screen. */
  private fitDistance(): number {
    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth || window.innerWidth, h = parent?.clientHeight || window.innerHeight;
    const free = Math.max(240, Math.min(w - this.insets.left - this.insets.right, h - this.insets.top - this.insets.bottom));
    const radius = R_EARTH + 700;
    // projected radius in px = (R / sqrt(d² − R²)) / tan(fov/2) · h/2
    const k = ((0.41 * free) / (h / 2)) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    return THREE.MathUtils.clamp(radius * Math.sqrt(1 + 1 / (k * k)), 16_000, 60_000);
  }

  /**
   * Drag sensitivity. Orbiting the Earth, a drag should carry the ground under
   * the cursor along with it: a surface point (d − R) away moves R·Δθ for a
   * rotation Δθ, so Δθ per screen angle is (d − R) / R. Far out a drag sweeps
   * the globe; close in it pans gently over the ground. While following, the
   * camera orbits a nearby object instead, so a constant rate feels right.
   */
  private rotateSpeed(): number {
    const target = this.controls.target;
    if (target.lengthSq() > 1000 * 1000) return 0.4;
    const altitude = Math.max(0, this.camera.position.distanceTo(target) - R_EARTH);
    // OrbitControls turns 2π per screen height at rotateSpeed 1; the screen spans one fov
    const grab = (THREE.MathUtils.degToRad(this.camera.fov) / (2 * Math.PI)) * (altitude / R_EARTH);
    return THREE.MathUtils.clamp(grab * 1.15, 0.025, 0.5);
  }

  /** Smoothly scale the camera's distance to its target. */
  zoomBy(factor: number) {
    if (!this.controls) return;
    const d = this.zoomGoal ?? this.camera.position.distanceTo(this.controls.target);
    this.zoomGoal = THREE.MathUtils.clamp(d * factor, this.controls.minDistance, this.controls.maxDistance);
  }

  /**
   * Tell the renderer which screen margins the UI covers. The projection is
   * shifted (not the camera) so the globe sits in the centre of the free area.
   */
  setViewInsets(insets: { left: number; right: number; top: number; bottom: number }) {
    this.insets = insets;
    this.viewShiftGoal = { x: (insets.right - insets.left) / 2, y: (insets.bottom - insets.top) / 2 };
    if (!this.insetsSet && this.controls) {
      // first layout: snap, and frame the globe for the space actually available
      this.insetsSet = true;
      this.viewShift = { ...this.viewShiftGoal };
      this.applyViewOffset();
      if (!this.pointer.moved) this.initialView();
    }
  }

  private applyViewOffset() {
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth, h = parent.clientHeight;
    const { x, y } = this.viewShift;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, x, y, w, h);
    this.camera.updateProjectionMatrix();
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
    this.clock.tick();
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
      this.camera.position.applyAxisAngle(Z_AXIS, d);
      this.controls.target.applyAxisAngle(Z_AXIS, d);
      const f = this.flight;
      if (f?.earthFixed) for (const v of [f.fromPos, f.fromTarget, f.toPos, f.toTarget]) v.applyAxisAngle(Z_AXIS, d);
    }
    this.lastGmst = g;
    this.earth.group.rotation.z = g;
    const sun = sun_position_teme(jd);
    const sunDir = this.sunDir.set(sun[0], sun[1], sun[2]).normalize();
    this.earth.setSun(sunDir.clone().applyAxisAngle(Z_AXIS, -g));

    // follow mode: keep the camera's offset from the object fixed
    if (this.flight) {
      this.stepFlight(now);
    } else if (s.follow && sel !== null && this.valid[sel]) {
      const t = new THREE.Vector3(this.pos[3 * sel], this.pos[3 * sel + 1], this.pos[3 * sel + 2]);
      this.camera.position.add(t.clone().sub(this.lastTarget));
      this.controls.target.copy(t);
      this.lastTarget.copy(t);
    }
    if (this.zoomGoal !== null) {
      const t = this.controls.target;
      const off = this.camera.position.clone().sub(t);
      const d = off.length();
      const next = d + (this.zoomGoal - d) * Math.min(1, dt / 60);
      this.camera.position.copy(t).add(off.setLength(next));
      if (Math.abs(next - this.zoomGoal) < 0.5) this.zoomGoal = null;
    }
    const vs = this.viewShift, vg = this.viewShiftGoal;
    if (vs.x !== vg.x || vs.y !== vg.y) {
      const f = Math.min(1, dt / 90);
      vs.x += (vg.x - vs.x) * f;
      vs.y += (vg.y - vs.y) * f;
      if (Math.abs(vg.x - vs.x) < 0.5 && Math.abs(vg.y - vs.y) < 0.5) this.viewShift = { ...vg };
      this.applyViewOffset();
    }
    this.controls.rotateSpeed = this.rotateSpeed();
    this.controls.update();
    this.camera.updateMatrixWorld();
    const cam = this.camera.position;
    this.earth.setCamera(cam.clone().applyAxisAngle(Z_AXIS, -g));

    this.updateSatellites(cam, layers, sel);
    this.updateLinks(cam, layers);
    this.updateRoute(cam, g, now, layers, s.src, s.dst);
    const ev = s.conj.selected !== null ? s.conj.events[s.conj.selected] : undefined;
    // a conjunction is shown only alongside one of its two objects
    const pair = ev && sel !== null && (ev.a === sel || ev.b === sel) ? ev : undefined;
    this.updateMarkers(cam, sel, pair);
    this.updateOrbits(cam, jd, sel, pair);
    this.sky.update(cam, sunDir);
    this.updateLabels(g, s.src, s.dst, layers.route || layers.cones);

    if (!this.analysisBusy && now - this.lastAnalysis > 250) this.requestAnalysis(jd, s.src, s.dst, layers.coverage || s.tab === 'coverage');
    if (now - this.lastStats > 200) this.publish(now, jd, sel);

    this.pipeline.render();
    this.frameMs = this.frameMs * 0.9 + (performance.now() - now) * 0.1;
    this.frames++;
  };

  private updateSatellites(cam: THREE.Vector3, layers: Layers, sel: number | null) {
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
        this.sats.setColor(i, GROUP_COLORS[gi], GROUP_SIZE[gi], GROUP_GAIN[gi]);
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

  /**
   * The selected object's orbit, always: where it has been and where it is going
   * is the context a single dot can't give. With a conjunction selected, the
   * other object's orbit too, so the crossing geometry is visible.
   */
  private updateOrbits(cam: THREE.Vector3, jd: number, sel: number | null, pair?: { a: number; b: number }) {
    const objects = [sel, pair ? (pair.a === sel ? pair.b : pair.a) : null];
    const now = performance.now();
    objects.forEach((i, k) => {
      const orbit = this.orbits[k];
      const tr = this.tracks[k];
      if (i === null || !this.valid[i]) {
        orbit.hide();
        tr.for = -1;
        return;
      }
      if (tr.for !== i || now - tr.at > 500) {
        const periodDays = Math.min(this.prop.info(i)[3], 1440) / 1440;
        tr.pts.set(this.prop.track(i, jd - periodDays / 2, jd + periodDays / 2, ORBIT_SAMPLES));
        tr.for = i;
        tr.at = now;
      }
      orbit.update(tr.pts, ORBIT_SAMPLES, k === 0 ? ORBIT_COLOR : PARTNER_ORBIT_COLOR, cam);
    });
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

  /** Names of the two ground terminals, shown while the route or their visibility cones are. */
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
      this.zoomGoal = null;
      this.cancelFlight();
    });
    c.addEventListener('wheel', () => this.cancelFlight(), { passive: true });
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

  /**
   * Select an object. While following, picking another object follows that one
   * instead; clearing the selection zooms back out (see stopFollowing).
   */
  selectObject(i: number | null, follow = false) {
    const s = useStore.getState();
    const wasFollowing = s.follow;
    this.leaving = s.selected;
    // a highlighted conjunction belongs to its two objects: clearing the selection,
    // or picking something else, lets it go too
    const ev = s.conj.selected !== null ? s.conj.events[s.conj.selected] : undefined;
    if (ev && (i === null || (i !== ev.a && i !== ev.b))) s.set({ conj: { ...s.conj, selected: null } });
    s.select(i);
    if (i !== null && this.valid[i]) {
      this.lastTarget.set(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]);
      if (follow || wasFollowing) this.flyTo(i);
    }
    this.colorsDirty = true;
  }
  /** the object whose follow just ended, so the zoom-out can keep it centred */
  private leaving: number | null = null;

  /** Chase position: behind the object along its track and a little above, so the horizon is in view. */
  private chase(i: number, outPos: THREE.Vector3, outTarget: THREE.Vector3) {
    const st = this.prop.state_at(i, this.clock.jd);
    outTarget.set(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]);
    const up = outTarget.clone().normalize();
    const back = st.length ? new THREE.Vector3(st[3], st[4], st[5]).normalize().negate() : Z_AXIS.clone();
    outPos.copy(outTarget).addScaledVector(back, 320).addScaledVector(up, 110);
  }

  /** Fly to an object and ride along with it. */
  flyTo(i: number) {
    if (!this.valid[i]) return;
    const toPos = new THREE.Vector3(), toTarget = new THREE.Vector3();
    this.chase(i, toPos, toTarget);
    useStore.getState().set({ follow: true });
    this.startFlight(toPos, toTarget, 1700, {
      track: () => this.valid[i] && this.chase(i, toPos, toTarget),
      done: () => this.lastTarget.copy(this.controls.target),
    });
  }

  /** Leave follow mode by zooming back out, with the object still in the middle of the view. */
  stopFollowing() {
    if (useStore.getState().follow) useStore.getState().set({ follow: false }); // the store subscription flies out
  }

  private flyOut(from: number | null) {
    const p = from !== null && this.valid[from] ? new THREE.Vector3(this.pos[3 * from], this.pos[3 * from + 1], this.pos[3 * from + 2]) : this.camera.position.clone();
    // a GEO object sits outside the usual framing distance: back off far enough to keep it in front
    const dist = Math.max(this.fitDistance(), p.length() * 1.6);
    this.startFlight(p.clone().setLength(dist), new THREE.Vector3(), 1500, { earthFixed: true });
  }

  /** Back to the opening view, smoothly. */
  resetView() {
    this.resetting = true;
    useStore.getState().set({ follow: false });
    this.resetting = false;
    this.startFlight(this.homePosition(), new THREE.Vector3(), 1500, { earthFixed: true });
  }
  private resetting = false;

  private startFlight(toPos: THREE.Vector3, toTarget: THREE.Vector3, dur: number, opts: { track?: () => void; done?: () => void; earthFixed?: boolean } = {}) {
    this.zoomGoal = null;
    this.controls.minDistance = 20; // the target moves between the object and the Earth's centre mid-flight
    this.flight = {
      t0: performance.now(),
      dur,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos,
      toTarget,
      track: opts.track,
      done: opts.done,
      earthFixed: opts.earthFixed ?? false,
    };
  }

  private stepFlight(now: number) {
    const f = this.flight!;
    f.track?.();
    const u = Math.min(1, (now - f.t0) / f.dur);
    const k = easeInOutCubic(u);
    // direction: great-circle slerp about the Earth's centre; distance: geometric
    // (log-linear) so the long zoom feels even and never dips inside the planet
    const r0 = f.fromPos.length(), r1 = f.toPos.length();
    const a = f.fromPos.clone().divideScalar(r0), b = f.toPos.clone().divideScalar(r1);
    const q = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), new THREE.Quaternion().setFromUnitVectors(a, b), k);
    this.camera.position.copy(a.applyQuaternion(q).multiplyScalar(Math.exp(Math.log(r0) + (Math.log(r1) - Math.log(r0)) * k)));
    this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
    if (u >= 1) {
      this.flight = null;
      if (!useStore.getState().follow) this.controls.minDistance = R_EARTH + 400;
      f.done?.();
    }
  }

  /** User input takes over from an overview flight; a fly-in to follow runs to the end. */
  private cancelFlight() {
    const f = this.flight;
    if (!f || useStore.getState().follow) return;
    this.flight = null;
    this.controls.minDistance = Math.min(R_EARTH + 400, this.camera.position.distanceTo(this.controls.target));
  }

  private bindStore() {
    this.unsub.push(
      useStore.subscribe((s, prev) => {
        if (s.layers !== prev.layers) {
          this.colorsDirty = true;
          this.coverage.mesh.visible = s.layers.coverage;
          this.cones.visible = s.layers.cones;
          this.sky.setVisible(s.layers.sky);
        }
        if (s.selected !== prev.selected) this.colorsDirty = true;
        // leaving follow mode, however it happens (Esc, the button, clearing the selection): zoom back out
        if (prev.follow && !s.follow && !this.resetting) this.flyOut(prev.selected ?? this.leaving);
        if (s.src !== prev.src || s.dst !== prev.dst) {
          this.routePath = null;
          s.set({ latency: [], route: null });
          this.rebuildCones(s.src, s.dst);
        }
      }),
    );
    const s = useStore.getState();
    this.rebuildCones(s.src, s.dst);
    this.cones.visible = s.layers.cones;
    this.coverage.mesh.visible = s.layers.coverage;
    this.sky.setVisible(s.layers.sky);
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
    s.set({ conj: { ...s.conj, status: 'running', progress: 0, elapsedMs: 0, total: 0, events: [], bands: [0, 0, 0], stats: null, hours, thresholdKm, startJd: jd0, selected: null } });
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
          bands: m.bands as never,
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
    this.applyViewOffset();
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
