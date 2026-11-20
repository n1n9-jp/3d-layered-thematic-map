import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, ROOT_DIR } from './paths.mjs';

/** 座標 [x, y] を 1m 単位に丸める。有限でない数値があれば例外。z 以降は捨てる（高さは画面側で与える）。 */
function roundPosition(pos) {
  if (!Array.isArray(pos) || pos.length < 2) throw new Error(`座標が [x, y] になっていません: ${JSON.stringify(pos)}`);
  const [x, y] = pos;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`座標に有限でない数値が含まれています: ${JSON.stringify(pos)}`);
  }
  // `+ 0` は Math.round が返す -0 を 0 にするため
  return [Math.round(x) + 0, Math.round(y) + 0];
}

/** 連続して同じ点になったものを1つにまとめる。 */
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

function normalizeLine(coords) {
  if (!Array.isArray(coords)) throw new Error('LineString の coordinates が配列ではありません');
  const line = dedupe(coords.map(roundPosition));
  if (line.length < 2) throw new Error(`LineString が丸めの結果 ${line.length} 点になりました（2点以上が必要）`);
  return line;
}

function normalizeRing(coords) {
  if (!Array.isArray(coords)) throw new Error('Polygon のリングが配列ではありません');
  const ring = dedupe(coords.map(roundPosition));
  if (ring.length < 4) throw new Error(`Polygon のリングが丸めの結果 ${ring.length} 点になりました（4点以上が必要）`);
  const [first, last] = [ring[0], ring[ring.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1]) throw new Error('Polygon のリングが閉じていません（始点と終点が異なる）');
  return ring;
}

function normalizePolygon(rings) {
  if (!Array.isArray(rings) || rings.length === 0) throw new Error('Polygon にリングがありません');
  return rings.map(normalizeRing);
}

function normalizeGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') throw new Error('geometry がありません');
  const { type, coordinates } = geometry;
  switch (type) {
    case 'Point':
      return { type, coordinates: roundPosition(coordinates) };
    case 'MultiPoint':
      return { type, coordinates: coordinates.map(roundPosition) };
    case 'LineString':
      return { type, coordinates: normalizeLine(coordinates) };
    case 'MultiLineString':
      return { type, coordinates: coordinates.map(normalizeLine) };
    case 'Polygon':
      return { type, coordinates: normalizePolygon(coordinates) };
    case 'MultiPolygon':
      return { type, coordinates: coordinates.map(normalizePolygon) };
    default:
      throw new Error(`未対応の geometry type: ${type}`);
  }
}

/** properties の値が undefined のものを null にする（JSON にした時にキーが消えないように）。 */
function normalizeProperties(properties) {
  if (properties == null) return null;
  return Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, v === undefined ? null : v]));
}

function normalizeFeature(feature, index) {
  try {
    const out = { type: 'Feature' };
    if (feature.id !== undefined) out.id = feature.id;
    out.properties = normalizeProperties(feature.properties);
    out.geometry = normalizeGeometry(feature.geometry);
    return out;
  } catch (e) {
    throw new Error(`features[${index}]（0始まり）: ${e.message}`, { cause: e });
  }
}

/**
 * FeatureCollection を書き出す。書き出す前に、座標を 1m 単位に丸め、連続する同一点を1つにまとめ、
 * properties の undefined を null にする。不正な地物（有限でない座標、2点未満の線、4点未満のリング、
 * 閉じていないリング、geometry なし）があれば、何番目の地物かを示して例外を投げ、何も書き出さない。
 *
 * 保存先は `public/data/<fileName>`。`options.dir` を指定すると、リポジトリのルートからの相対パスで
 * そのディレクトリに書き出す。戻り値は書き出したファイルの絶対パス。
 */
export async function writeFeatureCollection(fileName, features, { dir } = {}) {
  const normalized = features.map(normalizeFeature);
  const outDir = dir === undefined ? DATA_DIR : path.resolve(ROOT_DIR, dir);
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, fileName);
  await writeFile(file, JSON.stringify({ type: 'FeatureCollection', features: normalized }));
  return file;
}
