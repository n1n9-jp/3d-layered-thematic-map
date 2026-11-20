/**
 * 実データ（public/data/）での、断面（`section`）の所要時間と、結果の妥当性の確認。
 * ブラウザの外（Node）で動く。`npx vitest run src/layers/section.realdata.test.ts --silent=false` で、表が標準出力に出る
 * （`--silent=false` を付けないと、成功したテストの標準出力は出ない）。
 *
 * - 各レイヤーの本物の `load` を使う（fetch だけを、ファイルを読む代用品に差し替える）。断面の索引は load が作るので、
 *   所要時間には含まれない（利用者が端点を置く前に済んでいる）。
 * - 「初回」はそのプロセスで最初の1回（JIT 前）、「中央値」は続けて 15 回測った中央値。
 * - 結果は、索引を使わない総当たり、`sample`（探針と同じ参照）、生の GeoJSON から別の方法で求め直して照合する。
 */
import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { beforeAll, describe, expect, it } from 'vitest';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { lineLength, pointAt, projectOnLine, reverseLine } from '../lib/section';
import type {
  ElevationData,
  FacilityCollection,
  RailCollection,
  RoadCollection,
  SectionLine,
  SectionMarks,
  SectionSeries,
  SectionTrack,
  StationCollection,
} from '../types';
import { roundTo1 } from './elevation';
import { registry } from './index';

const DIR = 'public/data/';
const HAS_DATA = existsSync(`${DIR}elevation.bin`) && existsSync(`${DIR}roads.geojson`);

/** 東西の線：世田谷区の西から、江戸川区の東へ（約 29 km）。 */
const EAST_WEST: SectionLine = { ax: -15000, ay: -2000, bx: 14000, by: -2000 };
/** 南北の線：大田区の南から、板橋区・北区の北へ（約 28 km）。 */
const NORTH_SOUTH: SectionLine = { ax: -2000, ay: -15000, bx: -2000, by: 13000 };
const LINES: [string, SectionLine][] = [
  ['東西', EAST_WEST],
  ['南北', NORTH_SOUTH],
];

const json = <T>(name: string) => JSON.parse(readFileSync(`${DIR}${name}`, 'utf8')) as T;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (t: number) => t.toFixed(2).padStart(8);

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const out = fn();
  return [out, performance.now() - t0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = {} as Record<LayerId, any>;

const series = (tracks: SectionTrack[]) => tracks[0] as SectionSeries;
const marksOf = (tracks: SectionTrack[], i = 0) => (tracks[i] as SectionMarks).marks;

/** 系列の、距離 d での値（段の区切りから離れた d で使う）。 */
function valueAt(s: SectionSeries, d: number): number | null | undefined {
  for (let i = 0; i + 1 < s.points.length; i++) {
    const p = s.points[i];
    const q = s.points[i + 1];
    if (p.d + 1e-6 < d && d < q.d - 1e-6 && p.value === q.value) return p.value;
  }
  return undefined;
}

/** 総当たり：折れ線の集まりと線の交点の数（折れ線の各線分は始点を含み終点を除く。最後の線分だけ終点も含む）。 */
function bruteCrossings(paths: readonly (readonly (readonly [number, number])[])[], line: SectionLine): number {
  const rx = line.bx - line.ax;
  const ry = line.by - line.ay;
  let n = 0;
  for (const path of paths)
    for (let i = 0; i + 1 < path.length; i++) {
      const sx = path[i + 1][0] - path[i][0];
      const sy = path[i + 1][1] - path[i][1];
      const den = rx * sy - ry * sx;
      if (den === 0) continue;
      const qx = path[i][0] - line.ax;
      const qy = path[i][1] - line.ay;
      const t = (qx * sy - qy * sx) / den;
      const u = (qx * ry - qy * rx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && (u < 1 || (u === 1 && i + 2 === path.length))) n++;
    }
  return n;
}

describe.skipIf(!HAS_DATA)('実データでの section（東西・南北の2本の線）', () => {
  beforeAll(async () => {
    (globalThis as { ImageData?: unknown }).ImageData ??= class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    };
    globalThis.fetch = (async (url: string | URL | Request) => new Response(readFileSync(String(url)))) as typeof fetch;
    for (const id of LAYER_IDS) data[id] = await registry[id].load(DIR);
  });

  const results: Record<string, Record<LayerId, SectionTrack[]>> = {};
  const first: Record<string, Record<LayerId, number>> = {};
  const warm: Record<string, Record<LayerId, number>> = {};
  const warmTotal: Record<string, number> = {};

  it('全レイヤーの section を実行する（所要時間と結果の要約を表示）', () => {
    for (const [name, line] of LINES) {
      results[name] = {} as Record<LayerId, SectionTrack[]>;
      first[name] = {} as Record<LayerId, number>;
      warm[name] = {} as Record<LayerId, number>;
      for (const id of LAYER_IDS) {
        const [out, t] = time(() => registry[id].section(data[id], line));
        results[name][id] = out;
        first[name][id] = t;
      }
      // 全レイヤーを続けて呼んだ合計を15回測る（端点のドラッグ中の呼び出しに近い）
      const per: Record<LayerId, number[]> = { elevation: [], population: [], roads: [], transit: [], facilities: [] };
      const totals: number[] = [];
      for (let i = 0; i < 15; i++) {
        let total = 0;
        for (const id of LAYER_IDS) {
          const [, t] = time(() => registry[id].section(data[id], line));
          per[id].push(t);
          total += t;
        }
        totals.push(total);
      }
      for (const id of LAYER_IDS) warm[name][id] = median(per[id]);
      warmTotal[name] = median(totals);
    }

    const out: string[] = ['', '断面（section）の所要時間（ms）', ''];
    out.push('線   ' + '        '.repeat(0) + LAYER_IDS.map((id) => id.padStart(12)).join('') + '        合計');
    for (const [label, tbl] of [['初回', first], ['中央値', warm]] as const)
      for (const [name] of LINES) {
        const row = tbl[name];
        const total = LAYER_IDS.reduce((a, id) => a + row[id], 0);
        out.push(`${name}${label.padEnd(3)}` + LAYER_IDS.map((id) => ms(row[id]).padStart(12)).join('') + ms(total).padStart(12));
      }
    out.push('', '（中央値の合計は、全レイヤーを続けて呼んだ15回の合計の中央値：' + LINES.map(([n]) => `${n} ${warmTotal[n].toFixed(2)} ms`).join('、') + '）');

    for (const [name, line] of LINES) {
      const r = results[name];
      const len = lineLength(line);
      out.push('', `${name}の線（長さ ${(len / 1000).toFixed(2)} km）の結果`);
      const el = series(r.elevation);
      const vals = el.points.map((p) => p.value).filter((v): v is number => v !== null);
      const f = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(1));
      const valid = el.points.filter((p) => p.value !== null);
      out.push(
        `  標高：点 ${el.points.length}、最小 ${f(Math.min(...vals))} m、最大 ${f(Math.max(...vals))} m、始点 ${f(el.points[0].value)} m、終点 ${f(el.points[el.points.length - 1].value)} m、値なし ${el.points.length - vals.length} 点`,
      );
      out.push(`        値のある最初の点 d=${valid[0].d} で ${f(valid[0].value)} m、値のある最後の点 d=${valid[valid.length - 1].d} で ${f(valid[valid.length - 1].value)} m`);
      const pop = series(r.population);
      const dens = pop.points.map((p) => p.value).filter((v): v is number => v !== null);
      out.push(`  人口密度：点 ${pop.points.length}、最大 ${Math.max(...dens).toLocaleString('en-US')} 人/km²、値なしの区間 ${pop.points.filter((p, i) => p.value === null && i % 2 === 0).length} 個`);
      const byClass: Record<string, number> = {};
      for (const k of marksOf(r.roads)) byClass[k.category] = (byClass[k.category] ?? 0) + 1;
      out.push(`  道路との交差：計 ${marksOf(r.roads).length}（${Object.entries(byClass).map(([c, n]) => `${c} ${n}`).join('、')}）`);
      out.push(`  路線との交差：${marksOf(r.transit, 0).length}`);
      out.push(`  近くの駅：${marksOf(r.transit, 1).length}`);
      const sch = marksOf(r.facilities).filter((k) => k.category === 'school').length;
      out.push(`  近くの施設：${marksOf(r.facilities).length}（学校 ${sch}、病院 ${marksOf(r.facilities).length - sch}）`);
    }
    console.log(out.join('\n'));

    // 完了条件：全レイヤー合計 30 ms 以内（続けて呼んだ中央値）
    for (const [name] of LINES) expect(warmTotal[name]).toBeLessThan(30);
  });

  it('標高：東西の線で、西の端が 30 m 以上、東の端が 2 m 以下。線上の数点で sample と一致する', () => {
    // 東西の線の両端の点は、どちらも 23区の外（データなし）。値のある点のうち、いちばん西と東の点で見る
    const el = series(results['東西'].elevation);
    expect(el.points[0].value).toBeNull();
    expect(el.points[el.points.length - 1].value).toBeNull();
    const valid = el.points.filter((p) => p.value !== null);
    expect(valid[0].value!).toBeGreaterThanOrEqual(30);
    expect(valid[valid.length - 1].value!).toBeLessThanOrEqual(2);
    for (const [name, line] of LINES) {
      const s = series(results[name].elevation);
      expect(s.points[0].d).toBe(0);
      expect(s.points[s.points.length - 1].d).toBeCloseTo(lineLength(line), 6);
      let checked = 0;
      for (const p of s.points.filter((_, i) => i % 11 === 0)) {
        const { x, y } = pointAt(line, p.d);
        const v = registry.elevation.sample(data.elevation, x, y)[0].value;
        expect(p.value === null ? null : roundTo1(p.value)).toBe(v);
        checked++;
      }
      expect(checked).toBeGreaterThan(90);
    }
  });

  it('標高：生の格子を、線上の点のセルから直接引いた値と全点で一致する', () => {
    const e = data.elevation as ElevationData;
    for (const [name, line] of LINES)
      for (const p of series(results[name].elevation).points) {
        const { x, y } = pointAt(line, p.d);
        const col = Math.floor((x - e.minX) / e.cellSize);
        const row = Math.floor((e.maxY - y) / e.cellSize);
        const raw = col < 0 || col >= e.width || row < 0 || row >= e.height ? NaN : e.values[row * e.width + col];
        expect(p.value).toBe(Number.isNaN(raw) ? null : raw);
      }
  });

  it('人口：線上の数点（段の区切りを除く）で、sample の人口密度と一致する', () => {
    for (const [name, line] of LINES) {
      const s = series(results[name].population);
      const len = lineLength(line);
      let checked = 0;
      let populated = 0;
      for (let k = 1; k < 600; k++) {
        const d = (len * k) / 600;
        const v = valueAt(s, d);
        if (v === undefined) continue;
        const { x, y } = pointAt(line, d);
        const sampled = registry.population.sample(data.population, x, y).find((r) => r.label === '人口密度')?.value ?? null;
        expect(v).toBe(sampled);
        checked++;
        if (v !== null && v > 0) populated++;
      }
      expect(checked).toBeGreaterThan(550);
      expect(populated).toBeGreaterThan(200);
      // 段の端は、始点 0 と終点（長さ）に届き、d は単調に増える
      expect(s.points[0].d).toBe(0);
      expect(s.points[s.points.length - 1].d).toBeCloseTo(len, 6);
      for (let i = 1; i < s.points.length; i++) expect(s.points[i].d).toBeGreaterThanOrEqual(s.points[i - 1].d);
    }
  });

  it('道路：交点の数が、索引を使わない総当たりと一致し、交点は線の上にも道路の上にもある', () => {
    const roads = data.roads as { lines: { path: [number, number][] }[]; segIndex: { nearest(x: number, y: number, m?: number): { distance: number } | null } };
    for (const [name, line] of LINES) {
      const marks = marksOf(results[name].roads);
      expect(marks.length).toBe(bruteCrossings(roads.lines.map((l) => l.path), line));
      expect(marks.length).toBeGreaterThan(30);
      for (const k of marks) {
        const pr = projectOnLine(line, k.x, k.y)!;
        expect(Math.abs(pr.offset)).toBeLessThan(1e-6); // 線の上
        expect(k.d).toBeCloseTo(pr.d, 6);
        expect(roads.segIndex.nearest(k.x, k.y, 1)!.distance).toBeLessThan(1e-6); // 道路の上
        expect(k.offset).toBe(0);
      }
      for (let i = 1; i < marks.length; i++) expect(marks[i].d).toBeGreaterThanOrEqual(marks[i - 1].d);
    }
    // 生の GeoJSON からも数える（道路の種別ごと）
    const fc = json<RoadCollection>('roads.geojson');
    for (const [name, line] of LINES)
      for (const cls of ['motorway', 'national', 'prefectural', 'other'] as const) {
        const raw = bruteCrossings(fc.features.filter((f) => f.properties.class === cls).map((f) => f.geometry.coordinates), line);
        expect(marksOf(results[name].roads).filter((k) => k.category === cls)).toHaveLength(raw);
      }
  });

  it('公共交通：路線との交点の数が総当たりと一致し、交点は線の上にある。駅は総当たりと一致する', () => {
    const rail = json<RailCollection>('rail.geojson');
    const st = json<StationCollection>('stations.geojson');
    for (const [name, line] of LINES) {
      const rails = marksOf(results[name].transit, 0);
      expect(rails.length).toBe(bruteCrossings(rail.features.map((f) => f.geometry.coordinates), line));
      expect(rails.length).toBeGreaterThan(5);
      for (const k of rails) {
        expect(Math.abs(projectOnLine(line, k.x, k.y)!.offset)).toBeLessThan(1e-6);
        expect(k.category).toBe('rail');
        expect(k.name).toBeTruthy();
      }
      // 駅：全件を調べる。同じ駅名は、線にいちばん近い1つ
      const len = lineLength(line);
      const best = new Map<string, number>();
      for (const f of st.features) {
        const [px, py] = f.geometry.coordinates;
        const dx = line.bx - line.ax;
        const dy = line.by - line.ay;
        const along = ((px - line.ax) * dx + (py - line.ay) * dy) / len;
        const off = (dx * (py - line.ay) - dy * (px - line.ax)) / len;
        if (along < 0 || along > len || Math.abs(off) > 500) continue;
        const cur = best.get(f.properties.name);
        if (cur === undefined || Math.abs(off) < Math.abs(cur)) best.set(f.properties.name, off);
      }
      const stations = marksOf(results[name].transit, 1);
      expect(stations).toHaveLength(best.size);
      expect(stations.length).toBeGreaterThan(5);
      for (const k of stations) {
        expect(k.offset).toBeCloseTo(best.get(k.name!)!, 6);
        expect(Math.abs(k.offset)).toBeLessThanOrEqual(500);
        expect(k.d).toBeGreaterThanOrEqual(0);
        expect(k.d).toBeLessThanOrEqual(len);
      }
    }
  });

  it('施設：数と offset が、全施設の総当たりと一致する', () => {
    const fc = json<FacilityCollection>('facilities.geojson');
    for (const [name, line] of LINES) {
      const len = lineLength(line);
      const expected: { kind: string; name: string; off: number }[] = [];
      for (const f of fc.features) {
        const [px, py] = f.geometry.coordinates;
        const dx = line.bx - line.ax;
        const dy = line.by - line.ay;
        const along = ((px - line.ax) * dx + (py - line.ay) * dy) / len;
        const off = (dx * (py - line.ay) - dy * (px - line.ax)) / len;
        if (along >= 0 && along <= len && Math.abs(off) <= 300) expected.push({ kind: f.properties.kind, name: f.properties.name, off });
      }
      const got = marksOf(results[name].facilities);
      expect(got).toHaveLength(expected.length);
      expect(got.length).toBeGreaterThan(10);
      const key = (kind: string, off: number) => `${kind}:${off.toFixed(4)}`;
      expect(got.map((k) => key(k.category, k.offset)).sort()).toEqual(expected.map((e) => key(e.kind, e.off)).sort());
    }
  });

  it('線の向きを逆にすると、全レイヤーで d が「長さ − d」、offset の符号が逆になり、数は同じ', () => {
    for (const [name, line] of LINES) {
      const len = lineLength(line);
      const rev = reverseLine(line);
      for (const id of ['roads', 'transit', 'facilities'] as const) {
        const r = registry[id].section(data[id], rev);
        r.forEach((track, ti) => {
          const f = (results[name][id][ti] as SectionMarks).marks;
          const g = (track as SectionMarks).marks;
          expect(g).toHaveLength(f.length);
          const norm = (rows: [number, number][]) => rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          const ds = (marks: SectionMarks['marks'], flip: boolean) =>
            norm(marks.map((k) => [Math.round(((flip ? len - k.d : k.d) + 0) * 1e3) / 1e3, Math.round((flip ? -k.offset : k.offset) * 1e3) / 1e3 + 0] as [number, number]));
          expect(ds(g, false)).toEqual(ds(f, true));
        });
      }
    }
  });
});
