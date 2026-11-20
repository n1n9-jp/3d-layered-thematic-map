// 東京23区の道路データ（public/data/roads.geojson）を作る。使い方: node scripts/build-roads.mjs
// 元データ（1）: 国土数値情報 道路データ（N13）2024年度版、1次メッシュ 5339（23区はすべてこの1枚に入る）。
// 出典：国土交通省『国土数値情報（道路データ）』（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N13-2024.html）を加工して作成
// 元データ（2）: 国土数値情報 高速道路時系列データ（N06）2025年版。首都高などの路線名を、高速自動車国道等の線に付けるために使う。
// 出典：国土交通省『国土数値情報（高速道路時系列データ）』（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html）を加工して作成
//
// 処理:
//   1. N13 の ZIP（約58MB、展開すると約707MB）を、展開しながら1行ずつ読む（1行に1地物）
//   2. 種別が通常部で建設中でないもののうち、class が決まるもの（classifyRoad）だけを残す
//   3. 頂点が1つでも23区内にある線だけを残す
//   4. motorway には、線の中点から50m以内にある N06 の現存路線の名前を付ける
//   5. 同じ class と name で、端点が一致して一筆でつながる線を連結する（3本以上が集まる交差点では連結しない）
import { Unzip, UnzipInflate, unzipSync } from 'fflate';
import { fetchCached } from './lib/fetch-cache.mjs';
import { writeFeatureCollection } from './lib/geojson.mjs';
import { toLocal, toLonLat, EXTENT } from './lib/projection.mjs';
import { loadWards } from './lib/wards.mjs';
import { chainLines, classifyRoad, createNearestLineIndex, lineLength, lineMidpoint } from './lib/roads.mjs';

const N13_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/N13/N13-24/N13-24_5339_GEOJSON.zip';
const N13_ENTRY = 'N13-24_5339_GEOJSON/N13-24_5339.geojson';
const N06_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/N06/N06-25/N06-25_GML.zip';
const N06_ENTRY = 'N06-25_GML/UTF-8/N06-25_HighwaySection.geojson';
/** 名前を付ける距離の上限（m）。 */
const NAME_MAX_DISTANCE_M = 50;
/** ZIP を読み込ませる単位（バイト）。 */
const ZIP_CHUNK = 1 << 16;
const CLASSES = ['motorway', 'national', 'prefectural', 'other'];

const t0 = Date.now();
const lap = (label) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

// 23区の描画範囲を含む経度緯度の範囲。この外にある頂点は、座標変換せずに除く
const corners = [
  [EXTENT.minX, EXTENT.minY],
  [EXTENT.minX, EXTENT.maxY],
  [EXTENT.maxX, EXTENT.minY],
  [EXTENT.maxX, EXTENT.maxY],
].map(([x, y]) => toLonLat(x, y));
const BBOX = {
  minLon: Math.min(...corners.map((c) => c[0])) - 0.01,
  maxLon: Math.max(...corners.map((c) => c[0])) + 0.01,
  minLat: Math.min(...corners.map((c) => c[1])) - 0.01,
  maxLat: Math.max(...corners.map((c) => c[1])) + 0.01,
};
const inBbox = ([lon, lat]) => lon >= BBOX.minLon && lon <= BBOX.maxLon && lat >= BBOX.minLat && lat <= BBOX.maxLat;

const wards = loadWards();

// ---------- N06: 高速道路の路線名 ----------
console.log(`取得: ${N06_URL}`);
const n06Zip = await fetchCached(N06_URL);
const n06Files = unzipSync(new Uint8Array(n06Zip), { filter: (f) => f.name === N06_ENTRY });
if (!n06Files[N06_ENTRY]) throw new Error(`ZIP に ${N06_ENTRY} がありません`);
const n06 = JSON.parse(new TextDecoder('utf-8').decode(n06Files[N06_ENTRY]));
const highwayLines = [];
for (const f of n06.features) {
  if (f.properties.N06_003 !== 9999) continue; // 現存するもの（設置期間の終了年が 9999）
  const name = f.properties.N06_007;
  if (typeof name !== 'string' || name === '') continue;
  const parts = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
  for (const part of parts) {
    if (!part.some(inBbox)) continue;
    highwayLines.push({ name, coords: part.map(([lon, lat]) => toLocal(lon, lat)) });
  }
}
const nearestHighway = createNearestLineIndex(highwayLines, 100);
lap(`N06: 範囲内の現存路線の線 ${highwayLines.length} 本（路線名 ${new Set(highwayLines.map((l) => l.name)).size} 種）`);

// ---------- N13: 道路 ----------
console.log(`取得: ${N13_URL}`);
const n13Zip = await fetchCached(N13_URL);
lap(`N13 の ZIP を読み込み（${(n13Zip.length / 1e6).toFixed(1)}MB）`);

// 属性は固定の書式（`"N13_002": "1", "N13_003": "4", ...`）なので、まず正規表現で読んで、
// class の決まらない行は JSON として読み込まずに捨てる。書式が違う行は JSON として読む
const PROPS_RE = /"N13_002": "(\d)", "N13_003": "(\d)", "N13_004": "(\d)", "N13_005": \d+, "N13_006": "(\d)"/;

const stats = { lines: 0, classified: 0, inRange: 0 };
/** @type {{ cls: string, coords: number[][] }[]} */
const kept = [];

function handleLine(line) {
  if (!line.startsWith('{ "type": "Feature"')) return;
  stats.lines++;
  const m = PROPS_RE.exec(line);
  let cls;
  let feature = null;
  if (m) {
    cls = classifyRoad({ N13_002: m[1], N13_003: m[2], N13_004: m[3], N13_006: m[4] });
  } else {
    // 想定外の書式。JSON として読んで判定する
    feature = JSON.parse(line.replace(/,\s*$/, ''));
    cls = classifyRoad(feature.properties);
  }
  if (!cls) return;
  stats.classified++;
  feature ??= JSON.parse(line.replace(/,\s*$/, ''));
  const ll = feature.geometry.coordinates;
  if (!ll.some(inBbox)) return;
  const coords = ll.map(([lon, lat]) => toLocal(lon, lat));
  if (!coords.some(([x, y]) => wards.contains(x, y))) return;
  stats.inRange++;
  kept.push({ cls, coords });
}

// ZIP を小さな塊ずつ読ませ、展開された内容を改行で区切って1行ずつ処理する
const decoder = new TextDecoder('utf-8');
let pending = '';
let found = false;
const unzip = new Unzip();
unzip.register(UnzipInflate);
unzip.onfile = (file) => {
  if (file.name !== N13_ENTRY) return;
  found = true;
  file.ondata = (err, chunk, final) => {
    if (err) throw err;
    pending += decoder.decode(chunk, { stream: !final });
    let start = 0;
    for (let nl = pending.indexOf('\n', start); nl !== -1; nl = pending.indexOf('\n', start)) {
      handleLine(pending.slice(start, nl));
      start = nl + 1;
    }
    pending = pending.slice(start);
    if (final && pending) {
      handleLine(pending);
      pending = '';
    }
  };
  file.start();
};
for (let i = 0; i < n13Zip.length; i += ZIP_CHUNK) {
  unzip.push(new Uint8Array(n13Zip.subarray(i, i + ZIP_CHUNK)), i + ZIP_CHUNK >= n13Zip.length);
}
if (!found) throw new Error(`ZIP に ${N13_ENTRY} がありません`);
lap(`N13 を走査: 地物 ${stats.lines} 件、class が決まるもの ${stats.classified} 件、23区内 ${stats.inRange} 件`);

// ---------- 路線名・連結 ----------
const verts = (list) => list.reduce((s, l) => s + l.coords.length, 0);
console.log('23区内の連結前の線（件数 / 頂点数）:');
for (const cls of CLASSES) {
  const lines = kept.filter((l) => l.cls === cls);
  console.log(`  ${cls}: ${lines.length} / ${verts(lines)}`);
}

const groups = new Map(); // group → { cls, name }
const toGroup = (cls, name) => {
  const key = `${cls}|${name ?? ''}`;
  if (!groups.has(key)) groups.set(key, { cls, name });
  return key;
};
const lineItems = kept.map(({ cls, coords }) => {
  let name = null;
  if (cls === 'motorway') {
    const [x, y] = lineMidpoint(coords);
    name = nearestHighway(x, y, NAME_MAX_DISTANCE_M);
  }
  return { group: toGroup(cls, name), coords };
});
const motorwayBefore = lineItems.filter((l) => groups.get(l.group).cls === 'motorway');
const namedBefore = motorwayBefore.filter((l) => groups.get(l.group).name !== null).length;
lap(`motorway ${motorwayBefore.length} 本のうち名前が付いたもの ${namedBefore} 本`);

const chained = chainLines(lineItems);
lap(`連結: ${lineItems.length} 本 → ${chained.length} 本`);

// ---------- 書き出し ----------
const roundPoint = ([x, y]) => [Math.round(x) + 0, Math.round(y) + 0];
const features = [];
let dropped = 0;
for (const { group, coords } of chained) {
  const { cls, name } = groups.get(group);
  const rounded = [];
  for (const p of coords.map(roundPoint)) {
    const last = rounded[rounded.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) rounded.push(p);
  }
  if (rounded.length < 2) {
    dropped++; // 1m に丸めると点になってしまう短い線
    continue;
  }
  features.push({ cls, name, coords: rounded });
}
features.sort((a, b) => CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls));
const file = await writeFeatureCollection(
  'roads.geojson',
  features.map(({ cls, name, coords }) => ({
    type: 'Feature',
    properties: { class: cls, name },
    geometry: { type: 'LineString', coordinates: coords },
  })),
);
lap(`書き出し: ${file}`);

// ---------- 集計 ----------
console.log(`丸めで消えた線: ${dropped} 本`);
console.log('出力（class: 地物数 / 頂点数 / 総延長 km）:');
for (const cls of CLASSES) {
  const lines = features.filter((f) => f.cls === cls);
  const km = lines.reduce((s, f) => s + lineLength(f.coords), 0) / 1000;
  console.log(`  ${cls}: ${lines.length} / ${verts(lines.map((f) => ({ coords: f.coords })))} / ${km.toFixed(1)}`);
}
const motorway = features.filter((f) => f.cls === 'motorway');
const namedLength = new Map();
let motorwayKm = 0;
for (const f of motorway) {
  const km = lineLength(f.coords) / 1000;
  motorwayKm += km;
  const key = f.name ?? '(名前なし)';
  const e = namedLength.get(key) ?? { features: 0, km: 0 };
  e.features++;
  e.km += km;
  namedLength.set(key, e);
}
const named = motorway.filter((f) => f.name !== null);
const namedKm = named.reduce((s, f) => s + lineLength(f.coords) / 1000, 0);
console.log(
  `motorway のうち名前が付いたもの: 地物 ${named.length}/${motorway.length}（${((100 * named.length) / motorway.length).toFixed(1)}%）、` +
    `延長 ${namedKm.toFixed(1)}/${motorwayKm.toFixed(1)}km（${((100 * namedKm) / motorwayKm).toFixed(1)}%）`,
);
console.log('路線名（地物数 / 延長km）:');
for (const [name, e] of [...namedLength].sort((a, b) => b[1].km - a[1].km)) {
  console.log(`  ${name}: ${e.features} / ${e.km.toFixed(1)}`);
}
console.log(`所要時間: ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
