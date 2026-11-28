import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../../config';
import type { FloodScenario, LayerOptions } from '../../config';
import type { Position, RailCollection, SectionLine, StationCollection } from '../../types';
import { buildFloodData } from '../flood/model';
import type { FloodData, FloodMeta } from '../flood/model';
import { DEPTH_CLASSES, DURATION_COLORS } from '../flood/classes';
import { buildTransitData, sampleTransit, sectionTransit, subsetTransit, summarizeTransit } from '../transitModel';
import transit from '../transit';
import { EXPOSED_LABEL, EXPOSED_MIN_DEPTH, OTHER_LABEL, TRANSIT_COLORS, exposedMask, isExposedAt, splitPath, transitExposure } from './exposure';

/**
 * 4列×2行、セル 100 m の格子（x 0〜400、y 0〜200。行 0 が北 = y 100〜200）。
 * 深さのランク（0 = なし、1 = 0.5m 未満、2 = 0.5〜3m、3 = 3〜5m、6 = 20m 以上、255 = 23区の外）：
 *   洪水 行0: 0 1 2 3   行1: 6 1 0 255
 *   高潮 行0: 0 0 5 1   行1: 0 2 0 255
 * 区域（深さ 0.5m 以上 = ランク 2 以上）のセルの添字（行 * 4 + 列）：
 *   大きいほう：2 3 4 5　洪水：2 3 4　高潮：2 5
 */
function grid(): FloodData {
  const w = 4;
  const h = 2;
  const meta = {
    width: w,
    height: h,
    cellSize: 100,
    minX: 0,
    minY: 0,
    maxX: 400,
    maxY: 200,
    // ランクの表は、画面の定義と一致するものを借りる（buildFloodData が突き合わせる）
    ...ranksMeta(),
    files: { riverDepth: '', tideDepth: '', riverDuration: '', tideDuration: '' },
  } as unknown as FloodMeta;
  const buf = (v: number[]) => new Uint8Array(v).buffer;
  return buildFloodData(meta, {
    riverDepth: buf([0, 1, 2, 3, 6, 1, 0, 255]),
    tideDepth: buf([0, 0, 5, 1, 0, 2, 0, 255]),
    // 継続時間は、深さと違う並びにしておく（判定が継続時間に影響されないことを確かめるため）
    riverDuration: buf([7, 7, 0, 0, 0, 0, 7, 255]),
    tideDuration: buf([5, 5, 0, 0, 5, 0, 5, 255]),
  });
}

function ranksMeta() {
  const depth = DEPTH_CLASSES.map((c, i) => ({ rank: i + 1, label: c.label, minM: c.min, maxM: c.max }));
  const hours = (pairs: [number, number | null][]) => pairs.map(([minH, maxH], i) => ({ rank: i + 1, label: '', minH, maxH }));
  return {
    depthRanks: depth,
    durationRanks: hours([[0, 12], [12, 24], [24, 72], [72, 168], [168, 336], [336, 672], [672, null]]),
    tideDurationRanks: hours([[0, 12], [12, 24], [24, 72], [72, 168], [168, null]]),
  };
}

const mask = (s: FloodScenario) => [...exposedMask(grid(), s)];

describe('exposedMask：浸水の深さが 0.5m 以上のセル', () => {
  it('下限は 0.5m（深さの段の「0.5〜3m」から）', () => {
    expect(EXPOSED_MIN_DEPTH).toBe(0.5);
    expect(DEPTH_CLASSES[1].min).toBe(0.5);
  });
  it('想定に従う：大きいほう・洪水・高潮', () => {
    expect(mask('max')).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
    expect(mask('river')).toEqual([0, 0, 1, 1, 1, 0, 0, 0]);
    expect(mask('tide')).toEqual([0, 0, 1, 0, 0, 1, 0, 0]);
  });
  it('23区の外（255）は区域ではない', () => {
    expect(mask('max')[7]).toBe(0);
  });
  it('同じ格子・想定には、同じ（参照が等しい）ものを返す', () => {
    const g = grid();
    expect(exposedMask(g, 'max')).toBe(exposedMask(g, 'max'));
    expect(exposedMask(g, 'max')).not.toBe(exposedMask(g, 'tide'));
  });
  it('isExposedAt：座標から、浸水の段と同じセルを引く（境目は右・下のセルに入る）', () => {
    const g = grid();
    expect(isExposedAt(g, 'max', 250, 150)).toBe(true);
    expect(isExposedAt(g, 'max', 199.9, 150)).toBe(false);
    expect(isExposedAt(g, 'max', 200, 150)).toBe(true);
    expect(isExposedAt(g, 'tide', 350, 150)).toBe(false); // 高潮 0.5m 未満（ランク 1）
    expect(isExposedAt(g, 'max', 350, 150)).toBe(true);
    expect(isExposedAt(g, 'max', 350, 50)).toBe(false); // 23区の外
    expect(isExposedAt(g, 'max', -1, 150)).toBe(false); // 格子の外
    expect(isExposedAt(g, 'max', 250, 250)).toBe(false);
  });
});

describe('splitPath：浸水の格子のセルの境目で区切る', () => {
  const run = (path: Position[], s: FloodScenario) => {
    const exposed: Position[][] = [];
    const other: Position[][] = [];
    splitPath(path, grid(), exposedMask(grid(), s), exposed, other);
    return { exposed, other };
  };
  it('横切る線：区域の手前まで「それ以外」、区域に入る境目から「区域」', () => {
    const { exposed, other } = run([[0, 150], [400, 150]], 'max');
    expect(other).toEqual([[[0, 150], [200, 150]]]);
    expect(exposed).toEqual([[[200, 150], [400, 150]]]);
  });
  it('想定が変わると、区切りも変わる（高潮では、区域が1セルだけ）', () => {
    const { exposed, other } = run([[0, 150], [400, 150]], 'tide');
    expect(other).toEqual([[[0, 150], [200, 150]], [[300, 150], [400, 150]]]);
    expect(exposed).toEqual([[[200, 150], [300, 150]]]);
  });
  it('頂点を含む線：同じ種類が続くあいだは1本にまとめ、元の頂点を残す', () => {
    const { exposed, other } = run([[210, 190], [260, 120], [380, 140]], 'max');
    expect(other).toEqual([]);
    expect(exposed).toEqual([[[210, 190], [260, 120], [380, 140]]]);
  });
  it('斜めの線：セルの角をまたぐ位置で区切る', () => {
    // (0,100) → (400,200)：y = 100 + x/4。x 0〜200 は行 0（y > 100）で、0〜200 の「それ以外」、200〜400 が区域
    const { exposed, other } = run([[0, 100.5], [400, 200]], 'max');
    expect(other.length).toBe(1);
    expect(exposed.length).toBe(1);
    expect(other[0][0]).toEqual([0, 100.5]);
    expect(other[0].at(-1)![0]).toBeCloseTo(200, 6);
    expect(exposed[0][0][0]).toBeCloseTo(200, 6);
    expect(exposed[0].at(-1)).toEqual([400, 200]);
  });
  it('種類が変わる位置が、元の線の頂点と重なっても、同じ点を2回並べない（長さ 0 の線分を作らない）', () => {
    const { exposed, other } = run([[0, 150], [200, 150], [300, 130]], 'max');
    expect(other).toEqual([[[0, 150], [200, 150]]]);
    expect(exposed).toEqual([[[200, 150], [300, 130]]]);
    for (const p of [...exposed, ...other]) p.slice(1).forEach((q, i) => expect(q).not.toEqual(p[i]));
  });
  it('区切った前後の区間は、境目の頂点を共有する（隙間がない）', () => {
    const { exposed, other } = run([[0, 150], [400, 150]], 'max');
    expect(other[0].at(-1)).toEqual(exposed[0][0]);
  });
  it('格子の外にある線は、「それ以外」になる（区域ではない）', () => {
    const { exposed, other } = run([[1000, 1000], [2000, 1500]], 'max');
    expect(exposed).toEqual([]);
    expect(other).toEqual([[[1000, 1000], [2000, 1500]]]);
  });
  it('区間の長さの合計は、元の線の長さと同じ', () => {
    const path: Position[] = [[10, 190], [390, 20], [120, 60]];
    const { exposed, other } = run(path, 'max');
    const len = (p: Position[]) => p.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
    expect([...exposed, ...other].reduce((a, p) => a + len(p), 0)).toBeCloseTo(len(path), 6);
  });
});

/* ---------- 駅・路線に当てる ---------- */

const rail = (line: string, coordinates: Position[]) => ({
  type: 'Feature' as const,
  geometry: { type: 'LineString' as const, coordinates },
  properties: { operator: 'A社', line },
});
const station = (name: string, xy: Position) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: xy },
  properties: { name, operator: 'A社', line: 'L' },
});

function transitWith(flood: FloodData | null) {
  const data = buildTransitData(
    { type: 'FeatureCollection', features: [rail('東西線', [[0, 150], [400, 150]]), rail('南北線', [[50, 0], [50, 200]])] } as RailCollection,
    {
      type: 'FeatureCollection',
      features: [
        station('甲', [250, 150]), // 大きいほう・洪水・高潮のどれでも区域
        station('乙', [350, 150]), // 大きいほう・洪水は区域、高潮は区域外（0.5m 未満）
        station('丙', [50, 150]), // どれでも区域外
        station('丁', [150, 50]), // 大きいほう・高潮は区域、洪水は区域外
        station('戊', [350, 50]), // 23区の外
      ],
    } as StationCollection,
  );
  data.flood = flood;
  return data;
}
const opt = (floodScenario: FloodScenario, floodView: LayerOptions['floodView'] = 'depth'): LayerOptions => ({ ...DEFAULT_OPTIONS, floodScenario, floodView });

describe('transitExposure', () => {
  it('駅：想定ごとに区域内かどうかが変わる', () => {
    const data = transitWith(grid());
    expect([...transitExposure(data, 'max')!.stationExposed]).toEqual([1, 1, 0, 1, 0]);
    expect([...transitExposure(data, 'river')!.stationExposed]).toEqual([1, 1, 0, 0, 0]);
    expect([...transitExposure(data, 'tide')!.stationExposed]).toEqual([1, 0, 0, 1, 0]);
  });
  it('駅の位置の配列は、区域内・区域外の2つに分かれ、合わせて全駅になる', () => {
    const data = transitWith(grid());
    const e = transitExposure(data, 'max')!;
    expect(e.exposedStations).toEqual([[250, 150], [350, 150], [150, 50]]);
    expect(e.otherStations).toEqual([[50, 150], [350, 50]]);
  });
  it('路線：東西線は x = 200 で区切れ、南北線（x = 50 の列）は、洪水が 20m 以上のセルにかかる南半分が区域', () => {
    const data = transitWith(grid());
    const e = transitExposure(data, 'max')!;
    expect(e.exposedPaths).toEqual([[[200, 150], [400, 150]], [[50, 0], [50, 100]]]);
    expect(e.otherPaths).toEqual([[[0, 150], [200, 150]], [[50, 100], [50, 200]]]);
    // 高潮の想定では、この列（高潮は 0）は区域にならない
    expect(transitExposure(data, 'tide')!.exposedPaths).toEqual([[[200, 150], [300, 150]]]);
  });
  it('見るもの（深さ・水が引くまで）は、判定に影響しない（想定だけで決まる）', () => {
    const data = transitWith(grid());
    // 継続時間の格子は、深さと違う並びにしてある。判定は深さだけから作るので、同じ結果
    expect(transitExposure(data, 'max')).toBe(transitExposure(data, 'max'));
    expect([...transitExposure(data, 'max')!.stationExposed]).toEqual([1, 1, 0, 1, 0]);
  });
  it('データと想定の組ごとに1回だけ計算する（同じ参照を返す）', () => {
    const data = transitWith(grid());
    expect(transitExposure(data, 'tide')).toBe(transitExposure(data, 'tide'));
    expect(transitExposure(data, 'tide')).not.toBe(transitExposure(data, 'river'));
  });
  it('浸水の格子がないデータでは null', () => {
    expect(transitExposure(transitWith(null), 'max')).toBeNull();
    expect(transitExposure(buildTransitData({ type: 'FeatureCollection', features: [] }, { type: 'FeatureCollection', features: [] }), 'max')).toBeNull();
  });
});

describe('公共交通の凡例と色', () => {
  it('凡例は2行：区域の駅・区間（深さ 0.5m 以上）と、それ以外', () => {
    const legend = transit.legend(DEFAULT_OPTIONS);
    expect(legend.map((l) => l.label)).toEqual(['浸水が想定される区域の駅・区間（深さ 0.5m 以上）', 'それ以外']);
    expect(legend[0].label).toBe(EXPOSED_LABEL);
    expect(legend[1].label).toBe(OTHER_LABEL);
    expect(legend[0].color).toEqual(TRANSIT_COLORS.railExposed);
    expect(legend[1].color).toEqual(TRANSIT_COLORS.railOther);
  });
  it('2種は、色相だけでなく明るさ（相対輝度）の差で区別できる（コントラスト比が路線・駅とも 4 以上）', () => {
    const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4); // sRGB
    const Y = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (a: number[], b: number[]) => (Math.max(Y(a), Y(b)) + 0.05) / (Math.min(Y(a), Y(b)) + 0.05);
    expect(ratio(TRANSIT_COLORS.railExposed, TRANSIT_COLORS.railOther)).toBeGreaterThanOrEqual(4);
    expect(ratio(TRANSIT_COLORS.stationExposed, TRANSIT_COLORS.stationOther)).toBeGreaterThanOrEqual(4);
  });
  it('浸水の段の色（深さ・継続時間のすべての段）と、同じ色ではない', () => {
    const floodColors = [...DEPTH_CLASSES.map((c) => c.color), ...DURATION_COLORS];
    for (const c of [TRANSIT_COLORS.railExposed, TRANSIT_COLORS.railOther, TRANSIT_COLORS.stationExposed, TRANSIT_COLORS.stationOther])
      for (const f of floodColors) expect(Math.hypot(c[0] - f[0], c[1] - f[1], c[2] - f[2])).toBeGreaterThan(40);
  });
  it('描画：区域の区間・駅と、それ以外が別のレイヤー（データは判定の結果と同じ）', () => {
    const data = transitWith(grid());
    const ctx = { z: 0, modelMatrix: [], opacity: 1, solo: false, boundary: null, options: opt('max') };
    const layers = transit.render(data, ctx);
    const byId = Object.fromEntries(layers.map((l) => [l.id, l.props.data as unknown[]]));
    expect(Object.keys(byId)).toEqual(['transit-rail-other', 'transit-rail-exposed', 'transit-stations-other', 'transit-stations-exposed']);
    expect(byId['transit-stations-exposed']).toHaveLength(3);
    expect(byId['transit-stations-other']).toHaveLength(2);
    expect(byId['transit-rail-exposed']).toHaveLength(2);
    // 想定を替えると、描き分けも変わる
    const tide = transit.render(data, { ...ctx, options: opt('tide') });
    expect(tide.find((l) => l.id === 'transit-stations-exposed')!.props.data).toHaveLength(2);
  });
  it('描画：「見るもの」を替えても、描き分けは変わらない', () => {
    const data = transitWith(grid());
    const ctx = { z: 0, modelMatrix: [], opacity: 1, solo: false, boundary: null };
    const depth = transit.render(data, { ...ctx, options: opt('max', 'depth') });
    const duration = transit.render(data, { ...ctx, options: opt('max', 'duration') });
    expect(duration.map((l) => l.props.data)).toEqual(depth.map((l) => l.props.data));
  });
  it('描画：同じ想定なら、描画のたびに同じデータの配列を渡す（視点の操作で作り直さない）', () => {
    const data = transitWith(grid());
    const ctx = { z: 0, modelMatrix: [], opacity: 1, solo: false, boundary: null, options: opt('max') };
    const a = transit.render(data, ctx);
    const b = transit.render(data, ctx);
    a.forEach((l, i) => expect(l.props.data).toBe(b[i].props.data));
  });
  it('描画：浸水の格子がないときは、すべて「それ以外」で描く', () => {
    const data = transitWith(null);
    const layers = transit.render(data, { z: 0, modelMatrix: [], opacity: 1, solo: false, boundary: null, options: opt('max') });
    expect(layers.find((l) => l.id === 'transit-stations-exposed')!.props.data).toHaveLength(0);
    expect(layers.find((l) => l.id === 'transit-stations-other')!.props.data).toHaveLength(5);
    expect(layers.find((l) => l.id === 'transit-rail-exposed')!.props.data).toHaveLength(0);
  });
});

describe('地点の値（探針）', () => {
  const data = transitWith(grid());
  const row = (x: number, y: number, s: FloodScenario) => sampleTransit(data, x, y, opt(s)).find((v) => v.label === '最寄り駅の浸水想定')?.value;
  it('最寄り駅の位置が区域内かどうか（駅の位置で判定する。探針の位置ではない）', () => {
    expect(row(260, 150, 'max')).toMatch(/^区域内（深さ 0.5m 以上。洪水と高潮の大きいほう）$/);
    // 探針は区域の外（x = 150）でも、最寄り駅（甲、x = 250）が区域内なら「区域内」
    expect(row(150, 160, 'max')).toMatch(/^区域内/);
    expect(row(60, 150, 'max')).toMatch(/^区域外（深さ 0.5m 未満、または浸水なし。洪水と高潮の大きいほう）$/);
  });
  it('想定に従う', () => {
    expect(row(340, 150, 'river')).toMatch(/^区域内（.*。洪水）$/);
    expect(row(340, 150, 'tide')).toMatch(/^区域外（.*。高潮）$/);
  });
  it('主な値（先頭）は今のまま「駅名（路線、距離）」。区域の行は、そのあとに足す', () => {
    const v = sampleTransit(data, 260, 150, opt('max'));
    expect(v.map((x) => x.label)).toEqual(['最寄り駅', '最寄り駅の浸水想定', '通る路線']);
    expect(v[0].value).toBe('甲駅（L、10m）');
  });
  it('options を渡さないとき、浸水の想定は既定（大きいほう）', () => {
    expect(sampleTransit(data, 340, 150).find((v) => v.label === '最寄り駅の浸水想定')?.value).toMatch(/^区域内/);
  });
  it('最寄り駅がない（1 km 以内に駅がない）ときは、区域の行を出さない', () => {
    expect(sampleTransit(data, 5000, 5000, opt('max')).some((v) => v.label === '最寄り駅の浸水想定')).toBe(false);
  });
  it('浸水の格子がないときは、区域の行を出さない', () => {
    expect(sampleTransit(transitWith(null), 260, 150, opt('max')).map((v) => v.label)).toEqual(['最寄り駅', '通る路線']);
  });
});

describe('円の中の集計（クローズアップ）', () => {
  const data = transitWith(grid());
  const exposedCount = (s: FloodScenario, d = data) => summarizeTransit(d, opt(s)).find((v) => v.label === '浸水が想定される区域の駅')?.value;
  it('駅のうち、区域内の駅の数（想定に従う）', () => {
    expect(summarizeTransit(data, opt('max'))[0]).toEqual({ label: '駅', value: 5, unit: '駅' });
    expect(exposedCount('max')).toBe(3);
    expect(exposedCount('river')).toBe(2);
    expect(exposedCount('tide')).toBe(2);
  });
  it('円で切り出しても、判定は切り出さない全体の浸水の格子で行う（円の縁の駅も同じ結果）', () => {
    const sub = subsetTransit(data, 300, 150, 100); // 甲（250,150）・乙（350,150）が円の中
    expect(sub.flood).toBe(data.flood);
    expect(sub.stations.features.map((f) => f.properties.name)).toEqual(['甲', '乙']);
    expect(exposedCount('max', sub)).toBe(2);
    expect(exposedCount('tide', sub)).toBe(1);
    expect([...transitExposure(sub, 'max')!.stationExposed]).toEqual([1, 1]);
  });
  it('浸水の格子がないときは、この行を出さない', () => {
    expect(exposedCount('max', transitWith(null))).toBeUndefined();
  });
});

describe('断面', () => {
  const data = transitWith(grid());
  const line: SectionLine = { ax: 0, ay: 120, bx: 400, by: 120 };
  const colors = { rail: [1, 1, 1] as [number, number, number], station: [2, 2, 2] as [number, number, number], railExposed: [3, 3, 3] as [number, number, number], stationExposed: [4, 4, 4] as [number, number, number] };
  it('駅・交差に exposed を付け、区域内の色にする（想定に従う）', () => {
    const [rails, stations] = sectionTransit(data, line, colors, 'max');
    // 線（y = 120）は 南北線（x = 50）と交わる。x = 50 は区域外
    expect(rails.marks.map((m) => [m.x, m.exposed, m.color])).toEqual([[50, false, [1, 1, 1]]]);
    // 線から 500 m 以内の駅（y = 120 から、東西線 y = 150 上の駅は 30 m、丁は 70 m）
    const byName = Object.fromEntries(stations.marks.map((m) => [m.name, m]));
    expect(byName['甲'].exposed).toBe(true);
    expect(byName['甲'].color).toEqual([4, 4, 4]);
    expect(byName['丙'].exposed).toBe(false);
    expect(byName['丙'].color).toEqual([2, 2, 2]);
    const [, tideStations] = sectionTransit(data, line, colors, 'tide');
    expect(tideStations.marks.find((m) => m.name === '乙')!.exposed).toBe(false);
  });
  it('東西に切る線：東西線との交差は、線の位置が区域内なら区域の色', () => {
    const [rails] = sectionTransit(data, { ax: 300, ay: 0, bx: 300, by: 200 }, colors, 'max');
    expect(rails.marks.map((m) => [m.exposed, m.color])).toEqual([[true, [3, 3, 3]]]);
  });
  it('scenario を渡さない・浸水の格子がないときは、exposed を付けず、これまでの色', () => {
    const [r1, s1] = sectionTransit(data, line, colors);
    expect([...r1.marks, ...s1.marks].every((m) => m.exposed === undefined && (m.color[0] === 1 || m.color[0] === 2))).toBe(true);
    const [r2, s2] = sectionTransit(transitWith(null), line, colors, 'max');
    expect([...r2.marks, ...s2.marks].every((m) => m.exposed === undefined)).toBe(true);
  });
  it('レイヤーの section は、options の想定に従う', () => {
    const tracks = transit.section(data, line, opt('tide')) as ReturnType<typeof sectionTransit>;
    expect(tracks[1].marks.find((m) => m.name === '乙')!.exposed).toBe(false);
    expect(tracks[1].marks.find((m) => m.name === '甲')!.color).toEqual(TRANSIT_COLORS.stationExposed);
  });
});
