import { describe, expect, it } from 'vitest';
import { EXTENT } from '../config';
import type { SectionLine } from '../types';
import {
  MIN_SECTION_LENGTH,
  clearSection,
  clickSection,
  distanceAlongLine,
  dragSection,
  draftLine,
  hitSection,
  sectionFromQuery,
  sectionToQuery,
  translateLine,
} from './interaction';

/** 真上から見た平行投影（1 m = 0.01 px、y は上が北）。高さ z は画面の上へ 0.005 px/m ずれる（斜めの見た目の代用）。 */
const project = ([x, y, z]: [number, number, number]) => [500 + x * 0.01, 500 - y * 0.01 - z * 0.005] as const;
/** project の逆：画素から、高さ z の平面の地点を求める視線。unproject(depth ±1) の2点を返す。 */
const viewport = {
  unproject([px, py, depth]: number[]): number[] {
    // 視線は、(x, y, z) → 画素が (x, y - 200 z) で決まる向き：z を 1 つ上げると、画素が 0.005 上がる = y が 0.5 m 動くのと同じ
    // 簡単のため、鉛直方向 (0, 0, 1) に近い斜めの視線 dir = (0, 0.5/ sqrt(1.25)... ) を使う代わりに、z 軸方向の視線 + y の傾きを入れる。
    const z = depth * 1000;
    return [(px - 500) / 0.01, (500 - py - z * 0.005) / 0.01, z];
  },
};

describe('線を引く手順', () => {
  it('1回目で始点、2回目で終点。線が決まり、始点は空に戻る', () => {
    const s1 = clickSection({ line: null, start: null }, { x: 0, y: 0 });
    expect(s1).toEqual({ line: null, start: { x: 0, y: 0 } });
    const s2 = clickSection(s1, { x: 3000, y: 4000 });
    expect(s2).toEqual({ line: { ax: 0, ay: 0, bx: 3000, by: 4000 }, start: null });
  });
  it('始点に近すぎる終点は受け付けない（状態は変わらない）', () => {
    const s1 = { line: null, start: { x: 0, y: 0 } };
    expect(clickSection(s1, { x: MIN_SECTION_LENGTH - 1, y: 0 })).toBe(s1);
    expect(clickSection(s1, { x: MIN_SECTION_LENGTH, y: 0 }).line).not.toBeNull();
  });
  it('線があるときのクリックは、線を消して新しい始点にする（引き直し）', () => {
    const line: SectionLine = { ax: 0, ay: 0, bx: 1000, by: 0 };
    expect(clickSection({ line, start: null }, { x: 5, y: 6 })).toEqual({ line: null, start: { x: 5, y: 6 } });
  });
  it('Esc は線も始点も消す。下書きは始点からカーソルまで', () => {
    expect(clearSection()).toEqual({ line: null, start: null });
    expect(draftLine({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ ax: 1, ay: 2, bx: 3, by: 4 });
  });
});

describe('URL クエリ', () => {
  it('4つの数値から線を作る', () => {
    expect(sectionFromQuery('-15000,-2000,14000,-2000')).toEqual({ ax: -15000, ay: -2000, bx: 14000, by: -2000 });
    expect(sectionFromQuery('0.5,1,1000.5,1')).toEqual({ ax: 0.5, ay: 1, bx: 1000.5, by: 1 });
  });
  it('不正な値・短すぎる線・未指定は null', () => {
    for (const v of [null, '', '1,2,3', '1,2,3,4,5', 'a,b,c,d', '1,2,,4', '0,0,0,0', '0,0,100,0', 'Infinity,0,1000,0']) expect(sectionFromQuery(v)).toBeNull();
  });
  it('sectionToQuery は丸めた整数で、sectionFromQuery と往復できる', () => {
    const q = sectionToQuery({ ax: -15000.4, ay: -2000.6, bx: 14000, by: 7 });
    expect(q).toBe('-15000,-2001,14000,7');
    expect(sectionFromQuery(q)).not.toBeNull();
  });
});

describe('distanceAlongLine（地図のカーソル → 線に沿った距離）', () => {
  const line: SectionLine = { ax: -10000, ay: 0, bx: 10000, by: 0 }; // 画素では (400,500) → (600,500)
  const heights = [{ plane: 0, at: 0 }];
  it('線の近くなら、垂線の足の距離を返す', () => {
    const r = distanceAlongLine({ project, line, heights, px: 500, py: 504, maxPx: 10 });
    expect(r?.d).toBeCloseTo(10000, 3);
    expect(r?.dist).toBeCloseTo(4);
    expect(distanceAlongLine({ project, line, heights, px: 450, py: 500, maxPx: 10 })?.d).toBeCloseTo(5000, 3);
  });
  it('端の外側は、端の距離（0 と長さ）に収まる', () => {
    expect(distanceAlongLine({ project, line, heights, px: 395, py: 500, maxPx: 10 })?.d).toBe(0);
    expect(distanceAlongLine({ project, line, heights, px: 605, py: 500, maxPx: 10 })?.d).toBeCloseTo(20000);
  });
  it('離れていれば null。複数の高さのうち、近いほうを採る', () => {
    expect(distanceAlongLine({ project, line, heights, px: 500, py: 530, maxPx: 10 })).toBeNull();
    const two = [{ plane: 0, at: 0 }, { plane: 0, at: 4000 }]; // 高さ 4000 の線は、画素で 20 px 上
    const r = distanceAlongLine({ project, line, heights: two, px: 500, py: 481, maxPx: 5 });
    expect(r?.dist).toBeCloseTo(1);
  });
  it('近い高さ（height）も返す。段の ID が付いていれば、それも分かる（右のチャートを目立たせるため）', () => {
    const tagged = [{ plane: 0, at: 0, id: 'roads' }, { plane: 0, at: 4000, id: 'transit' }];
    expect(distanceAlongLine({ project, line, heights: tagged, px: 500, py: 501, maxPx: 5 })?.height.id).toBe('roads');
    expect(distanceAlongLine({ project, line, heights: tagged, px: 500, py: 481, maxPx: 5 })?.height.id).toBe('transit');
  });
  it('長さ 0 の線は null', () => {
    expect(distanceAlongLine({ project, line: { ax: 1, ay: 1, bx: 1, by: 1 }, heights, px: 500, py: 500, maxPx: 10 })).toBeNull();
  });
});

describe('hitSection と dragSection', () => {
  const line: SectionLine = { ax: -10000, ay: 0, bx: 10000, by: 0 };
  const base = { project, viewport, line, planes: [0], heights: [{ plane: 0, at: 0 }] };
  it('端点（輪）の上ならその端点。近いほう', () => {
    const a = hitSection({ ...base, px: 401, py: 501 });
    expect(a?.kind).toBe('a');
    const b = hitSection({ ...base, px: 598, py: 500 });
    expect(b?.kind).toBe('b');
  });
  it('端点から離れた線の上は線そのもの（つかんだ地点を覚える）。線の外は null', () => {
    const g = hitSection({ ...base, px: 500, py: 503 });
    expect(g?.kind).toBe('body');
    expect(g).toMatchObject({ plane: 0, line });
    expect(hitSection({ ...base, px: 500, py: 520 })).toBeNull();
  });
  it('端点をドラッグすると、その端点だけが動く（つかんだ位置のずれを保つ）', () => {
    const g = hitSection({ ...base, px: 402, py: 500 });
    const next = dragSection(viewport, 300, 500, g!, line);
    expect(next?.bx).toBe(line.bx);
    expect(next?.by).toBe(line.by);
    // 画素 300 + ずれ(-2) → x = (298 - 500) / 0.01 = -20200 だが、描画範囲 (-19000) に収まる
    expect(next?.ax).toBe(EXTENT.minX);
    expect(next?.ay).toBeCloseTo(0);
  });
  it('端点を、もう一方の端点に近づけすぎる位置へは動かさない', () => {
    const g = hitSection({ ...base, px: 400, py: 500 });
    expect(g?.kind).toBe('a');
    expect(dragSection(viewport, 599, 500, g!, line)).toBeNull();
  });
  it('線をドラッグすると平行に動く（向きと長さは変わらない）', () => {
    const g = hitSection({ ...base, px: 500, py: 500 })!;
    const next = dragSection(viewport, 500, 480, g, line)!;
    expect(next.ax - next.bx).toBeCloseTo(line.ax - line.bx);
    expect(next.ay - next.by).toBeCloseTo(0);
    expect(next.ay).toBeCloseTo(2000); // 20 px 上 = 北へ 2000 m
  });
});

describe('translateLine', () => {
  it('範囲の内側ではそのまま、外へ出る量は、形を保ったまま制限する', () => {
    const line: SectionLine = { ax: 0, ay: 0, bx: 1000, by: 2000 };
    expect(translateLine(line, 100, -50)).toEqual({ ax: 100, ay: -50, bx: 1100, by: 1950 });
    const far = translateLine(line, 1e9, 1e9);
    expect(far.bx).toBe(EXTENT.maxX);
    expect(far.by).toBe(EXTENT.maxY);
    expect(far.bx - far.ax).toBe(1000);
    expect(far.by - far.ay).toBe(2000);
    const low = translateLine(line, -1e9, -1e9);
    expect(low.ax).toBe(EXTENT.minX);
    expect(low.ay).toBe(EXTENT.minY);
  });
});
