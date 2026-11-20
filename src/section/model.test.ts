import { describe, expect, it } from 'vitest';
import type { SectionLine, SectionMarks, SectionSeries } from '../types';
import {
  bandQuads,
  cappedMax,
  distanceTicks,
  dToX,
  edgePath,
  edgeRuns,
  formatAlong,
  formatLength,
  groupByColor,
  isNearMark,
  markText,
  nearestMark,
  niceStep,
  normalize,
  postsOf,
  readoutText,
  standHeight,
  summaryLine,
  valueAt,
  valueTicks,
  wallPolygon,
  xToD,
} from './model';

const series = (points: { d: number; value: number | null }[], domain: [number, number] = [0, 100]): SectionSeries => ({
  kind: 'series',
  label: '標高',
  unit: 'm',
  points,
  domain,
  color: (v) => [Math.round(v), 0, 0],
});

const mark = (over: Partial<SectionMarks['marks'][number]> = {}): SectionMarks['marks'][number] => ({
  d: 0,
  offset: 0,
  category: 'other',
  categoryLabel: '一般道',
  name: null,
  color: [1, 2, 3],
  x: 0,
  y: 0,
  ...over,
});

describe('距離 ⇄ x', () => {
  const sc = { left: 50, width: 400, length: 20000 };
  it('始点は left、終点は left + width', () => {
    expect(dToX(sc, 0)).toBe(50);
    expect(dToX(sc, 20000)).toBe(450);
    expect(dToX(sc, 5000)).toBe(150);
  });
  it('xToD は dToX の逆で、余白の中は null', () => {
    expect(xToD(sc, 150)).toBeCloseTo(5000);
    expect(xToD(sc, 50)).toBe(0);
    expect(xToD(sc, 450)).toBeCloseTo(20000);
    expect(xToD(sc, 49)).toBeNull();
    expect(xToD(sc, 451)).toBeNull();
    for (const d of [0, 123, 9876, 20000]) expect(xToD(sc, dToX(sc, d))).toBeCloseTo(d, 6);
  });
  it('幅や長さが 0 のときは null', () => {
    expect(xToD({ left: 0, width: 0, length: 100 }, 0)).toBeNull();
    expect(xToD({ left: 0, width: 100, length: 0 }, 0)).toBeNull();
  });
});

describe('目盛り', () => {
  it('niceStep は 1・2・5 × 10^n', () => {
    expect(niceStep(55, 3)).toBe(20);
    expect(niceStep(40000, 3)).toBe(20000);
    expect(niceStep(29, 6)).toBe(5);
    expect(niceStep(0.9, 6)).toBe(0.2);
  });
  it('縦軸：標高 -5〜50 は 0, 20, 40、人口密度 0〜40000 は 0, 20000, 40000', () => {
    expect(valueTicks([-5, 50])).toEqual([0, 20, 40]);
    expect(valueTicks([0, 40000])).toEqual([0, 20000, 40000]);
  });
  it('横軸：29 km なら 5 km 刻み、短い線は小数', () => {
    expect(distanceTicks(29000).map((t) => t.label)).toEqual(['0', '5', '10', '15', '20', '25']);
    expect(distanceTicks(29000)[1].d).toBe(5000);
    expect(distanceTicks(6800).map((t) => t.label)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(distanceTicks(900).map((t) => t.label)).toEqual(['0', '0.2', '0.4', '0.6', '0.8']);
    expect(distanceTicks(0)).toEqual([]);
  });
});

describe('書式', () => {
  it('長さは km（小数1桁）、近くの距離の表示は線の長さで変わる', () => {
    expect(formatLength(29004)).toBe('29.0 km');
    expect(formatAlong(8600, 29000)).toBe('8.6 km');
    expect(formatAlong(850, 2000)).toBe('850 m');
  });
});

describe('valueAt', () => {
  const s = series([
    { d: 0, value: 10 },
    { d: 25, value: 20 },
    { d: 50, value: null },
    { d: 75, value: 40 },
  ]);
  it('いちばん近い点の値', () => {
    expect(valueAt(s, 0)).toBe(10);
    expect(valueAt(s, 10)).toBe(10);
    expect(valueAt(s, 15)).toBe(20);
    expect(valueAt(s, 74)).toBe(40);
  });
  it('値のない区間は null、系列の外も null', () => {
    expect(valueAt(s, 50)).toBeNull();
    expect(valueAt(s, 76)).toBeNull();
    expect(valueAt(s, -1)).toBeNull();
    expect(valueAt(series([]), 0)).toBeNull();
  });
  it('階段状：段の中ではその段の値', () => {
    const step = series([
      { d: 0, value: 5 },
      { d: 250, value: 5 },
      { d: 250, value: 9 },
      { d: 500, value: 9 },
    ]);
    expect(valueAt(step, 100)).toBe(5);
    expect(valueAt(step, 400)).toBe(9);
  });
});

describe('nearestMark と readoutText', () => {
  const marks = [mark({ d: 100, name: 'A通り' }), mark({ d: 140, name: 'B通り' }), mark({ d: 500, category: 'station', categoryLabel: '駅', name: '渋谷', offset: -120 })];
  it('いちばん近い地物。許容の外は null', () => {
    expect(nearestMark(marks, 130, 50)?.name).toBe('B通り');
    expect(nearestMark(marks, 120, 50)?.name).toBe('A通り'); // 同じ距離なら先
    expect(nearestMark(marks, 300, 50)).toBeNull();
    expect(nearestMark([], 0, 50)).toBeNull();
  });
  it('同じ距離なら線に近いほう', () => {
    const m = [mark({ d: 10, offset: 200, name: '遠' }), mark({ d: 10, offset: 5, name: '近' })];
    expect(nearestMark(m, 10, 3)?.name).toBe('近');
  });
  it('地物の説明：駅は線からの距離と向き、交差は種別だけ', () => {
    expect(isNearMark(marks[2])).toBe(true);
    expect(isNearMark(marks[0])).toBe(false);
    expect(markText(marks[2])).toBe('渋谷（駅・線の右 120 m）');
    expect(markText(mark({ categoryLabel: '国道' }))).toBe('国道');
    expect(markText(marks[0])).toBe('A通り（一般道）');
  });
  it('readoutText：系列は値と単位、marks は名前', () => {
    const s = series([{ d: 0, value: 12.4 }, { d: 100, value: 12.4 }]);
    expect(readoutText([s], 50, 10)).toBe('標高 12 m');
    expect(readoutText([series([{ d: 0, value: null }, { d: 100, value: null }])], 50, 10)).toBeNull();
    const mt: SectionMarks = { kind: 'marks', label: 'x', marks };
    expect(readoutText([mt], 498, 10)).toBe('渋谷（駅・線の右 120 m）');
    expect(readoutText([mt], 300, 10)).toBeNull();
  });
});

describe('面グラフの形', () => {
  it('normalize は範囲に収める', () => {
    expect(normalize(50, [0, 100])).toBe(0.5);
    expect(normalize(-5, [0, 100])).toBe(0);
    expect(normalize(500, [0, 100])).toBe(1);
    expect(normalize(1, [5, 5])).toBe(0);
  });
  it('bandQuads：隣り合う2点が値を持つときだけ。null の区間と幅 0 の辺は区間にならない', () => {
    const s = series([
      { d: 0, value: 10 },
      { d: 100, value: 10 },
      { d: 100, value: 60 }, // 階段の段差（幅 0）
      { d: 200, value: 60 },
      { d: 200, value: null },
      { d: 300, value: null },
      { d: 300, value: 20 },
      { d: 400, value: 40 },
    ]);
    const q = bandQuads(s);
    expect(q.map((x) => [x.d0, x.d1])).toEqual([[0, 100], [100, 200], [300, 400]]);
    expect(q[0]).toMatchObject({ t0: 0.1, t1: 0.1, capped: false, color: [10, 0, 0] });
    expect(q[2]).toMatchObject({ t0: 0.2, t1: 0.4, color: [30, 0, 0] });
  });
  it('上端を超えた区間は縦に頭打ちで、capped が立つ。色は実際の値で決まる', () => {
    const s = series([{ d: 0, value: 150 }, { d: 100, value: 150 }], [0, 100]);
    const [q] = bandQuads(s);
    expect(q).toMatchObject({ t0: 1, t1: 1, capped: true, color: [150, 0, 0] });
    expect(cappedMax(s)).toBe(150);
    expect(cappedMax(series([{ d: 0, value: 50 }, { d: 10, value: 100 }]))).toBeNull();
  });
  it('edgeRuns：値のある区間ごとの折れ線（段差の縦の辺を含む）', () => {
    const s = series([
      { d: 0, value: 10 },
      { d: 100, value: 10 },
      { d: 100, value: 60 },
      { d: 200, value: 60 },
      { d: 200, value: null },
      { d: 300, value: null },
      { d: 300, value: 20 },
      { d: 400, value: 20 },
    ]);
    const runs = edgeRuns(s);
    expect(runs).toHaveLength(2);
    expect(runs[0].points.map((p) => [p.d, p.t])).toEqual([[0, 0.1], [100, 0.1], [100, 0.6], [200, 0.6]]);
    expect(runs[1].points).toHaveLength(2);
  });
  it('groupByColor：同じ色を1つにまとめる', () => {
    const s = series([{ d: 0, value: 10 }, { d: 10, value: 10 }, { d: 20, value: 10 }, { d: 30, value: 50 }]);
    const g = groupByColor(bandQuads(s));
    expect(g).toHaveLength(2);
    expect(g[0].quads).toHaveLength(2);
  });
});

describe('地図の中に立てるグラフ', () => {
  it('standHeight：間隔の 65%。低すぎる（間隔が狭い）ときと 0 は立てない', () => {
    expect(standHeight(12000)).toBeCloseTo(7800);
    expect(standHeight(20000)).toBeCloseTo(13000);
    expect(standHeight(2000)).toBeCloseTo(1300);
    expect(standHeight(900)).toBe(0);
    expect(standHeight(0)).toBe(0);
    expect(standHeight(-1)).toBe(0);
    expect(standHeight(NaN)).toBe(0);
    for (const sp of [0, 500, 1000, 5000, 12000, 20000]) expect(standHeight(sp)).toBeLessThanOrEqual(sp * 0.7);
  });
  const line: SectionLine = { ax: 0, ay: 0, bx: 1000, by: 0 };
  it('wallPolygon：線に沿った面の四角形。高さは t × h', () => {
    expect(wallPolygon(line, { d0: 100, d1: 300, t0: 0.5, t1: 1 }, 1000)).toEqual([
      [100, 0, 0],
      [300, 0, 0],
      [300, 0, 1000],
      [100, 0, 500],
    ]);
    const diag: SectionLine = { ax: 0, ay: 0, bx: 300, by: 400 }; // 長さ 500
    const p = wallPolygon(diag, { d0: 0, d1: 250, t0: 0, t1: 0 }, 10);
    expect(p[1][0]).toBeCloseTo(150);
    expect(p[1][1]).toBeCloseTo(200);
  });
  it('edgePath：縁の折れ線を面の上へ', () => {
    const run = { points: [{ d: 0, t: 0.2, capped: false }, { d: 500, t: 1, capped: true }] };
    expect(edgePath(line, run, 100)).toEqual([[0, 0, 20], [500, 0, 100]]);
  });
  it('postsOf：交差は線の上、近くの地物は地物の地点。foot は線の上の同じ距離', () => {
    const cross: SectionMarks = { kind: 'marks', label: '交差', marks: [mark({ d: 200, x: 200, y: 0 })] };
    const near: SectionMarks = {
      kind: 'marks',
      label: '駅',
      marks: [mark({ d: 400, offset: 120, category: 'station', categoryLabel: '駅', name: '東京', x: 400, y: 120 })],
    };
    const posts = postsOf(line, [cross, near]);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ near: false, at: { x: 200, y: 0 }, foot: { x: 200, y: 0 } });
    expect(posts[1]).toMatchObject({ near: true, at: { x: 400, y: 120 }, foot: { x: 400, y: 0 } });
    expect(postsOf(line, [series([])])).toEqual([]);
  });
});

describe('要約', () => {
  const mt = (marks: SectionMarks['marks']): SectionMarks => ({ kind: 'marks', label: 'x', marks });
  it('標高：最小〜最大（m）。値がなければデータなし', () => {
    const s = series([{ d: 0, value: 48.4 }, { d: 25, value: null }, { d: 50, value: 0.6 }]);
    expect(summaryLine('elevation', [s])).toBe('標高 1〜48 m');
    expect(summaryLine('elevation', [series([{ d: 0, value: null }])])).toBe('標高のデータなし');
    expect(summaryLine('elevation', [series([])])).toBe('標高のデータなし');
  });
  it('人口密度：最大（人/km²）', () => {
    const s = series([{ d: 0, value: 50362.4 }, { d: 9, value: 800 }]);
    expect(summaryLine('population', [s])).toBe('人口密度の最大 50,362 人/km²');
    expect(summaryLine('population', [series([])])).toBe('人口密度のデータなし');
  });
  it('道路：交差の数と種別の内訳（高速・国道・都道府県道・一般道の順）', () => {
    const m = [
      mark({ category: 'other', categoryLabel: '一般道' }),
      mark({ category: 'motorway', categoryLabel: '高速道路' }),
      mark({ category: 'prefectural', categoryLabel: '都道府県道' }),
      mark({ category: 'motorway', categoryLabel: '高速道路' }),
      mark({ category: 'national', categoryLabel: '国道' }),
    ];
    expect(summaryLine('roads', [mt(m)])).toBe('道路との交差 5（高速道路 2・国道 1・都道府県道 1・一般道 1）');
    expect(summaryLine('roads', [mt([])])).toBe('道路との交差 0');
  });
  it('公共交通：路線との交差の数と駅の数。学校と病院の数', () => {
    const rail = mt([mark({ category: 'rail' }), mark({ category: 'rail' })]);
    const st = mt([mark({ category: 'station' })]);
    expect(summaryLine('transit', [rail, st])).toBe('路線との交差 2・近くの駅 1');
    const fac = mt([mark({ category: 'school' }), mark({ category: 'school' }), mark({ category: 'hospital' })]);
    expect(summaryLine('facilities', [fac])).toBe('学校 2・病院 1');
    expect(summaryLine('facilities', [mt([])])).toBe('学校 0・病院 0');
  });
});
