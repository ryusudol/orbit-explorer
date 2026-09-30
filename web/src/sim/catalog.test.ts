import { describe, expect, it } from 'vitest';
import { classify, isoToJd } from '../../../data/fetch-tles.mjs';
import { loadSnapshot, loadSnapshotMeta } from '../test/node';
import { Category, ELEMENT_STRIDE, Group, meanAltitudeKm, subset } from './catalog';
import { msToJd } from './time';

describe('snapshot', () => {
  const c = loadSnapshot();
  const meta = loadSnapshotMeta();

  it('decodes every object the builder wrote', () => {
    expect(c.count).toBe(meta.objects);
    expect(c.packed.length).toBe(c.count * ELEMENT_STRIDE);
    expect(c.names.length).toBe(c.count);
    expect(c.names.every((n) => n.length > 0)).toBe(true);
  });

  it('has sane, recent elements', () => {
    const gen = msToJd(c.generatedMs);
    for (let i = 0; i < c.count; i++) {
      const e = c.packed.subarray(i * ELEMENT_STRIDE, (i + 1) * ELEMENT_STRIDE);
      expect(gen - e[0]).toBeLessThan(30.01); // epoch age, days
      expect(e[1]).toBeGreaterThan(0.05); // mean motion
      expect(e[2]).toBeGreaterThanOrEqual(0);
      expect(e[2]).toBeLessThan(1);
      expect(e[3]).toBeGreaterThanOrEqual(0);
      expect(e[3]).toBeLessThanOrEqual(180);
    }
  });

  it('ids are unique and sorted', () => {
    for (let i = 1; i < c.count; i++) expect(c.ids[i]).toBeGreaterThan(c.ids[i - 1]);
  });

  it('places Starlink in its ~480 km shells', () => {
    const idx = subset(c, (i) => c.category[i] === Category.Starlink).indices;
    expect(idx.length).toBeGreaterThan(1000);
    const alts = Array.from(idx, (i) => meanAltitudeKm(c, i)).sort((a, b) => a - b);
    const median = alts[alts.length >> 1];
    expect(median).toBeGreaterThan(400);
    expect(median).toBeLessThan(600);
    expect(Array.from(idx).every((i) => c.group[i] === Group.Starlink)).toBe(true);
  });
});

describe('snapshot builder', () => {
  it('keeps microseconds when parsing epochs', () => {
    const jd = isoToJd('2026-09-29T18:24:12.956832');
    const ms = Date.UTC(2026, 8, 29, 18, 24, 12) + 956.832;
    expect(Math.abs(jd - msToJd(ms)) * 86400e6).toBeLessThan(1); // < 1 microsecond
  });

  it('classifies by name', () => {
    expect(classify('ISS (ZARYA)', 25544)).toBe(Category.Station);
    expect(classify('STARLINK-1007', 44713)).toBe(Category.Starlink);
    expect(classify('ONEWEB-0012', 44057)).toBe(Category.Constellation);
    expect(classify('FALCON 9 R/B', 99999)).toBe(Category.RocketBody);
    expect(classify('FENGYUN 1C DEB', 29733)).toBe(Category.Debris);
    expect(classify('ISS OBJECT YM', 64000)).toBe(Category.Payload);
    expect(classify('GPS BIIR-2', 24876)).toBe(Category.Payload);
  });
});
