import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeFeatureCollection } from './geojson.mjs';
import { DATA_DIR, ROOT_DIR } from './paths.mjs';

const outDirs = new Set();
const outFiles = new Set();

/** `.cache/` 配下（Git 管理外）の一意なディレクトリ。ルートからの相対パスで返す。 */
function tmpDir() {
  const rel = path.join('.cache', `test-${randomUUID()}`);
  outDirs.add(path.join(ROOT_DIR, rel));
  return rel;
}

afterAll(async () => {
  for (const d of outDirs) await rm(d, { recursive: true, force: true });
  for (const f of outFiles) await rm(f, { force: true });
});

const feature = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });
const line = (coordinates) => feature({ type: 'LineString', coordinates });
const poly = (...rings) => feature({ type: 'Polygon', coordinates: rings });

async function write(features, name = 'x.geojson') {
  const dir = tmpDir();
  const file = await writeFeatureCollection(name, features, { dir });
  return JSON.parse(await readFile(file, 'utf8'));
}

describe('保存先', () => {
  it('既定は リポジトリ直下の public/data/', async () => {
    expect(DATA_DIR).toBe(path.join(ROOT_DIR, 'public', 'data'));
    const name = `__test-${randomUUID()}.geojson`;
    const file = await writeFeatureCollection(name, []);
    outFiles.add(file);
    expect(file).toBe(path.join(ROOT_DIR, 'public', 'data', name));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('{ dir } を指定すると、ルートからの相対パスのそのディレクトリへ書く（public/data には書かない）', async () => {
    const dir = path.join(tmpDir(), 'sub', 'nested');
    const name = `__test-${randomUUID()}.geojson`;
    const file = await writeFeatureCollection(name, [], { dir });
    expect(file).toBe(path.join(ROOT_DIR, dir, name));
    expect(existsSync(file)).toBe(true);
    expect(existsSync(path.join(DATA_DIR, name))).toBe(false);
  });

  it('出力は インデントなしの FeatureCollection', async () => {
    const file = await writeFeatureCollection('plain.geojson', [feature({ type: 'Point', coordinates: [1, 2] })], {
      dir: tmpDir(),
    });
    expect(await readFile(file, 'utf8')).toBe(
      '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[1,2]}}]}',
    );
  });
});

describe('座標の丸め', () => {
  it('Point / LineString / Polygon / Multi* の全座標を 1m に丸める', async () => {
    const ring = [[0.4, 0.6], [10.5, 0.4], [10.4, 10.51], [0.4, 0.6]];
    const fc = await write([
      feature({ type: 'Point', coordinates: [1.49, -1.5] }),
      feature({ type: 'MultiPoint', coordinates: [[0.5, 0.5], [2.4, 2.6]] }),
      line([[0.2, 0.2], [5.5, 5.4]]),
      feature({ type: 'MultiLineString', coordinates: [[[0, 0], [3.3, 3.7]], [[10.2, 10.2], [20.8, 20.1]]] }),
      poly(ring),
      feature({ type: 'MultiPolygon', coordinates: [[ring], [ring]] }),
    ]);
    const g = fc.features.map((f) => f.geometry.coordinates);
    expect(g[0]).toEqual([1, -1]);
    expect(g[1]).toEqual([[1, 1], [2, 3]]);
    expect(g[2]).toEqual([[0, 0], [6, 5]]);
    expect(g[3]).toEqual([[[0, 0], [3, 4]], [[10, 10], [21, 20]]]);
    expect(g[4]).toEqual([[[0, 1], [11, 0], [10, 11], [0, 1]]]);
    expect(g[5]).toEqual([g[4], g[4]]);
    const all = JSON.stringify(g).match(/-?\d+(\.\d+)?/g);
    expect(all.every((n) => Number.isInteger(Number(n)))).toBe(true);
  });

  it('-0 は 0 にする', async () => {
    const fc = await write([feature({ type: 'Point', coordinates: [-0.3, -0] })]);
    expect(Object.is(fc.features[0].geometry.coordinates[0], 0)).toBe(true);
    const text = JSON.stringify(fc);
    expect(text).not.toContain('-0');
  });

  it('z など3番目以降の値は含めない（README: 高さはデータに含めない）', async () => {
    const fc = await write([feature({ type: 'Point', coordinates: [1.2, 2.2, 99] })]);
    expect(fc.features[0].geometry.coordinates).toEqual([1, 2]);
  });

  it('入力の地物は変更しない', async () => {
    const input = line([[0.4, 0.4], [0.2, 0.2], [5.6, 5.6]]);
    const copy = structuredClone(input);
    await write([input]);
    expect(input).toEqual(copy);
  });
});

describe('連続する同一点のまとめ', () => {
  it('LineString: 丸めて連続して同じになった点を1つにする（離れた同一点は残す）', async () => {
    const fc = await write([line([[0, 0], [0.3, 0.4], [10, 10], [20, 20], [10, 10], [10.2, 9.8]])]);
    expect(fc.features[0].geometry.coordinates).toEqual([[0, 0], [10, 10], [20, 20], [10, 10]]);
  });

  it('Polygon: リング内の連続する同一点をまとめ、閉じたリングは閉じたまま', async () => {
    const fc = await write([poly([[0, 0], [10, 0], [10.4, 0.2], [10, 10], [0, 10], [0.2, 9.8], [0, 0], [0.3, 0.3]])]);
    expect(fc.features[0].geometry.coordinates[0]).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  });

  it('メッシュの5点リングはそのまま5点', async () => {
    const mesh = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]];
    const fc = await write([poly(mesh)]);
    expect(fc.features[0].geometry.coordinates[0]).toEqual(mesh);
  });

  it('穴を持つ Polygon の各リングを処理する', async () => {
    const outer = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const hole = [[20, 20], [20.1, 20.1], [40, 20], [40, 40], [20, 40], [20, 20]];
    const fc = await write([poly(outer, hole)]);
    expect(fc.features[0].geometry.coordinates[1]).toEqual([[20, 20], [40, 20], [40, 40], [20, 40], [20, 20]]);
  });
});

describe('properties', () => {
  it('undefined は null にし、他の値はそのまま', async () => {
    const dir = tmpDir();
    const file = await writeFeatureCollection(
      'p.geojson',
      [feature({ type: 'Point', coordinates: [0, 0] }, { name: undefined, class: 'other', n: 0, empty: '', no: null })],
      { dir },
    );
    const text = await readFile(file, 'utf8');
    expect(JSON.parse(text).features[0].properties).toEqual({ name: null, class: 'other', n: 0, empty: '', no: null });
    expect(text).toContain('"name":null');
  });

  it('入力の properties は変更しない', async () => {
    const props = { name: undefined };
    await write([feature({ type: 'Point', coordinates: [0, 0] }, props)]);
    expect(props.name).toBeUndefined();
    expect('name' in props).toBe(true);
  });
});

describe('不正な地物は何番目かを示して例外にし、何も書かない', () => {
  const good = line([[0, 0], [10, 10]]);

  async function expectRejected(bad, message, index = 1) {
    const dir = tmpDir();
    const name = 'bad.geojson';
    const err = await writeFeatureCollection(name, [good, bad], { dir }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(`features[${index}]`);
    expect(err.message).toMatch(message);
    expect(existsSync(path.join(ROOT_DIR, dir, name))).toBe(false);
  }

  it('有限でない座標（NaN / Infinity / 文字列 / 欠落）', async () => {
    await expectRejected(feature({ type: 'Point', coordinates: [NaN, 0] }), /有限でない/);
    await expectRejected(line([[0, 0], [Infinity, 1]]), /有限でない/);
    await expectRejected(line([[0, 0], [1, -Infinity]]), /有限でない/);
    await expectRejected(line([[0, 0], ['1', 1]]), /有限でない/);
    await expectRejected(poly([[0, 0], [1, 0], [1, null], [0, 0]]), /有限でない/);
    await expectRejected(line([[0, 0], [1]]), /\[x, y\]/);
  });

  it('LineString が（丸めた結果）2点未満', async () => {
    await expectRejected(line([[0, 0]]), /2点以上/);
    await expectRejected(line([]), /2点以上/);
    await expectRejected(line([[0, 0], [0.4, 0.4]]), /2点以上/);
    await expectRejected(feature({ type: 'MultiLineString', coordinates: [[[0, 0], [5, 5]], [[1, 1], [1.2, 1.2]]] }), /2点以上/);
  });

  it('Polygon のリングが（丸めた結果）4点未満', async () => {
    await expectRejected(poly([[0, 0], [10, 0], [0, 0]]), /4点以上/);
    await expectRejected(poly([[0, 0], [10, 0], [10, 10], [0, 0]].slice(0, 3)), /4点以上/);
    // 丸めで三角形のうち2頂点が重なり、3点になる
    await expectRejected(poly([[0, 0], [10, 0], [10.3, 0.2], [0, 0]]), /4点以上/);
    // 穴のリングだけが不正
    await expectRejected(
      poly([[0, 0], [100, 0], [100, 100], [0, 0]], [[5, 5], [6, 5], [5, 5]]),
      /4点以上/,
    );
  });

  it('閉じていないリング / geometry なし / 未対応の type', async () => {
    await expectRejected(poly([[0, 0], [10, 0], [10, 10], [0, 10]]), /閉じていません/);
    await expectRejected({ type: 'Feature', properties: {}, geometry: null }, /geometry/);
    await expectRejected(feature({ type: 'Circle', coordinates: [0, 0] }), /未対応/);
  });

  it('先頭の地物が不正なら index 0 と示す', async () => {
    const err = await writeFeatureCollection('bad.geojson', [line([[0, 0]]), good], { dir: tmpDir() }).catch((e) => e);
    expect(err.message).toContain('features[0]');
  });
});
