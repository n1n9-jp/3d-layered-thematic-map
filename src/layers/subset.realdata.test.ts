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
import { DEFAULT_OPTIONS, LAYER_IDS } from '../config';
import type { FloodScenario, LayerId } from '../config';
import { subsetGrid } from '../lib/gridSubset';
import type { ElevationData, FacilityCollection, PopulationCollection, ProbeValue, ShelterCollection, StationCollection } from '../types';
import { elevationPixels } from './elevation/color';
import { registry } from './index';

const DIR = 'public/data/';
const HAS_DATA = ['elevation.bin', 'flood.json', 'flood-river.bin', 'flood-tide.bin', 'shelters.geojson', 'shelters.json', 'facilities.geojson'].every((f) => existsSync(`${DIR}${f}`));

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
        const [sum, tSum] = time(() => m.summarize(sub, DEFAULT_OPTIONS));
        first[key][id] = tSub + tSum;
        subsets[key][id] = sub;
        summaries[key][id] = sum;
        const runs: number[] = [];
        for (let i = 0; i < 9; i++) runs.push(time(() => m.summarize(m.subset(data[id], CX, CY, r), DEFAULT_OPTIONS))[1]);
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

  it('避難：避難場所（洪水・高潮で使えるもの・それ以外）と病院の数が、円の中の点を数えた値と一致する', () => {
    const sh = json<ShelterCollection>('shelters.geojson');
    const fac = json<FacilityCollection>('facilities.geojson');
    for (const r of RADII) {
      const inside = sh.features.filter((f) => inCircle(f.geometry.coordinates[0], f.geometry.coordinates[1], r));
      const usable = inside.filter((f) => f.properties.flood || f.properties.tide).length;
      const hospitals = fac.features.filter((f) => f.properties.kind === 'hospital' && inCircle(f.geometry.coordinates[0], f.geometry.coordinates[1], r)).length;
      const s = summaries[String(r)].shelters;
      expect(val(s, '洪水・高潮で使える避難場所')).toBe(usable);
      expect(val(s, 'それ以外の避難場所')).toBe(inside.length - usable);
      expect(val(s, '病院')).toBe(hospitals);
      expect(inside.length + hospitals).toBeGreaterThan(0);
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
      let elderly = 0;
      let unknownCells = 0;
      let unknownPeople = 0;
      for (const f of pop.features) {
        const ring = f.geometry.coordinates[0].slice(0, 4);
        const x = ring.reduce((a, p) => a + p[0], 0) / 4;
        const y = ring.reduce((a, p) => a + p[1], 0) / 4;
        if (!inCircle(x, y, r)) continue;
        sum += f.properties.population;
        if (typeof f.properties.elderly === 'number') elderly += f.properties.elderly;
        else {
          unknownCells++;
          unknownPeople += f.properties.population;
        }
      }
      const s = summaries[String(r)].population;
      expect(val(s, '人口')).toBe(sum);
      // 65歳以上：秘匿されたメッシュ（elderly が null）は合計に入れず、数と総人口を別に出す
      expect(val(s, '65歳以上')).toBe(elderly);
      expect(elderly).toBeLessThan(sum);
      const unknown = val(s, '65歳以上が不明');
      if (unknownCells > 0) expect(unknown).toBe(`${unknownCells} メッシュ（総人口 ${unknownPeople.toLocaleString('ja-JP')} 人）`);
      else expect(unknown).toBeUndefined();
      const density = val(s, '人口密度') as number;
      const circleKm2 = (Math.PI * r * r) / 1e6;
      const ratio = (density * circleKm2) / sum;
      console.log(`半径 ${r / 1000}km：人口密度 × 円の面積 / 人口の合計 = ${ratio.toFixed(3)}`);
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    }
  });

  it('浸水：段ごとの面積の割合が、生の格子（セルの中心が円の中）から数えた値と一致する。深い段が先、浸水なしが最後', () => {
    const meta = json<{ width: number; height: number; cellSize: number; minX: number; maxY: number; depthRanks: { rank: number; label: string }[] }>('flood.json');
    const bin = (name: string) => new Uint8Array(readFileSync(`${DIR}${name}`));
    const river = bin('flood-river.bin');
    const tide = bin('flood-tide.bin');
    const OUTSIDE = 255;
    // 想定ごとの、セルの段（0 = 浸水なし、1〜6 = 深さのランク、null = 23区の外）
    const position: Record<FloodScenario, (r: number, t: number) => number | null> = {
      river: (r) => (r === OUTSIDE ? null : r),
      tide: (_r, t) => (t === OUTSIDE ? null : t),
      max: (r, t) => (r === OUTSIDE || t === OUTSIDE ? null : Math.max(r, t)),
    };
    const percent = (p: number) => (p > 0 && p < 0.05 ? '0.1% 未満' : `${(Math.round(p * 10) / 10).toFixed(1)}%`);
    for (const scenario of ['max', 'river', 'tide'] as const)
      for (const r of RADII) {
        const counts = new Array<number>(7).fill(0);
        let total = 0;
        for (let row = 0; row < meta.height; row++) {
          const y = meta.maxY - (row + 0.5) * meta.cellSize;
          if (Math.abs(y - CY) > r) continue;
          for (let col = 0; col < meta.width; col++) {
            if (!inCircle(meta.minX + (col + 0.5) * meta.cellSize, y, r)) continue;
            const pos = position[scenario](river[row * meta.width + col], tide[row * meta.width + col]);
            if (pos === null) continue;
            counts[pos]++;
            total++;
          }
        }
        const rows = registry.flood.summarize(registry.flood.subset(data.flood, CX, CY, r), { ...DEFAULT_OPTIONS, floodScenario: scenario }) as ProbeValue[];
        const label = (pos: number) => (pos === 0 ? '浸水なし' : meta.depthRanks[pos - 1].label);
        // 深い段から、浸水なしは最後。割合が 0 の段は出さない
        const order = [6, 5, 4, 3, 2, 1, 0].filter((pos) => counts[pos] > 0);
        expect(rows.map((v) => v.label)).toEqual(order.map(label));
        expect(rows.map((v) => v.value)).toEqual(order.map((pos) => percent((100 * counts[pos]) / total)));
        expect(total).toBeGreaterThan(0);
      }
    // 東京駅の周りは、海（東京湾）と皇居などを含み、「浸水なし」の所と浸水する所の両方がある（既定の想定）
    expect(summaries['5000'].flood.length).toBeGreaterThan(1);
  });

  it('浸水：切り出した円の外のセルは、23区の外と同じ扱い（探針は値なし、面積に数えない）', () => {
    const sub = registry.flood.subset(data.flood, CX, CY, 1000);
    expect(registry.flood.sample(sub, CX, CY).some((v) => v.value !== null)).toBe(true);
    expect(registry.flood.sample(sub, CX + 1500, CY).every((v) => v.value === null)).toBe(true);
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
