// 浸水想定（洪水・高潮）を、標高と同じ 50m 格子に落とす純粋な処理。ネットワーク・ファイルには触れない。
// build-flood.mjs が使う。格子の約束は elevation.bin と同じ：行は北から南、列は西から東、値はセルの中心。
//   列 col・行 row のセルの中心は x = minX + (col + 0.5) × cellSize、y = maxY − (row + 0.5) × cellSize
import proj4 from 'proj4';
import { EXTENT, PROJ } from './projection.mjs';

/** 浸水深のランク（国土数値情報 A31b の想定最大規模のランクと同じ区切り）。minM 以上 maxM 未満。 */
export const DEPTH_RANKS = [
  { rank: 1, label: '0.5m 未満', minM: 0, maxM: 0.5 },
  { rank: 2, label: '0.5〜3m', minM: 0.5, maxM: 3 },
  { rank: 3, label: '3〜5m', minM: 3, maxM: 5 },
  { rank: 4, label: '5〜10m', minM: 5, maxM: 10 },
  { rank: 5, label: '10〜20m', minM: 10, maxM: 20 },
  { rank: 6, label: '20m 以上', minM: 20, maxM: null },
];

/** 浸水継続時間のランク（A31b の浸水継続時間と同じ区切り）。minH 以上 maxH 未満（時間）。 */
export const DURATION_RANKS = [
  { rank: 1, label: '12時間未満', minH: 0, maxH: 12 },
  { rank: 2, label: '12〜24時間', minH: 12, maxH: 24 },
  { rank: 3, label: '1日〜3日', minH: 24, maxH: 72 },
  { rank: 4, label: '3日〜1週間', minH: 72, maxH: 168 },
  { rank: 5, label: '1週間〜2週間', minH: 168, maxH: 336 },
  { rank: 6, label: '2週間〜4週間', minH: 336, maxH: 672 },
  { rank: 7, label: '4週間以上', minH: 672, maxH: null },
];

/**
 * 高潮の浸水継続時間のランク。1〜4 は洪水と同じ区切り。港湾局のデータは計算期間が約1週間で、1週間を超えて引かなかったセルは
 * 特別値（999999 分）になっており、1週間を超える値の違いは区別できないので、1週間以上をすべてランク 5 にまとめる。
 */
export const TIDE_DURATION_RANKS = [
  ...DURATION_RANKS.slice(0, 4),
  { rank: 5, label: '1週間以上', minH: 168, maxH: null },
];

/** 区の外のセルの値。 */
export const OUTSIDE = 255;

/** 浸水深（m）→ ランク。浸水なし（0 以下・数値でない）は 0。 */
export function depthRankOf(meters) {
  if (!(meters > 0)) return 0;
  if (meters < 0.5) return 1;
  if (meters < 3) return 2;
  if (meters < 5) return 3;
  if (meters < 10) return 4;
  if (meters < 20) return 5;
  return 6;
}

/** 浸水継続時間（分）→ ランク。0 以下・数値でないものは 0。 */
export function durationRankOfMinutes(minutes) {
  if (!(minutes > 0)) return 0;
  const h = minutes / 60;
  if (h < 12) return 1;
  if (h < 24) return 2;
  if (h < 72) return 3;
  if (h < 168) return 4;
  if (h < 336) return 5;
  if (h < 672) return 6;
  return 7;
}

/**
 * 高潮の浸水継続時間（分。TermMin）→ ランク（TIDE_DURATION_RANKS）。値がない（数値でない）ものは 0。
 * 継続時間の値があるセルは浸水深 0.5m 以上になったセルなので、0 分でもランク 1（12時間未満）とする。
 * 1週間以上（有限の値で 10080 分以上のものと、特別値 999999）は 5。
 */
export function tideDurationRankOf(minutes) {
  if (!(minutes >= 0)) return 0;
  return Math.min(5, Math.max(1, durationRankOfMinutes(minutes)));
}

/** 出典と、想定の前提（flood.json の sources）。 */
export const FLOOD_SOURCES = {
  river: {
    name: '国土数値情報 洪水浸水想定区域データ（A31b）',
    publisher: '国土交通省',
    url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A31b-2025.html',
    attribution:
      '「国土数値情報（洪水浸水想定区域データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A31b-2025.html）を加工して作成',
    vintage: '2025年度版',
    scenario: '想定最大規模',
    notes: [
      '洪水予報河川・水位周知河川と、その他の河川を重ねた、セルごとの最大',
      '支川の氾濫・高潮・内水（下水・排水が追いつかない浸水）は考慮していない',
      '浸水継続時間は、浸水深 0.5m 以上が続く時間',
    ],
  },
  tide: {
    name: '高潮浸水想定区域図［想定最大規模］（浸水深）',
    publisher: '東京都港湾局',
    url: 'https://www.kouwan.metro.tokyo.lg.jp/jishin_kouwankyoku_oshirase/takashio/shinsuisoutei',
    attribution:
      '「東京都港湾局『高潮浸水想定区域図』（令和6年12月改定）（https://www.kouwan.metro.tokyo.lg.jp/jishin_kouwankyoku_oshirase/takashio/shinsuisoutei）を加工して作成」',
    vintage: '令和6年12月改定',
    scenario: '想定最大規模（堤防等の決壊を見込む）',
    license: 'CC BY 4.0',
    notes: ['10m セルの浸水深（DepthM）の、50m セルの中の最大', '河川の氾濫・内水は考慮していない'],
  },
};

/** 高潮の浸水継続時間のランクの注記（flood.json の tideDurationNote）。 */
export const TIDE_DURATION_NOTE =
  '高潮の浸水継続時間（flood-tide-duration.bin）のランクは、tideDurationRanks の表を使う（洪水の durationRanks とは別）。' +
  '港湾局のデータは計算期間が約1週間で、1週間を超えて引かなかったセルは特別値（999999 分）になっており、それ以上は区別できない。' +
  'そのため、ランク 1〜4 は洪水と同じ区切り（12時間未満、12〜24時間、1日〜3日、3日〜1週間）、1週間以上（1週間を超える有限の値と特別値）はすべてランク 5 にまとめ、ランク 6・7 は使わない。' +
  '継続時間は浸水深 0.5m 以上が続く時間で、浸水深 0.5m 未満のセルには値がない（0）。';


// ---------------------------------------------------------------- flood.json

/** 出力するファイル名（public/data/ の中）。 */
export const FLOOD_FILES = {
  riverDepth: 'flood-river.bin',
  tideDepth: 'flood-tide.bin',
  riverDuration: 'flood-river-duration.bin',
  tideDuration: 'flood-tide-duration.bin',
  meta: 'flood.json',
};

/** flood.json の中身。 */
export function createFloodMeta(grid) {
  return {
    width: grid.width,
    height: grid.height,
    cellSize: grid.cellSize,
    minX: grid.minX,
    minY: grid.minY,
    maxX: grid.maxX,
    maxY: grid.maxY,
    depthRanks: DEPTH_RANKS,
    durationRanks: DURATION_RANKS,
    tideDurationRanks: TIDE_DURATION_RANKS,
    files: {
      riverDepth: FLOOD_FILES.riverDepth,
      tideDepth: FLOOD_FILES.tideDepth,
      riverDuration: FLOOD_FILES.riverDuration,
      tideDuration: FLOOD_FILES.tideDuration,
    },
    values: { none: 0, outside: OUTSIDE },
    tideDurationNote: TIDE_DURATION_NOTE,
    sources: FLOOD_SOURCES,
  };
}

// ---------------------------------------------------------------- 格子

/** 格子の定義。省略時は標高と同じ（EXTENT、50m、720×720）。 */
export function createGrid({ minX, minY, maxX, maxY } = EXTENT, cellSize = 50) {
  const width = Math.round((maxX - minX) / cellSize);
  const height = Math.round((maxY - minY) / cellSize);
  return { width, height, cellSize, minX, minY, maxX, maxY };
}

/** 列 col のセルの中心の x。 */
export const cellCenterX = (grid, col) => grid.minX + (col + 0.5) * grid.cellSize;
/** 行 row のセルの中心の y。 */
export const cellCenterY = (grid, row) => grid.maxY - (row + 0.5) * grid.cellSize;

/** 地点を含むセルの添字。格子の外なら -1。 */
export function cellIndexAt(grid, x, y) {
  const col = Math.floor((x - grid.minX) / grid.cellSize);
  const row = Math.floor((grid.maxY - y) / grid.cellSize);
  if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return -1;
  return row * grid.width + col;
}

// ---------------------------------------------------------------- 走査線法

/** セルの中心の x が x 以上になる最初の列（なければ width）。 */
function firstColAtOrAfter(grid, x) {
  const { width } = grid;
  let c = Math.ceil((x - grid.minX) / grid.cellSize - 0.5);
  if (!(c > 0)) c = 0; // NaN と負
  if (c > width) c = width;
  // 浮動小数点の丸めで1つずれることがあるので、セルの中心の式そのもので確かめて合わせる
  while (c > 0 && cellCenterX(grid, c - 1) >= x) c--;
  while (c < width && cellCenterX(grid, c) < x) c++;
  return c;
}

/**
 * 多角形（外周と穴。偶奇規則）の内側にあるセルの値を value にする。ただし、すでに value 以上の値が入っているセルは変えない
 * （複数の多角形が重なるセルは最大が残る）。「セルの中心が内側か」で決める走査線法。
 *
 * - rings: リングの配列。各リングは [x, y]（ローカル座標、m）の配列。閉じていなくてもよい（最後の点から最初の点へも辺とみなす）
 * - 内側の判定は、wards.mjs の contains と同じ（辺の下端を含み上端を含まない半開区間で交点を数え、交点の x が点の x より大きいものが
 *   奇数個なら内側）。セルの中心がちょうど辺の上にある場合も、素朴な「点が内側か」の判定と一致する
 * - 格子の外にはみ出す部分は無視する
 *
 * @param {{width:number,height:number,cellSize:number,minX:number,maxY:number}} grid
 * @param {Uint8Array} out 行は北から南、列は西から東（width × height）
 * @param {number[][][]} rings
 * @param {number} value
 */
export function fillPolygonMax(grid, out, rings, value) {
  const { width, height, cellSize, maxY } = grid;

  // 多角形の y の範囲から、関係する行を決める
  let polyMinY = Infinity;
  let polyMaxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      const y = p[1];
      if (y < polyMinY) polyMinY = y;
      if (y > polyMaxY) polyMaxY = y;
    }
  }
  if (!(polyMinY <= polyMaxY)) return;
  const rowOfY = (y) => (maxY - y) / cellSize - 0.5; // この値の行の中心が y（小数）
  const r0 = Math.max(0, Math.floor(rowOfY(polyMaxY)) - 1);
  const r1 = Math.min(height - 1, Math.ceil(rowOfY(polyMinY)) + 1);
  if (r0 > r1) return;
  const rowCount = r1 - r0 + 1;

  // 辺ごとに、中心の y が [下端, 上端) に入る行を求めて、その行での交点の x を集める。2回走査（数える・詰める）して、配列の割り当てを避ける
  const counts = new Int32Array(rowCount + 1);
  const visit = (emit) => {
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1 === n ? 0 : i + 1];
        if (y1 === y2) continue;
        const lo = y1 < y2 ? y1 : y2;
        const hi = y1 < y2 ? y2 : y1;
        const ra = Math.max(r0, Math.floor(rowOfY(hi)) - 1);
        const rb = Math.min(r1, Math.ceil(rowOfY(lo)) + 1);
        for (let r = ra; r <= rb; r++) {
          const y = maxY - (r + 0.5) * cellSize;
          if (y1 > y !== y2 > y) emit(r - r0, ((x2 - x1) * (y - y1)) / (y2 - y1) + x1);
        }
      }
    }
  };
  visit((k) => counts[k + 1]++);
  for (let k = 0; k < rowCount; k++) counts[k + 1] += counts[k];
  const xs = new Float64Array(counts[rowCount]);
  const fill = counts.slice(0, rowCount);
  visit((k, x) => {
    xs[fill[k]++] = x;
  });

  for (let k = 0; k < rowCount; k++) {
    const start = counts[k];
    const end = counts[k + 1];
    if (end - start < 2) continue;
    const row = xs.subarray(start, end).sort(); // Float64Array の sort は数値順
    const base = (r0 + k) * width;
    // 点の x が [row[2j], row[2j+1]) に入るとき内側
    for (let j = 0; j + 1 < row.length; j += 2) {
      const ca = firstColAtOrAfter(grid, row[j]);
      const cb = firstColAtOrAfter(grid, row[j + 1]);
      for (let c = ca; c < cb; c++) {
        if (out[base + c] < value) out[base + c] = value;
      }
    }
  }
}

/** GeoJSON の Polygon / MultiPolygon の coordinates から、多角形ごとのリングの配列を取り出す。 */
export function polygonsOf(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

// ---------------------------------------------------------------- 高潮（10m セルの点データ）

/** 東京都港湾局の高潮浸水想定区域図の座標系（JGD2011 平面直角座標系 第9系）。 */
export const PLANE_IX = '+proj=tmerc +lat_0=36 +lon_0=139.8333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m';

const planeToLocal = proj4(PLANE_IX, PROJ);

/** 第9系の座標（X = 東向き、Y = 北向き。m）→ ローカル座標 [x, y]。 */
export function planeIXToLocal(planeX, planeY) {
  return planeToLocal.forward([planeX, planeY]);
}

/** 点（ローカル座標）の値を、それを含むセルの最大として積む。格子の外なら何もしない。積んだら true。 */
export function accumulateMax(grid, cells, x, y, value) {
  const i = cellIndexAt(grid, x, y);
  if (i < 0) return false;
  if (!(cells[i] >= value)) cells[i] = value; // 初期値 NaN・負でも置き換わる
  return true;
}

// ---------------------------------------------------------------- dBASE（.dbf）

/**
 * .dbf から、数値のフィールドを列ごとに読む。削除済みの行は飛ばす。
 * 数値でない（空欄・読めない）値は NaN。フィールド名は ASCII として照合する（日本語名のフィールドは読まないので、文字コードは問わない）。
 * @param {Uint8Array} bytes
 * @param {string[]} names 読むフィールド名
 * @returns {{ count: number, columns: Record<string, Float64Array> }}
 */
export function readDbfNumbers(bytes, names) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);

  const fields = new Map();
  let offset = 1; // 先頭の1バイトは削除フラグ
  for (let o = 32; o + 32 <= headerLength && bytes[o] !== 0x0d; o += 32) {
    let name = '';
    for (let i = 0; i < 11 && bytes[o + i] !== 0; i++) name += String.fromCharCode(bytes[o + i]);
    const length = bytes[o + 16];
    fields.set(name, { offset, length });
    offset += length;
  }
  for (const name of names) {
    if (!fields.has(name)) throw new Error(`.dbf にフィールド ${name} がありません（あるのは ${[...fields.keys()].join(', ')}）`);
  }

  const columns = Object.fromEntries(names.map((name) => [name, new Float64Array(records)]));
  let count = 0;
  for (let i = 0; i < records; i++) {
    const r = headerLength + i * recordLength;
    if (r + recordLength > bytes.length) throw new Error('.dbf が途中で終わっています');
    if (bytes[r] === 0x2a) continue; // '*' は削除済み
    for (const name of names) {
      const { offset: fo, length } = fields.get(name);
      let s = '';
      for (let k = 0; k < length; k++) s += String.fromCharCode(bytes[r + fo + k]);
      columns[name][count] = s.trim() === '' ? NaN : Number(s);
    }
    count++;
  }
  for (const name of names) columns[name] = columns[name].subarray(0, count);
  return { count, columns };
}
