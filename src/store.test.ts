import { describe, expect, it } from 'vitest';
import { initialStateFromQuery, useMapStore } from './store';
import { SPACING } from './config';

describe('initialStateFromQuery', () => {
  it('クエリなしは既定値', () => {
    const s = initialStateFromQuery('');
    expect(s.spacing).toBe(SPACING.default);
    expect(s.order).toEqual(['elevation', 'population', 'roads', 'transit', 'facilities']);
    expect(Object.values(s.visible).every(Boolean)).toBe(true);
    expect(s.solo).toBeNull();
    expect(s.probe).toBeNull();
    expect(s.probePinned).toBe(false);
    expect(s.viewState.rotationX).toBe(45);
  });

  it('各クエリで上書きできる', () => {
    const s = initialStateFromQuery(
      '?spacing=0&order=facilities,roads&hidden=population,transit&solo=roads&probe=100,-200&rx=60&ro=-10&zoom=-3',
    );
    expect(s.spacing).toBe(0);
    expect(s.order).toEqual(['facilities', 'roads', 'elevation', 'population', 'transit']);
    expect(s.visible).toMatchObject({ population: false, transit: false, roads: true });
    expect(s.solo).toBe('roads');
    expect(s.probe).toEqual({ x: 100, y: -200 });
    expect(s.viewState).toMatchObject({ rotationX: 60, rotationOrbit: -10, zoom: -3 });
  });

  it('不正な値は無視する', () => {
    const s = initialStateFromQuery('?spacing=abc&order=foo,roads,roads&hidden=bar&solo=zzz&probe=1&rx=');
    expect(s.spacing).toBe(SPACING.default);
    expect(s.order[0]).toBe('roads');
    expect(new Set(s.order).size).toBe(5);
    expect(s.solo).toBeNull();
    expect(s.probe).toBeNull();
    expect(s.viewState.rotationX).toBe(45);
  });

  it('spacing は範囲に収める', () => {
    expect(initialStateFromQuery('?spacing=99999').spacing).toBe(SPACING.max);
    expect(initialStateFromQuery('?spacing=-5').spacing).toBe(SPACING.min);
  });
});

describe('store actions', () => {
  it('moveLayer は指定位置へ動かす', () => {
    const { moveLayer } = useMapStore.getState();
    moveLayer('facilities', 0);
    expect(useMapStore.getState().order).toEqual(['facilities', 'elevation', 'population', 'roads', 'transit']);
    moveLayer('facilities', 99);
    expect(useMapStore.getState().order).toEqual(['elevation', 'population', 'roads', 'transit', 'facilities']);
  });
});
