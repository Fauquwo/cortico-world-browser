import { describe, expect, it } from 'vitest';
import { describeEvents, dhash, gridFor, hamming, selectFrames, targetCount, type FrameMeta, type SelectOptions } from '../src/video/capture.ts';
import { VIDEO_DEFAULTS } from '../src/video/config.ts';

const OPTS: SelectOptions = { ...VIDEO_DEFAULTS.observe };

/** Samples at 2 fps over (t0, t0+gap], each with its own hash unless `same` says otherwise. */
function samples(t0: number, gap: number, overrides: Partial<Record<number, Partial<FrameMeta>>> = {}): FrameMeta[] {
  const out: FrameMeta[] = [];
  for (let i = 1; i <= gap * 2; i++) {
    const t = t0 + i / 2;
    out.push({ t, hash: (0x1000000000000n + BigInt(i) * 0x111111111111n).toString(16).slice(-16), luma: 120, diff: 5, ...overrides[i] });
  }
  return out;
}

describe('selectFrames', () => {
  it('always returns the newest frame, alone for a short gap', () => {
    const s = samples(100, 1);
    expect(selectFrames(s, 1, OPTS)).toEqual([s.length - 1]);
  });

  it('spreads the target count over the gap and keeps time order', () => {
    const s = samples(100, 10);
    const idx = selectFrames(s, 10, OPTS);
    expect(idx.length).toBe(targetCount(10, OPTS));
    expect(idx.at(-1)).toBe(s.length - 1);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    const d = idx.map((i) => s[s.length - 1].t - s[i].t);
    // geometric: each earlier pick is farther back than the next
    for (let i = 1; i < d.length; i++) expect(d[i - 1]).toBeGreaterThan(d[i]);
  });

  it('snaps a position to the cut frame inside its half-spacing', () => {
    const s = samples(100, 10, { 12: { diff: 90 } });
    const idx = selectFrames(s, 10, OPTS);
    expect(idx).toContain(11);
  });

  it('collapses frames that hash the same and black runs', () => {
    const same = 'ffffffffffffffff';
    const s = samples(100, 10).map((f, i) => (i < 16 ? { ...f, hash: same } : f));
    const idx = selectFrames(s, 10, OPTS);
    const dupPicks = idx.filter((i) => i < 16);
    expect(dupPicks.length).toBe(1);
    const black = samples(100, 10).map((f, i) => (i >= 4 && i < 14 ? { ...f, luma: 3 } : f));
    const picks = selectFrames(black, 10, OPTS).filter((i) => i >= 4 && i < 14);
    expect(picks.length).toBeLessThanOrEqual(1);
  });
});

describe('gridFor and targetCount', () => {
  it('maps counts to the five grids and caps at maxFrames', () => {
    expect(gridFor(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridFor(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridFor(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridFor(5)).toEqual({ cols: 3, rows: 2 });
    expect(gridFor(9)).toEqual({ cols: 3, rows: 3 });
    expect(targetCount(5, OPTS)).toBe(4);
    expect(targetCount(60, OPTS)).toBe(OPTS.maxFrames);
    expect(targetCount(0.3, OPTS)).toBe(1);
  });
});

describe('dhash', () => {
  it('gives identical hashes for identical pictures and distant ones for inverted pictures', () => {
    const w = 64, h = 36;
    const a = Array.from({ length: w * h }, (_, i) => (i % w) * 4);
    const b = a.map((v) => 255 - v);
    expect(hamming(dhash(a, w, h), dhash(a, w, h))).toBe(0);
    expect(hamming(dhash(a, w, h), dhash(b, w, h))).toBe(64);
  });
});

describe('describeEvents', () => {
  it('names cuts and black runs with their times', () => {
    const s = samples(0, 6, { 3: { diff: 80 }, 6: { luma: 2 }, 7: { luma: 2 }, 8: { luma: 2 }, 9: { luma: 100, diff: 90 } });
    const lines = describeEvents(s, OPTS, (t) => `${t}s`);
    expect(lines).toContain('1.5s 画面切换');
    expect(lines.some((l) => l.startsWith('3s 黑场'))).toBe(true);
    // the frame after a black run is not a cut
    expect(lines).not.toContain('4.5s 画面切换');
  });
});
