import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateFixtures } from './fixtures.mjs';
import {
  GEOJSON_FILES,
  formatReport,
  validateDirectory,
  validateElevation,
  validateFileSizes,
  validateGeoJson,
} from './validate.mjs';

const fixtures = generateFixtures();
const clone = (x) => structuredClone(x);
const messages = (r) => r.violations.map((v) => `${v.where}: ${v.message}`).join('\n');

describe('生成した仮データ', () => {
  it('同じ種から同じデータが生成される', () => {
    const again = generateFixtures();
    expect(JSON.stringify(again.geojson)).toBe(JSON.stringify(fixtures.geojson));
    expect(again.elevation.meta).toEqual(fixtures.elevation.meta);
    expect(again.elevation.bin.equals(fixtures.elevation.bin)).toBe(true);
  });

  it('全 GeoJSON が仕様を満たす', () => {
    for (const name of GEOJSON_FILES) {
      const r = validateGeoJson(name, fixtures.geojson[name]);
      expect(r.violationCount, `${name}\n${messages(r)}`).toBe(0);
    }
  });

  it('標高が仕様を満たす', () => {
    const r = validateElevation(fixtures.elevation.meta, fixtures.elevation.bin);
    expect(r.violationCount, messages(r)).toBe(0);
  });

  it('件数が依頼どおり', () => {
    const g = fixtures.geojson;
    expect(g['boundary.geojson'].features.length).toBeGreaterThanOrEqual(4);
    expect(g['boundary.geojson'].features.length).toBeLessThanOrEqual(6);
    const kinds = g['facilities.geojson'].features.map((f) => f.properties.kind);
    expect(kinds.filter((k) => k === 'school')).toHaveLength(150);
    expect(kinds.filter((k) => k === 'hospital')).toHaveLength(40);
    const classes = new Set(g['roads.geojson'].features.map((f) => f.properties.class));
    expect([...classes].sort()).toEqual(['motorway', 'national', 'other', 'prefectural']);
  });
});

describe('validateGeoJson の違反検出', () => {
  const base = () => clone(fixtures.geojson['roads.geojson']);

  it('FeatureCollection でないものを検出する', () => {
    const json = base();
    json.type = 'Feature';
    expect(validateGeoJson('roads.geojson', json).violationCount).toBe(1);
  });

  it('geometry の型違いを検出する', () => {
    const json = base();
    json.features[0].geometry = { type: 'Point', coordinates: [0, 0] };
    expect(messages(validateGeoJson('roads.geojson', json))).toContain('geometry.type');
  });

  it('整数でない座標を検出する', () => {
    const json = base();
    json.features[0].geometry.coordinates[0] = [0.5, 10];
    expect(messages(validateGeoJson('roads.geojson', json))).toContain('整数');
  });

  it('EXTENT 外の座標を検出する', () => {
    const json = base();
    json.features[0].geometry.coordinates[1] = [17001, 0];
    expect(messages(validateGeoJson('roads.geojson', json))).toContain('EXTENT 外');
  });

  it('z を含む座標を検出する', () => {
    const json = base();
    json.features[0].geometry.coordinates[0] = [0, 0, 5];
    expect(messages(validateGeoJson('roads.geojson', json))).toContain('2要素');
  });

  it('class の語彙違反と properties の欠落を検出する', () => {
    const json = base();
    json.features[0].properties.class = 'highway';
    delete json.features[1].properties.name;
    const text = messages(validateGeoJson('roads.geojson', json));
    expect(text).toContain('class');
    expect(text).toContain('項目 name がない');
  });

  it('kind の語彙違反を検出する', () => {
    const json = clone(fixtures.geojson['facilities.geojson']);
    json.features[0].properties.kind = 'park';
    expect(messages(validateGeoJson('facilities.geojson', json))).toContain('kind');
  });

  it('code が5桁の文字列でないものを検出する', () => {
    const json = clone(fixtures.geojson['boundary.geojson']);
    json.features[0].properties.code = 13101;
    json.features[1].properties.code = '1310';
    expect(validateGeoJson('boundary.geojson', json).violationCount).toBe(2);
  });

  it('population / density の負値・非数を検出する', () => {
    const json = clone(fixtures.geojson['population.geojson']);
    json.features[0].properties.population = -1;
    json.features[1].properties.density = '100';
    expect(validateGeoJson('population.geojson', json).violationCount).toBe(2);
  });

  it('メッシュが4隅でない Polygon を検出する', () => {
    const json = clone(fixtures.geojson['population.geojson']);
    json.features[0].geometry.coordinates[0].splice(1, 1);
    expect(validateGeoJson('population.geojson', json).violationCount).toBeGreaterThan(0);
  });

  it('閉じていないリングを検出する', () => {
    const json = clone(fixtures.geojson['boundary.geojson']);
    const ring = json.features[0].geometry.coordinates[0];
    ring[ring.length - 1] = [1, 1];
    expect(messages(validateGeoJson('boundary.geojson', json))).toContain('閉じていない');
  });
});

describe('validateElevation の違反検出', () => {
  const meta = () => ({ ...fixtures.elevation.meta });
  const bin = () => Buffer.from(fixtures.elevation.bin);

  it('width/height/cellSize/範囲の違いを検出する', () => {
    const m = { ...meta(), width: 700, cellSize: 100, minX: 0 };
    const text = messages(validateElevation(m, bin()));
    expect(text).toContain('width');
    expect(text).toContain('cellSize');
    expect(text).toContain('minX');
  });

  it('bin のバイト数の不一致を検出する', () => {
    const r = validateElevation(meta(), bin().subarray(0, 1000));
    expect(messages(r)).toContain('バイト数');
  });

  it('min / max の不一致を検出する', () => {
    const r = validateElevation({ ...meta(), min: -5, max: 99 }, bin());
    expect(messages(r)).toContain('min が');
    expect(messages(r)).toContain('max が');
  });

  it('有効値がない bin を検出する', () => {
    const empty = Buffer.alloc(720 * 720 * 4);
    for (let i = 0; i < 720 * 720; i++) empty.writeFloatLE(NaN, i * 4);
    expect(messages(validateElevation(meta(), empty))).toContain('有効値');
  });
});

describe('validateFileSizes', () => {
  const MB = 1024 * 1024;
  it('範囲内なら違反なし', () => {
    expect(validateFileSizes([{ name: 'a', size: 10 * MB }, { name: 'b', size: 5 }]).violationCount).toBe(0);
  });
  it('1ファイル 10MB 超と合計 30MB 超を検出する', () => {
    const r = validateFileSizes([
      { name: 'big.bin', size: 10 * MB + 1 },
      { name: 'b', size: 10 * MB },
      { name: 'c', size: 10 * MB },
    ]);
    expect(r.violations.map((v) => v.where)).toEqual(['big.bin', '(合計)']);
  });
});

describe('validateDirectory', () => {
  async function withDir(fn) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'validate-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async function writeAll(dir, { skip = [] } = {}) {
    await mkdir(dir, { recursive: true });
    for (const [name, fc] of Object.entries(fixtures.geojson)) {
      if (!skip.includes(name)) await writeFile(path.join(dir, name), JSON.stringify(fc));
    }
    if (!skip.includes('elevation.json')) await writeFile(path.join(dir, 'elevation.json'), JSON.stringify(fixtures.elevation.meta));
    if (!skip.includes('elevation.bin')) await writeFile(path.join(dir, 'elevation.bin'), fixtures.elevation.bin);
  }

  it('全ファイルが揃っていれば違反なし', () =>
    withDir(async (dir) => {
      await writeAll(dir);
      const report = await validateDirectory(dir, { requireAll: true });
      expect(report.ok, formatReport(report)).toBe(true);
    }));

  it('未作成のファイルは検証対象から外し、--require-all では違反にする', () =>
    withDir(async (dir) => {
      await writeAll(dir, { skip: ['rail.geojson'] });
      const lenient = await validateDirectory(dir);
      expect(lenient.ok).toBe(true);
      expect(lenient.entries.find((e) => e.name === 'rail.geojson').status).toBe('missing');
      const strict = await validateDirectory(dir, { requireAll: true });
      expect(strict.ok).toBe(false);
      expect(formatReport(strict)).toContain('rail.geojson');
    }));

  it('elevation のペアの片方だけがある場合は違反', () =>
    withDir(async (dir) => {
      await writeAll(dir, { skip: ['elevation.bin'] });
      expect((await validateDirectory(dir)).ok).toBe(false);
    }));

  it('壊れた JSON は違反として報告する', () =>
    withDir(async (dir) => {
      await writeAll(dir);
      await writeFile(path.join(dir, 'roads.geojson'), '{not json');
      const report = await validateDirectory(dir);
      expect(report.ok).toBe(false);
      expect(formatReport(report)).toContain('JSON として読めない');
    }));

  it('違反の表示は先頭10件まで', () =>
    withDir(async (dir) => {
      await writeAll(dir);
      const roads = clone(fixtures.geojson['roads.geojson']);
      roads.features.slice(0, 15).forEach((f) => (f.properties.class = 'x'));
      await writeFile(path.join(dir, 'roads.geojson'), JSON.stringify(roads));
      const text = formatReport(await validateDirectory(dir));
      expect(text).toContain('違反 15 件（先頭 10 件を表示）');
      expect(text.split('\n').filter((l) => l.startsWith('      - ')).length).toBe(10);
    }));

  it('存在しないディレクトリは例外', async () => {
    await expect(validateDirectory('/nonexistent-dir-for-test')).rejects.toThrow();
  });
});
