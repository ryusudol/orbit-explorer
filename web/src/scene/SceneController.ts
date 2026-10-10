// Owns the renderer, the animation loop and every worker. React starts it
// from one effect; the loop never goes through React. Summaries flow to the
// Zustand store at ~5 Hz; user intent flows back through store subscriptions.

import * as THREE from 'three/webgpu';
import { float, mrt, output, pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

import { Propagator, gmst, illumination, loadEngine, sun_position_teme, teme_to_geodetic } from '../engine';
import { GROUP_HEX } from '../palette';
import { Category, Group, subset, type Catalog } from '../sim/catalog';
import { cityById } from '../sim/cities';
import { capHalfAngle, fibreLatencyMs, geodeticToEcef, greatCircleKm, vacuumLatencyMs } from '../sim/physics';
import { PropagationPool } from '../sim/propagationPool';
import { SimClock, jdToMs } from '../sim/time';
import { useStore, type Layers } from '../state/store';
import type { AnalysisResult } from '../workers/analysis.worker';
import { Earth } from './earth';
import { OrbitPath, SegmentLayer, ThickPath } from './lines';
import { CoverageOverlay, visibilityCone } from './overlays';
import { Sky, decodeStars } from './sky';
import { Spacecraft, orbitFrame } from './spacecraft';
import { SpriteLayer } from './sprites';
import { ALL_TILES, loadInOrder } from './tiles';
import { BODIES, BODY_ORDER, type BodyId } from '../sim/bodies';
import { span } from '../sim/ephemeris';
import { lightTimeS, relayPlan } from '../sim/relay';
import { mulMat, precession, transpose, type Mat3, type Vec3 } from '../sim/solar';
import type { OrbiterInfo } from '../state/store';
import { SolarSystem, type OrbiterState } from './system';
import { arrivalDirection, travelDuration, travelPose, unit, type TravelPlan, type V3 } from './travel';

const R_EARTH = 6378.137;
const MIN_ELEV_DEG = 25;
/** Shell height the visibility cones reach up to. */
const CONE_SHELL_KM = 480;
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
const NEAR_MIN_KM = 0.0015;
/** Close-up viewpoint in the object's orbital frame: above, off to one side and one end (signs chosen per flight). */
const CLOSE_VIEW = new THREE.Vector3(0.75, 0.2, 0.62).normalize();
/**
 * Orbit viewpoint, in the same frame: behind, well off the orbital plane (on the close-up's
 * side) and a little below, so zoomed out the track climbs past the object and arcs away over
 * the Earth's limb instead of reading edge-on as a line.
 */
const ARC_VIEW = new THREE.Vector3(-0.7, 0.55, -0.15).normalize();
/** Zooming out while following swings the view from CLOSE_VIEW to ARC_VIEW between these distances (× orbit radius). */
const SWING_NEAR = 0.004;
const SWING_FAR = 0.4;
/** A follow view spans metres to thousands of km, so zoom steps are coarser. */
const FOLLOW_ZOOM = 2.5;

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
const matrix4 = (m: Mat3) => new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);

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
  /** move relative to the target (a close approach to a moving object), not about the Earth's centre */
  relative: boolean;
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
  private craft = new Spacecraft();
  /** the Moon, Mars and their orbiters, and where every world sits in the scene */
  private sys!: SolarSystem;
  /** everything drawn relative to the Earth's centre: satellites, links, route, orbits, the model */
  private earthLayers = new THREE.Group();
  /** model of a followed spacecraft around the Moon or Mars */
  private orbCraft = new Spacecraft();
  /** the world the scene is centred on; while travelling, the one we left until we arrive */
  private focus: BodyId = 'earth';
  /** geocentric position of the scene's origin, km */
  private anchor: Vec3 = [0, 0, 0];
  private travel: { from: BodyId; to: BodyId; t0: number; plan: TravelPlan; after?: () => void } | null = null;
  /** Moon/Mars orientation last frame, for turning the camera with the ground */
  private lastOrient: Mat3 | null = null;
  /** 0..1: the Earth's satellites fade out as we leave and back in as we arrive */
  private earthFade = 1;
  private orbiterModel = 0;
  private relayAt = 0;
  private relayKey = '';
  private worldLabels = new Map<BodyId, HTMLButtonElement>();

  readonly n: number;
  private pos: Float64Array;
  private valid: Uint8Array;
  private visibleMask: Uint8Array;
  private edges: Uint32Array | null = null;
  private routePath: Uint32Array | null = null;
  private routePoints = new Float64Array(MAX_ROUTE_POINTS * 3);
  /** cached one-period tracks, resampled twice a second */
  private tracks = [0, 1].map(() => ({ for: -1, at: 0, jd0: 0, days: 0, pts: new Float64Array(ORBIT_SAMPLES * 3) }));
  /** the selected track with the object's exact position spliced in */
  private spliced = new Float64Array((ORBIT_SAMPLES + 1) * 3);
  private orbitTint = new THREE.Color();
  private flight: Flight | null = null;
  private lastGmst: number | null = null;
  private lastSlot = -2;
  private colorsDirty = true;
  private lastTarget = new THREE.Vector3();
  private sunDir = new THREE.Vector3(1, 0, 0);
  private selVel = new THREE.Vector3();
  /** orbital frame of the followed object last frame: the camera turns with it */
  private followFrame: THREE.Quaternion | null = null;
  /** signs applied to CLOSE_VIEW for the current follow (the Sun's side); ARC_VIEW takes only the cross-track one */
  private followSide = new THREE.Vector3(1, 1, 1);
  /** how far the follow view has swung from CLOSE_VIEW to ARC_VIEW, 0..1 */
  private followSwing: number | null = null;
  /** 0 = selected object drawn as a dot and ring, 1 = drawn as its 3D model */
  private modelFade = 0;

  private labelLayer: HTMLDivElement;
  private labels = new Map<string, HTMLDivElement>();
  private unsub: (() => void)[] = [];
  private frames = 0;
  private fpsT0 = performance.now();
  private lastStats = 0;
  private lastFrame = performance.now();
  private frameMs = 0;
  private interpMs = 0;
  private pointer = { down: false, x: 0, y: 0, moved: false };
  /** the pending once-per-frame hover pick, and where the pointer was for it */
  private hoverPick = { raf: 0, x: 0, y: 0 };
  private disposed = false;
  /** camera distance the zoom buttons are easing towards */
  private zoomGoal: number | null = null;
  /** screen area covered by UI panels, so the globe can centre in what's left */
  private insets = { left: 0, right: 0, top: 0, bottom: 0 };
  private insetsSet = false;
  private viewShift = { x: 0, y: 0 };
  private viewH = 1;
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
    // a handle for driving the scene from the console and from browser tests
    if (import.meta.env.DEV) (window as unknown as { orbit: SceneController }).orbit = this;
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
    this.earthLayers.name = 'earth-layers';
    this.earthLayers.add(this.links.object, ...this.orbits.map((o) => o.object), this.route.object, this.sats.object, this.packets.object, this.markers.object, this.craft.object);
    this.sys = new SolarSystem(this.renderer, this.earth.group, textureTier(), this.renderer.getPixelRatio());
    this.scene.add(...this.sky.objects, this.earthLayers, ...this.sys.objects, this.orbCraft.object);

    // post-processing: scene -> bloom -> tone map. Bloom is tuned for points of light;
    // spacecraft models write 0 to the mask (see spacecraft.ts) so a sunlit hull doesn't flood the view
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    const scenePass = pass(this.scene, this.camera);
    scenePass.setMRT(mrt({ output, bloom: float(1) }));
    scenePass.getTexture('bloom').type = THREE.UnsignedByteType;
    const color = scenePass.getTextureNode('output');
    const mask = scenePass.getTextureNode('bloom').r;
    this.pipeline.outputNode = color.add(bloom(color.mul(mask), 0.85, 0.35, 0.22));

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = R_EARTH + 400;
    this.controls.maxDistance = 250_000;
    this.controls.zoomSpeed = 0.8;
    this.controls.addEventListener('start', () => (this.interacted = true));
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
    this.locateIfAllowed();
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

    // the Moon is in the Earth's sky; Mars is a point of light until we go there
    sky
      .then(() => this.sys.loadPreview('moon'))
      .then(() => this.sys.loadPreview('mars'))
      .catch((err) => console.warn('Moon and Mars previews unavailable', err));
    const P = precession(this.clock.jd);
    this.sky.setFrame(matrix4(P));

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
      .then((buf) => !this.disposed && this.scene.add(this.sky.setStars(decodeStars(buf), this.renderer.getPixelRatio(), new THREE.Matrix3().set(...P))))
      .catch((err) => console.warn('Star catalogue unavailable', err));
  }

  /** Where the opening view looks down: North America, or the visitor if they share their location. */
  private home = { lat: 38, lon: -97 };
  /** set once the visitor turns or zooms the globe themselves */
  private interacted = false;

  /** Above `home` (Routing frames its own two cities); elsewhere, the lit side facing Earth. */
  private homePosition(): THREE.Vector3 {
    if (this.focus !== 'earth') return this.arrivalOffset(this.focus, 'earth');
    const g = gmst(this.clock.jd);
    return new THREE.Vector3(...geodeticToEcef(this.home.lat, this.home.lon, 0)).normalize().applyAxisAngle(Z_AXIS, g).multiplyScalar(this.fitDistance('earth'));
  }

  /**
   * Makes the visitor's location home, if the browser will say where that is.
   * Rounded to a degree, plenty to aim a camera, and never stored or sent anywhere.
   */
  private findHome(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(false);
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          this.home = { lat: Math.round(coords.latitude), lon: Math.round(coords.longitude) };
          resolve(!this.disposed);
        },
        () => resolve(false), // declined or unavailable: North America stays home
        { enableHighAccuracy: false, maximumAge: 24 * 3600 * 1000, timeout: 30_000 },
      );
    });
  }

  /**
   * On load, never prompt: only a visitor who already allowed location (with the
   * button, on an earlier visit) starts above it, and only if they haven't begun
   * exploring by the time the browser answers.
   */
  private async locateIfAllowed() {
    try {
      if ((await navigator.permissions?.query({ name: 'geolocation' }))?.state !== 'granted') return;
    } catch {
      return;
    }
    if (!(await this.findHome())) return;
    const s = useStore.getState();
    const untouched = !this.interacted && !this.flight && !this.travel && this.focus === 'earth' && s.selected === null && s.tab === 'explore';
    if (untouched) this.startFlight(this.homePosition(), new THREE.Vector3(), 1500, { earthFixed: true });
  }

  /** The "my location" button: asks the browser (it prompts once) and flies there. */
  async goToMyLocation(): Promise<boolean> {
    if (!(await this.findHome())) return false;
    if (this.focus === 'earth' && !this.travel) this.resetView();
    else this.travelTo('earth', () => this.resetView());
    return true;
  }

  private initialView() {
    this.camera.position.copy(this.homePosition());
    this.controls.target.set(0, 0, 0);
    this.zoomGoal = null;
    this.flight = null;
    this.controls.update();
  }

  /** Distance at which a world plus its busiest orbits (Starlink's shells, for the Earth) fill most of the uncovered screen. */
  private fitDistance(body: BodyId = this.focus): number {
    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth || window.innerWidth, h = parent?.clientHeight || window.innerHeight;
    const free = Math.max(240, Math.min(w - this.insets.left - this.insets.right, h - this.insets.top - this.insets.bottom));
    const radius = BODIES[body].frameKm;
    // projected radius in px = (R / sqrt(d² − R²)) / tan(fov/2) · h/2
    const k = ((0.41 * free) / (h / 2)) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    return THREE.MathUtils.clamp(radius * Math.sqrt(1 + 1 / (k * k)), radius * 2.25, radius * 8.5);
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
    const R = BODIES[this.focus].radiusKm;
    if (target.length() > 0.15 * R) return 0.4;
    const altitude = Math.max(0, this.camera.position.distanceTo(target) - R);
    // OrbitControls turns 2π per screen height at rotateSpeed 1; the screen spans one fov
    const grab = (THREE.MathUtils.degToRad(this.camera.fov) / (2 * Math.PI)) * (altitude / R);
    return THREE.MathUtils.clamp(grab * 1.15, 0.025, 0.5);
  }

  /** Smoothly scale the camera's distance to its target. */
  zoomBy(factor: number) {
    if (!this.controls) return;
    this.interacted = true;
    const d = this.zoomGoal ?? this.camera.position.distanceTo(this.controls.target);
    const k = useStore.getState().follow ? factor ** FOLLOW_ZOOM : factor;
    this.zoomGoal = THREE.MathUtils.clamp(d * k, this.controls.minDistance, this.controls.maxDistance);
  }

  /** 0 at the model close-up, 1 at the orbit-arc view, by log distance (see SWING_NEAR/FAR). */
  private swingWeight(distance: number, orbitRadius: number): number {
    return THREE.MathUtils.smoothstep(Math.log(distance), Math.log(SWING_NEAR * orbitRadius), Math.log(SWING_FAR * orbitRadius));
  }

  /**
   * While following, "up" is the local vertical, so the horizon stays level all the way
   * round (with north up, a polar orbit's chase view rolls over near the equator).
   * Eased, so entering and leaving follow mode turn the view rather than snap it.
   */
  private updateUp(dt: number, followed: number | null) {
    const goal = followed === null ? Z_AXIS : new THREE.Vector3(this.pos[3 * followed], this.pos[3 * followed + 1], this.pos[3 * followed + 2]).normalize();
    const up = this.camera.up;
    if (up.equals(goal)) return;
    const turn = new THREE.Quaternion().setFromUnitVectors(up, goal);
    up.applyQuaternion(new THREE.Quaternion().slerp(turn, Math.min(1, dt / 250))).normalize();
    if (up.angleTo(goal) < 1e-4) up.copy(goal);
    // OrbitControls caches its frame for `up` at construction
    const c = this.controls as unknown as { _quat: THREE.Quaternion; _quatInverse: THREE.Quaternion };
    c._quat.setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
    c._quatInverse.copy(c._quat).invert();
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
        this.selVel.set(st[3], st[4], st[5]);
        this.valid[sel] = 1;
      }
    }
    this.craft.setObject(sel, sel === null ? '' : this.catalog.names[sel], sel === null ? 0 : this.catalog.category[sel], sel === null ? 0 : this.catalog.ids[sel]);

    // Earth orientation and lighting
    const g = gmst(jd);
    if (this.lastGmst !== null && layers.earthFixed && !s.follow && this.focus === 'earth' && !this.travel) {
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
    this.sys.update(jd, sun);
    if (!this.travel) {
      // the scene stays centred on the world in focus as it moves (Mars at ~20 km/s relative to us)
      const a = this.sys.at(this.focus);
      this.anchor = [a[0], a[1], a[2]];
      // orbiter states for this frame before the camera follows one
      if (this.focus !== 'earth') this.sys.advance(this.focus, jd);
    }
    if (this.focus !== 'earth' && !this.travel) this.turnWithWorld(layers.earthFixed && !s.follow);
    else this.lastOrient = null;

    // follow mode: keep the camera's offset from the object fixed in the object's
    // orbital frame, so a chase view stays a chase view all the way round
    if (this.travel) {
      this.stepTravel(now);
    } else if (this.flight) {
      this.stepFlight(now);
    } else if (s.follow && this.focus === 'earth' && sel !== null && this.valid[sel]) {
      const t = new THREE.Vector3(this.pos[3 * sel], this.pos[3 * sel + 1], this.pos[3 * sel + 2]);
      const off = this.camera.position.clone().sub(this.lastTarget);
      const q = orbitFrame(t, this.selVel, new THREE.Quaternion());
      if (this.followFrame) off.applyQuaternion(q.clone().multiply(this.followFrame.invert()));
      this.followFrame = q;
      // Zooming out swings the view off the orbital plane, from the model close-up to the
      // track seen as an arc over the Earth; zooming in swings it back. Each step turns only
      // the share of the way the zoom covered, so a direction the user dragged to is kept.
      const w = this.swingWeight(off.length(), t.length());
      const w0 = this.followSwing ?? w;
      if (w !== w0) {
        const out = w > w0;
        const side = this.followSide;
        const goal = (out ? ARC_VIEW.clone().setY(ARC_VIEW.y * side.y) : CLOSE_VIEW.clone().multiply(side)).applyQuaternion(q);
        const turn = new THREE.Quaternion().setFromUnitVectors(off.clone().normalize(), goal);
        off.applyQuaternion(new THREE.Quaternion().slerp(turn, out ? (w - w0) / (1 - w0) : (w0 - w) / w0));
      }
      this.followSwing = w;
      this.camera.position.copy(t).add(off);
      this.controls.target.copy(t);
      this.lastTarget.copy(t);
    } else if (s.follow && this.focus !== 'earth') {
      this.followOrbiter(s.orbiter);
    }
    if (this.zoomGoal !== null) {
      const t = this.controls.target;
      const off = this.camera.position.clone().sub(t);
      const d = off.length();
      const next = d + (this.zoomGoal - d) * Math.min(1, dt / 60);
      this.camera.position.copy(t).add(off.setLength(next));
      if (Math.abs(next - this.zoomGoal) < Math.min(0.5, this.zoomGoal * 1e-3)) this.zoomGoal = null;
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
    this.controls.zoomSpeed = s.follow ? 0.8 * FOLLOW_ZOOM : 0.8;
    this.updateUp(dt, s.follow && this.focus === 'earth' && sel !== null && this.valid[sel] ? sel : null);
    if (!this.travel) this.controls.update();
    // close to a model the near plane has to come in to metres (the log depth buffer keeps the
    // precision). Not below NEAR_MIN_KM: under ~0.5 m (far/near ~1e10) the view floods with glare.
    const near = this.travel ? 1 : THREE.MathUtils.clamp(this.camera.position.distanceTo(this.controls.target) * 0.01, NEAR_MIN_KM, 1);
    if (Math.abs(near / this.camera.near - 1) > 0.1) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
    const cam = this.camera.position;
    // worlds first: the Earth's satellites ride on the Earth's place in the scene
    this.sys.place(this.anchor, cam, this.viewH, this.camera.fov, layers.sky);
    this.earth.group.updateMatrixWorld();
    this.earth.setCamera(this.earth.group.worldToLocal(cam.clone()));
    const atEarth = this.focus === 'earth' && !this.travel;
    this.stepEarthFade(dt, atEarth);
    this.earthLayers.visible = this.earthFade > 0;
    this.earthLayers.position.copy(this.earth.group.position);
    this.coverage.mesh.visible = atEarth && layers.coverage;
    this.cones.visible = atEarth && layers.cones;
    if (this.earthLayers.visible) {
      // the camera relative to the Earth's centre: what every Earth layer is drawn against
      const camE = cam.clone().sub(this.earth.group.position);
      this.updateCraft(camE, jd, sel, sunDir);
      this.updateSatellites(camE, layers, sel);
      this.updateLinks(camE, layers);
      this.updateRoute(camE, g, now, layers, s.src, s.dst);
      const ev = s.conj.selected !== null ? s.conj.events[s.conj.selected] : undefined;
      // a conjunction is shown only alongside one of its two objects
      const pair = ev && sel !== null && (ev.a === sel || ev.b === sel) ? ev : undefined;
      // a hover from the Moon or Mars carries a colour and indexes their orbiters, not the catalogue
      this.updateMarkers(camE, sel, pair, s.hover && !s.hover.color ? s.hover.index : null);
      this.updateOrbits(camE, jd, sel, pair);
    }
    this.updateLabels(g, s.src, s.dst, atEarth && (layers.route || layers.cones));
    this.updateWorlds(jd, cam, s);

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
      const show = [layers.starlink, layers.debris, layers.otherSatellites];
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
        this.sats.setColor(i, GROUP_COLORS[gi], GROUP_SIZE[gi], GROUP_GAIN[gi] * this.earthFade);
      }
      // once its model is big enough to see, the selected object is drawn as that instead
      if (sel !== null) this.sats.setColor(sel, WHITE, this.modelFade > 0.5 ? 0 : 7, 3);
      this.visibleCount = visible;
      this.colorsDirty = false;
      this.sats.commit(n, cam, true);
    } else {
      this.sats.commit(n, cam, false);
    }
  }
  private visibleCount = 0;

  /** The selected object's model, faded in over the dot and ring as it grows past a few pixels. */
  private updateCraft(cam: THREE.Vector3, jd: number, sel: number | null, sunDir: THREE.Vector3) {
    const p = new THREE.Vector3();
    let px = 0;
    if (sel !== null && this.valid[sel]) {
      p.set(this.pos[3 * sel], this.pos[3 * sel + 1], this.pos[3 * sel + 2]);
      const angular = this.craft.radiusKm / Math.max(1e-9, p.distanceTo(cam));
      px = (angular / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * (this.viewH / 2);
    }
    const fade = THREE.MathUtils.smoothstep(px, 4, 14);
    if (fade > 0.5 !== this.modelFade > 0.5) this.colorsDirty = true;
    this.modelFade = fade;
    const shown = px > 1;
    const sunlit = shown ? illumination(p.x, p.y, p.z, jd) : 1;
    this.craft.update(p, this.selVel, sunDir, sunlit, (jd - 2451545) * 86400, shown);
  }

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

  private updateMarkers(cam: THREE.Vector3, sel: number | null, conj: { a: number; b: number } | undefined, hovered: number | null) {
    let k = 0;
    const ring = (i: number, c: THREE.Color, size: number, strength = 2.2) => {
      // the selected object's ring gives way to its model
      const gain = strength * (i === sel ? 1 - this.modelFade : 1);
      if (!this.valid[i] || gain <= 0) return;
      this.markers.setOffset(k, this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2], cam);
      this.markers.setColor(k, c, size, gain);
      k++;
    };
    if (sel !== null) ring(sel, WHITE, 22);
    if (conj) {
      ring(conj.a, SERIOUS, 26);
      ring(conj.b, SERIOUS, 26);
    }
    // the object under the pointer: a fainter, smaller ring than the selection's (as at the Moon and Mars)
    if (hovered !== null && hovered !== sel && hovered !== conj?.a && hovered !== conj?.b) ring(hovered, WHITE, 18, 1.2);
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
        tr.jd0 = jd - periodDays / 2;
        tr.days = periodDays;
      }
      // samples are ~1° apart, so the chords miss the object by up to a few hundred metres:
      // splice its exact position in, so close up the track runs through the model
      const j = Math.floor(((jd - tr.jd0) / tr.days) * (ORBIT_SAMPLES - 1));
      if (k === 0 && j >= 0 && j < ORBIT_SAMPLES - 1) {
        const sp = this.spliced;
        sp.set(tr.pts.subarray(0, 3 * (j + 1)));
        sp.set(this.pos.subarray(3 * i, 3 * i + 3), 3 * (j + 1));
        sp.set(tr.pts.subarray(3 * (j + 1)), 3 * (j + 2));
        // dimmer once the model is up: close in, the track is a guide, not the subject
        orbit.update(sp, ORBIT_SAMPLES + 1, this.orbitTint.copy(ORBIT_COLOR).multiplyScalar(1 - 0.65 * this.modelFade), cam);
      } else {
        orbit.update(tr.pts, ORBIT_SAMPLES, k === 0 ? ORBIT_COLOR : PARTNER_ORBIT_COLOR, cam);
      }
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
    // does the segment camera -> p pass through the world in focus (at the origin)?
    const c = this.camera.position;
    const d = p.clone().sub(c);
    const len2 = d.lengthSq();
    const t = Math.min(1, Math.max(0, -c.dot(d) / len2));
    const closest = c.clone().add(d.multiplyScalar(t));
    return closest.length() < (this.focus === 'earth' ? 6356 : BODIES[this.focus].radiusKm) && t < 0.999;
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
      if (this.pointer.down) return;
      // pick at most once a frame, at the latest pointer position, so the ring and tip keep up with the pointer
      const r = c.getBoundingClientRect();
      const hp = this.hoverPick;
      hp.x = e.clientX - r.left;
      hp.y = e.clientY - r.top;
      if (!hp.raf) hp.raf = requestAnimationFrame(() => this.hoverPointer(hp.x, hp.y));
    });
    c.addEventListener('pointerup', (e) => {
      const wasClick = this.pointer.down && !this.pointer.moved;
      this.pointer.down = false;
      if (!wasClick) return;
      const r = c.getBoundingClientRect();
      if (this.travel) return;
      if (this.focus !== 'earth') {
        const id = this.pickOrbiter(e.clientX - r.left, e.clientY - r.top, 14);
        if (id !== null) this.selectOrbiter(id);
        return;
      }
      const i = this.pick(e.clientX - r.left, e.clientY - r.top, 14);
      if (i !== null) this.selectObject(i);
    });
    c.addEventListener('pointerleave', () => {
      cancelAnimationFrame(this.hoverPick.raf);
      this.hoverPick.raf = 0;
      useStore.getState().set({ hover: null });
    });
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

  /**
   * Close-up position: a few model radii out, fixed in the object's orbital frame,
   * on the Sun's side so the lit face is in view and the Sun's glare is behind the camera.
   */
  private closeUp(i: number, outPos: THREE.Vector3, outTarget: THREE.Vector3, side: THREE.Vector3) {
    const st = this.prop.state_at(i, this.clock.jd);
    outTarget.set(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]);
    if (st.length) this.selVel.set(st[3], st[4], st[5]);
    const q = orbitFrame(outTarget, this.selVel, new THREE.Quaternion());
    outPos.copy(CLOSE_VIEW).multiply(side).applyQuaternion(q).multiplyScalar(this.closeDistance()).add(outTarget);
  }
  /** a few radii out, and never so close the hull reaches the near plane (small fragments) */
  private closeDistance = () => Math.max(this.craft.radiusKm * 4, this.craft.radiusKm + 3 * NEAR_MIN_KM);

  /** Fly to an object and ride along with it: across to a chase position, then in to its model. */
  flyTo(i: number) {
    if (!this.valid[i]) return;
    const toPos = new THREE.Vector3(), toTarget = new THREE.Vector3();
    this.chase(i, toPos, toTarget);
    useStore.getState().set({ follow: true });
    this.startFlight(toPos, toTarget, 1600, {
      track: () => this.valid[i] && this.chase(i, toPos, toTarget),
      done: () => this.approach(i),
    });
  }

  private approach(i: number) {
    const s = useStore.getState();
    if (!s.follow || s.selected !== i || !this.valid[i]) {
      this.lastTarget.copy(this.controls.target);
      return;
    }
    const toPos = new THREE.Vector3(), toTarget = new THREE.Vector3();
    const p = new THREE.Vector3(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]);
    const sun = this.sunDir.clone().applyQuaternion(orbitFrame(p, this.selVel, new THREE.Quaternion()).invert());
    const side = new THREE.Vector3(Math.sign(sun.x) || 1, Math.sign(sun.y) || 1, 1);
    this.followSide.copy(side);
    this.closeUp(i, toPos, toTarget, side);
    this.startFlight(toPos, toTarget, 1900, {
      relative: true,
      minDistance: Math.max(this.craft.radiusKm * 1.15, this.craft.radiusKm + 2 * NEAR_MIN_KM),
      track: () => this.valid[i] && this.closeUp(i, toPos, toTarget, side),
      done: () => this.lastTarget.copy(this.controls.target),
    });
  }

  /** Leave follow mode by zooming back out, with the object still in the middle of the view. */
  stopFollowing() {
    if (useStore.getState().follow) useStore.getState().set({ follow: false }); // the store subscription flies out
  }

  private flyOut(from: number | null) {
    const orbiter = this.focus !== 'earth' ? this.sys.find(useStore.getState().orbiter) : null;
    const p =
      this.focus !== 'earth'
        ? orbiter?.valid
          ? orbiter.pos.clone()
          : this.camera.position.clone()
        : from !== null && this.valid[from]
          ? new THREE.Vector3(this.pos[3 * from], this.pos[3 * from + 1], this.pos[3 * from + 2])
          : this.camera.position.clone();
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

  /** Fly to look straight down between two ground terminals, close enough that both and their visibility cones fill the open part of the view. */
  private frameRoute(src: string, dst: string) {
    if (useStore.getState().follow) {
      this.resetting = true;
      useStore.getState().set({ follow: false });
      this.resetting = false;
    }
    const g = gmst(this.clock.jd);
    const a = this.stationTeme(src, g).normalize(), b = this.stationTeme(dst, g).normalize();
    const axis = a.clone().add(b);
    // a near-antipodal pair has no midpoint on the surface: look down on the origin
    if (axis.lengthSq() < 1e-6) axis.copy(a);
    else axis.normalize();
    // angle from the view axis to the far edge of either cone
    const theta = Math.min(Math.acos(THREE.MathUtils.clamp(a.dot(axis), -1, 1)) + capHalfAngle(CONE_SHELL_KM, MIN_ELEV_DEG), Math.PI / 2);
    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth || window.innerWidth, h = parent?.clientHeight || window.innerHeight;
    const free = Math.max(240, Math.min(w - this.insets.left - this.insets.right, h - this.insets.top - this.insets.bottom));
    const tanFit = ((0.45 * free) / (h / 2)) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // a surface point θ off the axis is seen atan(R sinθ / (d − R cosθ)) off centre from distance d
    const d = R_EARTH * Math.cos(theta) + (R_EARTH * Math.sin(theta)) / tanFit;
    const dist = THREE.MathUtils.clamp(d, R_EARTH + 2000, this.fitDistance('earth'));
    this.startFlight(axis.multiplyScalar(dist), new THREE.Vector3(), 1500, { earthFixed: true });
  }

  private startFlight(
    toPos: THREE.Vector3,
    toTarget: THREE.Vector3,
    dur: number,
    opts: { track?: () => void; done?: () => void; earthFixed?: boolean; relative?: boolean; minDistance?: number } = {},
  ) {
    this.zoomGoal = null;
    this.followFrame = null;
    this.followSwing = null;
    // the target moves between the object and the Earth's centre mid-flight
    this.controls.minDistance = Math.max(1e-3, opts.minDistance ?? 20);
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
      relative: opts.relative ?? false,
    };
  }

  private stepFlight(now: number) {
    const f = this.flight!;
    f.track?.();
    const u = Math.min(1, (now - f.t0) / f.dur);
    const k = easeInOutCubic(u);
    // direction: slerp about the centre (the Earth's, or the object's when closing in on it);
    // distance: geometric (log-linear) so the long zoom feels even and never dips inside the planet
    const centre = f.relative ? f.toTarget : new THREE.Vector3();
    const from = f.relative ? f.fromPos.clone().sub(f.fromTarget) : f.fromPos.clone();
    const to = f.toPos.clone().sub(centre);
    const r0 = from.length(), r1 = to.length();
    const a = from.divideScalar(r0), b = to.divideScalar(r1);
    const q = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), new THREE.Quaternion().setFromUnitVectors(a, b), k);
    this.camera.position.copy(a.applyQuaternion(q).multiplyScalar(Math.exp(Math.log(r0) + (Math.log(r1) - Math.log(r0)) * k))).add(centre);
    if (f.relative) this.controls.target.copy(f.toTarget);
    else this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
    if (u >= 1) {
      this.flight = null;
      if (!useStore.getState().follow) this.controls.minDistance = this.minDistance();
      f.done?.();
    }
  }

  /** User input takes over from an overview flight; a fly-in to follow runs to the end. */
  private cancelFlight() {
    const f = this.flight;
    if (!f || useStore.getState().follow) return;
    this.flight = null;
    this.controls.minDistance = Math.min(this.minDistance(), this.camera.position.distanceTo(this.controls.target));
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
        if (prev.follow && !s.follow && !this.resetting && !this.travel) this.flyOut(prev.selected ?? this.leaving);
        if (s.layers.orbits !== prev.layers.orbits) this.sys.allOrbits = s.layers.orbits;
        if (s.src !== prev.src || s.dst !== prev.dst) {
          this.routePath = null;
          s.set({ latency: [], route: null });
          this.rebuildCones(s.src, s.dst);
          if (s.tab === 'route' && this.focus === 'earth' && !this.travel) this.frameRoute(s.src, s.dst);
        } else if (s.tab === 'route' && prev.tab !== 'route' && this.focus === 'earth' && !this.travel) {
          // opening Routing: the home view looks elsewhere, so bring the two cities into view
          this.frameRoute(s.src, s.dst);
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
      this.cones.add(visibilityCone(c.lat, c.lon, CONE_SHELL_KM, MIN_ELEV_DEG, CONE_TINT));
    }
  }

  // ------------------------------------------------------------ worlds

  /** The world being shown: the focus, or while travelling whichever world is nearer. */
  private nearestWorld(): BodyId {
    const c = this.camera.position;
    let best: BodyId = this.focus;
    let bestD = Infinity;
    for (const id of BODY_ORDER) {
      const a = this.sys.at(id);
      const d = Math.hypot(a[0] - this.anchor[0] - c.x, a[1] - this.anchor[1] - c.y, a[2] - this.anchor[2] - c.z) / BODIES[id].radiusKm;
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  /** One-way light time between the Earth and a world at a simulated time, s. */
  lightTimeTo(body: BodyId, timeMs: number): number {
    return lightTimeS(body, timeMs / 86400000 + 2440587.5);
  }

  /** Closest the camera may come to the world in focus (from its centre). */
  private minDistance(body: BodyId = this.focus): number {
    return BODIES[body].radiusKm + BODIES[body].minAltitudeKm;
  }

  /** Camera offset on arriving at `to` from `from`: the lit side, leaning toward where we came from. */
  private arrivalOffset(to: BodyId, from: BodyId): THREE.Vector3 {
    if (to === 'earth') {
      const g = gmst(this.clock.jd);
      return new THREE.Vector3(...geodeticToEcef(38, -38, 0)).normalize().applyAxisAngle(Z_AXIS, g).multiplyScalar(this.fitDistance('earth'));
    }
    const A = this.sys.at(from), B = this.sys.at(to);
    const sun = new THREE.Vector3();
    this.sys.sunFrom(to, sun);
    const pole = this.sys.pole(to, new THREE.Vector3());
    const d = arrivalDirection([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [sun.x, sun.y, sun.z], [pole.x, pole.y, pole.z]);
    return new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(this.fitDistance(to));
  }

  /**
   * Fly to another world (see travel.ts). The camera rises off this one, turns to
   * face the destination and falls toward its lit side; selections are let go.
   */
  travelTo(to: BodyId, after?: () => void) {
    if (!this.controls || !this.sys) return;
    if (!this.travel && to === this.focus) {
      if (after) after();
      else this.resetView();
      return;
    }
    const s = useStore.getState();
    const from = this.travel ? this.nearestWorld() : this.focus;
    if (this.travel && from === to && this.travel.to === to) return;
    const cam = this.camera.position;
    const camW: Vec3 = [this.anchor[0] + cam.x, this.anchor[1] + cam.y, this.anchor[2] + cam.z];
    const A = this.sys.at(from), B = this.sys.at(to);
    const fromOff: V3 = [camW[0] - A[0], camW[1] - A[1], camW[2] - A[2]];
    const look = this.camera.getWorldDirection(new THREE.Vector3());
    const arrive = this.arrivalOffset(to, from);
    const D = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
    const r0 = Math.hypot(...fromOff);
    // leave follow mode and any selection without the usual fly-out: this flight replaces it
    this.travel = {
      from,
      to,
      t0: performance.now(),
      after,
      plan: { from: fromOff, look: [look.x, look.y, look.z], toDir: unit([arrive.x, arrive.y, arrive.z]), toDist: arrive.length(), dur: travelDuration(r0, arrive.length(), D) },
    };
    this.flight = null;
    this.zoomGoal = null;
    this.followFrame = null;
    this.followSwing = null;
    this.controls.enabled = false;
    this.updateUp(1e6, null);
    if (s.selected !== null) this.selectObject(null);
    const tab = to === 'earth' ? (s.tab === 'fleet' || s.tab === 'relay' ? 'explore' : s.tab) : s.tab === 'explore' || s.tab === 'perf' || s.tab === 'fleet' || s.tab === 'relay' ? s.tab : 'fleet';
    s.set({ body: to, travel: { from, to }, orbiter: null, orbiterInfo: null, follow: false, hover: null, relay: null, tab });
    this.sys.loadTracks(to);
    if (to !== 'earth') this.sys.loadImagery(to, () => this.sys.toBodyFixed(to, arrive.clone().normalize()));
  }

  private stepTravel(now: number) {
    const tr = this.travel!;
    const u = Math.min(1, (now - tr.t0) / tr.plan.dur);
    const A = this.sys.at(tr.from), B = this.sys.at(tr.to);
    const { pos, look } = travelPose(tr.plan, u, [B[0] - A[0], B[1] - A[1], B[2] - A[2]]);
    if (u >= 1) {
      // arrived: centre the scene on the new world and hand the camera back
      this.travel = null;
      this.focus = tr.to;
      this.anchor = [B[0], B[1], B[2]];
      this.camera.position.set(A[0] + pos[0] - B[0], A[1] + pos[1] - B[1], A[2] + pos[2] - B[2]);
      this.controls.target.set(0, 0, 0);
      this.controls.minDistance = this.minDistance();
      this.controls.maxDistance = BODIES[tr.to].maxDistanceKm;
      this.controls.enabled = true;
      this.camera.lookAt(0, 0, 0);
      this.lastGmst = null;
      this.lastOrient = null;
      this.colorsDirty = true;
      useStore.getState().set({ travel: null });
      // the destination's trajectories may still be on their way
      if (tr.after) this.sys.loadTracks(tr.to).then(() => setTimeout(() => tr.after?.(), 60));
      return;
    }
    // in transit the camera is the scene's origin: precision where we look from
    this.anchor = [A[0] + pos[0], A[1] + pos[1], A[2] + pos[2]];
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(look[0], look[1], look[2]);
  }

  /** "Rotate with the world" for the Moon and Mars: carry the camera round with the ground. */
  private turnWithWorld(on: boolean) {
    const m = this.sys.orientation(this.focus as 'moon' | 'mars');
    if (on && this.lastOrient) {
      const q = new THREE.Quaternion().setFromRotationMatrix(matrix4(mulMat(m, transpose(this.lastOrient))));
      this.camera.position.applyQuaternion(q);
      this.controls.target.applyQuaternion(q);
      const f = this.flight;
      if (f?.earthFixed) for (const v of [f.fromPos, f.fromTarget, f.toPos, f.toTarget]) v.applyQuaternion(q);
    }
    this.lastOrient = m;
  }

  private stepEarthFade(dt: number, atEarth: boolean) {
    const goal = atEarth ? 1 : 0;
    if (this.earthFade === goal) return;
    this.earthFade = atEarth ? Math.min(1, this.earthFade + dt / 900) : Math.max(0, this.earthFade - dt / 350);
    this.colorsDirty = true;
  }

  /**
   * Everything about the worlds that isn't the Earth's own layers: the orbiters of
   * the Moon or Mars (dots, orbits, names, a followed spacecraft's model), the
   * other worlds' names in the sky, and the Sun as seen from where we are.
   */
  private updateWorlds(jd: number, cam: THREE.Vector3, s: ReturnType<typeof useStore.getState>) {
    const here = this.travel ? this.nearestWorld() : this.focus;
    const sun = new THREE.Vector3();
    const au = this.sys.sunFrom(here, sun);
    this.sky.update(cam, sun, au);

    // orbiters: around the world in focus, or the destination as we close in
    const tr = this.travel;
    const shown: BodyId | null = tr ? (here === tr.to && tr.to !== 'earth' ? tr.to : null) : this.focus !== 'earth' ? this.focus : null;
    const origin = new THREE.Vector3();
    if (shown) {
      const a = this.sys.at(shown);
      origin.set(a[0] - this.anchor[0], a[1] - this.anchor[1], a[2] - this.anchor[2]);
    }
    const sel = shown && !tr ? s.orbiter : null;
    const o = this.sys.find(sel);
    // the selected spacecraft's model fades in over its dot as it grows past a few pixels
    let px = 0;
    if (o?.valid && o.o.kind === 'spacecraft') {
      this.orbCraft.setObject(o.o.id, o.o.name, Category.Payload, 0);
      px = (this.orbCraft.radiusKm / Math.max(1e-9, o.pos.distanceTo(cam)) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * (this.viewH / 2);
    } else {
      this.orbCraft.setObject(null);
    }
    this.orbiterModel = THREE.MathUtils.smoothstep(px, 4, 14);
    this.sys.updateOrbiters(shown, jd, origin, cam, sel, s.hover?.color ? s.hover.index : null, true, this.orbiterModel > 0.5);
    if (o?.valid && o.o.kind === 'spacecraft') {
      this.orbCraft.update(o.pos, o.vel, sun, this.sys.sunlit(this.focus, o), (jd - 2451545) * 86400, px > 1);
    } else {
      this.orbCraft.update(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), sun, 1, 0, false);
    }

    // orbiter names
    const named = new Set<string>();
    if (shown && !tr) {
      for (const st of this.sys.orbiters) {
        const key = `orb${st.o.id}`;
        named.add(key);
        const el = this.label(key, st.o.name);
        el.classList.add('orbiter-label');
        el.classList.toggle('moon', st.o.kind === 'moon');
        const p = st.pos;
        const sc = this.toScreen(p);
        // a name over a body that fills the view (Phobos close up, a spacecraft's model) only gets in the way
        const discPx = st.o.radii ? (st.o.radii[0] / Math.max(1e-6, p.distanceTo(cam)) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * (this.viewH / 2) : 0;
        const visible = st.valid && sc.ok && !this.occluded(p) && !(st.o.id === sel && this.orbiterModel > 0.5) && discPx < 24;
        el.style.opacity = visible ? (st.o.id === sel ? '1' : '0.78') : '0';
        if (visible) el.style.transform = `translate(${sc.x.toFixed(1)}px, ${sc.y.toFixed(1)}px)`;
      }
    }
    for (const [key, el] of this.labels) if (key.startsWith('orb') && !named.has(key)) el.style.opacity = '0';

    // the other worlds, named where they hang in the sky; click one to go there
    for (const id of BODY_ORDER) {
      const el = this.worldLabel(id);
      const a = this.sys.at(id);
      const d = new THREE.Vector3(a[0] - this.anchor[0], a[1] - this.anchor[1], a[2] - this.anchor[2]).sub(cam);
      const dist = d.length();
      const p = cam.clone().addScaledVector(d, Math.min(1, 5e5 / dist));
      const sc = this.toScreen(p);
      // only once it's small in the sky: a world filling the view needs no name
      const angular = BODIES[id].radiusKm / dist;
      const visible = !tr && id !== this.focus && s.layers.sky && sc.ok && angular < 0.08 && !this.occluded(p);
      el.style.opacity = visible ? '1' : '0';
      el.style.pointerEvents = visible ? 'auto' : 'none';
      if (visible) el.style.transform = `translate(${sc.x.toFixed(1)}px, ${sc.y.toFixed(1)}px)`;
    }
  }

  private worldLabel(id: BodyId): HTMLButtonElement {
    let el = this.worldLabels.get(id);
    if (!el) {
      el = document.createElement('button');
      el.className = 'scene-label world-label';
      el.textContent = BODIES[id].name;
      el.title = `Go to ${id === 'earth' ? 'the Earth' : id === 'moon' ? 'the Moon' : 'Mars'}`;
      el.addEventListener('click', () => this.travelTo(id));
      this.labelLayer.appendChild(el);
      this.worldLabels.set(id, el);
    }
    return el;
  }

  /** Nearest orbiter of the world in focus within `radiusPx` of a screen point (Horizons id). */
  private pickOrbiter(x: number, y: number, radiusPx: number): number | null {
    let best: number | null = null;
    let bestD = radiusPx * radiusPx;
    for (const st of this.sys.orbiters) {
      if (!st.valid) continue;
      const sc = this.toScreen(st.pos);
      if (!sc.ok) continue;
      const d = (sc.x - x) ** 2 + (sc.y - y) ** 2;
      if (d < bestD && !this.occluded(st.pos)) {
        bestD = d;
        best = st.o.id;
      }
    }
    return best;
  }

  private hoverPointer(x: number, y: number) {
    this.hoverPick.raf = 0;
    if (this.pointer.down) return;
    if (this.focus !== 'earth' || this.travel) {
      this.hoverOrbiter(x, y);
      return;
    }
    const i = this.pick(x, y, 10);
    const s = useStore.getState();
    if (i === null) {
      if (s.hover) s.set({ hover: null });
      this.canvas.style.cursor = '';
    } else {
      s.set({ hover: { index: i, name: this.catalog.names[i], x, y } });
      this.canvas.style.cursor = 'pointer';
    }
  }

  private hoverOrbiter(x: number, y: number) {
    const s = useStore.getState();
    const id = this.travel ? null : this.pickOrbiter(x, y, 12);
    const st = this.sys.find(id);
    if (!st) {
      if (s.hover) s.set({ hover: null });
      this.canvas.style.cursor = '';
      return;
    }
    s.set({ hover: { index: st.o.id, name: st.o.name, x, y, color: st.o.kind === 'moon' ? '#c9c4bc' : GROUP_HEX[2], meta: st.o.by } });
    this.canvas.style.cursor = 'pointer';
  }

  /** Select an orbiter of the Moon or Mars by Horizons id; while following, follow it instead. */
  selectOrbiter(id: number | null, follow = false) {
    const s = useStore.getState();
    const wasFollowing = s.follow;
    s.set({ orbiter: id, orbiterInfo: null, ...(id === null ? { follow: false } : null) });
    const st = this.sys.find(id);
    if (st?.valid) {
      this.lastTarget.copy(st.pos);
      if (follow || wasFollowing) this.flyToOrbiter(st.o.id);
    }
  }

  /** Fly to an orbiter and ride along: to a chase point, then in to the model (spacecraft) or a few radii out (moons). */
  flyToOrbiter(id: number) {
    const st = this.sys.find(id);
    if (!st?.valid || this.travel) return;
    useStore.getState().set({ orbiter: id, follow: true });
    const toPos = new THREE.Vector3(), toTarget = new THREE.Vector3();
    const moon = st.o.kind === 'moon';
    const chase = () => {
      const o = this.sys.find(id);
      if (!o?.valid) return;
      toTarget.copy(o.pos);
      const up = o.pos.clone().normalize();
      const back = o.vel.clone().normalize().negate();
      const d = moon ? o.o.radii![0] * 5 : 140;
      toPos.copy(o.pos).addScaledVector(back, d).addScaledVector(up, d * 0.35);
    };
    chase();
    this.startFlight(toPos, toTarget, 1600, {
      track: chase,
      minDistance: moon ? st.o.radii![0] * 1.4 : 1,
      done: () => (moon ? this.lastTarget.copy(this.controls.target) : this.approachOrbiter(id)),
    });
  }

  private approachOrbiter(id: number) {
    const s = useStore.getState();
    const st = this.sys.find(id);
    if (!s.follow || s.orbiter !== id || !st?.valid) {
      this.lastTarget.copy(this.controls.target);
      return;
    }
    this.orbCraft.setObject(id, st.o.name, Category.Payload, 0);
    const toPos = new THREE.Vector3(), toTarget = new THREE.Vector3();
    const sunW = new THREE.Vector3();
    this.sys.sunFrom(this.focus, sunW);
    const closeUp = () => {
      const o = this.sys.find(id);
      if (!o?.valid) return;
      toTarget.copy(o.pos);
      const q = orbitFrame(o.pos, o.vel, new THREE.Quaternion());
      const sun = sunW.clone().applyQuaternion(q.clone().invert());
      const side = new THREE.Vector3(Math.sign(sun.x) || 1, Math.sign(sun.y) || 1, 1);
      toPos.copy(CLOSE_VIEW).multiply(side).applyQuaternion(q).multiplyScalar(Math.max(this.orbCraft.radiusKm * 3.2, 0.01)).add(o.pos);
    };
    closeUp();
    this.startFlight(toPos, toTarget, 1900, {
      relative: true,
      minDistance: Math.max(this.orbCraft.radiusKm * 1.15, this.orbCraft.radiusKm + 2 * NEAR_MIN_KM),
      track: closeUp,
      done: () => this.lastTarget.copy(this.controls.target),
    });
  }

  /** Ride along with a followed orbiter, the camera's offset held in its orbital frame. */
  private followOrbiter(id: number | null) {
    const o = this.sys.find(id);
    if (!o?.valid) return;
    const off = this.camera.position.clone().sub(this.lastTarget);
    const q = orbitFrame(o.pos, o.vel, new THREE.Quaternion());
    if (this.followFrame) off.applyQuaternion(q.clone().multiply(this.followFrame.invert()));
    this.followFrame = q;
    this.camera.position.copy(o.pos).add(off);
    this.controls.target.copy(o.pos);
    this.lastTarget.copy(o.pos);
  }

  private orbiterInfo(o: OrbiterState, jd: number): OrbiterInfo {
    const body = this.focus as 'moon' | 'mars';
    const [t0, t1] = span(o.track);
    const base = { id: o.o.id, name: o.o.name, kind: o.o.kind, lightTimeS: lightTimeS(body, jd), spanMs: [jdToMs(t0), jdToMs(t1)] as [number, number] };
    if (!o.valid) return { ...base, valid: false, latDeg: 0, lonDeg: 0, altKm: 0, speedKms: 0, sunlit: 1, periodH: 0, inclinationDeg: 0, eccentricity: 0, periapsisKm: 0, apoapsisKm: 0 };
    const geo = this.sys.geo(body, o);
    const el = this.sys.elements(body, o);
    const R = BODIES[body].radiusKm;
    return {
      ...base,
      valid: true,
      latDeg: geo.lat,
      lonDeg: geo.lon,
      altKm: geo.altKm,
      speedKms: o.vel.length(),
      sunlit: this.sys.sunlit(body, o),
      periodH: el.periodS / 3600,
      inclinationDeg: el.inclinationDeg,
      eccentricity: el.e,
      periapsisKm: el.periapsisKm - R,
      apoapsisKm: el.apoapsisKm - R,
    };
  }

  /** The relay plan for the chosen site, refreshed as simulated time moves on (≤ every 1.5 s). */
  private relay(now: number, jd: number) {
    const s = useStore.getState();
    const body = this.focus as 'moon' | 'mars';
    const tracks = this.sys.tracksFor(body);
    const key = `${body}:${s.site[body]}:${tracks.length}`;
    const stale = !s.relay || key !== this.relayKey || Math.abs(jd - s.relay.jd0) * 1440 > 2;
    if (!stale || (key === this.relayKey && now - this.relayAt < 1500)) return null;
    this.relayKey = key;
    this.relayAt = now;
    const site = BODIES[body].sites.find((x) => x.id === s.site[body]) ?? BODIES[body].sites[0];
    return relayPlan(body, site, tracks, jd, 24, 60);
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
    if (this.focus !== 'earth' && !this.travel) {
      const o = this.sys.find(s.orbiter);
      if (o) patch.orbiterInfo = this.orbiterInfo(o, jd);
      patch.fleet = this.sys.orbiters.map((st) => {
        const R = BODIES[this.focus].radiusKm;
        const el = st.valid ? this.sys.elements(this.focus as 'moon' | 'mars', st) : null;
        return { id: st.o.id, name: st.o.name, kind: st.o.kind, by: st.o.by, valid: st.valid, altKm: st.valid ? st.pos.length() - R : 0, periodH: el ? el.periodS / 3600 : 0 };
      });
      if (s.tab === 'relay') {
        const plan = this.relay(now, jd);
        if (plan) patch.relay = plan;
      }
    }
    s.set(patch);
  }

  private resize() {
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth, h = parent.clientHeight;
    this.renderer.setSize(w, h, false);
    this.viewH = h;
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
    this.worldLabels.forEach((el) => el.remove());
    this.sys?.dispose();
    this.renderer?.dispose();
    if (current === this) current = null;
  }
}
