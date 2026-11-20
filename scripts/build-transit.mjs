// 公共交通レイヤー（鉄道路線 public/data/rail.geojson、駅 public/data/stations.geojson）を作る。
// 使い方: node scripts/build-transit.mjs
// 元データ: 国土数値情報 鉄道データ（N02）2025年度版（データ基準日 2025年12月31日）。
// 出典：「国土数値情報（鉄道データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html）を加工して作成
import { unzipSync } from 'fflate';
import { fetchCached } from './lib/fetch-cache.mjs';
import { writeFeatureCollection } from './lib/geojson.mjs';
import { EXTENT, toLocal } from './lib/projection.mjs';
import { clipLineToRect, lineLength, lineMidpoint, mergeLines } from './lib/transit.mjs';
import { loadWards } from './lib/wards.mjs';

const ZIP_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-25/N02-25_GML.zip';
const RAIL_ENTRY = 'N02-25_GML/UTF-8/N02-25_RailroadSection.geojson';
const STATION_ENTRY = 'N02-25_GML/UTF-8/N02-25_Station.geojson';

console.log(`取得: ${ZIP_URL}`);
const zip = await fetchCached(ZIP_URL);
const files = unzipSync(new Uint8Array(zip), { filter: (f) => f.name === RAIL_ENTRY || f.name === STATION_ENTRY });
const readJson = (name) => {
  if (!files[name]) throw new Error(`ZIP に ${name} がありません`);
  return JSON.parse(new TextDecoder('utf-8').decode(files[name]));
};
const railSource = readJson(RAIL_ENTRY);
const stationSource = readJson(STATION_ENTRY);

const wards = loadWards();
const project = (coords) => coords.map(([lon, lat]) => toLocal(lon, lat));
const inWards = ([x, y]) => wards.contains(x, y);

function lineCoords(f) {
  const g = f.geometry;
  if (g?.type !== 'LineString') throw new Error(`LineString ではありません: ${g?.type}（${JSON.stringify(f.properties)}）`);
  return project(g.coordinates);
}

/** 1m に丸めたときの、連続する重複を除いた点の数。 */
function distinctRoundedPoints(coords) {
  let count = 0;
  let last = null;
  for (const [x, y] of coords) {
    const p = [Math.round(x), Math.round(y)];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) count++;
    last = p;
  }
  return count;
}

// ---- 路線 ----------------------------------------------------------------
/** "事業者\t路線名" → 区内に頂点がある線（ローカル座標）の配列 */
const railGroups = new Map();
let railSourceCount = 0;
let railKept = 0;
let railVerticesKept = 0;
for (const f of railSource.features) {
  railSourceCount++;
  const coords = lineCoords(f);
  if (!coords.some(inWards)) continue;
  const operator = f.properties.N02_004;
  const line = f.properties.N02_003;
  if (!operator || !line) throw new Error(`事業者名・路線名がありません: ${JSON.stringify(f.properties)}`);
  const key = `${operator}\t${line}`;
  let group = railGroups.get(key);
  if (!group) railGroups.set(key, (group = { operator, line, lines: [] }));
  group.lines.push(coords);
  railKept++;
  railVerticesKept += coords.length;
}

const railFeatures = [];
for (const { operator, line, lines } of railGroups.values()) {
  for (const merged of mergeLines(lines)) {
    // 描画範囲（EXTENT）の外へはみ出す部分は切り落とす
    for (const coords of clipLineToRect(merged, EXTENT)) {
      // 1m に丸めると2点未満になる切れ端は除く（writeFeatureCollection が例外にするため）
      if (distinctRoundedPoints(coords) < 2) continue;
      railFeatures.push({
        type: 'Feature',
        properties: { operator, line },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
  }
}

// ---- 駅 ------------------------------------------------------------------
const stationFeatures = [];
const stationNames = new Set();
let stationSourceCount = 0;
let stationTouching = 0;
for (const f of stationSource.features) {
  stationSourceCount++;
  const coords = lineCoords(f);
  if (coords.some(inWards)) stationTouching++;
  const [x, y] = lineMidpoint(coords);
  if (!wards.contains(x, y)) continue;
  const { N02_005: name, N02_004: operator, N02_003: line } = f.properties;
  if (!name || !operator || !line) throw new Error(`駅名・事業者名・路線名がありません: ${JSON.stringify(f.properties)}`);
  stationNames.add(name);
  stationFeatures.push({
    type: 'Feature',
    properties: { name, operator, line },
    geometry: { type: 'Point', coordinates: [x, y] },
  });
}

const railFile = await writeFeatureCollection('rail.geojson', railFeatures);
const stationFile = await writeFeatureCollection('stations.geojson', stationFeatures);

// ---- 報告 ----------------------------------------------------------------
const vertices = railFeatures.reduce((s, f) => s + f.geometry.coordinates.length, 0);
const totalKm = railFeatures.reduce((s, f) => s + lineLength(f.geometry.coordinates), 0) / 1000;
console.log(`路線: 元 ${railSourceCount} 件 → 区内に頂点あり ${railKept} 件（頂点 ${railVerticesKept}）→ 連結・切り取り後 ${railFeatures.length} 件（頂点 ${vertices}）、総延長 ${totalKm.toFixed(1)} km`);

/** 事業者 → 路線名の集合 */
const byOperator = new Map();
for (const f of railFeatures) {
  const { operator, line } = f.properties;
  if (!byOperator.has(operator)) byOperator.set(operator, new Map());
  const m = byOperator.get(operator);
  m.set(line, (m.get(line) ?? 0) + 1);
}
console.log(`事業者: ${byOperator.size} 社`);
for (const [operator, m] of byOperator) {
  console.log(`  ${operator}: ${[...m].map(([l, c]) => (c > 1 ? `${l}(${c})` : l)).join('、')}`);
}
console.log(`駅: 元 ${stationSourceCount} 件、頂点が区内に1つでもある ${stationTouching} 件 → 中点が区内 ${stationFeatures.length} 件、駅名 ${stationNames.size} 種類`);
console.log(`出力: ${railFile}\n      ${stationFile}`);
