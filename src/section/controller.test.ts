import { beforeEach, describe, expect, it } from 'vitest';
import type { PickingInfo } from '@deck.gl/core';
import { LAYER_IDS } from '../config';
import { initialStateFromQuery, useMapStore } from '../store';
import { HOVER_NEAR_PX, onSectionHover, releaseSection, sectionHeights } from './controller';

const LINE = { ax: -10000, ay: 0, bx: 10000, by: 0 };
const SPACING = 10000;
/** 真上から見た平行投影（1 m = 0.01 px）。高さ z は、画面の上へ 0.02 px/m（段が縦に離れて見える）。 */
const project = ([x, y, z]: number[]) => [500 + x * 0.01, 1500 - y * 0.01 - z * 0.02, 0];
const info = (x: number, y: number) => ({ x, y, viewport: { project } }) as unknown as PickingInfo;

beforeEach(() => {
  useMapStore.setState({
    ...initialStateFromQuery(''),
    spacing: SPACING,
    mode: 'section',
    section: LINE,
    sectionStart: null,
    sectionCursor: null,
    sectionHover: null,
    sectionFocus: null,
  });
});

describe('sectionHeights', () => {
  it('段ごとの高さに、その段のレイヤー ID が付く（立てたグラフの高さも同じ ID）', () => {
    const hs = sectionHeights(useMapStore.getState());
    expect(new Set(hs.map((h) => h.id))).toEqual(new Set(LAYER_IDS));
    expect(hs.filter((h) => h.id === 'elevation').every((h) => h.plane === 0)).toBe(true);
    expect(hs.filter((h) => h.id === 'facilities').every((h) => h.plane === 4 * SPACING)).toBe(true);
  });
  it('非表示の段は含まない', () => {
    useMapStore.getState().setVisible('roads', false);
    expect(sectionHeights(useMapStore.getState()).some((h) => h.id === 'roads')).toBe(false);
  });
});

describe('onSectionHover（全体の地図 → 右のチャート）', () => {
  it('切り口の線の近くなら、その段が目立つ（from = map）', () => {
    // 公共交通の平面は z = 3 × SPACING = 30000 → 画面の y = 1500 - 600 = 900
    onSectionHover(info(500, 900 + 2));
    const s = useMapStore.getState();
    expect(s.sectionFocus).toEqual({ id: 'transit', from: 'map' });
    expect(s.sectionHover).toBeCloseTo(10000, -1);
  });
  it('線から離れると、目立たせるのをやめる', () => {
    onSectionHover(info(500, 900 + 2));
    onSectionHover(info(500, 900 + 2 + HOVER_NEAR_PX + 30));
    expect(useMapStore.getState().sectionFocus).toBeNull();
    expect(useMapStore.getState().sectionHover).toBeNull();
  });
  it('右のチャートにカーソルがあるあいだ（from = chart）は、地図のカーソルで消さない', () => {
    useMapStore.getState().setSectionFocus({ id: 'roads', from: 'chart' });
    onSectionHover(info(500, 99999));
    expect(useMapStore.getState().sectionFocus).toEqual({ id: 'roads', from: 'chart' });
  });
  it('線を消すと、目立たせるのもやめる', () => {
    useMapStore.getState().setSectionFocus({ id: 'roads', from: 'chart' });
    releaseSection();
    expect(useMapStore.getState().sectionFocus).toBeNull();
  });
});

describe('sectionFocus', () => {
  it('同じ値を入れても、値は同じオブジェクトのまま（無駄に描き直さない）', () => {
    const { setSectionFocus } = useMapStore.getState();
    setSectionFocus({ id: 'roads', from: 'chart' });
    const before = useMapStore.getState().sectionFocus;
    setSectionFocus({ id: 'roads', from: 'chart' });
    expect(useMapStore.getState().sectionFocus).toBe(before);
    setSectionFocus({ id: 'roads', from: 'map' });
    expect(useMapStore.getState().sectionFocus?.from).toBe('map');
  });
  it('「地点」へ切り替えると消える', () => {
    useMapStore.getState().setSectionFocus({ id: 'roads', from: 'chart' });
    useMapStore.getState().setMode('point');
    expect(useMapStore.getState().sectionFocus).toBeNull();
  });
});
