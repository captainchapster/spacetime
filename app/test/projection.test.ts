import { describe, expect, it } from 'vitest';
import { Projection } from '../src/view/projection';

describe('projection', () => {
  it('maps (ct, x, y) with time vertical and "now" at height 0', () => {
    const p = Object.assign(new Projection(), { axes: 'txy', now: 10 });
    const out = [0, 0, 0];
    p.project(7, 1, 2, 3, out);
    expect(out).toEqual([1, -3, -2]);
  });

  it('keeps light at 45° under a boost but tilts the sim frame\'s "now"', () => {
    const p = Object.assign(new Projection(), { axes: 'txy', boost: 0.6 });
    const ray = [0, 0, 0];
    p.project(5, 5, 0, 0, ray); // light moving along +x
    expect(ray[1]).toBeCloseTo(ray[0], 12);

    const simultaneous = [0, 0, 0];
    p.project(0, 4, 0, 0, simultaneous); // an event at t = 0, x = 4
    expect(simultaneous[1]).toBeCloseTo(-0.6 * 1.25 * 4, 12); // t′ = γ(t − βx) < 0
  });

  it('puts z vertical in the space view and samples fields at z = slice', () => {
    const p = Object.assign(new Projection(), { axes: 'xyz', now: 3, slice: 1.5 });
    expect(p.fieldEvent(2, -1)).toEqual([3, 2, -1, 1.5]);
    expect(p.fieldPlaneY).toBe(1.5);
  });
});
