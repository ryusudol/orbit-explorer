// The worlds you can fly to, what orbits them and where on them we listen.
// Trajectories come from JPL Horizons (data/fetch-ephemeris.mjs); the ids here
// are Horizons ids. Mission notes are short on purpose: they are a caption.

export type BodyId = 'earth' | 'moon' | 'mars';

export interface Orbiter {
  /** JPL Horizons id: negative for spacecraft, 401/402 for Mars' moons */
  id: number;
  name: string;
  kind: 'spacecraft' | 'moon';
  /** operator and launch year, or discovery for a moon */
  by: string;
  note: string;
  /** natural moons: triaxial radii, km */
  radii?: [number, number, number];
}

export interface Site {
  id: string;
  /** what the site selector says */
  short: string;
  name: string;
  /** what is (or was) there */
  what: string;
  lat: number;
  /** planetocentric east longitude */
  lon: number;
}

export interface Body {
  id: BodyId;
  name: string;
  /** mean radius, km */
  radiusKm: number;
  /** gravitational parameter, km³/s² */
  mu: number;
  /** closest the camera may come to the surface, km */
  minAltitudeKm: number;
  /** farthest the camera may pull back, km from the centre */
  maxDistanceKm: number;
  /** radius the opening view frames: the body plus its busiest orbits, km */
  frameKm: number;
  orbiters: Orbiter[];
  sites: Site[];
}

export const BODIES: Record<BodyId, Body> = {
  earth: { id: 'earth', name: 'Earth', radiusKm: 6378.137, mu: 398600.4418, minAltitudeKm: 400, maxDistanceKm: 250_000, frameKm: 6378 + 700, orbiters: [], sites: [] },
  moon: {
    id: 'moon',
    name: 'Moon',
    radiusKm: 1737.4,
    mu: 4902.8,
    minAltitudeKm: 30,
    maxDistanceKm: 80_000,
    frameKm: 1737.4 + 160,
    orbiters: [
      { id: -85, name: 'LRO', kind: 'spacecraft', by: 'NASA · 2009', note: 'Lunar Reconnaissance Orbiter. Its wide-angle camera and laser altimeter made the map and the relief on this globe.' },
      { id: -152, name: 'Chandrayaan-2', kind: 'spacecraft', by: 'ISRO · 2019', note: 'India’s polar orbiter, mapping water ice and minerals; it was the backup relay for Chandrayaan-3’s lander in 2023.' },
      { id: -155, name: 'Danuri', kind: 'spacecraft', by: 'KARI · 2022', note: 'Korea Pathfinder Lunar Orbiter. It carries NASA’s ShadowCam, which images the permanently shadowed craters at the poles.' },
      { id: -192, name: 'ARTEMIS P1', kind: 'spacecraft', by: 'NASA · 2007', note: 'Two of the five THEMIS probes, moved to the Moon in 2011 to sample the solar wind and Earth’s magnetotail from long, looping orbits.' },
      { id: -193, name: 'ARTEMIS P2', kind: 'spacecraft', by: 'NASA · 2007', note: 'The second ARTEMIS probe. Both loop between ~400 and ~16,000 km over the equator, P1 retrograde and P2 prograde.' },
    ],
    sites: [
      { id: 'apollo11', short: 'Apollo 11', name: 'Tranquility Base', what: 'Apollo 11, 1969', lat: 0.6741, lon: 23.473 },
      { id: 'change4', short: 'Chang’e 4', name: 'Von Kármán crater', what: 'Chang’e 4 and Yutu-2, far side', lat: -45.4446, lon: 177.5991 },
      { id: 'shackleton', short: 'South pole', name: 'Shackleton crater', what: 'South pole, an Artemis target', lat: -89.67, lon: 129.78 },
    ],
  },
  mars: {
    id: 'mars',
    name: 'Mars',
    radiusKm: 3389.5,
    mu: 42828.37,
    minAltitudeKm: 80,
    maxDistanceKm: 140_000,
    frameKm: 3389.5 + 450,
    orbiters: [
      {
        id: 401,
        name: 'Phobos',
        kind: 'moon',
        by: 'Moon · found 1877',
        note: 'Orbits 6,000 km up, faster than Mars turns, so it rises in the west. Tides are pulling it in: in 30–50 million years it breaks up into a ring.',
        radii: [13.0, 11.4, 9.1],
      },
      {
        id: 402,
        name: 'Deimos',
        kind: 'moon',
        by: 'Moon · found 1877',
        note: 'The small outer moon. Its 30-hour orbit is barely longer than Mars’ day, so it takes ~2½ days to cross the sky.',
        radii: [7.8, 6.0, 5.1],
      },
      { id: -74, name: 'MRO', kind: 'spacecraft', by: 'NASA · 2005', note: 'Mars Reconnaissance Orbiter: HiRISE sees 30 cm detail, and it carries most of the rovers’ data home.' },
      { id: -53, name: 'Mars Odyssey', kind: 'spacecraft', by: 'NASA · 2001', note: 'The longest-serving spacecraft at Mars. It has relayed for every NASA lander since Spirit and Opportunity.' },
      { id: -143, name: 'Trace Gas Orbiter', kind: 'spacecraft', by: 'ESA · Roscosmos · 2016', note: 'ExoMars TGO sniffs the atmosphere for methane and relays for NASA’s rovers.' },
      { id: -41, name: 'Mars Express', kind: 'spacecraft', by: 'ESA · 2003', note: 'Europe’s first planetary mission, still mapping Mars in stereo from a 7-hour ellipse that dips to a few hundred km.' },
      { id: -62, name: 'Hope', kind: 'spacecraft', by: 'UAE · 2020', note: 'Emirates Mars Mission. Its high, slow orbit sees the whole disc, so it can watch the weather at every hour of the local day.' },
    ],
    sites: [
      { id: 'jezero', short: 'Perseverance', name: 'Jezero crater', what: 'Perseverance rover', lat: 18.4447, lon: 77.4508 },
      { id: 'gale', short: 'Curiosity', name: 'Gale crater', what: 'Curiosity rover', lat: -4.5895, lon: 137.4417 },
    ],
  },
};

export const BODY_ORDER: BodyId[] = ['earth', 'moon', 'mars'];
