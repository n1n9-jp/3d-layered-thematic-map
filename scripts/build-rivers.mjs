// 河川の水域（public/data/rivers.geojson）と、川の名前の位置（public/data/river-labels.json）を作る。
// 使い方: node scripts/build-rivers.mjs
//
// 元データ: 国土地理院 最適化ベクトルタイル（ズーム14、optimal_bvmap-v1）。
//   水域 WA のうち、種別 5200（河川・湖沼などの水部）の面。種別 5100（海）は除く。
//   川の名前は注記 Anno の河川名（vt_code 322）の点。
// 出典：「国土地理院最適化ベクトルタイル」（国土地理院）を加工して作成
//   https://github.com/gsi-cyberjapan/optimal_bvmap
// 利用条件：国土地理院コンテンツ利用規約（https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html ）。
//
// 処理の流れ（ズーム14のタイル 361 枚）:
//   1. タイルごとに WA（5200）の面を読み、タイルの枠（0〜4096）で切り抜く（タイルは枠の外に 80 単位の余白を持つので、重なりを除く）。
//   2. 断片をローカル座標にして間引き、格子（10 m）に塗って、つながった水部のまとまり（水域）に分ける。水域ごとの面積を求める。
//   3. 面積が閾値（MIN_BODY_AREA_M2）に満たない水域（細い支流・水路・小さな池）を除く。
//   4. 1 m に丸め、描画範囲（EXTENT）で切り抜く。間引きは許容誤差 3 m で、枠に載った点は残す（継ぎ目が開かないように）。
//   5. 川の名前（対象 10 河川）の注記（川に沿った線）を、river-labels.json に書く。
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXTENT, toLocal, toLonLat } from './lib/projection.mjs';
import { loadWards } from './lib/wards.mjs';
import { fetchCached } from './lib/fetch-cache.mjs';
import { writeFeatureCollection } from './lib/geojson.mjs';
import { decodeTile } from './lib/mvt.mjs';
import { DATA_DIR } from './lib/paths.mjs';
import {
  Mask,
  splitByGrid,
  clipRingToBox,
  midpointOf,
  distanceToLand,
  nameWaterCells,
  nearestWaterCell,
  polygonArea,
  ringPerimeter,
  signedArea,
  simplifyRing,
} from './lib/rivers.mjs';
import { RIVER_NAMES, TRUNK_NAMES } from './lib/river-names.mjs';

const ZOOM = 14;
const TILE_URL = (x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${ZOOM}/${x}/${y}.pbf`;
const CONCURRENCY = 4;
const TILE_SIZE = 4096; // MVT の extent

/** WA の種別：5200 = 河川・湖沼などの水部、5100 = 海。海は描かない（標高・浸水の段に水面として塗るため）。 */
const WATER_CODE = 5200;
/** 水の名前の注記の種別：322 = 河川名（線または点）、321 = 湖沼名（点）。 */
const WATER_NAME_CODES = [322, 321];
/** 幅（2 × 面積 ÷ 周長、m）がこれに満たない面（ベクトルタイルの1つの水域のポリゴン）は、細い支流や水路として除く。 */
export const MIN_WIDTH_M = 12;
/** この面積（m²）に満たない水域（つながった水部のまとまり）は除く。細い支流・水路・小さな池を落とし、主な川と運河だけを残す。 */
export const MIN_BODY_AREA_M2 = 150_000;
/** 間引きの許容誤差（m）。 */
const TOLERANCE_M = 3;
/** 穴（中の島など）として残す面積の下限（m²）。 */
const MIN_HOLE_AREA_M2 = 1500;
/** 同じ名前の点が、これより近いものは重複（タイルの余白で重なった分）として1つにまとめる（m）。 */
const LABEL_DEDUPE_M = 300;
/** 名前の起点（注記の位置）から、水のセルを探す距離の上限（m）。 */
const SOURCE_SNAP_M = 150;
/** 注記から水に沿って名前を伝える距離の上限（m）。これより遠い水には名前を付けない。 */
const MAX_NAME_DISTANCE_M = 15_000;
/** 細い水路ほど、名前を伝える 1 歩を長く数える倍率（1 + NARROW_PENALTY × exp(−川幅の半分 ÷ WIDE_HALF_WIDTH_M)）。 */
const NARROW_PENALTY = 5;
const WIDE_HALF_WIDTH_M = 50;
/** 名前の標本を、名前ごとにこの大きさの正方形に 1 点ずつ取る（m）。 */
const SAMPLE_BLOCK_M = 250;
/** 大きな面を切り分ける格子の大きさ（m）。画面側の RIVER_GRID_M（src/layers/rivers.ts）と同じ値。 */
const SPLIT_CELL_M = 1000;
/** 「23区に近い」と判定する、23区の外へ広げる距離（m）。 */
const NEAR_WARD_M = 400;
/** 連結成分を求める格子のセル（m）。 */
const GRID_CELL_M = 10;

// ---------------------------------------------------------------- タイル座標

const lonToTileX = (lon) => ((lon + 180) / 360) * 2 ** ZOOM;
const latToTileY = (lat) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** ZOOM;
const tileXToLon = (fx) => (fx / 2 ** ZOOM) * 360 - 180;
const tileYToLat = (fy) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / 2 ** ZOOM))) * 180) / Math.PI;

/** 描画範囲を覆うタイルの範囲（四隅と各辺をたどって求める）。 */
function tileRange() {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const N = 36;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = EXTENT.minX + t * (EXTENT.maxX - EXTENT.minX);
    const y = EXTENT.minY + t * (EXTENT.maxY - EXTENT.minY);
    for (const [px, py] of [[x, EXTENT.minY], [x, EXTENT.maxY], [EXTENT.minX, y], [EXTENT.maxX, y]]) {
      const [lon, lat] = toLonLat(px, py);
      const fx = lonToTileX(lon), fy = latToTileY(lat);
      minX = Math.min(minX, Math.floor(fx)); maxX = Math.max(maxX, Math.floor(fx));
      minY = Math.min(minY, Math.floor(fy)); maxY = Math.max(maxY, Math.floor(fy));
    }
  }
  return { minX, maxX, minY, maxY };
}

/** タイル内の座標（0〜4096、y は下向き）→ ローカル座標（m）。 */
const tileToLocal = (tx, ty, u, v) =>
  toLocal(tileXToLon(tx + u / TILE_SIZE), tileYToLat(ty + v / TILE_SIZE));

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

// ---------------------------------------------------------------- 本体

async function build() {
  const range = tileRange();
  const tiles = [];
  for (let ty = range.minY; ty <= range.maxY; ty++) for (let tx = range.minX; tx <= range.maxX; tx++) tiles.push([tx, ty]);
  console.log(`取得: ${TILE_URL('{x}', '{y}')}`);
  console.log(`タイル範囲 x=${range.minX}..${range.maxX} y=${range.minY}..${range.maxY}（${tiles.length} 枚）`);

  // タイル内の 1 単位は、描画範囲の中央付近で約 0.485 m（ズーム 14、緯度 35.7 度）。範囲内での違いは 0.1% 未満。
  const metersPerUnit = (() => {
    const a = tileToLocal(range.minX, range.minY, 0, 0);
    const b = tileToLocal(range.minX, range.minY, TILE_SIZE, 0);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) / TILE_SIZE;
  })();
  console.log(`1 単位 = ${metersPerUnit.toFixed(3)} m（タイルの幅 ${(metersPerUnit * TILE_SIZE).toFixed(0)} m）`);
  let thinDropped = 0;

  /** 断片：タイルの枠で切り抜いた1つの面。 */
  // タイルは並列に取得するので、結果はタイルの順に並べ直す（何度実行しても同じ出力にする）
  const tilePieces = tiles.map(() => []);
  const tileAnnos = tiles.map(() => []);
  const t0 = Date.now();
  let done = 0;
  await mapLimit(tiles, CONCURRENCY, async ([tx, ty], tileIndex) => {
    const layers = decodeTile(await fetchCached(TILE_URL(tx, ty)));
    for (const feature of layers.WA?.features ?? []) {
      if (feature.properties.vt_code !== WATER_CODE || feature.type !== 3) continue;
      // MVT の面は、外周と穴が別のリング。外周ごとに、それに続く穴をまとめて1つの面にする。
      const rings = feature.geometry.map((r) => (r.length >= 4 ? r : null)).filter(Boolean);
      let current = null;
      let outerSign = 0;
      const polys = [];
      for (const ring of rings) {
        const a = signedArea(ring);
        if (a === 0) continue;
        if (!current || Math.sign(a) === outerSign) {
          outerSign = Math.sign(a);
          current = [ring];
          polys.push(current);
        } else current.push(ring);
      }
      for (const poly of polys) {
        // 幅（2 × 面積 ÷ 周長。細長い面なら川幅にほぼ等しい）が狭い面は、細い支流や水路として除く
        const widthM = (2 * polygonArea(poly) * metersPerUnit) / ringPerimeter(poly);
        if (widthM < MIN_WIDTH_M) {
          thinDropped++;
          continue;
        }
        const clipped = poly.map((r) => clipRingToBox(r, 0, 0, TILE_SIZE, TILE_SIZE)).filter(Boolean);
        if (clipped.length === 0) continue;
        // 外周が切り抜きで消えたのに穴だけが残る場合を除く（外周は最初のリング）
        if (!clipRingToBox(poly[0], 0, 0, TILE_SIZE, TILE_SIZE)) continue;
        tilePieces[tileIndex].push({ tx, ty, rings: clipped });
      }
    }
    for (const f of layers.Anno?.features ?? []) {
      const p = f.properties;
      // 河川名（線または点）と、湖沼名（点）。対象外の川や池の名前も、名前を伝える起点にする（その水域が、近くの対象の川の名前にならないように）。
      if (!WATER_NAME_CODES.includes(p.vt_code) || typeof p.vt_text !== 'string' || (f.type !== 1 && f.type !== 2)) continue;
      const line = f.geometry[0].map(([u, v]) => tileToLocal(tx, ty, u, v));
      tileAnnos[tileIndex].push({ name: p.vt_text, line });
    }
    done++;
    if (done % 60 === 0) console.log(`  ${done}/${tiles.length} 枚 処理済み`);
  });
  const pieces = tilePieces.flat();
  const annos = tileAnnos.flat();
  console.log(
    `細い面を除いた数 ${thinDropped}、断片 ${pieces.length}、河川名の注記 ${annos.length} 件（取得とデコード ${((Date.now() - t0) / 1000).toFixed(1)} 秒）`,
  );

  // --- ローカル座標に変換して間引く（枠に載った点は残す。継ぎ目が開かないように）
  const pinned = (pt) => pt[0] === 0 || pt[0] === TILE_SIZE || pt[1] === 0 || pt[1] === TILE_SIZE;
  let vertsBefore = 0;
  const local = []; // { rings（ローカル座標、丸める前）, area（m²） }
  for (const { tx, ty, rings } of pieces) {
    const out = [];
    for (const ring of rings) {
      vertsBefore += ring.length;
      const simplified = simplifyRing(ring, TOLERANCE_M / metersPerUnit, pinned);
      if (simplified) out.push(simplified.map(([u, v]) => tileToLocal(tx, ty, u, v)));
    }
    if (out.length === 0) continue;
    local.push({ rings: out, area: polygonArea(out) });
  }

  // --- 水域（つながった断片のまとまり）。格子に塗って、連結成分を求める。
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const { rings } of local) {
    for (const [x, y] of rings[0]) {
      gx0 = Math.min(gx0, x); gx1 = Math.max(gx1, x); gy0 = Math.min(gy0, y); gy1 = Math.max(gy1, y);
    }
  }
  const mask = new Mask(Math.floor(gx0) - 20, Math.floor(gy0) - 20, GRID_CELL_M, Math.ceil((gx1 - gx0 + 40) / GRID_CELL_M), Math.ceil((gy1 - gy0 + 40) / GRID_CELL_M));
  for (const p of local) mask.paint(p.rings);
  const { labels: cellLabel } = mask.label();
  const bodyArea = new Map();
  for (const p of local) {
    const [x, y] = p.rings[0][0];
    p.component = cellLabel[mask.cellOf(x, y)];
    bodyArea.set(p.component, (bodyArea.get(p.component) ?? 0) + p.area);
  }
  const roots = [...bodyArea.keys()].filter((r) => bodyArea.get(r) >= MIN_BODY_AREA_M2).sort((a, b) => bodyArea.get(b) - bodyArea.get(a));
  const bodyId = new Map(roots.map((r, i) => [r, i]));
  console.log(
    `水域 ${bodyArea.size} 個のうち、面積 ${(MIN_BODY_AREA_M2 / 1e6).toFixed(2)} km² 以上の ${roots.length} 個を残す` +
      `（最大 ${(bodyArea.get(roots[0]) / 1e6).toFixed(2)} km²、最小 ${(bodyArea.get(roots[roots.length - 1]) / 1e6).toFixed(2)} km²）`,
  );

  const features = [];
  let vertsAfter = 0;
  for (const p of local) {
    if (!bodyId.has(p.component)) continue;
    // 1 m に丸め、描画範囲（EXTENT）で切り抜く。外周が消えれば断片ごと除く。
    const rounded = p.rings.map((ring) => {
      const pts = [];
      for (const [x, y] of ring) {
        const q = [Math.round(x), Math.round(y)];
        const last = pts[pts.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
      }
      return pts;
    });
    if (rounded[0].length < 4) continue;
    const outer = clipRingToBox(rounded[0], EXTENT.minX, EXTENT.minY, EXTENT.maxX, EXTENT.maxY);
    if (!outer) continue;
    const clippedRings = [outer];
    for (const hole of rounded.slice(1)) {
      if (hole.length < 4 || Math.abs(signedArea(hole)) < MIN_HOLE_AREA_M2) continue;
      const h = clipRingToBox(hole, EXTENT.minX, EXTENT.minY, EXTENT.maxX, EXTENT.maxY);
      if (h) clippedRings.push(h);
    }
    if (Math.abs(signedArea(clippedRings[0])) < 1) continue;
    // GeoJSON は外周が反時計回り、穴が時計回り（RFC 7946）。deck.gl は向きを問わないが、揃えておく。
    const oriented = clippedRings.map((ring, k) => {
      const ccw = signedArea(ring) > 0;
      return (k === 0) === ccw ? ring : [...ring].reverse();
    });
    const body = bodyId.get(p.component); // 水域の番号（大きい順）。出力の並びを、近い面がまとまるように決めるのに使う
    p.body = body;
    // 大きな面は、1000 m の格子で切り分ける（23区に近いかを、小さな単位で決めるため）。切り分けた面は、隣と辺を共有する
    for (const sub of splitByGrid(oriented, SPLIT_CELL_M)) {
      vertsAfter += sub.reduce((n, ring) => n + ring.length, 0);
      features.push({ body, rings: sub });
    }
  }
  // 水域の番号順（大きい順）、同じ水域の中は読んだ順
  features.sort((a, b) => a.body - b.body);
  // 23区に近いか（in）：面の頂点の平均と、そのまわり 400 m の 8 方向の点のどれかが、23区の中にあれば true。
  // 23区の境は川の真ん中を通ることが多いので、境の川は「近い」とする。区から離れた上流・下流は、控えめに描く。
  const nearWards = loadWards();
  const isNear = (rings) => {
    const outer = rings[0];
    let cx = 0;
    let cy = 0;
    for (const [x, y] of outer) { cx += x; cy += y; }
    cx /= outer.length;
    cy /= outer.length;
    if (nearWards.contains(cx, cy)) return true;
    for (let k = 0; k < 8; k++) {
      const t = (k * Math.PI) / 4;
      if (nearWards.contains(cx + NEAR_WARD_M * Math.cos(t), cy + NEAR_WARD_M * Math.sin(t))) return true;
    }
    return false;
  };
  let nearCount = 0;
  const out = features.map((f) => {
    const near = isNear(f.rings);
    if (near) nearCount++;
    return { type: 'Feature', properties: { in: near }, geometry: { type: 'Polygon', coordinates: f.rings } };
  });
  const file = await writeFeatureCollection('rivers.geojson', out);
  console.log(`rivers.geojson: 面 ${features.length}（23区に近い ${nearCount}）、頂点 ${vertsBefore} → ${vertsAfter}、出力 ${file}`);

  // --- 川の名前。注記（河川名）は、川ごとに数か所しかなく、川に沿った短い線なので、断面が川を横切る位置の名前は、注記だけでは決まらない。
  // そこで、水域の格子（mask）の上で、すべての川の注記を起点に、水に沿った距離がいちばん近い起点の名前を、水のセルごとに決める
  // （起点には、対象外の川（石神井川など）の注記も含める。その支流が、近くの対象の川の名前になってしまわないように）。
  const keptComponent = new Set(roots);
  const sources = [];
  for (const a of annos) {
    const [ax, ay] = midpointOf(a.line);
    if (ax < EXTENT.minX || ax > EXTENT.maxX || ay < EXTENT.minY || ay > EXTENT.maxY) continue;
    const cell = nearestWaterCell(mask, cellLabel, keptComponent, ax, ay, SOURCE_SNAP_M);
    if (cell !== null) sources.push({ name: a.name, cell, x: ax, y: ay });
  }
  // 細い水路は、広い川の名前を取りにくく、広い川は、遠くの細い水路まで名前を伝えにくくする。川幅の目安から、1 歩の倍率を決める。
  const halfWidth = distanceToLand(mask);
  const stepCost = (c) => 1 + NARROW_PENALTY * Math.exp(-halfWidth[c] / WIDE_HALF_WIDTH_M);
  const owner = nameWaterCells(mask, cellLabel, keptComponent, sources.map((o) => o.cell), MAX_NAME_DISTANCE_M, stepCost);
  const wantedNames = RIVER_NAMES;
  // 水のセルを、名前ごとに 250 m 四方に 1 点ずつ（その区画の中心にいちばん近いセル）まとめて、標本の点にする
  const best = new Map();
  for (let c = 0; c < owner.length; c++) {
    if (owner[c] < 0) continue;
    const row = Math.floor(c / mask.w);
    const col = c - row * mask.w;
    const x = mask.minX + (col + 0.5) * mask.cell;
    const y = mask.minY + (row + 0.5) * mask.cell;
    if (x < EXTENT.minX || x > EXTENT.maxX || y < EXTENT.minY || y > EXTENT.maxY) continue;
    const name = sources[owner[c]].name;
    const k = wantedNames.indexOf(name); // 対象外の川は -1（「別の川」として、近くの対象の川に名前を取られないための標本）
    const bx = Math.floor(x / SAMPLE_BLOCK_M);
    const by = Math.floor(y / SAMPLE_BLOCK_M);
    const key = `${k}/${k < 0 ? name : ''}/${bx}/${by}`;
    const d = Math.hypot(x - (bx + 0.5) * SAMPLE_BLOCK_M, y - (by + 0.5) * SAMPLE_BLOCK_M);
    const cur = best.get(key);
    if (!cur || d < cur.d) best.set(key, { d, x: Math.round(x), y: Math.round(y), k });
  }
  const samples = [...best.values()].sort((p, q) => p.k - q.k || p.x - q.x || p.y - q.y).map((v) => [v.x, v.y, v.k]);

  // 地図に名前の札を出すための、川ごとの1点：23区の中にある標本の重心にいちばん近い標本
  const wards = loadWards();
  const anchors = [];
  for (let k = 0; k < wantedNames.length; k++) {
    const mine = samples.filter((s) => s[2] === k);
    if (mine.length === 0) {
      console.log(`  注意: ${wantedNames[k]} の標本がありません`);
      continue;
    }
    const inside = mine.filter((s) => wards.contains(s[0], s[1]));
    const pool = inside.length > 0 ? inside : mine;
    const mx = pool.reduce((t, s) => t + s[0], 0) / pool.length;
    const my = pool.reduce((t, s) => t + s[1], 0) / pool.length;
    const pick = pool.reduce((a, s) => (Math.hypot(s[0] - mx, s[1] - my) < Math.hypot(a[0] - mx, a[1] - my) ? s : a));
    anchors.push({ name: wantedNames[k], trunk: TRUNK_NAMES.includes(wantedNames[k]), x: pick[0], y: pick[1] });
  }
  const labelFile = path.join(DATA_DIR, 'river-labels.json');
  await writeFile(labelFile, JSON.stringify({ names: wantedNames, trunk: TRUNK_NAMES, anchors, samples }));
  const counts = {};
  for (const s of samples) counts[s[2] < 0 ? '（対象外）' : wantedNames[s[2]]] = (counts[s[2] < 0 ? '（対象外）' : wantedNames[s[2]]] ?? 0) + 1;
  console.log(`river-labels.json: 起点 ${sources.length} 件（注記 ${annos.length} 件のうち）、標本 ${samples.length} 点 ${JSON.stringify(counts)}`);
  console.log(`  札の位置: ${anchors.map((a) => `${a.name}(${a.x},${a.y})`).join(' ')}`);
  console.log(`出力: ${labelFile}`);

  const summary = roots.slice(0, 12).map((r, i) => `  水域 ${i}: ${(bodyArea.get(r) / 1e6).toFixed(2)} km²`);
  console.log(`大きい水域（上位 ${summary.length}）:\n${summary.join('\n')}`);
}

await build();
