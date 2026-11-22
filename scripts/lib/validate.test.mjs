import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { generateFixtures } from './fixtures.mjs';
import { generateFloodFixture } from './flood-fixture.mjs';
import { FLOOD_FILES } from './flood.mjs';
import { DATA_DIR, ROOT_DIR } from './paths.mjs';
import { createWards } from './wards.mjs';
import {
  ELEVATION_SPEC,
  GEOJSON_FILES,
  formatReport,
  validateDirectory,
  validateElevation,
  validateFileSizes,
  validateFlood,
  validateGeoJson,
} from './validate.mjs';

const run = promisify(execFile);
const fixtures = generateFixtures();
const fixtureWards = createWards(fixtures.geojson['boundary.geojson'].features);
const floodFixture = generateFloodFixture(fixtures.elevation.bin, fixtureWards);
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

  it('標高は区の多角形の内側だけに値があり、外側は NaN', () => {
    const { width, height, cellSize } = ELEVATION_SPEC;
    const view = new DataView(fixtures.elevation.bin.buffer, fixtures.elevation.bin.byteOffset);
    let inside = 0;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const x = -19000 + (col + 0.5) * cellSize;
        const y = 17000 - (row + 0.5) * cellSize;
        const valid = !Number.isNaN(view.getFloat32((row * width + col) * 4, true));
        if (fixtureWards.contains(x, y)) inside += 1;
        expect(valid, `row ${row}, col ${col}`).toBe(fixtureWards.contains(x, y));
      }
    }
    expect(inside).toBeGreaterThan(100_000);
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

  it('地物が0件の FeatureCollection を、全ファイルで違反にする', () => {
    for (const name of GEOJSON_FILES) {
      const r = validateGeoJson(name, { type: 'FeatureCollection', features: [] });
      expect(r.violationCount, name).toBe(1);
      expect(messages(r), name).toContain('0件');
    }
  });

  it('boundary の code の重複を検出する', () => {
    const json = clone(fixtures.geojson['boundary.geojson']);
    expect(validateGeoJson('boundary.geojson', json).violationCount).toBe(0);
    json.features[2].properties.code = json.features[0].properties.code;
    json.features[4].properties.code = json.features[0].properties.code;
    const r = validateGeoJson('boundary.geojson', json);
    expect(r.violationCount).toBe(2);
    expect(messages(r)).toContain('features[2].properties.code');
    expect(messages(r)).toContain('重複');
  });

  it('code の重複検査は boundary だけ（他のファイルの項目には効かない）', () => {
    const json = clone(fixtures.geojson['stations.geojson']);
    json.features[1].properties = { ...json.features[0].properties };
    expect(validateGeoJson('stations.geojson', json).violationCount).toBe(0);
  });

  it('facilities の subtype は空でない文字列が必須（null・空文字・欠落・数値は違反）', () => {
    const json = clone(fixtures.geojson['facilities.geojson']);
    expect(validateGeoJson('facilities.geojson', json).violationCount).toBe(0);
    json.features[0].properties.subtype = null;
    json.features[1].properties.subtype = '';
    delete json.features[2].properties.subtype;
    json.features[3].properties.subtype = 3;
    const r = validateGeoJson('facilities.geojson', json);
    expect(r.violationCount).toBe(4);
    expect(messages(r)).toContain('subtype');
  });

  it('roads の name は null でもよい', () => {
    const json = clone(fixtures.geojson['roads.geojson']);
    json.features[0].properties.name = null;
    expect(validateGeoJson('roads.geojson', json).violationCount).toBe(0);
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

  it('min / max は 0.05m までの差なら通り、それを超えると違反（生成側が丸めて書いても通る）', () => {
    const { min, max } = meta();
    const check = (dMin, dMax) => validateElevation({ ...meta(), min: min + dMin, max: max + dMax }, bin());
    expect(check(0.04, -0.04).violationCount).toBe(0);
    expect(check(-0.05, 0.05).violationCount).toBe(0);
    expect(messages(check(0.06, 0))).toContain('min が');
    expect(check(0.06, 0).violationCount).toBe(1);
    expect(messages(check(0, -0.06))).toContain('max が');
    expect(check(0, -0.06).violationCount).toBe(1);
  });

  describe('区の範囲（セルの中心がどの区にも含まれないのに有効値があるセル）', () => {
    const { width } = ELEVATION_SPEC;
    /** 仕様の格子の (row, col) に値を書く。 */
    const setCell = (b, row, col, value) => b.writeFloatLE(value, (row * width + col) * 4);
    const wards = fixtureWards;

    it('区の外が NaN なら違反なし', () => {
      const r = validateElevation(meta(), bin(), { wards });
      expect(r.violationCount, messages(r)).toBe(0);
      expect(r.summary.join('\n')).toContain('区の外の有効セル: 0');
    });

    it('区の外のセルに値があれば、件数つきで違反にする', () => {
      const b = bin();
      // 左上隅・右下隅・左下隅の3セル（仮の都市の外）に、範囲内の値を入れる
      setCell(b, 0, 0, 10);
      setCell(b, 719, 719, 10);
      setCell(b, 719, 0, 10);
      const r = validateElevation(meta(), b, { wards });
      expect(r.violationCount).toBe(1);
      expect(messages(r)).toContain('3 個');
      expect(r.summary.join('\n')).toContain('区の外の有効セル: 3');
    });

    it('区の内側のセルが NaN でも、この検査では違反にしない', () => {
      const b = bin();
      setCell(b, 360, 380, NaN);
      expect(validateElevation(meta(), b, { wards }).violationCount).toBe(0);
    });

    it('wards を渡さなければこの検査はしない', () => {
      const b = bin();
      setCell(b, 0, 0, 10);
      expect(validateElevation(meta(), b).violationCount).toBe(0);
    });

    it('セルの中心で判定する（セルの一部が区にかかっていても、中心が外なら違反）', () => {
      // x: -100..100, y: -100..100 の正方形の区。中心が (±75, ±75) の4セルは内側、(±125, 0) は外側
      const square = createWards([
        {
          type: 'Feature',
          properties: { code: '13101', name: 'S' },
          geometry: { type: 'Polygon', coordinates: [[[-100, -100], [100, -100], [100, 100], [-100, 100], [-100, -100]]] },
        },
      ]);
      const b = Buffer.alloc(720 * 720 * 4);
      for (let i = 0; i < 720 * 720; i++) b.writeFloatLE(NaN, i * 4);
      const cellAt = (x, y) => [Math.floor((17000 - y) / 50), Math.floor((x + 19000) / 50)];
      for (const [x, y] of [[-75, -75], [-75, 75], [75, -75], [75, 75]]) setCell(b, ...cellAt(x, y), 5);
      const m = { ...meta(), min: 5, max: 5 };
      expect(validateElevation(m, b, { wards: square }).violationCount).toBe(0);
      setCell(b, ...cellAt(125, 0), 5);
      expect(validateElevation(m, b, { wards: square }).violationCount).toBe(1);
    });
  });

  it('有効値がない bin を検出する', () => {
    const empty = Buffer.alloc(720 * 720 * 4);
    for (let i = 0; i < 720 * 720; i++) empty.writeFloatLE(NaN, i * 4);
    expect(messages(validateElevation(meta(), empty))).toContain('有効値');
  });
});

describe('validateFlood（浸水想定の格子）', () => {
  const W = 720;
  const meta = () => clone(floodFixture.meta);
  const bins = () => ({
    riverDepth: Buffer.from(floodFixture.bins.riverDepth),
    tideDepth: Buffer.from(floodFixture.bins.tideDepth),
    riverDuration: Buffer.from(floodFixture.bins.riverDuration),
    tideDuration: Buffer.from(floodFixture.bins.tideDuration),
  });
  const insideIndex = () => {
    for (let i = 0; i < W * W; i++) if (floodFixture.bins.riverDepth[i] !== 255) return i;
    throw new Error('区内のセルがない');
  };
  const outsideIndex = () => floodFixture.bins.riverDepth.indexOf(255);

  it('仮データの浸水想定は、仕様を満たす（区との突き合わせも）', () => {
    const r = validateFlood(meta(), bins(), { wards: fixtureWards });
    expect(r.violationCount, messages(r)).toBe(0);
    expect(r.summary.join('\n')).toContain('flood-river.bin');
    expect(r.summary.join('\n')).toContain('ランク別');
  });

  it('flood.json の項目の違いを検出する（範囲・ランクの表・出典）', () => {
    let m = meta();
    m.width = 360;
    m.minX = 0;
    expect(messages(validateFlood(m, bins()))).toMatch(/width は 720/);
    expect(messages(validateFlood(m, bins()))).toMatch(/minX は -19000/);
    m = meta();
    m.depthRanks.pop();
    expect(messages(validateFlood(m, bins()))).toMatch(/depthRanks は 6 件/);
    m = meta();
    m.durationRanks[2].rank = 9;
    expect(messages(validateFlood(m, bins()))).toMatch(/durationRanks\[2\]\.rank は 3/);
    m = meta();
    m.depthRanks[0].label = '';
    expect(messages(validateFlood(m, bins()))).toMatch(/depthRanks\[0\]\.label/);
    m = meta();
    delete m.sources.tide.attribution;
    expect(messages(validateFlood(m, bins()))).toMatch(/sources\.tide\.attribution/);
    expect(messages(validateFlood(null, bins()))).toMatch(/オブジェクトでない/);
  });

  it('バイト数の不一致を検出する', () => {
    const b = bins();
    b.tideDepth = b.tideDepth.subarray(0, 100);
    expect(messages(validateFlood(meta(), b))).toMatch(/flood-tide\.bin: バイト数は width × height = 518400/);
  });

  it('値の範囲を検出する（浸水深は 6、洪水の継続時間は 7 まで。255 は区の外）', () => {
    const i = insideIndex();
    let b = bins();
    b.riverDepth[i] = 7;
    expect(messages(validateFlood(meta(), b))).toMatch(/flood-river\.bin: 値が 0〜6 と 255.*が 1 個ある/);
    b = bins();
    b.tideDepth[i] = 6; // 範囲内
    b.riverDuration[i] = 7; // 範囲内
    expect(validateFlood(meta(), b).violationCount).toBe(0);
    b.riverDuration[i] = 8;
    expect(messages(validateFlood(meta(), b))).toMatch(/flood-river-duration\.bin: 値が 0〜7/);
    b = bins();
    b.riverDepth[i] = 254;
    expect(validateFlood(meta(), b).violationCount).toBe(1);
  });

  it('区の外が 255 でないセルと、区内が 255 のセルを、区と突き合わせて検出する', () => {
    const b = bins();
    b.riverDepth[outsideIndex()] = 0;
    b.tideDepth[insideIndex()] = 255;
    const r = validateFlood(meta(), b, { wards: fixtureWards });
    expect(messages(r)).toMatch(/flood-river\.bin: セルの中心がどの区にも含まれないのに 255 でないセルが 1 個/);
    expect(messages(r)).toMatch(/flood-tide\.bin: セルの中心が区の中なのに 255 のセルが 1 個/);
    expect(r.violationCount).toBe(2);
    // 区を渡さなければ、この突き合わせはしない
    expect(validateFlood(meta(), b).violationCount).toBe(0);
  });

  it('高潮の浸水継続時間は、最大 5（1週間以上）。6 以上は違反（洪水の継続時間は 7 まで）', () => {
    const i = insideIndex();
    const b = bins();
    b.tideDuration[i] = 5;
    expect(validateFlood(meta(), b, { wards: fixtureWards }).violationCount).toBe(0);
    b.tideDuration[i] = 6;
    expect(messages(validateFlood(meta(), b))).toMatch(/flood-tide-duration\.bin: 値が 0〜5 と 255/);
    b.riverDuration[i] = 7; // 洪水のほうは 7 まで
    expect(validateFlood(meta(), { ...b, tideDuration: floodFixture.bins.tideDuration }).violationCount).toBe(0);
  });

  it('高潮の継続時間のランクの表（tideDurationRanks）と注記・files の食い違いを検出する', () => {
    let m = meta();
    m.tideDurationRanks.push({ rank: 6, label: '2週間〜4週間' });
    expect(messages(validateFlood(m, bins()))).toMatch(/tideDurationRanks は 5 件/);
    m = meta();
    m.tideDurationRanks[4].label = '';
    expect(messages(validateFlood(m, bins()))).toMatch(/tideDurationRanks\[4\]\.label/);
    expect(meta().tideDurationRanks[4]).toMatchObject({ rank: 5, label: '1週間以上' });
    m = meta();
    delete m.tideDurationNote;
    expect(messages(validateFlood(m, bins()))).toMatch(/tideDurationNote/);
    m = meta();
    m.files.tideDuration = null;
    expect(messages(validateFlood(m, bins()))).toMatch(/files\.tideDuration は "flood-tide-duration\.bin" であること/);
  });

  it('必須の格子がなければ違反', () => {
    const b = bins();
    delete b.riverDuration;
    delete b.tideDuration;
    expect(messages(validateFlood(meta(), b))).toMatch(/flood-river-duration\.bin: ファイルがない/);
    expect(messages(validateFlood(meta(), b))).toMatch(/flood-tide-duration\.bin: ファイルがない/);
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
    const flood = { [FLOOD_FILES.meta]: JSON.stringify(floodFixture.meta) + '\n', [FLOOD_FILES.riverDepth]: floodFixture.bins.riverDepth, [FLOOD_FILES.tideDepth]: floodFixture.bins.tideDepth, [FLOOD_FILES.riverDuration]: floodFixture.bins.riverDuration, [FLOOD_FILES.tideDuration]: floodFixture.bins.tideDuration };
    for (const [name, content] of Object.entries(flood)) {
      if (!skip.includes(name)) await writeFile(path.join(dir, name), content);
    }
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

  it('boundary.geojson と同じディレクトリでは、区の外の標高を違反にする（件数を表示）', () =>
    withDir(async (dir) => {
      await writeAll(dir);
      const b = Buffer.from(fixtures.elevation.bin);
      b.writeFloatLE(10, 0); // 左上隅のセル
      b.writeFloatLE(10, 4);
      await writeFile(path.join(dir, 'elevation.bin'), b);
      const report = await validateDirectory(dir, { requireAll: true });
      expect(report.ok).toBe(false);
      const entry = report.entries.find((e) => e.name === 'elevation.json + elevation.bin');
      expect(entry.status).toBe('ng');
      expect(formatReport(report)).toContain('2 個');
    }));

  it('boundary.geojson がなければ、区の範囲の検査はしない', () =>
    withDir(async (dir) => {
      await writeAll(dir, { skip: ['boundary.geojson'] });
      const b = Buffer.from(fixtures.elevation.bin);
      b.writeFloatLE(10, 0);
      await writeFile(path.join(dir, 'elevation.bin'), b);
      const report = await validateDirectory(dir);
      expect(report.entries.find((e) => e.name === 'elevation.json + elevation.bin').status).toBe('ok');
    }));

  it('boundary.geojson 自体に違反があるときは、区の範囲の検査を省略して理由を示す', () =>
    withDir(async (dir) => {
      await writeAll(dir);
      const boundary = clone(fixtures.geojson['boundary.geojson']);
      boundary.features[1].properties.code = boundary.features[0].properties.code;
      await writeFile(path.join(dir, 'boundary.geojson'), JSON.stringify(boundary));
      const report = await validateDirectory(dir);
      expect(report.entries.find((e) => e.name === 'boundary.geojson').status).toBe('ng');
      const elevation = report.entries.find((e) => e.name === 'elevation.json + elevation.bin');
      expect(elevation.status).toBe('ok');
      expect(elevation.summary.join('\n')).toContain('検査していない');
    }));

  it('浸水想定は、未作成ならほかと同じく検証対象から外し、--require-all では違反にする', () =>
    withDir(async (dir) => {
      await writeAll(dir, { skip: Object.values(FLOOD_FILES) });
      const lenient = await validateDirectory(dir);
      expect(lenient.ok, formatReport(lenient)).toBe(true);
      expect(lenient.entries.find((e) => e.name === 'flood.json + flood-*.bin').status).toBe('missing');
      const strict = await validateDirectory(dir, { requireAll: true });
      expect(strict.ok).toBe(false);
      expect(formatReport(strict)).toContain('flood.json + flood-*.bin');
    }));

  it('浸水想定は、flood.json と必須の格子がそろっていないと違反（片方だけ・1つ欠けている）', () =>
    withDir(async (dir) => {
      await writeAll(dir, { skip: [FLOOD_FILES.meta] });
      const noMeta = await validateDirectory(dir);
      expect(noMeta.ok).toBe(false);
      expect(formatReport(noMeta)).toContain('flood.json: ファイルがない');
      await writeAll(dir, { skip: [FLOOD_FILES.tideDepth] });
      await rm(path.join(dir, FLOOD_FILES.tideDepth), { force: true });
      const noBin = await validateDirectory(dir);
      expect(noBin.ok).toBe(false);
      expect(formatReport(noBin)).toContain('flood-tide.bin: ファイルがない');
    }));

  it('boundary.geojson と同じディレクトリでは、区の外の浸水想定の値を違反にする（件数を表示）', () =>
    withDir(async (dir) => {
      await writeAll(dir);
      const b = Buffer.from(floodFixture.bins.riverDepth);
      b[b.indexOf(255)] = 2; // 左上隅のセル
      await writeFile(path.join(dir, FLOOD_FILES.riverDepth), b);
      const report = await validateDirectory(dir, { requireAll: true });
      expect(report.ok).toBe(false);
      expect(report.entries.find((e) => e.name === 'flood.json + flood-*.bin').status).toBe('ng');
      expect(formatReport(report)).toContain('255 でないセルが 1 個');
    }));

  it('boundary.geojson がなければ、浸水想定の区の範囲の検査はしない（理由を示す）', () =>
    withDir(async (dir) => {
      await writeAll(dir, { skip: ['boundary.geojson'] });
      const b = Buffer.from(floodFixture.bins.riverDepth);
      b[b.indexOf(255)] = 2;
      await writeFile(path.join(dir, FLOOD_FILES.riverDepth), b);
      const report = await validateDirectory(dir);
      const entry = report.entries.find((e) => e.name === 'flood.json + flood-*.bin');
      expect(entry.status).toBe('ok');
      expect(entry.summary.join('\n')).toContain('boundary.geojson がないので検査していない');
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

describe('スクリプトの出力先・既定のディレクトリはリポジトリのルート基準', () => {
  async function inOtherDir(fn) {
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'script-cwd-')));
    try {
      return await fn(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
  const script = (name) => path.join(ROOT_DIR, 'scripts', name);
  const exitCodeOf = (e) => (e.code === undefined ? 0 : e.code);

  it('validate-data.mjs は、引数なしなら実行したディレクトリではなく public/data を検証する', () =>
    inOtherDir(async (cwd) => {
      // 実行したディレクトリに public/data と別の内容があっても、そちらは見ない
      await mkdir(path.join(cwd, 'public', 'data'), { recursive: true });
      await writeFile(path.join(cwd, 'public', 'data', 'roads.geojson'), '{not json');
      const out = await run(process.execPath, [script('validate-data.mjs')], { cwd }).catch((e) => e);
      expect(exitCodeOf(out)).not.toBe(2); // 2 は引数・ディレクトリの誤り
      expect(out.stdout).toContain(`検証対象: ${DATA_DIR}`);
      expect(out.stdout).not.toContain('JSON として読めない');
    }));

  it('validate-data.mjs は、明示したディレクトリは実行したディレクトリからの相対で読む', () =>
    inOtherDir(async (cwd) => {
      await mkdir(path.join(cwd, 'mine'));
      await writeFile(path.join(cwd, 'mine', 'roads.geojson'), '{not json');
      const out = await run(process.execPath, [script('validate-data.mjs'), 'mine'], { cwd }).catch((e) => e);
      expect(out.code).toBe(1);
      expect(out.stdout).toContain('JSON として読めない');
    }));

  it('make-fixtures.mjs は、別のディレクトリで実行しても public/data-fixture に出力する', () =>
    inOtherDir(async (cwd) => {
      const fixtureDir = path.join(ROOT_DIR, 'public', 'data-fixture');
      const read = async () =>
        Object.fromEntries(
          await Promise.all((await readdir(fixtureDir)).sort().map(async (f) => [f, (await readFile(path.join(fixtureDir, f))).toString('base64')])),
        );
      const before = await read();
      const { stdout } = await run(process.execPath, [script('make-fixtures.mjs')], { cwd });
      expect(stdout).toContain(`出力先: ${fixtureDir}`);
      expect(await readdir(cwd)).toEqual([]); // 実行したディレクトリには何も作らない
      expect(existsSync(path.join(cwd, 'public'))).toBe(false);
      // 生成は決定的なので、コミット済みの仮データと一致する（再生成を忘れていれば、ここで気づく）
      expect(await read()).toEqual(before);
    }), 30_000);
});
