import { describe, expect, it } from 'vitest';
import { initialStateFromQuery, radiusQuery, useMapStore, viewQuery } from './store';
import { DEFAULT_ANGLES, SPACING, VIEW_LIMITS } from './config';

describe('initialStateFromQuery', () => {
  it('クエリなしは既定値', () => {
    const s = initialStateFromQuery('');
    expect(s.spacing).toBe(SPACING.default);
    expect(s.order).toEqual(['elevation', 'population', 'roads', 'transit', 'facilities']);
    expect(Object.values(s.visible).every(Boolean)).toBe(true);
    expect(s.solo).toBeNull();
    expect(s.probe).toBeNull();
    expect(s.probePinned).toBe(false);
    expect(s.viewState.rotationX).toBe(DEFAULT_ANGLES.rotationX);
    expect(s.spacing).toBe(12000);
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
    expect(s.viewState.rotationX).toBe(DEFAULT_ANGLES.rotationX);
  });

  it('spacing は範囲に収める', () => {
    expect(initialStateFromQuery('?spacing=99999').spacing).toBe(SPACING.max);
    expect(initialStateFromQuery('?spacing=-5').spacing).toBe(SPACING.min);
  });
});

describe('section クエリ', () => {
  it('線があれば「断面」で開く。なければ「地点」', () => {
    const s = initialStateFromQuery('?section=-15000,-2000,14000,-2000');
    expect(s.mode).toBe('section');
    expect(s.section).toEqual({ ax: -15000, ay: -2000, bx: 14000, by: -2000 });
    const d = initialStateFromQuery('');
    expect(d.mode).toBe('point');
    expect(d.section).toBeNull();
  });
  it('不正な値は無視して「地点」', () => {
    for (const q of ['?section=1,2,3', '?section=a,b,c,d', '?section=0,0,10,10']) {
      const s = initialStateFromQuery(q);
      expect(s.mode).toBe('point');
      expect(s.section).toBeNull();
    }
  });
  it('probe と併せて指定しても、両方を保持する', () => {
    const s = initialStateFromQuery('?probe=100,200&section=0,0,5000,0');
    expect(s.mode).toBe('section');
    expect(s.probePinned).toBe(true);
    expect(s.probe).toEqual({ x: 100, y: 200 });
    expect(s.section).not.toBeNull();
  });
});

describe('モードの切り替え', () => {
  it('切り替えても、線と固定した探針は消えない。カーソルに付いてくる表示は消える', () => {
    const st = useMapStore;
    st.setState({ mode: 'point', section: { ax: 0, ay: 0, bx: 1000, by: 0 }, probe: { x: 1, y: 2 }, probePinned: true, sectionHover: 500, sectionCursor: { x: 3, y: 4 } });
    st.getState().setMode('section');
    expect(st.getState()).toMatchObject({ mode: 'section', probePinned: true, probe: { x: 1, y: 2 }, sectionHover: null, sectionCursor: null });
    expect(st.getState().section).not.toBeNull();
    st.getState().setMode('point');
    expect(st.getState().section).toEqual({ ax: 0, ay: 0, bx: 1000, by: 0 });
    expect(st.getState().probe).toEqual({ x: 1, y: 2 });
  });
  it('固定していない探針は、「断面」へ切り替えるときに消す', () => {
    const st = useMapStore;
    st.setState({ mode: 'point', probe: { x: 1, y: 2 }, probePinned: false });
    st.getState().setMode('section');
    expect(st.getState().probe).toBeNull();
  });
});

describe('視点のクエリは上下限に収める', () => {
  it('rx と zoom は視点の上下限に収まる', () => {
    expect(initialStateFromQuery('?rx=200&zoom=50').viewState).toMatchObject({
      rotationX: VIEW_LIMITS.maxRotationX,
      zoom: VIEW_LIMITS.maxZoom,
    });
    expect(initialStateFromQuery('?rx=-30&zoom=-99').viewState).toMatchObject({
      rotationX: VIEW_LIMITS.minRotationX,
      zoom: VIEW_LIMITS.minZoom,
    });
  });
  it('範囲内の値はそのまま、ro は有限の値をそのまま', () => {
    expect(initialStateFromQuery('?rx=45&ro=120&zoom=-5').viewState).toMatchObject({ rotationX: 45, rotationOrbit: 120, zoom: -5 });
    expect(viewQuery('?rx=abc&ro=Infinity&zoom=')).toEqual({ rx: null, ro: null, zoom: null });
  });
  it('spacing の上限は 20km', () => {
    expect(SPACING.max).toBe(20000);
    expect(initialStateFromQuery('?spacing=20000').spacing).toBe(20000);
    expect(initialStateFromQuery('?spacing=30000').spacing).toBe(20000);
  });
});

describe('store actions', () => {
  it('setSpacing は有限でない値を無視し、範囲に収める', () => {
    const { setSpacing } = useMapStore.getState();
    setSpacing(8000);
    setSpacing(NaN);
    setSpacing(Infinity);
    setSpacing(-Infinity);
    expect(useMapStore.getState().spacing).toBe(8000);
    setSpacing(99999);
    expect(useMapStore.getState().spacing).toBe(SPACING.max);
    setSpacing(-1);
    expect(useMapStore.getState().spacing).toBe(SPACING.min);
  });
  it('moveLayer は指定位置へ動かす', () => {
    const { moveLayer } = useMapStore.getState();
    moveLayer('facilities', 0);
    expect(useMapStore.getState().order).toEqual(['facilities', 'elevation', 'population', 'roads', 'transit']);
    moveLayer('facilities', 99);
    expect(useMapStore.getState().order).toEqual(['elevation', 'population', 'roads', 'transit', 'facilities']);
  });
});

describe('radiusQuery', () => {
  it('1000 / 2000 / 5000 はそのまま', () => {
    expect(radiusQuery('?radius=1000')).toBe(1000);
    expect(radiusQuery('?radius=2000')).toBe(2000);
    expect(radiusQuery('?radius=5000')).toBe(5000);
  });
  it('それ以外（ほかの数値、数値でない値、空、省略）は既定の 2000', () => {
    for (const q of ['', '?radius=', '?radius=abc', '?radius=3000', '?radius=0', '?radius=-1000', '?radius=1e3x', '?radius=2000.5'])
      expect(radiusQuery(q)).toBe(2000);
  });
  it('initialStateFromQuery が closeupRadius に取り込む。探針の固定とは独立', () => {
    expect(initialStateFromQuery('?radius=5000').closeupRadius).toBe(5000);
    expect(initialStateFromQuery('?radius=5000').probePinned).toBe(false);
    expect(initialStateFromQuery('?probe=1,2&radius=1000')).toMatchObject({ closeupRadius: 1000, probePinned: true });
    expect(initialStateFromQuery('').closeupRadius).toBe(2000);
  });
  it('setCloseupRadius で切り替わる', () => {
    useMapStore.getState().setCloseupRadius(5000);
    expect(useMapStore.getState().closeupRadius).toBe(5000);
    useMapStore.getState().setCloseupRadius(2000);
  });
});
