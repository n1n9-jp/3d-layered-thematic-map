// 人口レイヤー（public/data/population.geojson）を、国勢調査の地域メッシュ統計から作る。
//
// 使い方:
//   node scripts/build-population.mjs               250m メッシュ（既定）
//   node scripts/build-population.mjs --size 500    500m メッシュ
//
// 出力: 中心が23区内にあるメッシュを1個ごとの Polygon（南西 → 南東 → 北東 → 北西 → 南西）にして、
//   properties に meshCode, population（人）, density（人/km²、整数）, elderly, elderlyMerged を持たせる。
//   人口の行がないメッシュ（人口0）も、23区内なら population: 0, density: 0, elderly: 0, elderlyMerged: false で出力する。
//   elderly は 65歳以上人口（整数）。秘匿されたメッシュ（`*`）は null。合算先のメッシュ（周辺の秘匿メッシュの分を含む）は
//   elderlyMerged: true で、elderly が総人口を上回るときは総人口を上限に丸める。
//
// 出典：総務省統計局『令和2年国勢調査 地域メッシュ統計（250mメッシュ、世界測地系）』
//   政府統計の総合窓口(e-Stat)（https://www.e-stat.go.jp/）を加工して作成
import { unzipSync } from 'fflate';
import iconv from 'iconv-lite';
import { elderlyOf, parseMeshTable } from './lib/population.mjs';
import { fetchCached } from './lib/fetch-cache.mjs';
import { writeFeatureCollection } from './lib/geojson.mjs';
import { enumerateMeshCodes, meshCorners } from './lib/mesh.mjs';
import { toLocal } from './lib/projection.mjs';
import { loadWards } from './lib/wards.mjs';

const PRIMARY = '5339';
const SOURCES = {
  250: { statsId: 'T001142', entry: 'tblT001142Q5339.txt', populationColumn: 'T001142001', elderlyColumn: 'T001142019', codeLength: 10 },
  500: { statsId: 'T001141', entry: 'tblT001141H5339.txt', populationColumn: 'T001141001', elderlyColumn: 'T001141019', codeLength: 9 },
};
const url = (statsId) =>
  `https://www.e-stat.go.jp/gis/statmap-search/data?statsId=${statsId}&code=${PRIMARY}&downloadType=2`;

function parseArgs(argv) {
  let size = 250;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--size') size = Number(argv[++i]);
    else throw new Error(`未知の引数: ${argv[i]}（使い方: node scripts/build-population.mjs [--size 250|500]）`);
  }
  if (!(size in SOURCES)) throw new Error(`--size は 250 か 500 です: ${size}`);
  return size;
}

/** 多角形（[x, y] の配列、閉じていなくてよい）の面積（m²）。 */
function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** 地域メッシュ統計の表（meshCode → { population, elderly, merged }）を ZIP から読む。1行目が列コード、2行目が列名。 */
function readTable(zip, spec) {
  const files = unzipSync(new Uint8Array(zip), { filter: (f) => f.name === spec.entry });
  const data = files[spec.entry];
  if (!data) throw new Error(`ZIP に ${spec.entry} がありません`);
  return parseMeshTable(iconv.decode(Buffer.from(data), 'cp932'), spec);
}

const size = parseArgs(process.argv.slice(2));
const source = SOURCES[size];
console.log(`取得: ${url(source.statsId)}`);
const table = readTable(await fetchCached(url(source.statsId)), source);
console.log(`人口の行: ${table.size} メッシュ（合計 ${[...table.values()].reduce((a, b) => a + b.population, 0).toLocaleString('en-US')} 人）`);

const wards = loadWards();
const features = [];
const used = new Set();
let total = 0;
let zero = 0;
const elderlyStat = { sum: 0, sumBeforeClamp: 0, hidden: 0, hiddenPopulation: 0, merged: 0, clamped: 0 };
for (const code of enumerateMeshCodes(PRIMARY, size)) {
  const corners = meshCorners(code);
  const lon = (corners[0][0] + corners[1][0]) / 2;
  const lat = (corners[0][1] + corners[3][1]) / 2;
  const [cx, cy] = toLocal(lon, lat);
  if (!wards.contains(cx, cy)) continue;

  const entry = table.get(code);
  const population = entry?.population ?? 0;
  if (entry) used.add(code);
  const { elderly, elderlyMerged, clamped } = elderlyOf(entry);
  if (elderly === null) {
    elderlyStat.hidden++;
    elderlyStat.hiddenPopulation += population;
  } else {
    elderlyStat.sum += elderly;
    elderlyStat.sumBeforeClamp += entry?.elderly ?? 0;
  }
  if (elderlyMerged) elderlyStat.merged++;
  if (clamped) elderlyStat.clamped++;
  const ring = corners.map(([lo, la]) => toLocal(lo, la));
  const areaKm2 = polygonArea(ring) / 1e6;
  total += population;
  if (population === 0) zero++;
  features.push({
    type: 'Feature',
    properties: { meshCode: code, population, density: Math.round(population / areaKm2), elderly, elderlyMerged },
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
  });
}

const file = await writeFeatureCollection('population.geojson', features);
console.log(`出力: ${file}`);
console.log(`メッシュ数: ${features.length}（うち人口0: ${zero}）、人口合計: ${total.toLocaleString('en-US')} 人`);
console.log(`人口の行のうち23区外（中心が区外）で除いたメッシュ: ${table.size - used.size}`);
const fmt = (n) => n.toLocaleString('en-US');
console.log(
  `65歳以上人口: 合計 ${fmt(elderlyStat.sum)} 人（総人口の ${((elderlyStat.sum / total) * 100).toFixed(1)}%。丸める前の合計 ${fmt(elderlyStat.sumBeforeClamp)} 人）`,
);
console.log(`  秘匿（elderly: null）: ${elderlyStat.hidden} メッシュ（総人口の合計 ${fmt(elderlyStat.hiddenPopulation)} 人）`);
console.log(`  合算先（elderlyMerged: true）: ${elderlyStat.merged} メッシュ`);
console.log(`  総人口を上限に丸めたメッシュ: ${elderlyStat.clamped}`);
