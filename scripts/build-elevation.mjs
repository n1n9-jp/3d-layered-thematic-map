// 標高格子（public/data/elevation.bin / elevation.json）を、国土地理院の DEM5A タイル（ズーム14）から作る。
//
// 使い方:
//   node scripts/build-elevation.mjs               格子を生成する（生成後に既知地点の確認も表示）
//   node scripts/build-elevation.mjs --check       生成済みの出力だけを既知地点と照合する
//   node scripts/build-elevation.mjs --preview f.png  生成後に確認用の画像（北が上）を f.png に書く
//
// 出典: 『標高タイル（基盤地図情報数値標高モデル）』（国土地理院）をもとに作成
//   https://maps.gsi.go.jp/development/ichiran.html
//   https://maps.gsi.go.jp/development/demtile.html

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { EXTENT, toLocal, toLonLat } from './lib/projection.mjs';
import { fetchCached } from './lib/fetch-cache.mjs';
import { loadWards } from './lib/wards.mjs';
import { CACHE_DIR, DATA_DIR } from './lib/paths.mjs';

const ZOOM = 14;
const TILE_SIZE = 256;
const TILE_URL = (x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${ZOOM}/${x}/${y}.png`;
const CELL_SIZE = 50;
const WIDTH = (EXTENT.maxX - EXTENT.minX) / CELL_SIZE;
const HEIGHT = (EXTENT.maxY - EXTENT.minY) / CELL_SIZE;
const CONCURRENCY = 4;

const BIN_FILE = path.join(DATA_DIR, 'elevation.bin');
const JSON_FILE = path.join(DATA_DIR, 'elevation.json');
const BOUNDARY_FILE = path.join(DATA_DIR, 'boundary.geojson');
const MISSING_FILE = path.join(CACHE_DIR, 'dem5a-14-404.json');

// 確認用の既知地点（DEM5A、最近傍画素の値）
const CHECK_POINTS = [
  { name: '皇居の天守台付近', lon: 139.7547, lat: 35.6877, expected: 20.0 },
  { name: '東京駅', lon: 139.7671, lat: 35.6812, expected: 3.6 },
  { name: '新宿駅', lon: 139.7006, lat: 35.6896, expected: 37.5 },
  { name: '石神井公園', lon: 139.6063, lat: 35.7435, expected: 47.0 },
  { name: '葛西（江戸川区役所付近）', lon: 139.8727, lat: 35.6672, expected: -0.35 },
];
const CHECK_TOLERANCE = 2;

// ---------------------------------------------------------------- タイル座標

function lonToTileX(lon) {
  return ((lon + 180) / 360) * 2 ** ZOOM;
}
function latToTileY(lat) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** ZOOM;
}
function tileXToLon(fx) {
  return (fx / 2 ** ZOOM) * 360 - 180;
}
function tileYToLat(fy) {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / 2 ** ZOOM))) * 180) / Math.PI;
}

/** 描画範囲を覆うタイルの範囲（四隅と各辺の中点をたどって求める）。 */
function tileRange() {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const N = 36;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = EXTENT.minX + t * (EXTENT.maxX - EXTENT.minX);
    const y = EXTENT.minY + t * (EXTENT.maxY - EXTENT.minY);
    for (const [px, py] of [
      [x, EXTENT.minY], [x, EXTENT.maxY], [EXTENT.minX, y], [EXTENT.maxX, y],
    ]) {
      const [lon, lat] = toLonLat(px, py);
      const fx = lonToTileX(lon), fy = latToTileY(lat);
      minX = Math.min(minX, Math.floor(fx)); maxX = Math.max(maxX, Math.floor(fx));
      minY = Math.min(minY, Math.floor(fy)); maxY = Math.max(maxY, Math.floor(fy));
    }
  }
  return { minX, maxX, minY, maxY };
}

// ---------------------------------------------------------------- タイル取得（404 は記録して再取得しない）

async function loadMissing() {
  try {
    return new Set(JSON.parse(await readFile(MISSING_FILE, 'utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return new Set();
    throw e;
  }
}
async function saveMissing(set) {
  await mkdir(path.dirname(MISSING_FILE), { recursive: true });
  await writeFile(MISSING_FILE, JSON.stringify([...set].sort(), null, 1));
}

/** タイルの PNG を返す。存在しない（404）なら null。 */
async function fetchTile(tx, ty, missing) {
  const key = `${tx}/${ty}`;
  if (missing.has(key)) return null;
  try {
    return await fetchCached(TILE_URL(tx, ty));
  } catch (e) {
    if (/HTTP 404/.test(String(e.message))) {
      missing.add(key);
      return null;
    }
    throw e;
  }
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------------------------------------------------------------- 格子の生成

/** 画素値（R,G,B）→ 標高（m）。データなしは NaN。 */
function decode(r, g, b) {
  const v = r * 65536 + g * 256 + b;
  if (v === 8388608) return NaN;
  return (v < 8388608 ? v : v - 16777216) * 0.01;
}

async function build() {
  const range = tileRange();
  const tiles = [];
  for (let ty = range.minY; ty <= range.maxY; ty++)
    for (let tx = range.minX; tx <= range.maxX; tx++) tiles.push([tx, ty]);
  console.log(`タイル範囲 x=${range.minX}..${range.maxX} y=${range.minY}..${range.maxY}（${tiles.length} 枚）`);

  const missing = await loadMissing();
  const knownMissing = tiles.filter(([x, y]) => missing.has(`${x}/${y}`)).length;

  const sum = new Float64Array(WIDTH * HEIGHT);
  const valid = new Uint32Array(WIDTH * HEIGHT);
  const total = new Uint32Array(WIDTH * HEIGHT); // セル内の画素数（データなしを含む）

  const lonOf = new Float64Array(TILE_SIZE);
  const latOf = new Float64Array(TILE_SIZE);

  let fetched = 0, notFound = 0;
  const t0 = Date.now();
  await mapLimit(tiles, CONCURRENCY, async ([tx, ty]) => {
    const buf = await fetchTile(tx, ty, missing);
    let rgba = null;
    if (buf) {
      const png = PNG.sync.read(buf);
      if (png.width !== TILE_SIZE || png.height !== TILE_SIZE) throw new Error(`タイルの大きさが想定外: ${tx}/${ty}`);
      rgba = png.data;
      fetched++;
    } else notFound++;
    if ((fetched + notFound) % 40 === 0) console.log(`  ${fetched + notFound}/${tiles.length} 枚 処理済み`);

    // 画素中心の経緯度は、経度が列、緯度が行だけで決まる。
    for (let i = 0; i < TILE_SIZE; i++) {
      lonOf[i] = tileXToLon(tx + (i + 0.5) / TILE_SIZE);
      latOf[i] = tileYToLat(ty + (i + 0.5) / TILE_SIZE);
    }
    // 画素ごとにローカル座標へ変換し、描画範囲内ならそのセルに足し込む。
    for (let py = 0; py < TILE_SIZE; py++) {
      for (let px = 0; px < TILE_SIZE; px++) {
        const [x, y] = toLocal(lonOf[px], latOf[py]);
        if (x < EXTENT.minX || x >= EXTENT.maxX || y <= EXTENT.minY || y > EXTENT.maxY) continue;
        const col = Math.floor((x - EXTENT.minX) / CELL_SIZE);
        const row = Math.floor((EXTENT.maxY - y) / CELL_SIZE);
        const idx = row * WIDTH + col;
        total[idx]++;
        if (!rgba) continue;
        const o = (py * TILE_SIZE + px) * 4;
        const h = decode(rgba[o], rgba[o + 1], rgba[o + 2]);
        if (Number.isNaN(h)) continue;
        sum[idx] += h;
        valid[idx]++;
      }
    }
  });
  await saveMissing(missing);
  console.log(
    `タイル: 取得（またはキャッシュ） ${fetched} 枚、404 ${notFound} 枚（うち前回までに記録済み ${knownMissing} 枚）、` +
      `処理時間 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`,
  );

  const grid = new Float32Array(WIDTH * HEIGHT).fill(NaN);
  for (let i = 0; i < grid.length; i++) {
    // 有効な画素がセル内の画素の半分に満たなければ NaN
    if (valid[i] > 0 && valid[i] * 2 >= total[i]) grid[i] = sum[i] / valid[i];
  }

  // 23区の外はデータなし。判定は他のレイヤーと同じ共通関数（scripts/lib/wards.mjs）を使い、輪郭を揃える。
  const wards = loadWards(BOUNDARY_FILE);
  let cut = 0;
  for (let row = 0; row < HEIGHT; row++) {
    const y = EXTENT.maxY - (row + 0.5) * CELL_SIZE;
    for (let col = 0; col < WIDTH; col++) {
      const i = row * WIDTH + col;
      if (Number.isNaN(grid[i])) continue;
      const x = EXTENT.minX + (col + 0.5) * CELL_SIZE;
      if (!wards.contains(x, y)) { grid[i] = NaN; cut++; }
    }
  }
  console.log(`境界で切り抜き: 23区の外のセル ${cut} 個を NaN にした`);

  let min = Infinity, max = -Infinity, nan = 0;
  for (const v of grid) {
    if (Number.isNaN(v)) { nan++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (nan === grid.length) throw new Error('有効なセルがありません');

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(BIN_FILE, Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength)); // 実行環境はリトルエンディアン
  await writeFile(
    JSON_FILE,
    JSON.stringify({
      width: WIDTH, height: HEIGHT, cellSize: CELL_SIZE,
      minX: EXTENT.minX, minY: EXTENT.minY, maxX: EXTENT.maxX, maxY: EXTENT.maxY,
      min, max,
    }) + '\n',
  );
  console.log(
    `出力: ${path.relative('.', BIN_FILE)}（${grid.byteLength} バイト）、${path.relative('.', JSON_FILE)}\n` +
      `NaN ${nan} / ${grid.length} セル（${((nan / grid.length) * 100).toFixed(1)}%）、有効値の最小 ${min} m、最大 ${max} m`,
  );
  return grid;
}

// ---------------------------------------------------------------- 確認

async function readGrid() {
  const buf = await readFile(BIN_FILE);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

async function check(grid) {
  console.log('既知の地点との照合（セルの値 − 期待値）:');
  let bad = 0;
  for (const p of CHECK_POINTS) {
    const [x, y] = toLocal(p.lon, p.lat);
    const col = Math.floor((x - EXTENT.minX) / CELL_SIZE);
    const row = Math.floor((EXTENT.maxY - y) / CELL_SIZE);
    const v = grid[row * WIDTH + col];
    const diff = v - p.expected;
    const ok = Math.abs(diff) <= CHECK_TOLERANCE;
    if (!ok) bad++;
    console.log(
      `  ${ok ? 'OK ' : 'NG '} ${p.name}: 格子 ${v.toFixed(2)} m / 期待 ${p.expected} m / 差 ${Number.isNaN(diff) ? 'NaN' : diff.toFixed(2)} m` +
        `（x=${x.toFixed(0)}, y=${y.toFixed(0)}, col=${col}, row=${row}）`,
    );
  }
  if (bad) console.log(`  ${bad} 地点が ±${CHECK_TOLERANCE} m を超えた`);
  return bad;
}

/** 確認用の画像（北が上、東が右）。1セル = 1画素、データなしは青。 */
async function writePreview(grid, file) {
  const meta = JSON.parse(await readFile(JSON_FILE, 'utf8'));
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  const span = 60; // 0〜60m を灰色の濃淡にする
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    let r, g, b;
    if (Number.isNaN(v)) [r, g, b] = [30, 80, 160];
    else if (v < 0) [r, g, b] = [200, 120, 40];
    else {
      const t = Math.min(1, v / span);
      [r, g, b] = [Math.round(30 + 200 * t), Math.round(90 + 140 * t), Math.round(30 + 100 * t)];
    }
    png.data.set([r, g, b, 255], i * 4);
  }
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, PNG.sync.write(png));
  console.log(`確認用の画像を ${file} に書いた（0〜${span}m を緑から白、負は橙、データなしは青。min=${meta.min}, max=${meta.max}）`);
}

const args = process.argv.slice(2);
const previewIdx = args.indexOf('--preview');
const previewFile = previewIdx >= 0 ? args[previewIdx + 1] : null;

let grid;
if (args.includes('--check')) grid = await readGrid();
else grid = await build();
const bad = await check(grid);
if (previewFile) await writePreview(grid, previewFile);
if (args.includes('--check') && bad) process.exitCode = 1;
