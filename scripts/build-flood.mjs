// 浸水想定（洪水・高潮）の格子（public/data/flood*）を作る。標高（elevation.bin）と同じ 720×720、50m 格子。
//
// 使い方:
//   node scripts/build-flood.mjs                     格子を生成し、生成後に確認（地点・ランクごとのセル数・標高との突き合わせ）も表示する
//   node scripts/build-flood.mjs --check             生成済みの出力だけを確認する
//   node scripts/build-flood.mjs --preview dir       生成後（--check なら生成済みの出力）に、確認用の画像（北が上）を dir に書く
//
// 先に build-boundary.mjs を実行しておく（23区の判定に boundary.geojson を使う）。標高との突き合わせには build-elevation.mjs の出力を使う。
//
// 元データ（1）洪水：国土数値情報 洪水浸水想定区域（A31b）2025年度版、1次メッシュ 5339（23区はすべてこの1枚に入る）。
//   洪水予報河川・水位周知河川（10）と、その他の河川（20）の2つの ZIP。それぞれの
//     `20_想定最大規模`（A31b_201：浸水深ランク）と `30_浸水継続時間`（A31b_301：継続時間ランク）を、セルごとの最大で重ねる。
//   出典：「『国土数値情報（洪水浸水想定区域データ）』（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A31b-2025.html）を加工して作成」
// 元データ（2）高潮：東京都港湾局 高潮浸水想定区域図（令和6年12月改定、想定最大規模）の shape(depth).zip。
//   図郭ごとの Shapefile（10m セルの点の属性。.dbf だけを使う）。X, Y はセルの中心（JGD2011 平面直角座標系 第9系）、DepthM は浸水深（m）。
//   出典：「東京都港湾局『高潮浸水想定区域図』（令和6年12月改定）（https://www.kouwan.metro.tokyo.lg.jp/jishin_kouwankyoku_oshirase/takashio/shinsuisoutei）を加工して作成」（CC BY 4.0）
//
// 処理:
//   1. 洪水：ZIP を展開しながら1行ずつ読み（1行に1地物）、多角形を走査線法で格子に塗る（セルの中心が内側か。重なるセルは最大のランク）
//   2. 高潮：10m セルの DepthM の、50m セルの中の最大から、洪水と同じ区切りのランクを決める
//   3. 23区の外のセルは 255、区内で浸水しないセルは 0

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Unzip, UnzipInflate, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { fetchCached } from './lib/fetch-cache.mjs';
import {
  DEPTH_RANKS,
  DURATION_RANKS,
  FLOOD_FILES,
  OUTSIDE,
  TIDE_DURATION_RANKS,
  accumulateMax,
  cellCenterX,
  cellCenterY,
  cellIndexAt,
  createFloodMeta,
  createGrid,
  depthRankOf,
  fillPolygonMax,
  planeIXToLocal,
  polygonsOf,
  readDbfNumbers,
  tideDurationRankOf,
} from './lib/flood.mjs';
import { DATA_DIR } from './lib/paths.mjs';
import { EXTENT, toLocal, toLonLat } from './lib/projection.mjs';
import { loadWards } from './lib/wards.mjs';

const A31B_BASE = 'https://nlftp.mlit.go.jp/ksj/gml/data/A31b/A31b-25';
const RIVER_ZIPS = [
  { name: '洪水予報河川・水位周知河川', url: `${A31B_BASE}/A31b-25_10_5339_GEOJSON.zip` },
  { name: 'その他の河川', url: `${A31B_BASE}/A31b-25_20_5339_GEOJSON.zip` },
];
/** ZIP の中の、使うファイル。ZIP のパスの区切りはバックスラッシュなので、'/' にそろえてから照合する。 */
const RIVER_ENTRIES = [
  { key: 'depth', re: /^20_想定最大規模\/[^/]+\.geojson$/, property: 'A31b_201', maxRank: 6 },
  { key: 'duration', re: /^30_浸水継続時間\/[^/]+\.geojson$/, property: 'A31b_301', maxRank: 7 },
];
const TIDE_DEPTH_URL = 'https://data.storage.data.metro.tokyo.lg.jp/kouwan/shape(depth).zip';
const TIDE_TERM_URL = 'https://data.storage.data.metro.tokyo.lg.jp/kouwan/shape(term).zip';
const ZIP_CHUNK = 1 << 16;

const FILES = {
  river: FLOOD_FILES.riverDepth,
  tide: FLOOD_FILES.tideDepth,
  riverDuration: FLOOD_FILES.riverDuration,
  tideDuration: FLOOD_FILES.tideDuration,
  meta: FLOOD_FILES.meta,
};
const file = (name) => path.join(DATA_DIR, name);

const grid = createGrid();
const { width: WIDTH, height: HEIGHT } = grid;
const CELLS = WIDTH * HEIGHT;

const t0 = Date.now();
const lap = (label) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
const fmt = (n) => n.toLocaleString('en-US');

// 描画範囲を含む経緯度の範囲。これと交わらない地物は、座標変換せずに除く
const corners = [
  [EXTENT.minX, EXTENT.minY], [EXTENT.minX, EXTENT.maxY], [EXTENT.maxX, EXTENT.minY], [EXTENT.maxX, EXTENT.maxY],
].map(([x, y]) => toLonLat(x, y));
const BBOX = {
  minLon: Math.min(...corners.map((c) => c[0])) - 0.01,
  maxLon: Math.max(...corners.map((c) => c[0])) + 0.01,
  minLat: Math.min(...corners.map((c) => c[1])) - 0.01,
  maxLat: Math.max(...corners.map((c) => c[1])) + 0.01,
};

/** 区内のセル（中心が23区の中）か。 */
function insideMask(wards) {
  const inside = new Uint8Array(CELLS);
  for (let row = 0; row < HEIGHT; row++) {
    const y = cellCenterY(grid, row);
    for (let col = 0; col < WIDTH; col++) {
      if (wards.contains(cellCenterX(grid, col), y)) inside[row * WIDTH + col] = 1;
    }
  }
  return inside;
}

// ---------------------------------------------------------------- 洪水

/** ZIP を展開しながら、使うエントリの内容を1行ずつ handler(key, line) に渡す。 */
function streamRiverZip(zipBuf, handler) {
  const decoder = new TextDecoder('utf-8');
  const found = new Set();
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (f) => {
    const name = f.name.replaceAll('\\', '/');
    const entry = RIVER_ENTRIES.find((e) => e.re.test(name));
    if (!entry) return;
    found.add(entry.key);
    let pending = '';
    f.ondata = (err, chunk, final) => {
      if (err) throw err;
      pending += decoder.decode(chunk, { stream: !final });
      let start = 0;
      for (let nl = pending.indexOf('\n', start); nl !== -1; nl = pending.indexOf('\n', start)) {
        handler(entry, pending.slice(start, nl));
        start = nl + 1;
      }
      pending = pending.slice(start);
      if (final && pending) {
        handler(entry, pending);
        pending = '';
      }
    };
    f.start();
  };
  for (let i = 0; i < zipBuf.length; i += ZIP_CHUNK) {
    unzip.push(new Uint8Array(zipBuf.subarray(i, i + ZIP_CHUNK)), i + ZIP_CHUNK >= zipBuf.length);
  }
  return found;
}

async function buildRiver() {
  const out = { depth: new Uint8Array(CELLS), duration: new Uint8Array(CELLS) };
  for (const { name, url } of RIVER_ZIPS) {
    console.log(`取得: ${url}（${name}）`);
    const zip = await fetchCached(url);
    lap(`ZIP を読み込み（${(zip.length / 1e6).toFixed(1)}MB）`);
    const stats = { depth: { lines: 0, near: 0 }, duration: { lines: 0, near: 0 } };
    const found = streamRiverZip(zip, (entry, line) => {
      if (!line.startsWith('{ "type": "Feature"')) return;
      const s = stats[entry.key];
      s.lines++;
      const feature = JSON.parse(line.replace(/,\s*$/, ''));
      const rank = feature.properties?.[entry.property];
      if (!Number.isInteger(rank) || rank < 1 || rank > entry.maxRank) {
        throw new Error(`${entry.property} が想定外の値: ${JSON.stringify(rank)}（1〜${entry.maxRank} の整数のはず）`);
      }
      for (const rings of polygonsOf(feature.geometry)) {
        // 経緯度の範囲が描画範囲と交わらなければ飛ばす
        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const ring of rings) {
          for (const [lon, lat] of ring) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
        }
        if (maxLon < BBOX.minLon || minLon > BBOX.maxLon || maxLat < BBOX.minLat || minLat > BBOX.maxLat) continue;
        s.near++;
        fillPolygonMax(grid, out[entry.key], rings.map((ring) => ring.map(([lon, lat]) => toLocal(lon, lat))), rank);
      }
    });
    for (const e of RIVER_ENTRIES) {
      if (!found.has(e.key)) {
        // 継続時間は、その他の河川（20）に無くてもよい。想定最大規模の浸水深は両方に必要
        if (e.key === 'duration') console.log('  （この ZIP に 30_浸水継続時間 はない）');
        else throw new Error(`ZIP に 20_想定最大規模 がありません: ${url}`);
      }
    }
    lap(
      `走査: 浸水深 ${fmt(stats.depth.lines)} 地物（範囲に近い多角形 ${fmt(stats.depth.near)}）、` +
        `継続時間 ${fmt(stats.duration.lines)} 地物（同 ${fmt(stats.duration.near)}）`,
    );
  }
  return out;
}

// ---------------------------------------------------------------- 高潮

/** 高潮の ZIP の .dbf を、図郭の順に順に処理する。 */
function eachDbf(zipBuf, fn) {
  const files = unzipSync(new Uint8Array(zipBuf), { filter: (f) => f.name.toLowerCase().endsWith('.dbf') });
  const names = Object.keys(files).sort();
  if (names.length === 0) throw new Error('ZIP に .dbf がありません');
  for (const name of names) fn(name, files[name]);
  return names.length;
}

/** セルごとの最大値（Float32、なければ NaN）と、読んだ件数。 */
function accumulateTide(zipBuf, valueField, wards) {
  const cells = new Float32Array(CELLS).fill(NaN);
  const stats = { records: 0, inWards: 0, inGrid: 0 };
  const tiles = eachDbf(zipBuf, (name, bytes) => {
    const { count, columns } = readDbfNumbers(bytes, ['X', 'Y', valueField]);
    for (let i = 0; i < count; i++) {
      const v = columns[valueField][i];
      if (!(v >= 0)) continue;
      const [x, y] = planeIXToLocal(columns.X[i], columns.Y[i]);
      stats.records++;
      if (wards.contains(x, y)) stats.inWards++;
      if (accumulateMax(grid, cells, x, y, v)) stats.inGrid++;
    }
  });
  return { cells, stats, tiles };
}

async function buildTide(wards) {
  console.log(`取得: ${TIDE_DEPTH_URL}`);
  const zip = await fetchCached(TIDE_DEPTH_URL);
  lap(`ZIP を読み込み（${(zip.length / 1e6).toFixed(1)}MB）`);
  const { cells, stats, tiles } = accumulateTide(zip, 'DepthM', wards);
  lap(
    `高潮: 図郭 ${tiles}、10m セル ${fmt(stats.records)} 件（うち23区内 ${fmt(stats.inWards)} 件 = ${((stats.inWards * 100) / 1e6).toFixed(1)} km²、` +
      `格子の範囲内 ${fmt(stats.inGrid)} 件）`,
  );
  const ranks = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) ranks[i] = depthRankOf(cells[i]); // NaN は 0
  return { ranks, depthM: cells };
}

/** 高潮の浸水継続時間のランク（1〜5。値のないセルは 0）。あわせて、元の値の内訳を表示する。 */
async function buildTideDuration(wards, inside) {
  console.log(`取得: ${TIDE_TERM_URL}`);
  const zip = await fetchCached(TIDE_TERM_URL);
  lap(`ZIP を読み込み（${(zip.length / 1e6).toFixed(1)}MB）`);
  const { cells, stats, tiles } = accumulateTide(zip, 'TermMin', wards);
  lap(`高潮の継続時間: 図郭 ${tiles}、10m セル ${fmt(stats.records)} 件（TermMin は分。999999 は、計算期間（約1週間）内に引かなかったことを示す特別値）`);
  const SENTINEL = 999999;
  const ranks = new Uint8Array(CELLS);
  let withValue = 0, unresolved = 0, finiteMax = 0, finiteOverWeek = 0;
  for (let i = 0; i < CELLS; i++) {
    ranks[i] = tideDurationRankOf(cells[i]);
    if (!inside[i] || Number.isNaN(cells[i])) continue;
    withValue++;
    if (cells[i] >= SENTINEL) unresolved++;
    else {
      if (cells[i] > finiteMax) finiteMax = cells[i];
      if (cells[i] >= 10080) finiteOverWeek++;
    }
  }
  console.log(
    `  区内の、継続時間のあるセル ${fmt(withValue)}：特別値（999999）${fmt(unresolved)}（${((unresolved * 100) / withValue).toFixed(1)}%）、` +
      `1週間を超える有限の値 ${fmt(finiteOverWeek)}、有限の値の最大 ${finiteMax} 分（${(finiteMax / 1440).toFixed(1)} 日）。1週間以上はすべてランク 5`,
  );
  return ranks;
}

// ---------------------------------------------------------------- 出力

async function writeOutputs(wards, inside, river, tide, tideDuration) {
  const mask = (src) => {
    const out = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i++) out[i] = inside[i] ? src[i] : OUTSIDE;
    return out;
  };
  await mkdir(DATA_DIR, { recursive: true });
  const outputs = [
    [FILES.river, mask(river.depth)],
    [FILES.tide, mask(tide.ranks)],
    [FILES.riverDuration, mask(river.duration)],
    [FILES.tideDuration, mask(tideDuration)],
  ];
  for (const [name, data] of outputs) await writeFile(file(name), data);
  const meta = createFloodMeta(grid);
  await writeFile(file(FILES.meta), JSON.stringify(meta, null, 2) + '\n');
  for (const [name, data] of outputs) console.log(`出力: public/data/${name}（${data.byteLength} バイト）`);
  console.log(`出力: public/data/${FILES.meta}`);
}

// ---------------------------------------------------------------- 確認

async function readBin(name) {
  const buf = await readFile(file(name));
  if (buf.length !== CELLS) throw new Error(`${name} の大きさが想定外: ${buf.length} バイト（${CELLS} のはず）`);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
async function readElevation() {
  const buf = await readFile(file('elevation.bin'));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function countRanks(bin, maxRank) {
  const counts = new Array(maxRank + 2).fill(0); // 0..maxRank と、区の外（最後）
  for (const v of bin) counts[v === OUTSIDE ? maxRank + 1 : Math.min(v, maxRank)]++;
  return counts;
}

function printRankCounts(title, bin, maxRank, labels) {
  const c = countRanks(bin, maxRank);
  const inside = CELLS - c[maxRank + 1];
  console.log(`${title}: 区内 ${fmt(inside)} セル、浸水 ${fmt(inside - c[0])} セル（${(((inside - c[0]) / inside) * 100).toFixed(1)}%）`);
  console.log(`  なし ${fmt(c[0])}` + labels.map((l, i) => ` / ${i + 1}（${l.label}） ${fmt(c[i + 1])}`).join(''));
}

const CHECK_POINTS = [
  { name: '江戸川区役所', lon: 139.8683, lat: 35.7067, river: 3, tide: '>0' },
  { name: '江東区役所', lon: 139.8172, lat: 35.6728, river: 3, tide: '>0' },
  { name: '新宿駅', lon: 139.7005, lat: 35.6896, river: 0, tide: 0 },
  { name: '世田谷区役所', lon: 139.6532, lat: 35.6461, river: 0, tide: 0 },
  { name: '豊洲', lon: 139.796, lat: 35.654, river: null, tide: '>0' },
  { name: 'お台場', lon: 139.777, lat: 35.627, river: null, tide: '>0' },
  { name: '北千住（荒川沿い。高潮は 0 だが、期待は置かない）', lon: 139.8049, lat: 35.7497, river: '>0', tide: null },
  { name: '錦糸町駅（荒川と隅田川のあいだの低地）', lon: 139.8148, lat: 35.6967, river: '>0', tide: '>0' },
  { name: '新小岩駅（荒川と中川のあいだの低地）', lon: 139.8575, lat: 35.7168, river: '>0', tide: '>0' },
  { name: '葛西（江戸川区）', lon: 139.8727, lat: 35.6672, river: null, tide: '>0' },
];

function meets(expected, v) {
  if (expected === null) return true;
  if (expected === '>0') return v > 0 && v !== OUTSIDE;
  return v === expected;
}

async function check(wards) {
  const river = await readBin(FILES.river);
  const tide = await readBin(FILES.tide);
  const riverDuration = await readBin(FILES.riverDuration);
  const tideDuration = await readBin(FILES.tideDuration);
  console.log('\n各格子のランクごとのセル数（区の外は 255）:');
  printRankCounts('洪水 浸水深（flood-river）', river, 6, DEPTH_RANKS);
  printRankCounts('高潮 浸水深（flood-tide）', tide, 6, DEPTH_RANKS);
  printRankCounts('洪水 浸水継続時間（flood-river-duration）', riverDuration, 7, DURATION_RANKS);
  printRankCounts('高潮 浸水継続時間（flood-tide-duration。1週間以上はすべて 5）', tideDuration, 5, TIDE_DURATION_RANKS);
  const outsideCount = (b) => b.reduce((n, v) => n + (v === OUTSIDE ? 1 : 0), 0);
  console.log(`  区の外（255）のセル数: 洪水 ${fmt(outsideCount(river))} / 高潮 ${fmt(outsideCount(tide))} / 洪水の継続時間 ${fmt(outsideCount(riverDuration))} / 高潮の継続時間 ${fmt(outsideCount(tideDuration))}`);
  const ge = (bin, k) => bin.reduce((n, v) => n + (v >= k && v !== OUTSIDE ? 1 : 0), 0);
  console.log(`  洪水の継続時間 ランク 4 以上（3日以上） ${fmt(ge(riverDuration, 4))} セル、ランク 5 以上（1週間以上） ${fmt(ge(riverDuration, 5))} セル`);

  console.log('\n地点の確認（ランク）:');
  let bad = 0;
  for (const p of CHECK_POINTS) {
    const [x, y] = toLocal(p.lon, p.lat);
    const i = cellIndexAt(grid, x, y);
    const r = river[i];
    const t = tide[i];
    const ok = meets(p.river, r) && meets(p.tide, t);
    if (!ok) bad++;
    const show = (v) => (v === OUTSIDE ? '区の外' : v);
    console.log(`  ${ok ? 'OK ' : 'NG '} ${p.name}: 洪水 ${show(r)}（期待 ${p.river ?? '—'}）、高潮 ${show(t)}（期待 ${p.tide ?? '—'}）、洪水の継続時間 ${show(riverDuration[i])}、高潮の継続時間 ${show(tideDuration[i])}`);
  }
  if (bad) console.log(`  ${bad} 地点が期待と違う`);

  // 標高との突き合わせ
  let elevation = null;
  try {
    elevation = await readElevation();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.log('\n（elevation.bin がないので、標高との突き合わせは省略）');
  }
  if (elevation) {
    let below = 0, belowRiver = 0, belowTide = 0, belowEither = 0;
    let water = 0, waterRiver = 0, waterTide = 0;
    const high = []; // 標高 20m 以上で浸水するセル
    let highCount = 0, highRiver = 0, highTide = 0;
    for (let i = 0; i < CELLS; i++) {
      if (river[i] === OUTSIDE) continue;
      const e = elevation[i];
      if (Number.isNaN(e)) {
        water++;
        if (river[i] > 0) waterRiver++;
        if (tide[i] > 0) waterTide++;
        continue;
      }
      if (e < 0) {
        below++;
        if (river[i] > 0) belowRiver++;
        if (tide[i] > 0) belowTide++;
        if (river[i] > 0 || tide[i] > 0) belowEither++;
      } else if (e >= 20 && (river[i] > 0 || tide[i] > 0)) {
        highCount++;
        if (river[i] > 0) highRiver++;
        if (tide[i] > 0) highTide++;
        high.push(i);
      }
    }
    const pct = (a, b) => (b ? `${((a * 100) / b).toFixed(1)}%` : '—');
    console.log('\n標高との突き合わせ:');
    console.log(
      `  標高 0m 未満のセル ${fmt(below)}: 洪水で浸水 ${fmt(belowRiver)}（${pct(belowRiver, below)}）、高潮で浸水 ${fmt(belowTide)}（${pct(belowTide, below)}）、` +
        `どちらかで浸水 ${fmt(belowEither)}（${pct(belowEither, below)}）`,
    );
    console.log(`  標高が NaN（水面）の区内のセル ${fmt(water)}: 洪水の値あり ${fmt(waterRiver)}（${pct(waterRiver, water)}）、高潮の値あり ${fmt(waterTide)}（${pct(waterTide, water)}）`);
    console.log(`  標高 20m 以上で浸水するセル ${fmt(highCount)}（洪水 ${fmt(highRiver)}、高潮 ${fmt(highTide)}）`);
    const byWard = new Map();
    for (const i of high) {
      const row = Math.floor(i / WIDTH);
      const w = wards.wardAt(cellCenterX(grid, i % WIDTH), cellCenterY(grid, row))?.name ?? '区の外';
      const e = byWard.get(w) ?? { n: 0, sample: null, maxRank: 0, maxElev: -Infinity };
      e.n++;
      e.maxRank = Math.max(e.maxRank, river[i], tide[i]);
      if (elevation[i] > e.maxElev) {
        e.maxElev = elevation[i];
        const [lon, lat] = toLonLat(cellCenterX(grid, i % WIDTH), cellCenterY(grid, row));
        e.sample = `${lon.toFixed(4)}, ${lat.toFixed(4)}（標高 ${elevation[i].toFixed(1)} m、洪水 ${river[i]}、高潮 ${tide[i]}）`;
      }
      byWard.set(w, e);
    }
    for (const [w, e] of [...byWard].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`    ${w}: ${fmt(e.n)} セル、最も高い所 ${e.sample}`);
    }
    // 谷筋か：周囲 ±10 セル（約 500m）の最低標高との差（谷底ほど小さい）。標高 20m 以上で浸水しないセル（20 個に 1 個の標本）と比べる
    const reliefOf = (i) => {
      const row = Math.floor(i / WIDTH), col = i % WIDTH;
      let lowest = Infinity;
      for (let r = Math.max(0, row - 10); r <= Math.min(HEIGHT - 1, row + 10); r++) {
        for (let c = Math.max(0, col - 10); c <= Math.min(WIDTH - 1, col + 10); c++) {
          const v = elevation[r * WIDTH + c];
          if (v < lowest) lowest = v;
        }
      }
      return elevation[i] - lowest;
    };
    const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const dry = [];
    let k = 0;
    for (let i = 0; i < CELLS; i++) {
      if (river[i] === 0 && tide[i] === 0 && elevation[i] >= 20 && k++ % 20 === 0) dry.push(reliefOf(i));
    }
    if (high.length && dry.length) {
      console.log(
        `  周囲 500m の最低標高との差の中央値：浸水する ${median(high.map(reliefOf)).toFixed(1)} m、浸水しない（標高 20m 以上の標本）${median(dry).toFixed(1)} m` +
          '（差が小さいほど谷底）',
      );
    }
  }
  return bad;
}

// ---------------------------------------------------------------- 確認用の画像

/** 確認用の画像（北が上、東が右。1セル = 1画素）。標高を暗い灰色の背景にして、浸水のランクを色で重ねる。 */
async function writePreviews(dir) {
  const elevation = await readElevation().catch(() => null);
  const targets = [
    ['river', FILES.river, 6], ['tide', FILES.tide, 6], ['river-duration', FILES.riverDuration, 7], ['tide-duration', FILES.tideDuration, 5],
  ];
  const depthColors = [[255, 255, 140], [255, 200, 60], [255, 120, 30], [225, 40, 40], [160, 20, 120], [90, 0, 170]];
  const durationColors = [[255, 255, 140], [255, 215, 70], [255, 160, 40], [240, 90, 30], [210, 30, 60], [150, 20, 120], [90, 0, 170]];
  await mkdir(path.resolve(dir), { recursive: true });
  const images = [];
  for (const [label, name, maxRank] of targets) {
    const bin = await readBin(name);
    const colors = maxRank === 6 ? depthColors : durationColors; // 高潮の継続時間（5）は、洪水の 1〜5 と同じ色
    const png = new PNG({ width: WIDTH, height: HEIGHT });
    for (let i = 0; i < CELLS; i++) {
      const v = bin[i];
      let rgb;
      if (v === OUTSIDE) rgb = [8, 8, 8];
      else if (v > 0) rgb = colors[v - 1];
      else if (elevation && Number.isNaN(elevation[i])) rgb = [30, 70, 120]; // 水面（浸水の値もない）
      else {
        const g = elevation ? Math.round(60 + Math.max(0, Math.min(60, elevation[i])) * 1.6) : 100;
        rgb = [g, g, g];
      }
      png.data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
    }
    const p = path.join(dir, `flood-${label}.png`);
    await writeFile(p, PNG.sync.write(png));
    images.push({ label, png });
    console.log(`確認用の画像: ${p}`);
  }
  // 2×2 に並べた画像（洪水の深さ・高潮の深さ・洪水の継続時間・高潮の継続時間）
  const montage = new PNG({ width: WIDTH * 2 + 4, height: HEIGHT * 2 + 4 });
  montage.data.fill(255);
  images.forEach(({ png }, k) => PNG.bitblt(png, montage, 0, 0, WIDTH, HEIGHT, (k % 2) * (WIDTH + 4), Math.floor(k / 2) * (HEIGHT + 4)));
  const mp = path.join(dir, 'flood-all.png');
  await writeFile(mp, PNG.sync.write(montage));
  console.log(`確認用の画像（左上：洪水の深さ、右上：高潮の深さ、左下：洪水の継続時間、右下：高潮の継続時間）: ${mp}`);
}

// ---------------------------------------------------------------- 実行

const args = process.argv.slice(2);
const previewIdx = args.indexOf('--preview');
const previewDir = previewIdx >= 0 ? args[previewIdx + 1] : null;
if (previewIdx >= 0 && (!previewDir || previewDir.startsWith('--'))) {
  console.error('使い方: --preview <ディレクトリ>');
  process.exit(2);
}

const wards = loadWards();
const inside = insideMask(wards);
lap(`区内のセル ${fmt(inside.reduce((n, v) => n + v, 0))} / ${fmt(CELLS)}`);

if (!args.includes('--check')) {
  const river = await buildRiver();
  const tide = await buildTide(wards);
  const tideDuration = await buildTideDuration(wards, inside);
  await writeOutputs(wards, inside, river, tide, tideDuration);
  lap('完了');
}
const bad = await check(wards);
if (previewDir) await writePreviews(previewDir);
if (bad) process.exitCode = 1;
