/**
 * 実データ（public/data/）での、対応の線の関係の確認。ブラウザの外（Node）で動く。
 * `npx vitest run src/links/links.realdata.test.ts --silent=false` で、要約の値が標準出力に出る。
 * 関係は、生の GeoJSON から総当たりで求め直した値と照合する（索引を使わない）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LAYER_IDS } from '../config';
import { registry } from '../layers';
import type { DataKey, LayerStatus } from '../store';
import type { FacilityCollection, PopulationCollection, StationCollection } from '../types';
import { computeLinks } from './compute';
import { describeFacilityStation, describeStationPopulation } from './linksModel';

const DIR = 'public/data/';
const HAS_DATA = existsSync(`${DIR}facilities.geojson`) && existsSync(`${DIR}elevation.bin`);
const json = <T>(name: string) => JSON.parse(readFileSync(`${DIR}${name}`, 'utf8')) as T;

const CASES = [
  { name: '東京駅 2km', x: 1550, y: 130, r: 2000 },
  { name: '世田谷区 1km', x: -10000, y: -3000, r: 1000 },
  { name: '東京駅 5km', x: 1550, y: 130, r: 5000 },
];

describe.skipIf(!HAS_DATA)('実データでの対応の線', () => {
  it.each(CASES)('$name：総当たりと一致し、要約が線と合う', async (c) => {
    (globalThis as { ImageData?: unknown }).ImageData ??= class {};
    globalThis.fetch = (async (url: string | URL | Request) => new Response(readFileSync(String(url)))) as typeof fetch;
    const data: Partial<Record<DataKey, unknown>> = {};
    const status = { boundary: 'idle' } as Record<DataKey, LayerStatus>;
    for (const id of ['population', 'transit', 'facilities'] as const) {
      data[id] = await registry[id].load(DIR);
      status[id] = 'ready';
    }
    void LAYER_IDS;
    const links = computeLinks(data, status, c);
    const fs = links.facilityStation!;
    const sp = links.stationPopulation!;

    // ---- 生データから総当たり ----
    const facilities = json<FacilityCollection>('facilities.geojson').features.filter(
      (f) => (f.geometry.coordinates[0] - c.x) ** 2 + (f.geometry.coordinates[1] - c.y) ** 2 <= c.r * c.r,
    );
    const stations = json<StationCollection>('stations.geojson').features;
    // 最寄りの駅の点（総当たり）。
    let reached = 0;
    let sumNearest = 0;
    for (const f of facilities) {
      const [fx, fy] = f.geometry.coordinates;
      let best = Infinity;
      for (const s of stations) best = Math.min(best, Math.hypot(s.geometry.coordinates[0] - fx, s.geometry.coordinates[1] - fy));
      if (best <= 1000) {
        reached++;
        sumNearest += best;
      }
    }
    expect(fs.facilityCount).toBe(facilities.length);
    // 距離と終点は、総当たりの最寄りの駅の点と一致する
    for (const l of fs.links) {
      let best = Infinity;
      for (const s of stations) best = Math.min(best, Math.hypot(s.geometry.coordinates[0] - l.from[0], s.geometry.coordinates[1] - l.from[1]));
      expect(l.distance).toBeCloseTo(best, 9);
      expect(l.distance).toBeLessThanOrEqual(1000);
      expect(Math.hypot(l.to[0] - l.from[0], l.to[1] - l.from[1])).toBeCloseTo(l.distance, 9);
      // 線の終点は、その駅名の駅の点の上にある
      expect(stations.some((s) => s.properties.name === l.station && s.geometry.coordinates[0] === l.to[0] && s.geometry.coordinates[1] === l.to[1])).toBe(true);
    }
    // 線の本数 + 駅なしの施設 = 円の中の施設
    expect(fs.links.length + fs.noStation).toBe(facilities.length);
    // 総当たりで 1 km 以内に駅がある施設には、すべて線がある
    expect(fs.links.length).toBe(reached);
    // 駅の数：円の中に点がある駅名の数（表の「駅」）と同じ
    const namesInCircle = new Set(stations.filter((s) => (s.geometry.coordinates[0] - c.x) ** 2 + (s.geometry.coordinates[1] - c.y) ** 2 <= c.r * c.r).map((s) => s.properties.name));
    expect(sp.links.length).toBe(namesInCircle.size);
    // 駅の直下の人口密度：生のメッシュの多角形（矩形）から総当たりで引く
    const mesh = json<PopulationCollection>('population.geojson').features;
    for (const l of sp.links) {
      const [x, y] = l.at;
      const hits = mesh.filter((m) => {
        const xs = m.geometry.coordinates[0].map((p) => p[0]);
        const ys = m.geometry.coordinates[0].map((p) => p[1]);
        return x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys);
      });
      // メッシュの境界の上にある駅は、隣り合うどちらのメッシュでもよい
      if (hits.length > 0) expect(hits.map((h) => h.properties.density)).toContain(l.density);
      else expect(l.density).toBeNull();
    }
    // 要約が線と合う
    expect(fs.summary.lineCount).toBe(fs.links.length);
    expect(fs.summary.byKind.school + fs.summary.byKind.hospital).toBe(fs.links.length);
    expect(fs.summary.meanDistance).toBeCloseTo(fs.links.reduce((s, l) => s + l.distance, 0) / fs.links.length, 9);
    expect(fs.summary.maxDistance).toBe(Math.max(...fs.links.map((l) => l.distance)));
    expect(sp.summary.lineCount).toBe(sp.links.length);
    expect(fs.summary.meanDistance).toBeCloseTo(sumNearest / reached, 6);

    console.log(`\n[${c.name}] 施設 ${facilities.length} / 駅 ${sp.links.length}`);
    console.log('  施設 → 最寄り駅: ' + describeFacilityStation(fs.summary).join(' / '));
    console.log('  駅 → 直下の人口: ' + describeStationPopulation(sp.summary).join(' / '));
    console.log(`  （総当たり：1km 以内に駅のある施設 ${reached}、その最寄りの駅の点までの平均 ${Math.round(sumNearest / reached)}m）`);
  }, 60000);
});
