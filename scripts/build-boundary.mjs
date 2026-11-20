// 東京23区の境界データ（public/data/boundary.geojson）を作る。使い方: node scripts/build-boundary.mjs
// 元データ: 国土数値情報 行政区域（N03）2026年1月1日時点、東京都。
// 出典：国土交通省 国土数値情報（行政区域データ 2026年（令和8年）1月1日時点）
//   （https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html）を加工して作成
import { unzipSync } from 'fflate';
import { fetchCached } from './lib/fetch-cache.mjs';
import { writeFeatureCollection } from './lib/geojson.mjs';
import { toLocal } from './lib/projection.mjs';

const ZIP_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2026/N03-20260101_13_GML.zip';
const ENTRY_NAME = 'N03-20260101_13.geojson';
/** これ未満の面積（m²）のポリゴンは除く。 */
const MIN_AREA_M2 = 5000;
const WARD_COUNT = 23;

/** 23区の団体コード（13101〜13123）か。 */
const isWardCode = (code) => /^131(0[1-9]|1\d|2[0-3])$/.test(code);

/** リングの面積（m²、符号なし）。シューレース公式。 */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

/** ポリゴン（外周＋穴）の面積（m²）。 */
function polygonArea(rings) {
  const [outer, ...holes] = rings;
  return ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0);
}

const projectPolygon = (rings) => rings.map((ring) => ring.map(([lon, lat]) => toLocal(lon, lat)));

console.log(`取得: ${ZIP_URL}`);
const zip = await fetchCached(ZIP_URL);
const files = unzipSync(new Uint8Array(zip), { filter: (f) => f.name === ENTRY_NAME });
const entry = files[ENTRY_NAME];
if (!entry) throw new Error(`ZIP に ${ENTRY_NAME} がありません`);
const source = JSON.parse(new TextDecoder('utf-8').decode(entry));

/** code → { name, polygons: [], dropped: 0, sourceFeatures: 0 } */
const wards = new Map();
for (const f of source.features) {
  const code = f.properties?.N03_007;
  if (typeof code !== 'string' || !isWardCode(code)) continue;
  const name = f.properties.N03_004;
  if (f.geometry?.type !== 'MultiPolygon') throw new Error(`${code} ${name}: MultiPolygon ではありません（${f.geometry?.type}）`);
  let ward = wards.get(code);
  if (!ward) wards.set(code, (ward = { name, polygons: [], dropped: 0, sourceFeatures: 0 }));
  if (ward.name !== name) throw new Error(`${code} の区名が一致しません: ${ward.name} / ${name}`);
  ward.sourceFeatures++;
  for (const rings of f.geometry.coordinates) {
    const local = projectPolygon(rings);
    if (polygonArea(local) < MIN_AREA_M2) ward.dropped++;
    else ward.polygons.push(local);
  }
}

if (wards.size !== WARD_COUNT) throw new Error(`23区ではありません: ${wards.size} 区`);

const codes = [...wards.keys()].sort();
const features = codes.map((code) => {
  const { name, polygons } = wards.get(code);
  if (polygons.length === 0) throw new Error(`${code} ${name}: 残るポリゴンがありません`);
  return {
    type: 'Feature',
    properties: { code, name },
    geometry: { type: 'MultiPolygon', coordinates: polygons },
  };
});

const file = await writeFeatureCollection('boundary.geojson', features);

let totalArea = 0;
let totalPolys = 0;
let totalDropped = 0;
for (const code of codes) {
  const w = wards.get(code);
  const area = w.polygons.reduce((s, p) => s + polygonArea(p), 0);
  totalArea += area;
  totalPolys += w.polygons.length;
  totalDropped += w.dropped;
  console.log(
    `${code} ${w.name}\tポリゴン ${w.polygons.length}\t除外 ${w.dropped}\t${(area / 1e6).toFixed(2)} km²`,
  );
}
console.log(`合計: ${codes.length}区、ポリゴン ${totalPolys}、除外 ${totalDropped}、面積 ${(totalArea / 1e6).toFixed(1)} km²`);
console.log(`出力: ${file}`);
