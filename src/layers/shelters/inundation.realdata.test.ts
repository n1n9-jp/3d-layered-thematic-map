/**
 * 実データ（public/data/）での、洪水・高潮で使える避難場所の「浸水が想定される区域の中・外」の数。
 * 画面のコード（buildShelterData）の結果を、生の GeoJSON と浸水の格子から別の書き方で数え直した値と突き合わせる。
 * `npx vitest run src/layers/shelters/inundation.realdata.test.ts --silent=false` で、想定ごとの数が出る。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOOD_SCENARIOS } from '../../config';
import type { FloodScenario } from '../../config';
import type { BoundaryData, FacilityCollection, ShelterCollection, ShelterSummary } from '../../types';
import { buildFloodData } from '../flood/model';
import type { FloodMeta } from '../flood/model';
import { buildShelterData, insideCounts, usableSplit } from './model';

const DIR = 'public/data/';
const HAS_DATA = ['flood.json', 'flood-river.bin', 'flood-tide.bin', 'flood-river-duration.bin', 'flood-tide-duration.bin', 'shelters.geojson', 'shelters.json', 'facilities.geojson', 'boundary.geojson'].every((f) => existsSync(`${DIR}${f}`));

const json = <T>(name: string) => JSON.parse(readFileSync(`${DIR}${name}`, 'utf8')) as T;
const bin = (name: string) => {
  const b = readFileSync(`${DIR}${name}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe.skipIf(!HAS_DATA)('実データ：洪水・高潮で使える避難場所の、浸水が想定される区域の中・外', () => {
  const meta = json<FloodMeta>('flood.json');
  const flood = buildFloodData(meta, {
    riverDepth: bin(meta.files.riverDepth),
    tideDepth: bin(meta.files.tideDepth),
    riverDuration: bin(meta.files.riverDuration),
    tideDuration: bin(meta.files.tideDuration),
  });
  const raw = json<ShelterCollection>('shelters.geojson');
  const data = buildShelterData(raw, json<ShelterSummary>('shelters.json'), json<FacilityCollection>('facilities.geojson'), json<BoundaryData>('boundary.geojson'), flood);

  /** 生のランク（洪水・高潮の深さ）から、画面のコードを使わずに数える。ランク 2 以上 = 深さ 0.5m 以上。255 = 23区の外（外にする）。 */
  function direct(scenario: FloodScenario) {
    let out = 0;
    let inn = 0;
    for (const f of raw.features) {
      if (!(f.properties.flood || f.properties.tide)) continue;
      const [x, y] = f.geometry.coordinates;
      const col = Math.floor((x - meta.minX) / meta.cellSize);
      const row = Math.floor((meta.maxY - y) / meta.cellSize);
      const ok = col >= 0 && col < meta.width && row >= 0 && row < meta.height;
      const r = ok ? flood.riverDepth[row * meta.width + col] : 255;
      const t = ok ? flood.tideDepth[row * meta.width + col] : 255;
      const rank = scenario === 'river' ? r : scenario === 'tide' ? t : Math.max(r, t);
      const valid = scenario === 'river' ? r !== 255 : scenario === 'tide' ? t !== 255 : r !== 255 && t !== 255;
      if (valid && rank >= 2) inn++;
      else out++;
    }
    return { out, in: inn };
  }

  it('洪水・高潮で使える避難場所は 672 か所', () => {
    expect(data.points.usable).toHaveLength(672);
  });
  it.each([...FLOOD_SCENARIOS])('想定 %s：外・中の数が、データから直接数えた値と一致する', (scenario) => {
    const got = insideCounts(data, scenario);
    const want = direct(scenario);
    console.log(`[${scenario}] 外 ${got?.out}・中 ${got?.in}（合計 ${(got?.out ?? 0) + (got?.in ?? 0)}）`);
    expect(got).toEqual(want);
    expect(usableSplit(data, scenario).in.length + usableSplit(data, scenario).out.length).toBe(672);
  });
  it('想定ごとの数（2026年10月19日の更新分のデータ）', () => {
    expect(FLOOD_SCENARIOS.map((s) => [s, insideCounts(data, s)])).toEqual([
      // 外には、浸水想定の範囲の外にある 1 か所を含む
      ['max', { out: 468, in: 204 }],
      ['river', { out: 480, in: 192 }],
      ['tide', { out: 569, in: 103 }],
    ]);
  });
});
