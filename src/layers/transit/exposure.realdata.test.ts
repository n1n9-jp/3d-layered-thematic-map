/**
 * 実データで、公共交通の「浸水が想定される区域」の判定を、浸水の格子（bin）を直接読んだ値と突き合わせる。
 * 判定のコード（`exposure.ts`）は使わず、bin のバイトから、想定ごとの深さのランクを自分で読む。
 * public/data がないとき（取得前の環境）は飛ばす。
 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { FLOOD_SCENARIOS } from '../../config';
import type { FloodScenario } from '../../config';
import type { Position } from '../../types';
import transit from '../transit';
import type { TransitData } from '../transit';
import { summarizeTransit } from '../transitModel';
import { EXPOSED_MIN_DEPTH, transitExposure } from './exposure';

const DIR = 'public/data/';
const HAS_DATA = ['flood.json', 'flood-river.bin', 'flood-tide.bin', 'flood-river-duration.bin', 'flood-tide-duration.bin', 'rail.geojson', 'stations.geojson'].every((f) => existsSync(`${DIR}${f}`));

let data: TransitData;
const meta = HAS_DATA ? (JSON.parse(readFileSync(`${DIR}flood.json`, 'utf8')) as { width: number; height: number; cellSize: number; minX: number; maxY: number; depthRanks: { rank: number; minM: number }[] }) : null;
const river = HAS_DATA ? readFileSync(`${DIR}flood-river.bin`) : null;
const tide = HAS_DATA ? readFileSync(`${DIR}flood-tide.bin`) : null;

/** bin を直接読んだ、地点の深さのランク。想定が洪水なら洪水、高潮なら高潮、大きいほうなら大きいほう。23区の外・格子の外は null。 */
function rawRank(scenario: FloodScenario, x: number, y: number): number | null {
  const m = meta!;
  const col = Math.floor((x - m.minX) / m.cellSize);
  const row = Math.floor((m.maxY - y) / m.cellSize);
  if (col < 0 || col >= m.width || row < 0 || row >= m.height) return null;
  const r = river![row * m.width + col];
  const t = tide![row * m.width + col];
  if (scenario === 'river') return r === 255 ? null : r;
  if (scenario === 'tide') return t === 255 ? null : t;
  return r === 255 || t === 255 ? null : Math.max(r, t);
}
/** 深さのランクが、0.5m 以上か。ランクの表（flood.json の depthRanks の minM）から読む。 */
const MIN_RANK = HAS_DATA ? meta!.depthRanks.find((d) => d.minM >= EXPOSED_MIN_DEPTH)!.rank : 0;
const rawExposed = (scenario: FloodScenario, x: number, y: number) => {
  const k = rawRank(scenario, x, y);
  return k !== null && k >= MIN_RANK;
};

describe.skipIf(!HAS_DATA)('実データ：公共交通の区域の判定を、浸水の格子の直接の読みと突き合わせる', () => {
  beforeAll(async () => {
    (globalThis as { ImageData?: unknown }).ImageData ??= class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    };
    globalThis.fetch = (async (url: string | URL | Request) => new Response(readFileSync(String(url)))) as typeof fetch;
    data = await transit.load(DIR);
  });

  it('load が、浸水の格子を付ける', () => {
    expect(data.flood).toBeTruthy();
    expect(MIN_RANK).toBe(2); // 「0.5〜3m」
  });

  for (const scenario of FLOOD_SCENARIOS) {
    it(`${scenario}：全駅（${'696'}）の区域内・外が、直接読んだ値と一致する`, () => {
      const e = transitExposure(data, scenario)!;
      let inside = 0;
      data.stationPoints.forEach(([x, y], i) => {
        const want = rawExposed(scenario, x, y);
        if (want) inside++;
        expect(e.stationExposed[i] === 1, `${data.stations.features[i].properties.name} (${x}, ${y})`).toBe(want);
      });
      expect(e.exposedStations.length).toBe(inside);
      expect(e.exposedStations.length + e.otherStations.length).toBe(data.stationPoints.length);
      // 駅の名前で数えた数（クローズアップの集計と同じ数え方）
      const names = new Set(data.stations.features.map((f) => f.properties.name));
      const exposedNames = new Set(data.stations.features.filter((_, i) => e.stationExposed[i] === 1).map((f) => f.properties.name));
      console.log(`[exposure] ${scenario}: 区域内の駅 ${inside} / ${data.stationPoints.length}（駅名で ${exposedNames.size} / ${names.size}）`);
      const s = summarizeTransit(data, { floodScenario: scenario });
      expect(s.find((v) => v.label === '浸水が想定される区域の駅')?.value).toBe(exposedNames.size);
    });

    it(`${scenario}：路線の区間は、区間の中を細かく標本にしたどの点も、区間の種類と一致する。長さの合計は路線全体と同じ`, () => {
      const e = transitExposure(data, scenario)!;
      let bad = 0;
      let n = 0;
      const lenOf = (p: Position[]) => p.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
      const check = (paths: Position[][], want: boolean) => {
        for (const p of paths)
          for (let i = 0; i + 1 < p.length; i++) {
            const [ax, ay] = p[i];
            const [bx, by] = p[i + 1];
            const len = Math.hypot(bx - ax, by - ay);
            const steps = Math.max(1, Math.ceil(len / 10));
            for (let k = 0; k < steps; k++) {
              const t = (k + 0.5) / steps; // 小区間の中点（セルの境目の上は避ける）
              n++;
              if (rawExposed(scenario, ax + (bx - ax) * t, ay + (by - ay) * t) !== want) bad++;
            }
          }
      };
      check(e.exposedPaths, true);
      check(e.otherPaths, false);
      const total = [...e.exposedPaths, ...e.otherPaths].reduce((a, p) => a + lenOf(p), 0);
      const orig = data.railPaths.reduce((a, p) => a + lenOf(p), 0);
      const exposedLen = e.exposedPaths.reduce((a, p) => a + lenOf(p), 0);
      console.log(`[exposure] ${scenario}: 区域の路線 ${(exposedLen / 1000).toFixed(1)} km / ${(orig / 1000).toFixed(1)} km、標本 ${n} 点、不一致 ${bad}、区間 ${e.exposedPaths.length} + ${e.otherPaths.length} 本`);
      expect(total).toBeCloseTo(orig, 3);
      // 区切りは格子のセルの境目で行うので、標本はすべて一致する
      expect(bad).toBe(0);
    });
  }

  it('判定の計算時間（読み込み時に作る。3つの想定を新しく計算する）', () => {
    const fresh: TransitData = { ...data };
    const t0 = performance.now();
    for (const s of FLOOD_SCENARIOS) transitExposure(fresh, s);
    console.log(`[exposure] 3想定の判定（路線の区切りと駅。浸水の印は共有済み）: ${(performance.now() - t0).toFixed(1)} ms`);
  });
});
