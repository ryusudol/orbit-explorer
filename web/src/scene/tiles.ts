// Shared layout of the UHD texture tiles: a 4x4 grid over a plate-carrée map
// (16384x8192 as 4096x2048 tiles; 90° x 45° each). Column 0 is the map's left
// edge, row 0 its bottom edge, matching the files scripts/*.mjs write.

import * as THREE from 'three/webgpu';
import { uniform, uv, vec2 } from 'three/tsl';

export const GRID = { cols: 4, rows: 4 } as const;

/** Every (column, row) of the grid. */
export const ALL_TILES: [number, number][] = Array.from({ length: GRID.cols * GRID.rows }, (_, k) => [k % GRID.cols, Math.floor(k / GRID.cols)]);

/**
 * UVs for one patch of geometry. Local UVs run 0..1 across the patch; this maps
 * them into whichever texture the patch currently holds: the whole map (lower
 * tiers) or the patch's own tile (UHD), so tiers swap without new geometry.
 */
export class PatchUv {
  private readonly scale = uniform(new THREE.Vector2());
  private readonly offset = uniform(new THREE.Vector2());
  /** texture coordinates for the current source */
  readonly node = uv().mul(this.scale).add(this.offset);
  /** coordinates over the whole map, for textures that always span it */
  readonly global;

  constructor(
    readonly c: number,
    readonly r: number,
  ) {
    this.global = uv().add(vec2(c, r)).div(vec2(GRID.cols, GRID.rows));
    this.useFullMap();
  }

  useFullMap() {
    this.scale.value.set(1 / GRID.cols, 1 / GRID.rows);
    this.offset.value.set(this.c / GRID.cols, this.r / GRID.rows);
  }

  useTile() {
    this.scale.value.set(1, 1);
    this.offset.value.set(0, 0);
  }
}

/**
 * Runs `load` over tiles in priority order, a few at a time. A tile that fails
 * keeps its lower-resolution texture; the rest still load. Resolves to the
 * number of failures.
 */
export async function loadInOrder<T>(tiles: [number, number][], load: (c: number, r: number) => Promise<T>, concurrency = 4): Promise<number> {
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < tiles.length) {
      const [c, r] = tiles[next++];
      await load(c, r).catch(() => failed++);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return failed;
}
