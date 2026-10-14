// Every world in one scene: the planets, the Moon, and the Sun-centered view out
// to the Oort cloud.
//
// Positions are geocentric, equatorial of date, in km (sim/planets.ts), kept in
// float64 here. The scene's origin is wherever precision is needed: the focused
// world's center, or the camera itself while traveling between worlds. A world
// beyond 700,000 km is drawn closer along its true direction and scaled down by the
// same factor (far.ts): same direction, same angular size, same lighting. Below a
// few pixels across, each world is also drawn as a point of light at its apparent
// magnitude, like the stars, so Jupiter is a bright star from Earth.
//
// Around the focused world, what orbits it comes from the JPL Horizons snapshot
// (sim/ephemeris.ts): dots, names and orbits for every spacecraft and moon, mapped
// globes for the big moons and lumpy bodies for the small ones.

import * as THREE from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { BODIES, BODY_ORDER, type BodyId, type Orbiter } from '../sim/bodies';
import { decodeEphemeris, eccentricAnomaly, elementsFromState, keplerState, objectState, osculating, span, stateAt, type EphObject, type Track } from '../sim/ephemeris';
import { geocentric, orientationOf } from '../sim/planets';
import { AU_KM, mul, mulMat, precession, transpose, type Mat3, type Vec3 } from '../sim/solar';
import { farPoint, farScale } from './far';
import { GasGiant, MappedMoon, type GiantLook, type MoonLook } from './giants';
import { Heliosphere, decodeTno } from './heliosphere';
import { OrbitPath, SegmentLayer, orbitPhase } from './lines';
import { Planet, SmallMoon, type PlanetLook } from './planet';
import { psf } from './sky';
import { SpriteLayer } from './sprites';
import { ALL_TILES, loadInOrder } from './tiles';

const ORBIT_SAMPLES = 361;
/** samples per orbit in the thin layer that draws every moon's orbit */
const THIN_SAMPLES = 96;
const THICK_PATHS = 14;

const SPACECRAFT = new THREE.Color('#DDAA33'); // Tol yellow, as for the Earth's "other satellites"
const MOON_DOT = new THREE.Color('#c9c4bc');
const MINOR_DOT = new THREE.Color('#a49f97');
const WHITE = new THREE.Color('#ffffff');
const ORBIT_DIM = new THREE.Color('#dfe9ff').multiplyScalar(0.22);
const ORBIT_SEL = new THREE.Color('#dfe9ff');

const matrix4 = (m: Mat3) => new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
const toV = (v: ArrayLike<number>, out = new THREE.Vector3()) => out.set(v[0], v[1], v[2]);
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** How each world is drawn. Rocky worlds use the tiled Planet; giants their own shader. */
type Look = { type: 'earth' } | { type: 'none' } | { type: 'rocky'; look: Omit<PlanetLook, 'radiusKm'>; uhd: boolean; relief: boolean } | { type: 'giant'; look: Omit<GiantLook, 'radiusKm' | 'polarKm'> };
const LOOKS: Record<BodyId, Look> = {
  earth: { type: 'earth' },
  moon: { type: 'rocky', look: { minnaert: 0.5, gain: 0.6, relief: 1.6 }, uhd: true, relief: true },
  mars: { type: 'rocky', look: { minnaert: 0.8, gain: 0.82, relief: 1.8, haze: { color: [1.0, 0.72, 0.5], heightKm: 40, strength: 0.4 } }, uhd: true, relief: true },
  // MESSENGER's color is subtle: a little warmer and darker than the Moon
  mercury: { type: 'rocky', look: { minnaert: 0.55, gain: 0.72, relief: 1.6 }, uhd: false, relief: true },
  // Magellan's radar view of the surface, under the cloud deck (see VENUS_CLOUDS)
  venus: { type: 'rocky', look: { minnaert: 0.9, gain: 0.85, relief: 2.5 }, uhd: false, relief: true },
  jupiter: { type: 'giant', look: { minnaert: 0.88, gain: 1.05 } },
  saturn: { type: 'giant', look: { minnaert: 0.88, gain: 1.1 } },
  uranus: { type: 'giant', look: { minnaert: 0.72, gain: 1.05, limb: [0.55, 0.78, 0.85] } },
  neptune: { type: 'giant', look: { minnaert: 0.72, gain: 1.15, limb: [0.45, 0.6, 1.0] } },
  oort: { type: 'none' },
};

/** Point-of-light colors. */
const STAR_TINT: Partial<Record<BodyId, string>> = { mars: '#ffb48a', earth: '#bcd6ff', mercury: '#e6ddd2', venus: '#fff4dc', jupiter: '#ffeacc', saturn: '#ffe5b4', uranus: '#d8f6ff', neptune: '#bccdff' };

/** Moons with a global map (scripts/worlds.mjs writes /textures/moons/{file}.jpg). */
const MAPPED: Record<number, { file: string; look: Omit<MoonLook, 'radii'> }> = {
  501: { file: 'io', look: { minnaert: 0.65, gain: 0.95 } },
  502: { file: 'europa', look: { minnaert: 0.7, gain: 0.95 } },
  503: { file: 'ganymede', look: { minnaert: 0.65, gain: 0.95 } },
  504: { file: 'callisto', look: { minnaert: 0.6, gain: 1.0 } },
  606: { file: 'titan', look: { minnaert: 0.8, gain: 1.0, haze: { color: [0.46, 0.29, 0.12], surface: 0.12 } } },
  605: { file: 'rhea', look: { minnaert: 0.65, gain: 0.95 } },
  608: { file: 'iapetus', look: { minnaert: 0.65, gain: 1.0 } },
  604: { file: 'dione', look: { minnaert: 0.65, gain: 0.95 } },
  603: { file: 'tethys', look: { minnaert: 0.65, gain: 0.95 } },
  602: { file: 'enceladus', look: { minnaert: 0.7, gain: 0.9 } },
  601: { file: 'mimas', look: { minnaert: 0.65, gain: 0.95 } },
  703: { file: 'titania', look: { minnaert: 0.65, gain: 0.95 } },
  704: { file: 'oberon', look: { minnaert: 0.65, gain: 0.95 } },
  702: { file: 'umbriel', look: { minnaert: 0.65, gain: 1.0 } },
  701: { file: 'ariel', look: { minnaert: 0.65, gain: 0.9 } },
  705: { file: 'miranda', look: { minnaert: 0.65, gain: 0.95 } },
  801: { file: 'triton', look: { minnaert: 0.7, gain: 0.9 } },
};

/** Small moons drawn as lumpy bodies: seed, an optional big crater, albedo tint. */
const LUMPY: Record<number, { seed: number; crater?: { lat: number; lon: number; radiusKm: number }; tint?: [number, number, number] }> = {
  401: { seed: 3.7, crater: { lat: 1, lon: -49, radiusKm: 4.5 } },
  402: { seed: 8.1 },
  505: { seed: 5.05, tint: [1.25, 0.82, 0.62] }, // Amalthea: dark (albedo 0.09) and the reddest body in the solar system
  607: { seed: 6.07, tint: [2.6, 2.3, 2.0] }, // Hyperion: icy, albedo ~0.3
  609: { seed: 6.09 },
  808: { seed: 8.08 },
  802: { seed: 8.02, tint: [1.6, 1.6, 1.6] },
};

/** Venus' clouds turn westward once every ~4 days, 60 times faster than the ground below. */
const VENUS_CLOUDS = { heightKm: 70, periodDays: 4.0 };

/** What one orbiter looks like right now, in scene coordinates relative to its world. */
export interface OrbiterState {
  o: Orbiter;
  eph: EphObject;
  /** the sampled trajectory, for spacecraft and fast moons */
  track?: Track;
  valid: boolean;
  /** position and velocity relative to the world's center, scene axes (km, km/s) */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** listed in BODIES: named in the scene, a thick orbit, a body of its own */
  curated: boolean;
}

interface World {
  id: BodyId;
  /** geocentric position, equatorial of date (km) */
  at: Vec3;
  /** body-fixed -> scene axes */
  orient: Mat3;
  /** scene group: the planet's body-fixed frame */
  group: THREE.Object3D;
  planet: Planet | null;
  giant: GasGiant | null;
}

/** A one-line description of a moon the curated list doesn't cover. */
function describeMoon(e: EphObject, body: BodyId, s: ArrayLike<number> | null, pole: THREE.Vector3): string {
  const r = e.radiusKm;
  const size = r ? (r < 1.5 ? 'About 2 km across' : `About ${r < 10 ? Math.round(2 * r) : Math.round(r / 5) * 10} km across`) : 'A few km across';
  let what = 'A small moon';
  if (s) {
    const mu = BODIES[body].mu;
    const el = osculating(s, mu);
    const h = new THREE.Vector3(s[1] * s[5] - s[2] * s[4], s[2] * s[3] - s[0] * s[5], s[0] * s[4] - s[1] * s[3]).normalize();
    const retro = h.dot(pole) < 0;
    const far = el.a > 50 * BODIES[body].radiusKm;
    const period = el.periodS / 86400;
    const round = period > 600 ? `${(period / 365.25).toFixed(1)} years` : period > 2 ? `${Math.round(period)} days` : `${(period * 24).toFixed(1)} hours`;
    const dist = el.a > 1e6 ? `${(el.a / 1e6).toFixed(el.a > 1e7 ? 0 : 1)} million km` : `${Math.round(el.a / 1000).toLocaleString('en-US')},000 km`;
    what = far ? `An irregular moon${retro ? ' on a backward orbit' : ''}, probably a captured asteroid or comet: ${round} around ${BODIES[body].the} at ${dist}` : `An inner moon, ${round} around ${BODIES[body].the} at ${dist}`;
  }
  const found = e.found ? ` Found in ${e.found.year}${e.found.by ? ` by ${e.found.by}` : ''}.` : '';
  return `${what}. ${size}.${found}`;
}

export class SolarSystem {
  readonly moon: Planet;
  readonly mars: Planet;
  readonly objects: THREE.Object3D[];
  readonly helio: Heliosphere;
  private worlds: Record<BodyId, World>;
  private venusClouds: MappedMoon;
  private P: Mat3 = precession(2461322.5);
  private Pjd = 0;
  /** geocentric Sun, equatorial of date (km) */
  sun: Vec3 = [AU_KM, 0, 0];
  /** see Venus' surface by radar instead of its clouds */
  radar = false;

  // orbiters of the focused world
  private ephem: Partial<Record<BodyId, EphObject[]>> = {};
  private loading: Partial<Record<BodyId, Promise<void>>> = {};
  readonly orbiters: OrbiterState[] = [];
  private orbiterBody: BodyId | null = null;
  private dots = new SpriteLayer(640, 'glow', { renderOrder: 2 });
  private rings = new SpriteLayer(4, 'ring', { renderOrder: 4, depthTest: true });
  private paths: OrbitPath[] = [];
  private thin = new SegmentLayer(640 * THIN_SAMPLES, new THREE.Color('#dfe9ff'), 0.16);
  private pathAt = 0;
  /** each orbit's samples relative to its world's center: the scene origin moves while traveling */
  private pathRel = Array.from({ length: THICK_PATHS }, () => ({ id: 0, pts: new Float64Array(ORBIT_SAMPLES * 3) }));
  private thinRel = new Map<number, { at: number; pts: Float64Array }>();
  private trackPts = new Float64Array(ORBIT_SAMPLES * 3);
  /** planets as points of light when too small to see as discs */
  private points = new SpriteLayer(12, 'star', { renderOrder: -1, depthTest: true });
  private imagery: Partial<Record<string, Promise<void>>> = {};
  private ktx2: KTX2Loader | null = null;
  private st = new Float64Array(6);
  private mapped = new Map<number, MappedMoon>();
  private lumpy = new Map<number, SmallMoon>();
  private moonGroup = new THREE.Group();
  private placeholder: THREE.Texture;
  private tnoLoad: Promise<void> | null = null;
  /** draw every orbiter's track, not just the selected one's */
  allOrbits = false;
  /** false hides every moon but the selected one (dots, bodies, orbits), leaving the spacecraft */
  showMoons = true;

  /** A moon hidden by the moons switch (the selection always shows). */
  hidden(s: OrbiterState, selected: number | null): boolean {
    return !this.showMoons && s.o.kind === 'moon' && s.o.id !== selected;
  }

  constructor(
    private renderer: THREE.WebGPURenderer,
    earthGroup: THREE.Object3D,
    private tier: 'uhd' | 'standard',
    private pixelRatio: number,
  ) {
    const gray = new THREE.DataTexture(new Uint8Array([40, 40, 40, 255]), 1, 1);
    gray.needsUpdate = true;
    this.placeholder = gray;
    const make = (id: BodyId): World => {
      const L = LOOKS[id];
      const B = BODIES[id];
      let planet: Planet | null = null, giant: GasGiant | null = null;
      let group: THREE.Object3D = earthGroup;
      if (L.type === 'rocky') {
        planet = new Planet(id, { radiusKm: B.radiusKm, ...L.look }, gray);
        group = planet.group;
      } else if (L.type === 'giant') {
        giant = new GasGiant(id, { radiusKm: B.radiusKm, polarKm: B.polarKm, ...L.look }, gray);
        group = giant.group;
      } else if (L.type === 'none') {
        group = new THREE.Group();
      }
      return { id, at: [0, 0, 0], orient: IDENTITY, group, planet, giant };
    };
    this.worlds = Object.fromEntries(BODY_ORDER.map((id) => [id, make(id)])) as Record<BodyId, World>;
    this.moon = this.worlds.moon.planet!;
    this.mars = this.worlds.mars.planet!;
    this.moon.fill.value = 0.012; // earthshine
    // Venus as we would see it: a bright, nearly featureless deck of sulfuric-acid cloud
    const R = BODIES.venus.radiusKm + VENUS_CLOUDS.heightKm;
    this.venusClouds = new MappedMoon('venus-clouds', { radii: [R, R, R], minnaert: 0.85, gain: 1.0 }, gray);
    this.worlds.venus.group.add(this.venusClouds.object);
    for (let i = 0; i < THICK_PATHS; i++) this.paths.push(new OrbitPath(ORBIT_SAMPLES, 1.3));
    this.moonGroup.name = 'moons';
    this.helio = new Heliosphere();
    const groups = BODY_ORDER.filter((id) => id !== 'earth').map((id) => this.worlds[id].group);
    this.objects = [...groups, this.moonGroup, this.points.object, this.thin.object, this.dots.object, this.rings.object, ...this.paths.map((p) => p.object), ...this.helio.objects];
  }

  // ------------------------------------------------------------------ data

  /** The 2k color map: enough for a world seen from another. */
  loadPreview(id: BodyId) {
    const L = LOOKS[id];
    if (L.type !== 'rocky' && L.type !== 'giant') return Promise.resolve();
    const tex = new THREE.TextureLoader().loadAsync(`/textures/${id}-color-2k.jpg`).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      const w = this.worlds[id];
      w.planet?.setColor(t);
      w.giant?.setColor(t);
    });
    if (id === 'venus') return Promise.all([tex, this.loadMoonMap(this.venusClouds, 'venus-clouds-2k', `/textures/`)]).then(() => {});
    return tex;
  }

  private loader(): KTX2Loader {
    this.ktx2 ??= new KTX2Loader().setTranscoderPath('/basis/').detectSupport(this.renderer);
    return this.ktx2;
  }

  private loadMoonMap(m: MappedMoon, file: string, dir = '/textures/moons/') {
    return new THREE.TextureLoader().loadAsync(`${dir}${file}.jpg`).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      m.setColor(t);
    });
  }

  /**
   * Full imagery for a world we are going to: 4k color (and relief for rocky
   * worlds), then on UHD displays the Moon's and Mars' 16k tiles, those facing
   * `toward` (a body-fixed direction) first; and the maps of its big moons.
   */
  loadImagery(id: BodyId, toward: () => THREE.Vector3): Promise<void> {
    const L = LOOKS[id];
    if (L.type !== 'rocky' && L.type !== 'giant') return Promise.resolve();
    return (this.imagery[id] ??= (async () => {
      const w = this.worlds[id];
      const ktx = (url: string, srgb: boolean) =>
        this.loader()
          .loadAsync(url)
          .then((t) => {
            t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            t.anisotropy = 8;
            return t;
          });
      // the big moons' maps, alongside
      const moons = BODIES[id].orbiters.filter((o) => MAPPED[o.id]).map((o) => this.loadMoonMap(this.mappedMoon(o), MAPPED[o.id].file).catch(() => {}));
      const relief = L.type === 'rocky' && L.relief;
      const [c, r] = await Promise.all([ktx(`/textures/${id}-color.ktx2`, true), relief ? ktx(`/textures/${id}-relief.ktx2`, false) : Promise.resolve(null)]).catch(async () => [
        await new THREE.TextureLoader().loadAsync(`/textures/${id}-color.jpg`).then((t) => ((t.colorSpace = THREE.SRGBColorSpace), t)),
        null,
      ]);
      w.planet?.setColor(c!);
      w.giant?.setColor(c!);
      if (r) w.planet?.setRelief(r);
      await Promise.all(moons);
      if (this.tier !== 'uhd' || L.type !== 'rocky' || !L.uhd) return;
      const planet = w.planet!;
      const d = toward();
      const order = [...ALL_TILES].sort((p, q) => Planet.tileCenter(q[0], q[1]).dot(d) - Planet.tileCenter(p[0], p[1]).dot(d));
      const failed = await loadInOrder(order, async (col, row) => {
        const [tc, tr] = await Promise.all([ktx(`/textures/${id}-color-uhd-${col}-${row}.ktx2`, true), ktx(`/textures/${id}-relief-uhd-${col}-${row}.ktx2`, false)]);
        planet.setTile(col, row, tc, tr);
      });
      if (failed) console.warn(`${id}: ${failed} UHD tiles unavailable; those areas stay at 4k`);
    })().catch((err) => console.warn(`${id} imagery unavailable`, err)));
  }

  /** Horizons trajectories for a world's orbiters. */
  loadTracks(id: BodyId): Promise<void> {
    if (id === 'earth') return Promise.resolve();
    return (this.loading[id] ??= fetch(`/data/ephemeris-${id}.bin`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`ephemeris: HTTP ${r.status}`))))
      .then((buf) => {
        const file = decodeEphemeris(buf);
        this.ephem[id] = file.objects;
        if (id === 'oort') this.helio.setPaths(file.objects);
        this.orbiterBody = null; // rebuild the list
      })
      .catch((err) => console.warn(`${id} trajectories unavailable`, err)));
  }

  /** The Kuiper belt, once it is first in view. */
  private loadTno() {
    this.tnoLoad ??= fetch('/data/tno.bin')
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`TNO snapshot: HTTP ${r.status}`))))
      .then((buf) => this.helio.setTno(decodeTno(buf)))
      .catch((err) => console.warn('Kuiper belt unavailable', err));
  }

  /** Every orbiter in every loaded snapshot, for search. */
  searchable(): { body: BodyId; id: number; name: string; kind: 'moon' | 'spacecraft'; found?: { year: number; by: string } }[] {
    return (Object.entries(this.ephem) as [BodyId, EphObject[]][]).flatMap(([body, list]) => list.map((e) => ({ body, id: e.id, name: e.name, kind: e.kind, found: e.found })));
  }

  /** One object of a world's snapshot, by Horizons id. */
  ephemObject(body: BodyId, id: number): EphObject | undefined {
    return this.ephem[body]?.find((e) => e.id === id);
  }

  tracksFor(id: BodyId): Track[] {
    return (this.ephem[id] ?? []).flatMap((o) => (o.track ? [o.track] : []));
  }

  /** How many moons and spacecraft the snapshot has for a world (null until loaded). */
  roster(id: BodyId): { moons: number; craft: number } | null {
    const e = this.ephem[id];
    return e ? { moons: e.filter((o) => o.kind === 'moon').length, craft: e.filter((o) => o.kind === 'spacecraft').length } : null;
  }

  // ------------------------------------------------------------------ state

  /** Advance every world to `jd`. `sunGeo` is the engine's Sun (the one lighting the Earth). */
  update(jd: number, sunGeo: ArrayLike<number>) {
    if (Math.abs(jd - this.Pjd) > 1) {
      this.P = precession(jd);
      this.Pjd = jd;
    }
    const P = this.P;
    this.sun = [sunGeo[0], sunGeo[1], sunGeo[2]];
    for (const id of BODY_ORDER) {
      if (id === 'earth') continue;
      const w = this.worlds[id];
      w.at = id === 'oort' ? this.sun : geocentric(id, jd, P);
      w.orient = id === 'oort' ? IDENTITY : mulMat(P, orientationOf(id, jd));
    }
    // the cloud deck's own turn about Venus' pole
    const d = jd - 2451545;
    const surface = -1.4813688; // deg/day, IAU
    this.venusClouds.object.rotation.z = THREE.MathUtils.degToRad(((-360 / VENUS_CLOUDS.periodDays - surface) * d) % 360);
  }

  /** Geocentric position of a world (km, scene axes). */
  at(id: BodyId): Vec3 {
    return this.worlds[id].at;
  }

  /** Precession to the scene's equator of date (ICRF -> scene). */
  get precession(): Mat3 {
    return this.P;
  }

  /** Unit vector from a world to the Sun, and the Sun's distance in au. */
  sunFrom(id: BodyId, out: THREE.Vector3): number {
    const a = this.worlds[id].at;
    out.set(this.sun[0] - a[0], this.sun[1] - a[1], this.sun[2] - a[2]);
    const d = out.length();
    if (d === 0) {
      out.set(1, 0, 0);
      return 0;
    }
    out.divideScalar(d);
    return d / AU_KM;
  }

  /** Unit vector from any geocentric point to the Sun, and its distance in au. */
  sunFromPoint(p: Vec3, out: THREE.Vector3): number {
    out.set(this.sun[0] - p[0], this.sun[1] - p[1], this.sun[2] - p[2]);
    const d = out.length();
    out.divideScalar(d || 1);
    return d / AU_KM;
  }

  /** A world's north pole (scene axes). */
  pole(id: BodyId, out: THREE.Vector3): THREE.Vector3 {
    if (id === 'earth') return out.set(0, 0, 1);
    if (id === 'oort') return toV(mul(this.P, [0, -0.397777, 0.917482]), out); // the ecliptic's pole
    const m = this.worlds[id].orient;
    return out.set(m[2], m[5], m[8]);
  }

  /** Scene axes -> a world's body-fixed frame. */
  toBodyFixed(id: BodyId, v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    if (id === 'earth') return out.copy(v); // the Earth's frame is handled by its group (GMST)
    const m = transpose(this.worlds[id].orient);
    return toV(mul(m, [v.x, v.y, v.z]), out);
  }

  /** Body-fixed -> scene orientation matrix (not for the Earth, whose group turns by GMST). */
  orientation(id: BodyId): Mat3 {
    return this.worlds[id].orient;
  }

  // ------------------------------------------------------------------ placing

  /**
   * Put every world in the scene, relative to the scene origin `anchor`
   * (geocentric km) and the camera (scene coordinates).
   */
  place(anchor: Vec3, cam: THREE.Vector3, viewH: number, fovDeg: number, showSky: boolean) {
    const pxPerRad = viewH / 2 / Math.tan(THREE.MathUtils.degToRad(fovDeg / 2));
    const sunDir = new THREE.Vector3();
    const camGeo: Vec3 = [anchor[0] + cam.x, anchor[1] + cam.y, anchor[2] + cam.z];
    let np = 0;
    for (const id of BODY_ORDER) {
      const w = this.worlds[id];
      if (id === 'oort') continue;
      const g = w.group;
      const p = new THREE.Vector3(w.at[0] - anchor[0], w.at[1] - anchor[1], w.at[2] - anchor[2]);
      const d = p.clone().sub(cam);
      const dist = d.length();
      const s = farScale(dist);
      if (s < 1) p.copy(cam).addScaledVector(d, s);
      g.position.copy(p);
      g.scale.setScalar(s);
      if (id !== 'earth') {
        g.quaternion.setFromRotationMatrix(matrix4(w.orient));
        g.updateMatrixWorld();
        this.sunFrom(id, sunDir);
        const local = this.toBodyFixed(id, sunDir);
        const camLocal = g.worldToLocal(cam.clone());
        if (w.planet) {
          w.planet.sun.value.copy(local);
          w.planet.cameraLocal.value.copy(camLocal);
        }
        if (w.giant) {
          w.giant.sun.value.copy(local);
          w.giant.cameraLocal.value.copy(camLocal);
        }
        if (id === 'venus') {
          const c = this.venusClouds;
          c.object.visible = !this.radar;
          c.object.updateMatrixWorld();
          c.sun.value.copy(local).applyAxisAngle(new THREE.Vector3(0, 0, 1), -c.object.rotation.z);
          c.cameraLocal.value.copy(c.object.worldToLocal(cam.clone()));
        }
      }
      // as a point of light, while its disc is under a few pixels
      const R = BODIES[id].radiusKm;
      const discPx = (R / dist) * pxPerRad;
      const weight = 1 - THREE.MathUtils.smoothstep(discPx, 1.2, 3.5);
      if (weight > 0.01 && showSky) {
        const v = this.magnitude(id, camGeo);
        const { sigma, peak } = psf(v);
        const c = new THREE.Color(STAR_TINT[id] ?? '#fff6e8');
        const dir = d.clone().normalize().multiplyScalar(Math.min(dist, dist * s) * 0.999);
        this.points.setOffset(np, cam.x + dir.x, cam.y + dir.y, cam.z + dir.z, cam);
        this.points.setColor(np, c, (6 * sigma) / this.pixelRatio, peak * weight);
        np++;
      }
    }
    this.points.commit(np, cam);
  }

  /** Apparent visual magnitude of a world from a geocentric point (Mallama & Hilton 2018 phase laws, simplified). */
  private magnitude(id: BodyId, obs: Vec3): number {
    const a = this.worlds[id].at;
    const toObs = new THREE.Vector3(obs[0] - a[0], obs[1] - a[1], obs[2] - a[2]);
    const toSun = new THREE.Vector3(this.sun[0] - a[0], this.sun[1] - a[1], this.sun[2] - a[2]);
    const delta = toObs.length() / AU_KM, r = toSun.length() / AU_KM;
    const al = THREE.MathUtils.radToDeg(toObs.angleTo(toSun));
    const k = 5 * Math.log10(r * delta);
    switch (id) {
      case 'mars':
        return -1.52 + k + 0.016 * al;
      case 'earth':
        return -3.87 + k + 0.0122 * al + 3e-6 * al ** 2;
      case 'mercury':
        return -0.613 + k + 6.328e-2 * al - 1.6336e-3 * al ** 2 + 3.3644e-5 * al ** 3 - 3.4265e-7 * al ** 4 + 1.6893e-9 * al ** 5 - 3.0334e-12 * al ** 6;
      case 'venus':
        return -4.384 + k - 1.044e-3 * al + 3.687e-4 * al ** 2 - 2.814e-6 * al ** 3 + 8.938e-9 * al ** 4;
      case 'jupiter':
        return -9.395 + k - 3.7e-4 * al + 6.16e-4 * al ** 2;
      case 'saturn': {
        // the rings add up to ~0.8 magnitudes when open toward the observer
        const pole = this.pole('saturn', new THREE.Vector3());
        const B = Math.abs(Math.asin(THREE.MathUtils.clamp(toObs.normalize().dot(pole), -1, 1)));
        return -8.914 + k + 0.026 * al - 1.825 * Math.sin(B);
      }
      case 'uranus':
        return -7.11 + k + 6.587e-3 * al + 1.045e-4 * al ** 2;
      case 'neptune':
        return -7.0 + k + 7.944e-3 * al + 9.617e-5 * al ** 2;
      default:
        return 0.21 + k + 0.026 * al + 4e-9 * al ** 4; // the Moon
    }
  }

  /**
   * The heliosphere layer for this frame: planets' orbits, the Voyagers' paths,
   * the Kuiper belt and the Oort cloud. `nearKm` is the camera's distance from the
   * nearest world; at the Oort cloud everything is shown.
   */
  placeHelio(anchor: Vec3, cam: THREE.Vector3, jd: number, nearKm: number, focusOort: boolean, showOrbits: boolean) {
    const sun = new THREE.Vector3(this.sun[0] - anchor[0], this.sun[1] - anchor[1], this.sun[2] - anchor[2]);
    this.helio.update(sun, cam, jd, this.P, nearKm, focusOort, { orbits: showOrbits });
    if (this.helio.fades.belt > 0) this.loadTno();
    if (this.helio.fades.orbits > 0 && !this.ephem.oort) this.loadTracks('oort');
  }

  // ------------------------------------------------------------------ orbiters

  /** Bring the orbiters of `body` to `jd` (once per frame; later calls at the same time are free). */
  advance(body: BodyId, jd: number) {
    this.refreshOrbiters(body, jd);
  }
  private statesJd = NaN;
  private statesBody: BodyId | null = null;

  /** Orbiters of `body` at `jd`, relative to its center (scene axes); [] for the Earth. */
  private refreshOrbiters(body: BodyId, jd: number) {
    if (this.orbiterBody === body && this.statesBody === body && this.statesJd === jd) return;
    const P = this.P;
    if (this.orbiterBody !== body) {
      this.orbiterBody = body;
      this.orbiters.length = 0;
      this.thinRel.clear();
      const eph = this.ephem[body] ?? [];
      const byId = new Map(eph.map((e) => [e.id, e]));
      const pole = this.pole(body, new THREE.Vector3());
      // the curated ones first, in their order, then the rest by distance from the planet
      for (const o of BODIES[body].orbiters) {
        const e = byId.get(o.id);
        if (e) this.orbiters.push({ o, eph: e, track: e.track, valid: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), curated: true });
      }
      const rest: OrbiterState[] = [];
      for (const e of eph) {
        if (BODIES[body].orbiters.some((o) => o.id === e.id)) continue;
        const s = objectState(e, jd, this.st) ? Array.from(this.st) : null;
        const sc = s ? (toV(mul(P, [s[0], s[1], s[2]])).toArray().concat(toV(mul(P, [s[3], s[4], s[5]])).toArray()) as number[]) : null;
        const r = e.radiusKm ?? 2;
        const o: Orbiter = {
          id: e.id,
          name: e.name,
          kind: e.kind,
          by: e.kind === 'moon' ? `Moon · found ${e.found?.year ?? '—'}` : 'Spacecraft',
          note: e.kind === 'moon' ? describeMoon(e, body, sc, pole) : '',
          radii: [r * 1.15, r, r * 0.85],
        };
        rest.push({ o, eph: e, track: e.track, valid: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), curated: false });
      }
      const sma = (x: OrbiterState) => x.eph.elements?.a ?? (x.eph.track ? Math.hypot(x.eph.track.data[0], x.eph.track.data[1], x.eph.track.data[2]) : 0);
      rest.sort((a, b) => sma(a) - sma(b));
      this.orbiters.push(...rest);
    }
    this.statesJd = jd;
    this.statesBody = body;
    for (const s of this.orbiters) {
      s.valid = objectState(s.eph, jd, this.st);
      if (!s.valid) continue;
      toV(mul(P, [this.st[0], this.st[1], this.st[2]]), s.pos);
      toV(mul(P, [this.st[3], this.st[4], this.st[5]]), s.vel);
    }
  }

  /** Index into `orbiters` by Horizons id. */
  find(id: number | null): OrbiterState | null {
    return id === null ? null : (this.orbiters.find((s) => s.o.id === id) ?? null);
  }

  /** The globe of a mapped moon (made on first use). */
  private mappedMoon(o: Orbiter): MappedMoon {
    let m = this.mapped.get(o.id);
    if (!m) {
      m = new MappedMoon(o.name, { radii: o.radii ?? [1, 1, 1], ...MAPPED[o.id].look }, this.placeholder);
      m.object.visible = false;
      this.mapped.set(o.id, m);
      this.moonGroup.add(m.object);
    }
    return m;
  }

  /** The body of a small moon (made on first use: a few hundred craters take ~30 ms). */
  private lumpyMoon(o: Orbiter): SmallMoon {
    let m = this.lumpy.get(o.id);
    if (!m) {
      const cfg = LUMPY[o.id] ?? { seed: (o.id % 997) / 97 + 1 };
      m = new SmallMoon(o.name, o.radii ?? [2, 2, 2], cfg.seed, cfg.crater, cfg.tint);
      m.object.visible = false;
      this.lumpy.set(o.id, m);
      this.moonGroup.add(m.object);
      // keep a handful: the curated ones and the last few selected
      if (this.lumpy.size > 16) {
        for (const [id, x] of this.lumpy) {
          if (LUMPY[id] || id === o.id) continue;
          this.moonGroup.remove(x.object);
          x.object.geometry.dispose();
          this.lumpy.delete(id);
          break;
        }
      }
    }
    return m;
  }

  /**
   * One orbit, `n` samples relative to the world's center (scene axes) written to
   * `out`: a period centered on now (phased toward now when `phased`), from the
   * track where it is published and from two-body motion beyond.
   */
  private sampleOrbit(s: OrbiterState, body: BodyId, jd: number, n: number, out: Float64Array, phased: boolean) {
    const P = this.P;
    const mu = BODIES[body].mu;
    const cur = [s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z];
    const el = osculating(cur, mu);
    const st = this.st;
    // osculating elements of the current state, in ICRF, for whatever the track doesn't cover
    const icrf = mul(transpose(P), [cur[0], cur[1], cur[2]]).concat(mul(transpose(P), [cur[3], cur[4], cur[5]]));
    const kep = s.eph.elements ?? elementsFromState(icrf, mu, jd);
    // not in orbit (BepiColombo arriving): its ellipse means nothing, so only the track is
    // drawn, up to a month either side of now
    const free = !this.orbiting(body, s);
    const bound = Number.isFinite(el.periodS) && !free;
    let days = bound ? el.periodS / 86400 : 4;
    let t0 = -Infinity, t1 = Infinity;
    if (s.track) [t0, t1] = span(s.track);
    if (free) days = 2 * Math.min(30, Math.max(jd - t0, t1 - jd));
    else if (!bound) days = Math.min(8, 2 * Math.min(jd - t0, t1 - jd));
    // eccentric orbits are sampled evenly in eccentric anomaly, not time: a time-uniform
    // track cuts the corner at periapsis, where Juno spends two hours of a 33-day orbit
    const ecc = bound && kep && kep.e > 0.2 ? kep : null;
    let E0 = 0, M0 = 0;
    if (ecc) {
      M0 = ecc.M + ecc.n * (jd - ecc.epochJd) * 86400;
      E0 = eccentricAnomaly(M0, ecc.e);
    }
    for (let j = 0; j < n; j++) {
      const f = phased ? orbitPhase(j, n) : j / n - 0.5;
      let t = jd + days * f;
      if (ecc) {
        const E = E0 + 2 * Math.PI * f;
        t = jd + (E - ecc.e * Math.sin(E) - M0) / ecc.n / 86400;
      }
      const ok = s.track && t >= t0 && t <= t1 ? stateAt(s.track, t, st) : kep && bound ? keplerState(kep, t, st) : false;
      if (!ok) {
        out[3 * j] = out[3 * j + 1] = out[3 * j + 2] = NaN;
        continue;
      }
      out.set(mul(P, [st[0], st[1], st[2]]), 3 * j);
    }
  }

  /**
   * Whether a spacecraft is in orbit about the world, so that its osculating ellipse is its
   * path: bound, with the whole ellipse inside half the world's Hill sphere, where its pull
   * beats the Sun's (or the Earth's, for the Moon). BepiColombo, arriving at Mercury in a loose
   * capture the Sun shapes as much as Mercury does, is not until late November 2026.
   * Moons, and the Voyagers' Sun-centered tracks, always count.
   */
  orbiting(body: BodyId, s: OrbiterState): boolean {
    if (s.o.kind === 'moon' || body === 'oort') return true;
    const mu = BODIES[body].mu;
    const primaryKm = body === 'moon' ? Math.hypot(...this.worlds.moon.at) : this.sunFrom(body, new THREE.Vector3()) * AU_KM;
    const hillKm = primaryKm * Math.cbrt(mu / (3 * (body === 'moon' ? BODIES.earth.mu : BODIES.oort.mu)));
    return osculating([s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z], mu).apoapsisKm < hillKm / 2;
  }

  /** The closest the track comes to the world's center from now on: km and UTC Julian date (NaN when none). */
  closestAhead(s: OrbiterState, jd: number): { km: number; jd: number; atEnd: boolean } {
    const t = s.track;
    if (!t) return { km: NaN, jd: NaN, atEnd: false };
    const k0 = Math.max(0, Math.ceil(((jd - t.jd0) * 86400) / t.stepS));
    let best = Infinity, at = -1;
    for (let k = k0; k < t.count; k++) {
      const r = Math.hypot(t.data[6 * k], t.data[6 * k + 1], t.data[6 * k + 2]);
      if (r < best) {
        best = r;
        at = k;
      }
    }
    if (at < 0) return { km: NaN, jd: NaN, atEnd: false };
    return { km: best, jd: t.jd0 + (at * t.stepS) / 86400, atEnd: at === t.count - 1 };
  }

  /**
   * Draw the focused world's orbiters: dots, the selection ring, every orbit
   * (dim) and the selected one (bright), and the moons as bodies.
   * `origin` is the world's center in scene coordinates.
   */
  updateOrbiters(body: BodyId | null, jd: number, origin: THREE.Vector3, cam: THREE.Vector3, selected: number | null, hovered: number | null, show: boolean, selectedAsModel = false, viewH = 1, fovDeg = 40, near = 1, camera?: THREE.PerspectiveCamera) {
    const active = body !== null && body !== 'earth' && show;
    if (active) this.refreshOrbiters(body, jd);
    let k = 0, nr = 0;
    const p = new THREE.Vector3();
    const q: number[] = [0, 0, 0];
    const pxPerKm = (dist: number) => viewH / 2 / Math.tan(THREE.MathUtils.degToRad(fovDeg / 2)) / Math.max(dist, 1e-9);
    if (active) {
      for (const s of this.orbiters) {
        if (!s.valid || k >= this.dots.capacity || this.hidden(s, selected)) continue;
        p.copy(origin).add(s.pos);
        farPoint(p.x, p.y, p.z, cam, q);
        this.dots.setOffset(k, q[0], q[1], q[2], cam);
        const sel = s.o.id === selected;
        const moon = s.o.kind === 'moon';
        const major = moon && s.curated;
        // once its model is big enough to see, the selected spacecraft is drawn as that instead
        const size = sel ? (selectedAsModel ? 0 : 7) : major ? 5 : moon ? 3 : 4.4;
        this.dots.setColor(k, sel ? WHITE : major ? MOON_DOT : moon ? MINOR_DOT : SPACECRAFT, size, sel ? 3 : major ? 1.6 : moon ? 1.2 : 2.4);
        k++;
        if ((sel && !selectedAsModel) || (!sel && s.o.id === hovered)) {
          this.rings.setOffset(nr, q[0], q[1], q[2], cam);
          this.rings.setColor(nr, WHITE, sel ? 22 : 18, sel ? 2.2 : 1.2);
          nr++;
        }
      }
    }
    this.dots.commit(k, cam);
    this.rings.commit(nr, cam);

    // thick orbits for the curated orbiters and the selection: one period centered on now,
    // resampled twice a second (the selected one every frame)
    const now = performance.now();
    const refresh = now - this.pathAt > 500;
    if (refresh) this.pathAt = now;
    const thick = active ? this.orbiters.filter((s) => s.valid && (s.o.id === selected || (s.curated && this.allOrbits && !this.hidden(s, selected)))).slice(0, THICK_PATHS) : [];
    const selIn = active && selected !== null && !thick.some((s) => s.o.id === selected) ? this.find(selected) : null;
    if (selIn?.valid) {
      if (thick.length < THICK_PATHS) thick.push(selIn);
      else thick[THICK_PATHS - 1] = selIn;
    }
    this.paths.forEach((path, i) => {
      const s = thick[i];
      if (!s) {
        path.hide();
        return;
      }
      const sel = s.o.id === selected;
      const rel = this.pathRel[i];
      // a selected moon seen close up: the stretch of its orbit nearer to it than the camera would
      // run across its face, so it is left out, the gap growing with the disc
      let gapR = 0;
      if (sel && s.o.kind === 'moon') {
        const dist = p.copy(origin).add(s.pos).distanceTo(cam);
        gapR = dist * 1.05 * THREE.MathUtils.smoothstep(this.bodyRadius(s) * pxPerKm(dist), 6, 30);
      }
      if (refresh || sel || rel.id !== s.o.id) {
        rel.id = s.o.id;
        this.sampleOrbit(s, body!, jd, ORBIT_SAMPLES, rel.pts, true);
      }
      // thick lines break up (Line2's screen-space math) once a segment reaches ~10⁹ near-plane
      // distances: following a Voyager, only the nearest 30,000 km of its track is drawn thick
      const reach = near * 2e7;
      const pts = this.trackPts;
      for (let j = 0; j < 3 * ORBIT_SAMPLES; j += 3) {
        const x = rel.pts[j] + origin.x, y = rel.pts[j + 1] + origin.y, z = rel.pts[j + 2] + origin.z;
        const nearSelf = gapR > 0 && Math.hypot(rel.pts[j] - s.pos.x, rel.pts[j + 1] - s.pos.y, rel.pts[j + 2] - s.pos.z) < gapR;
        if (Number.isNaN(x) || nearSelf || Math.hypot(x - cam.x, y - cam.y, z - cam.z) > reach) {
          pts[j] = NaN;
          continue;
        }
        farPoint(x, y, z, cam, pts, j);
      }
      path.update(pts, ORBIT_SAMPLES, sel ? ORBIT_SEL : ORBIT_DIM, cam, camera);
    });

    // every other moon's orbit, thin: the irregular moons' ellipses barely change, so they
    // are resampled every few seconds; the fast inner moons twice a second
    const thinList = active && this.allOrbits ? this.orbiters.filter((s) => s.valid && !thick.includes(s) && !this.hidden(s, selected)) : [];
    this.thin.object.visible = thinList.length > 0;
    if (thinList.length) {
      const a = this.thin.array;
      const col = this.thin.colorArray;
      const camDist = cam.distanceTo(origin);
      let m = 0;
      for (const s of thinList) {
        // an orbit much bigger than the camera's distance surrounds the camera and reads as a tangle
        // of straight lines: each fades in once the camera has pulled back far enough to see its shape
        const size = s.eph.elements?.a ?? s.pos.length();
        const w = THREE.MathUtils.smoothstep(camDist / size, 0.12, 0.45);
        if (w < 0.02) continue;
        let c = this.thinRel.get(s.o.id);
        const stale = !c || now - c.at > (s.eph.elements ? 4000 : 500);
        if (stale) {
          c ??= { at: 0, pts: new Float64Array(THIN_SAMPLES * 3) };
          c.at = now;
          this.sampleOrbit(s, body!, jd, THIN_SAMPLES, c.pts, false);
          this.thinRel.set(s.o.id, c);
        }
        const pts = c!.pts;
        for (let j = 0; j < THIN_SAMPLES && m < this.thin.capacity; j++) {
          const i0 = 3 * j, i1 = 3 * ((j + 1) % THIN_SAMPLES);
          if (Number.isNaN(pts[i0]) || Number.isNaN(pts[i1])) continue;
          farPoint(pts[i0] + origin.x, pts[i0 + 1] + origin.y, pts[i0 + 2] + origin.z, cam, q);
          a[6 * m] = q[0] - cam.x;
          a[6 * m + 1] = q[1] - cam.y;
          a[6 * m + 2] = q[2] - cam.z;
          farPoint(pts[i1] + origin.x, pts[i1 + 1] + origin.y, pts[i1 + 2] + origin.z, cam, q);
          a[6 * m + 3] = q[0] - cam.x;
          a[6 * m + 4] = q[1] - cam.y;
          a[6 * m + 5] = q[2] - cam.z;
          col.fill(w, 6 * m, 6 * m + 6);
          m++;
        }
      }
      this.thin.commit(m, cam, true);
    }

    // the moons as bodies, tidally locked, once they are more than a pixel or so across
    const worldSun = new THREE.Vector3();
    if (body) this.sunFrom(body, worldSun);
    const seen = new Set<THREE.Object3D>();
    if (active) {
      for (const s of this.orbiters) {
        if (!s.valid || s.o.kind !== 'moon' || this.hidden(s, selected)) continue;
        const sel = s.o.id === selected;
        if (!s.curated && !sel) continue;
        p.copy(origin).add(s.pos);
        const dist = p.distanceTo(cam);
        const r = s.o.radii ? Math.max(...s.o.radii) : 2;
        if (r * pxPerKm(dist) < 0.6) continue;
        const mm = MAPPED[s.o.id] ? this.mappedMoon(s.o) : null;
        if (mm && !mm.loaded) continue; // the dot stands in until its map arrives
        const obj = mm ? mm.object : this.lumpyMoon(s.o).object;
        const sc = farScale(dist);
        obj.position.copy(cam).addScaledVector(p.sub(cam), sc);
        obj.scale.setScalar(sc);
        const x = s.pos.clone().normalize().negate();
        const z = s.pos.clone().cross(s.vel).normalize();
        const y = z.clone().cross(x);
        obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
        obj.visible = true;
        seen.add(obj);
        const inv = obj.quaternion.clone().invert();
        if (mm) {
          mm.sun.value.copy(worldSun).applyQuaternion(inv);
          obj.updateMatrixWorld();
          mm.cameraLocal.value.copy(obj.worldToLocal(cam.clone()));
        } else {
          this.lumpy.get(s.o.id)!.sun.value.copy(worldSun).applyQuaternion(inv);
        }
      }
    }
    for (const o of this.moonGroup.children) if (!seen.has(o)) o.visible = false;
  }

  /** Radius of an orbiter's body (moons) in km, for framing a close look; 0 for spacecraft. */
  bodyRadius(s: OrbiterState): number {
    return s.o.kind === 'moon' && s.o.radii ? Math.max(...s.o.radii) : 0;
  }

  /** Is the orbiter in its world's shadow? 1 sunlit, 0 eclipsed (cylindrical shadow). */
  sunlit(body: BodyId, s: OrbiterState): number {
    if (body === 'oort') return 1;
    const sun = new THREE.Vector3();
    this.sunFrom(body, sun);
    const along = s.pos.dot(sun);
    if (along > 0) return 1;
    const perp = s.pos.clone().addScaledVector(sun, -along).length();
    return perp > BODIES[body].radiusKm ? 1 : 0;
  }

  /** Sub-orbiter latitude / east longitude and altitude. */
  geo(body: BodyId, s: OrbiterState) {
    const bf = this.toBodyFixed(body, s.pos);
    const r = bf.length();
    return { lat: THREE.MathUtils.radToDeg(Math.asin(bf.z / r)), lon: THREE.MathUtils.radToDeg(Math.atan2(bf.y, bf.x)), altKm: r - BODIES[body].radiusKm };
  }

  /** Orbital elements about the body's equator. */
  elements(body: BodyId, s: OrbiterState) {
    const r = this.toBodyFixed(body, s.pos), v = this.toBodyFixed(body, s.vel);
    return osculating([r.x, r.y, r.z, v.x, v.y, v.z], BODIES[body].mu);
  }

  dispose() {
    this.ktx2?.dispose();
  }
}
