// The Earth, the Moon and Mars in one scene.
//
// Positions are geocentric, equatorial of date, in km (sim/solar.ts), kept in
// float64 here. The scene's origin is wherever precision is needed: the focused
// world's centre, or the camera itself while travelling between worlds. A world
// farther than PROXY_KM from the camera is drawn at PROXY_KM along its true
// direction and scaled down by the same factor: same direction, same angular
// size, same lighting, but inside the far plane and float32's comfort zone.
// Below a few pixels across, each world is also drawn as a point of light at
// its apparent magnitude, like the stars, so Mars is a red star from Earth.
//
// Around the Moon and Mars, the orbiters come from JPL Horizons trajectories
// (sim/ephemeris.ts): dots, names, orbits, and Phobos and Deimos as bodies.

import * as THREE from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { BODIES, type BodyId, type Orbiter } from '../sim/bodies';
import { decodeEphemeris, osculating, span, stateAt, type Track } from '../sim/ephemeris';
import { AU_KM, marsGeocentric, marsOrientation, moonGeocentric, moonOrientation, mul, mulMat, precession, transpose, type Mat3, type Vec3 } from '../sim/solar';
import { OrbitPath, orbitPhase } from './lines';
import { Planet, SmallMoon } from './planet';
import { psf } from './sky';
import { SpriteLayer } from './sprites';
import { ALL_TILES, loadInOrder } from './tiles';

/** Worlds farther than this from the camera are drawn here, scaled to keep their apparent size. */
const PROXY_KM = 7e5;
const ORBIT_SAMPLES = 361;

const SPACECRAFT = new THREE.Color('#DDAA33'); // Tol yellow, as for the Earth's "other satellites"
const MOON_DOT = new THREE.Color('#c9c4bc');
const WHITE = new THREE.Color('#ffffff');
const ORBIT_DIM = new THREE.Color('#dfe9ff').multiplyScalar(0.22);
const ORBIT_SEL = new THREE.Color('#dfe9ff');

const matrix4 = (m: Mat3) => new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
const toV = (v: Vec3, out = new THREE.Vector3()) => out.set(v[0], v[1], v[2]);

/** What one orbiter looks like right now, in scene coordinates relative to its world. */
export interface OrbiterState {
  o: Orbiter;
  track: Track;
  valid: boolean;
  /** position and velocity relative to the world's centre, scene axes (km, km/s) */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
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
}

export class SolarSystem {
  readonly moon: Planet;
  readonly mars: Planet;
  private phobos = new SmallMoon('phobos', [13.0, 11.4, 9.1], 3.7, { lat: 1, lon: -49, radiusKm: 4.5 });
  private deimos = new SmallMoon('deimos', [7.8, 6.0, 5.1], 8.1);
  readonly objects: THREE.Object3D[];
  private worlds: Record<BodyId, World>;
  private P: Mat3 = precession(2461322.5);
  private Pjd = 0;
  /** geocentric Sun, equatorial of date (km) */
  sun: Vec3 = [AU_KM, 0, 0];

  // orbiters of the focused world
  private tracks: Partial<Record<BodyId, Track[]>> = {};
  private loading: Partial<Record<BodyId, Promise<void>>> = {};
  readonly orbiters: OrbiterState[] = [];
  private orbiterBody: BodyId | null = null;
  private dots = new SpriteLayer(16, 'glow', { renderOrder: 2 });
  private rings = new SpriteLayer(4, 'ring', { renderOrder: 4, depthTest: true });
  private paths: OrbitPath[] = [];
  private pathAt = 0;
  /** each orbit's samples relative to its world's centre: the scene origin moves while travelling */
  private pathRel = Array.from({ length: 8 }, () => ({ id: 0, pts: new Float64Array(ORBIT_SAMPLES * 3) }));
  private trackPts = new Float64Array(ORBIT_SAMPLES * 3);
  /** planets as points of light when too small to see as discs */
  private points = new SpriteLayer(4, 'star', { renderOrder: -1, depthTest: true });
  private imagery: Partial<Record<BodyId, Promise<void>>> = {};
  private ktx2: KTX2Loader | null = null;
  private st = new Float64Array(6);
  /** draw every orbiter's track, not just the selected one's */
  allOrbits = true;

  constructor(
    private renderer: THREE.WebGPURenderer,
    earthGroup: THREE.Object3D,
    private tier: 'uhd' | 'standard',
    private pixelRatio: number,
  ) {
    const black = new THREE.DataTexture(new Uint8Array([40, 40, 40, 255]), 1, 1);
    black.needsUpdate = true;
    this.moon = new Planet('moon', { radiusKm: BODIES.moon.radiusKm, minnaert: 0.5, gain: 0.6, relief: 1.6 }, black);
    this.mars = new Planet(
      'mars',
      { radiusKm: BODIES.mars.radiusKm, minnaert: 0.8, gain: 0.82, relief: 1.8, haze: { color: [1.0, 0.72, 0.5], heightKm: 40, strength: 0.4 } },
      black,
    );
    this.moon.fill.value = 0.012; // earthshine
    this.worlds = {
      earth: { id: 'earth', at: [0, 0, 0], orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], group: earthGroup, planet: null },
      moon: { id: 'moon', at: [0, 0, 0], orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], group: this.moon.group, planet: this.moon },
      mars: { id: 'mars', at: [0, 0, 0], orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], group: this.mars.group, planet: this.mars },
    };
    for (let i = 0; i < 8; i++) this.paths.push(new OrbitPath(ORBIT_SAMPLES, 1.3));
    this.objects = [this.moon.group, this.mars.group, this.phobos.object, this.deimos.object, this.points.object, this.dots.object, this.rings.object, ...this.paths.map((p) => p.object)];
  }

  // ------------------------------------------------------------------ data

  /** The 2k colour map: enough for a world seen from another. */
  loadPreview(id: 'moon' | 'mars') {
    return new THREE.TextureLoader().loadAsync(`/textures/${id}-color-2k.jpg`).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      this.worlds[id].planet!.setColor(t);
    });
  }

  private loader(): KTX2Loader {
    this.ktx2 ??= new KTX2Loader().setTranscoderPath('/basis/').detectSupport(this.renderer);
    return this.ktx2;
  }

  /**
   * Full imagery for a world we are going to: 4k colour and relief, then on UHD
   * displays the 16k tiles, those facing `toward` (a body-fixed direction) first.
   */
  loadImagery(id: 'moon' | 'mars', toward: () => THREE.Vector3): Promise<void> {
    return (this.imagery[id] ??= (async () => {
      const planet = this.worlds[id].planet!;
      const ktx = (url: string, srgb: boolean) =>
        this.loader()
          .loadAsync(url)
          .then((t) => {
            t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            t.anisotropy = 8;
            return t;
          });
      const [c, r] = await Promise.all([ktx(`/textures/${id}-color.ktx2`, true), ktx(`/textures/${id}-relief.ktx2`, false)]).catch(async () => [
        await new THREE.TextureLoader().loadAsync(`/textures/${id}-color.jpg`).then((t) => ((t.colorSpace = THREE.SRGBColorSpace), t)),
        null,
      ]);
      planet.setColor(c!);
      if (r) planet.setRelief(r);
      if (this.tier !== 'uhd') return;
      const d = toward();
      const order = [...ALL_TILES].sort((p, q) => Planet.tileCentre(q[0], q[1]).dot(d) - Planet.tileCentre(p[0], p[1]).dot(d));
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
        this.tracks[id] = decodeEphemeris(buf).tracks;
        this.orbiterBody = null; // rebuild the list
      })
      .catch((err) => console.warn(`${id} trajectories unavailable`, err)));
  }

  tracksFor(id: BodyId): Track[] {
    return this.tracks[id] ?? [];
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
    this.worlds.moon.at = moonGeocentric(jd);
    this.worlds.mars.at = marsGeocentric(jd, P);
    this.worlds.moon.orient = mulMat(P, moonOrientation(jd));
    this.worlds.mars.orient = mulMat(P, marsOrientation(jd));
  }

  /** Geocentric position of a world (km, scene axes). */
  at(id: BodyId): Vec3 {
    return this.worlds[id].at;
  }

  /** Unit vector from a world to the Sun, and the Sun's distance in au. */
  sunFrom(id: BodyId, out: THREE.Vector3): number {
    const a = this.worlds[id].at;
    out.set(this.sun[0] - a[0], this.sun[1] - a[1], this.sun[2] - a[2]);
    const d = out.length();
    out.divideScalar(d);
    return d / AU_KM;
  }

  /** A world's north pole (scene axes). */
  pole(id: BodyId, out: THREE.Vector3): THREE.Vector3 {
    if (id === 'earth') return out.set(0, 0, 1);
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
  orientation(id: 'moon' | 'mars'): Mat3 {
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
    let np = 0;
    for (const w of Object.values(this.worlds)) {
      const g = w.group;
      const p = new THREE.Vector3(w.at[0] - anchor[0], w.at[1] - anchor[1], w.at[2] - anchor[2]);
      const d = p.clone().sub(cam);
      const dist = d.length();
      let s = 1;
      if (dist > PROXY_KM) {
        s = PROXY_KM / dist;
        p.copy(cam).addScaledVector(d, s);
      }
      g.position.copy(p);
      g.scale.setScalar(s);
      if (w.planet) {
        g.quaternion.setFromRotationMatrix(matrix4(w.orient));
        g.updateMatrixWorld();
        this.sunFrom(w.id, sunDir);
        w.planet.sun.value.copy(this.toBodyFixed(w.id, sunDir));
        w.planet.cameraLocal.value.copy(g.worldToLocal(cam.clone()));
      }
      // as a point of light, while its disc is under a few pixels
      const R = BODIES[w.id].radiusKm;
      const discPx = (R / dist) * pxPerRad;
      const weight = 1 - THREE.MathUtils.smoothstep(discPx, 1.2, 3.5);
      if (weight > 0.01 && showSky) {
        const v = this.magnitude(w.id, anchor, cam);
        const { sigma, peak } = psf(v);
        const c = w.id === 'mars' ? new THREE.Color('#ffb48a') : w.id === 'earth' ? new THREE.Color('#bcd6ff') : new THREE.Color('#fff6e8');
        const dir = d.clone().normalize().multiplyScalar(PROXY_KM * 0.999);
        this.points.setOffset(np, cam.x + dir.x, cam.y + dir.y, cam.z + dir.z, cam);
        this.points.setColor(np, c, (6 * sigma) / this.pixelRatio, peak * weight);
        np++;
      }
    }
    this.points.commit(np, cam);
  }

  /** Apparent visual magnitude of a world from the camera (Mallama-style phase laws, simplified). */
  private magnitude(id: BodyId, anchor: Vec3, cam: THREE.Vector3): number {
    const a = this.worlds[id].at;
    const camGeo: Vec3 = [anchor[0] + cam.x, anchor[1] + cam.y, anchor[2] + cam.z];
    const toObs = new THREE.Vector3(camGeo[0] - a[0], camGeo[1] - a[1], camGeo[2] - a[2]);
    const toSun = new THREE.Vector3(this.sun[0] - a[0], this.sun[1] - a[1], this.sun[2] - a[2]);
    const delta = toObs.length() / AU_KM, r = toSun.length() / AU_KM;
    const phase = THREE.MathUtils.radToDeg(toObs.angleTo(toSun));
    const k = 5 * Math.log10(r * delta);
    if (id === 'mars') return -1.52 + k + 0.016 * phase;
    if (id === 'earth') return -3.87 + k + 0.0122 * phase + 3e-6 * phase ** 2;
    return 0.21 + k + 0.026 * phase + 4e-9 * phase ** 4;
  }

  // ------------------------------------------------------------------ orbiters

  /** Bring the orbiters of `body` to `jd` (once per frame; later calls at the same time are free). */
  advance(body: BodyId, jd: number) {
    this.refreshOrbiters(body, jd);
  }
  private statesJd = NaN;
  private statesBody: BodyId | null = null;

  /** Orbiters of `body` at `jd`, relative to its centre (scene axes); [] for the Earth. */
  private refreshOrbiters(body: BodyId, jd: number) {
    if (this.orbiterBody === body && this.statesBody === body && this.statesJd === jd) return;
    if (this.orbiterBody !== body) {
      this.orbiterBody = body;
      this.orbiters.length = 0;
      const tracks = this.tracks[body] ?? [];
      for (const o of BODIES[body].orbiters) {
        const track = tracks.find((t) => t.id === o.id);
        if (track) this.orbiters.push({ o, track, valid: false, pos: new THREE.Vector3(), vel: new THREE.Vector3() });
      }
    }
    this.statesJd = jd;
    this.statesBody = body;
    const P = this.P;
    for (const s of this.orbiters) {
      s.valid = stateAt(s.track, jd, this.st);
      if (!s.valid) continue;
      toV(mul(P, [this.st[0], this.st[1], this.st[2]]), s.pos);
      toV(mul(P, [this.st[3], this.st[4], this.st[5]]), s.vel);
    }
  }

  /** Index into `orbiters` by Horizons id. */
  find(id: number | null): OrbiterState | null {
    return id === null ? null : (this.orbiters.find((s) => s.o.id === id) ?? null);
  }

  /**
   * Draw the focused world's orbiters: dots, the selection ring, every orbit
   * (dim) and the selected one (bright), and Phobos and Deimos as bodies.
   * `origin` is the world's centre in scene coordinates.
   */
  updateOrbiters(body: BodyId | null, jd: number, origin: THREE.Vector3, cam: THREE.Vector3, selected: number | null, hovered: number | null, show: boolean, selectedAsModel = false) {
    const active = body !== null && body !== 'earth' && show;
    if (active) this.refreshOrbiters(body, jd);
    let k = 0, nr = 0;
    const p = new THREE.Vector3();
    if (active) {
      for (const s of this.orbiters) {
        if (!s.valid) continue;
        p.copy(origin).add(s.pos);
        this.dots.setOffset(k, p.x, p.y, p.z, cam);
        const sel = s.o.id === selected;
        const moon = s.o.kind === 'moon';
        // once its model is big enough to see, the selected spacecraft is drawn as that instead
        this.dots.setColor(k, sel ? WHITE : moon ? MOON_DOT : SPACECRAFT, sel ? (selectedAsModel ? 0 : 7) : moon ? 5 : 4.4, sel ? 3 : moon ? 1.6 : 2.4);
        k++;
        if ((sel && !selectedAsModel) || (!sel && s.o.id === hovered)) {
          this.rings.setOffset(nr, p.x, p.y, p.z, cam);
          this.rings.setColor(nr, WHITE, sel ? 22 : 18, sel ? 2.2 : 1.2);
          nr++;
        }
      }
    }
    this.dots.commit(k, cam);
    this.rings.commit(nr, cam);

    // orbits: one period centred on now, resampled twice a second (the selected one every frame)
    const now = performance.now();
    const refresh = now - this.pathAt > 500;
    if (refresh) this.pathAt = now;
    this.paths.forEach((path, i) => {
      const s = active ? this.orbiters[i] : undefined;
      if (!s || !s.valid) {
        path.hide();
        return;
      }
      const sel = s.o.id === selected;
      if (!sel && !this.allOrbits) {
        path.hide();
        return;
      }
      const rel = this.pathRel[i];
      if (refresh || sel || rel.id !== s.o.id) {
        rel.id = s.o.id;
        const el = osculating([s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z], BODIES[body!].mu);
        const days = Math.min(el.periodS, 4 * 86400) / 86400;
        const [t0, t1] = span(s.track);
        const P = this.P;
        for (let j = 0; j < ORBIT_SAMPLES; j++) {
          const t = jd + days * orbitPhase(j, ORBIT_SAMPLES);
          if (t < t0 || t > t1 || !stateAt(s.track, t, this.st)) {
            rel.pts[3 * j] = rel.pts[3 * j + 1] = rel.pts[3 * j + 2] = NaN;
            continue;
          }
          rel.pts.set(mul(P, [this.st[0], this.st[1], this.st[2]]), 3 * j);
        }
      }
      const pts = this.trackPts;
      for (let j = 0; j < 3 * ORBIT_SAMPLES; j += 3) {
        pts[j] = rel.pts[j] + origin.x;
        pts[j + 1] = rel.pts[j + 1] + origin.y;
        pts[j + 2] = rel.pts[j + 2] + origin.z;
      }
      path.update(pts, ORBIT_SAMPLES, sel ? ORBIT_SEL : ORBIT_DIM, cam);
    });

    // Phobos and Deimos as bodies: tidally locked, long axis to Mars
    const small: [SmallMoon, number][] = [
      [this.phobos, 401],
      [this.deimos, 402],
    ];
    const marsSun = new THREE.Vector3();
    this.sunFrom('mars', marsSun);
    for (const [m, id] of small) {
      const s = active && body === 'mars' ? this.find(id) : null;
      m.object.visible = !!s?.valid;
      if (!s?.valid) continue;
      m.object.position.copy(origin).add(s.pos);
      const x = s.pos.clone().normalize().negate();
      const z = s.pos.clone().cross(s.vel).normalize();
      const y = z.clone().cross(x);
      m.object.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      m.sun.value.copy(marsSun).applyQuaternion(m.object.quaternion.clone().invert());
    }
  }

  /** Is the orbiter in its world's shadow? 1 sunlit, 0 eclipsed (cylindrical shadow). */
  sunlit(body: BodyId, s: OrbiterState): number {
    const sun = new THREE.Vector3();
    this.sunFrom(body, sun);
    const along = s.pos.dot(sun);
    if (along > 0) return 1;
    const perp = s.pos.clone().addScaledVector(sun, -along).length();
    return perp > BODIES[body].radiusKm ? 1 : 0;
  }

  /** Sub-orbiter latitude / east longitude and altitude. */
  geo(body: 'moon' | 'mars', s: OrbiterState) {
    const bf = this.toBodyFixed(body, s.pos);
    const r = bf.length();
    return { lat: THREE.MathUtils.radToDeg(Math.asin(bf.z / r)), lon: THREE.MathUtils.radToDeg(Math.atan2(bf.y, bf.x)), altKm: r - BODIES[body].radiusKm };
  }

  /** Orbital elements about the body's equator. */
  elements(body: 'moon' | 'mars', s: OrbiterState) {
    const r = this.toBodyFixed(body, s.pos), v = this.toBodyFixed(body, s.vel);
    return osculating([r.x, r.y, r.z, v.x, v.y, v.z], BODIES[body].mu);
  }

  dispose() {
    this.ktx2?.dispose();
  }
}
