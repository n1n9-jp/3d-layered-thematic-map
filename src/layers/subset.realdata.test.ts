/**
 * 実データ（public/data/）での、円の切り出しの所要時間と集計の確認。
 * ブラウザの外（Node）で動く。`npx vitest run src/layers/subset.realdata.test.ts --silent=false` で、表が標準出力に出る
 * （`--silent=false` を付けないと、成功したテストの標準出力は出ない）。
 *
 * - 各レイヤーの本物の `load` を使う（fetch だけを、ファイルを読む代用品に差し替える）。
 * - ブラウザにしか無い `ImageData` は、データを持つだけの代用品に差し替える。実際のブラウザでは
 *   `new ImageData(pixels, w, h)` は画素列を包むだけなので、標高の画像づくりの時間は「画素列の生成
 *   （elevationPixels）」で測れる。その時間は標高の内訳として別に出す。
 * - 「初回」はそのプロセスで最初の1回（JIT 前）、「中央値」は続けて 9 回測った中央値。
 * - 集計の値は、生の GeoJSON から別の方法（円の中の点を数える、など）で求め直して照合する。
 */
import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { beforeAll, describe, expect, it } from 'vitest';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { subsetGrid } from '../lib/gridSubset';
import type { ElevationData, FacilityCollection, PopulationCollection, ProbeValue, RoadCollection, StationCollection } from '../types';
import { elevationPixels } from './elevation/color';
import { registry } from './index';

const DIR = 'public/data/';
const HAS_DATA = existsSync(`${DIR}elevation.bin`) && existsSync(`${DIR}roads.geojson`);

/** 東京駅（README の座標）。 */
const CX = 1550;
const CY = 130;
const RADII = [1000, 2000, 5000];

const json = <T>(name: string) => JSON.parse(readFileSync(`${DIR}${name}`, 'utf8')) as T;
const inCircle = (x: number, y: number, r: number) => (x - CX) ** 2 + (y - CY) ** 2 <= r * r;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (t: number) => t.toFixed(2).padStart(8);
const val = (rows: ProbeValue[], label: string) => rows.find((r) => r.label === label)?.value;

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const out = fn();
  return [out, performance.now() - t0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = {} as Record<LayerId, any>;

describe.skipIf(!HAS_DATA)('実データでの subset / summarize（東京駅 x=1550, y=130）', () => {
  beforeAll(async () => {
    (globalThis as { ImageData?: unknown }).ImageData ??= class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    };
    // load が呼ぶ fetch を、ファイルを読むものに差し替える
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = String(url);
      return new Response(readFileSync(path));
    }) as typeof fetch;
    for (const id of LAYER_IDS) data[id] = await registry[id].load(DIR);
  });

  // 初回の測定。radii を昇順に、全レイヤーを1回ずつ測る（これがそのプロセスの最初の呼び出し）。
  const first: Record<string, Record<LayerId, number>> = {};
  const warm: Record<string, Record<LayerId, number>> = {};
  const summaries: Record<string, Record<LayerId, ProbeValue[]>> = {};
  const subsets: Record<string, Record<LayerId, unknown>> = {};
  const elevationSplit: Record<string, { grid: number; pixels: number }> = {};

  it('全レイヤーを切り出して集計する（所要時間を表示）', () => {
    for (const r of RADII) {
      const key = String(r);
      first[key] = {} as Record<LayerId, number>;
      warm[key] = {} as Record<LayerId, number>;
      summaries[key] = {} as Record<LayerId, ProbeValue[]>;
      subsets[key] = {} as Record<LayerId, unknown>;
      for (const id of LAYER_IDS) {
        const m = registry[id];
        const [sub, tSub] = time(() => m.subset(data[id], CX, CY, r));
        const [sum, tSum] = time(() => m.summarize(sub));
        first[key][id] = tSub + tSum;
        subsets[key][id] = sub;
        summaries[key][id] = sum;
        const runs: number[] = [];
        for (let i = 0; i < 9; i++) runs.push(time(() => m.summarize(m.subset(data[id], CX, CY, r)))[1]);
        warm[key][id] = median(runs);
      }
      const gridRuns: number[] = [];
      const pixRuns: number[] = [];
      for (let i = 0; i < 9; i++) {
        const [g, tg] = time(() => subsetGrid(data.elevation as ElevationData, CX, CY, r));
        gridRuns.push(tg);
        pixRuns.push(time(() => elevationPixels(g.values))[1]);
      }
      elevationSplit[key] = { grid: median(gridRuns), pixels: median(pixRuns) };
    }

    const lines: string[] = ['', '東京駅 (x=1550, y=130) を中心にした切り出し + 集計の所要時間（ms）', ''];
    lines.push('半径        ' + LAYER_IDS.map((id) => id.padStart(12)).join('') + '        合計');
    for (const [label, tbl] of [['初回', first], ['中央値', warm]] as const) {
      for (const r of RADII) {
        const row = tbl[String(r)];
        const total = LAYER_IDS.reduce((a, id) => a + row[id], 0);
        lines.push(`${label.padEnd(3)}${String(r / 1000).padStart(2)}km ` + LAYER_IDS.map((id) => ms(row[id]).padStart(12)).join('') + ms(total).padStart(12));
      }
    }
    lines.push('', '標高の内訳（中央値、ms）：格子の切り出し / 画素列の生成（ブラウザでは ImageData が包むだけ）');
    for (const r of RADII) lines.push(`  ${r / 1000}km  ${ms(elevationSplit[String(r)].grid)} / ${ms(elevationSplit[String(r)].pixels)}`);
    lines.push('', '集計の結果');
    for (const r of RADII) {
      lines.push(`半径 ${r / 1000}km`);
      for (const id of LAYER_IDS)
        lines.push(`  ${id.padEnd(11)}` + summaries[String(r)][id].map((v) => `${v.label}=${v.value ?? '—'}${v.unit ? ' ' + v.unit : ''}`).join(' / '));
    }
    console.log(lines.join('\n'));

    // 余裕をもった上限（100ms の目標は表で確認する。ここは遅い環境での誤検出を避ける）
    const total2 = LAYER_IDS.reduce((a, id) => a + warm['2000'][id], 0);
    expect(total2).toBeLessThan(250);
  });

  it('施設：円の中の点を数えた値と一致する', () => {
    const fac = json<FacilityCollection>('facilities.geojson');
    for (const r of RADII) {
      const n = (kind: string) => fac.features.filter((f) => f.properties.kind === kind && inCircle(f.geometry.coordinates[0], f.geometry.coordinates[1], r)).length;
      const s = summaries[String(r)].facilities;
      expect(val(s, '学校')).toBe(n('school'));
      expect(val(s, '病院')).toBe(n('hospital'));
    }
  });

  it('公共交通：駅の数（同名は1つ）が、円の中の駅を数えた値と一致する', () => {
    const st = json<StationCollection>('stations.geojson');
    for (const r of RADII) {
      const names = new Set(st.features.filter((f) => inCircle(f.geometry.coordinates[0], f.geometry.coordinates[1], r)).map((f) => f.properties.name));
      expect(val(summaries[String(r)].transit, '駅')).toBe(names.size);
      expect(names.size).toBeGreaterThan(0);
    }
  });

  it('人口：合計が、生データのメッシュ（中心が円の中）の合計と一致し、密度 × 円の面積とおおむね合う', () => {
    const pop = json<PopulationCollection>('population.geojson');
    for (const r of RADII) {
      let sum = 0;
      for (const f of pop.features) {
        const ring = f.geometry.coordinates[0].slice(0, 4);
        const x = ring.reduce((a, p) => a + p[0], 0) / 4;
        const y = ring.reduce((a, p) => a + p[1], 0) / 4;
        if (inCircle(x, y, r)) sum += f.properties.population;
      }
      const s = summaries[String(r)].population;
      expect(val(s, '人口')).toBe(sum);
      const density = val(s, '人口密度') as number;
      const circleKm2 = (Math.PI * r * r) / 1e6;
      const ratio = (density * circleKm2) / sum;
      console.log(`半径 ${r / 1000}km：人口密度 × 円の面積 / 人口の合計 = ${ratio.toFixed(3)}`);
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    }
  });

  it('道路：半径を大きくすると延長が面積に近い割合で増える。内訳の合計が合計と合う', () => {
    const km = (r: number) => val(summaries[String(r)].roads, '道路の延長') as number;
    const [a, b, c] = [km(1000), km(2000), km(5000)];
    // 面積は半径の2乗（2倍で4倍、2→5 km で 6.25 倍）。東京駅の周りは、皇居（大きな道路が無い）と東京湾（海）が
    // 円に入るので、道路の延長は面積ほどは増えない（2 倍で 3.3 倍ほど、2→5 km で 3.5 倍ほど）。
    console.log(`道路の延長：1km=${a}、2km=${b}（${(b / a).toFixed(2)} 倍）、5km=${c}（${(c / b).toFixed(2)} 倍、面積比 6.25）`);
    expect(b / a).toBeGreaterThan(2.5);
    expect(b / a).toBeLessThan(5);
    expect(c).toBeGreaterThan(b);
    for (const r of RADII) {
      const total = val(summaries[String(r)].roads, '道路の延長') as number;
      const parts = [...String(val(summaries[String(r)].roads, '内訳')).matchAll(/ (\d+\.\d)/g)].map((m) => Number(m[1]));
      expect(parts).toHaveLength(4);
      expect(Math.abs(parts.reduce((x, y) => x + y, 0) - total)).toBeLessThan(0.25);
    }
  });

  it('道路：円で切った延長が、生データの線分のうち中点が円の中にあるものの合計（円で切らない別の近似）と合う', () => {
    const fc = json<RoadCollection>('roads.geojson');
    for (const r of RADII) {
      let m = 0;
      for (const f of fc.features) {
        const c = f.geometry.coordinates;
        for (let i = 0; i + 1 < c.length; i++) {
          const mx = (c[i][0] + c[i + 1][0]) / 2;
          const my = (c[i][1] + c[i + 1][1]) / 2;
          if (inCircle(mx, my, r)) m += Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]);
        }
      }
      const km = val(summaries[String(r)].roads, '道路の延長') as number;
      console.log(`道路の延長（半径 ${r / 1000}km）：円で切った値 ${km} km、線分の中点が円の中のものの合計 ${(m / 1000).toFixed(1)} km`);
      expect(Math.abs(km - m / 1000) / km).toBeLessThan(0.03);
    }
  });

  it('標高：最小〜最大と平均が、生の格子から求めた値と一致する', () => {
    const e = data.elevation as ElevationData;
    for (const r of RADII) {
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let n = 0;
      for (let row = 0; row < e.height; row++) {
        for (let col = 0; col < e.width; col++) {
          const v = e.values[row * e.width + col];
          if (Number.isNaN(v)) continue;
          if (inCircle(e.minX + (col + 0.5) * e.cellSize, e.maxY - (row + 0.5) * e.cellSize, r)) {
            min = Math.min(min, v);
            max = Math.max(max, v);
            sum += v;
            n++;
          }
        }
      }
      const f1 = (v: number) => (Math.round(v * 10) / 10 + 0).toFixed(1);
      const s = summaries[String(r)].elevation;
      expect(val(s, '標高')).toBe(`${f1(min)}〜${f1(max)}`);
      expect(val(s, '平均')).toBe(Math.round((sum / n) * 10) / 10);
    }
  });
});
