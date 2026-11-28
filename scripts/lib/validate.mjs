// データ仕様（README「データ仕様」）の検証ロジック。
// 純粋関数（validateGeoJson / validateElevation / validateFileSizes）と、
// ディレクトリ全体を検証する validateDirectory、結果の整形 formatReport を提供する。
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { EXTENT } from './projection.mjs';
import { createWards } from './wards.mjs';
import { DEPTH_RANKS, DURATION_RANKS, FLOOD_FILES, OUTSIDE, TIDE_DURATION_RANKS } from './flood.mjs';
import { distanceToRings, polygonArea } from './rivers.mjs';

/** ファイルサイズの上限（1MB = 1024*1024 byte として扱う）。 */
export const SIZE_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
};

/** 標高格子の仕様値。 */
export const ELEVATION_SPEC = { width: 720, height: 720, cellSize: 50 };

/** elevation.json の min / max と、bin の有効値の最小・最大との差の許容（m）。生成側が値を丸めて書いても通るようにする。 */
export const ELEVATION_MINMAX_TOLERANCE = 0.05;

export const ROAD_CLASSES = ['motorway', 'national', 'prefectural', 'other'];
export const FACILITY_KINDS = ['school', 'hospital'];

/** 1ファイルあたり、報告に残す違反の最大数（件数は別に全数を数える）。 */
const STORED_VIOLATIONS = 200;

class Violations {
  constructor() {
    this.items = [];
    this.total = 0;
  }
  add(where, message) {
    this.total += 1;
    if (this.items.length < STORED_VIOLATIONS) this.items.push({ where, message });
  }
}

const round3 = (x) => Math.round(x * 1000) / 1000;

const show = (v) => {
  const s = JSON.stringify(v);
  const t = s === undefined ? String(v) : s;
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
};

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isNonNegativeNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isStringOrNull = (v) => v === null || typeof v === 'string';
const oneOf = (list) => (v) => list.includes(v);
const isBoolean = (v) => typeof v === 'boolean';
const isNonNegativeInteger = (v) => Number.isInteger(v) && v >= 0;
const isIsoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** 避難場所の災害種別（shelters.geojson の真偽値の項目）。洪水・高潮・内水氾濫・地震・大規模な火事・津波・崖崩れ。 */
export const SHELTER_HAZARDS = ['flood', 'tide', 'inland', 'quake', 'fire', 'tsunami', 'landslide'];

/**
 * GeoJSON ファイルごとの仕様。
 *  - geometry: 許可する geometry.type
 *  - properties: 項目名 → { test, expect }（expect は違反メッセージ用の説明）
 *  - category: 件数を内訳表示する項目名
 *  - unique: 値が Feature 間で重複してはならない項目名
 *  - extra: 追加の geometry 検査（問題があれば文字列を返す）
 *  - rowCheck: 1件の properties の項目どうしの関係の検査（項目ごとの検査が通ったときだけ。問題があれば文字列を返す）
 *  - collectionCheck: 全地物にまたがる検査（features を受け取り、{ where, message } の配列を返す）
 *  - summarize: 件数のほかに表示する要約（features を受け取り、文字列の配列を返す）
 */
export const GEOJSON_SPECS = {
  'boundary.geojson': {
    geometry: ['Polygon', 'MultiPolygon'],
    properties: {
      code: { test: (v) => typeof v === 'string' && /^\d{5}$/.test(v), expect: '5桁の数字の文字列' },
      name: { test: isNonEmptyString, expect: '空でない文字列' },
    },
    unique: 'code',
  },
  'population.geojson': {
    geometry: ['Polygon'],
    properties: {
      meshCode: { test: isNonEmptyString, expect: '空でない文字列' },
      population: { test: isNonNegativeNumber, expect: '0以上の数値' },
      density: { test: isNonNegativeNumber, expect: '0以上の数値' },
      elderly: { test: (v) => v === null || isNonNegativeInteger(v), expect: '0以上の整数（秘匿のメッシュは null）' },
      elderlyMerged: { test: isBoolean, expect: '真偽値' },
    },
    extra: (geom) =>
      geom.coordinates.length === 1 && geom.coordinates[0].length === 5
        ? null
        : 'メッシュは外周1つ・4隅（閉じた5点）の Polygon であること',
    rowCheck: (p) => (p.elderly !== null && p.elderly > p.population ? `elderly ${p.elderly} が population ${p.population} を上回っている（総人口を上限にする）` : null),
    summarize: (features) => {
      let sum = 0;
      let hidden = 0;
      let merged = 0;
      for (const f of features) {
        const p = f?.properties;
        if (!p) continue;
        if (p.elderly === null) hidden += 1;
        else if (typeof p.elderly === 'number') sum += p.elderly;
        if (p.elderlyMerged === true) merged += 1;
      }
      return [`65歳以上人口の合計: ${sum.toLocaleString('en-US')}（秘匿 ${hidden} メッシュ、合算先 ${merged} メッシュ）`];
    },
  },
  'roads.geojson': {
    geometry: ['LineString'],
    properties: {
      class: { test: oneOf(ROAD_CLASSES), expect: ROAD_CLASSES.join(' / ') },
      name: { test: isStringOrNull, expect: '文字列または null' },
    },
    category: 'class',
  },
  'rail.geojson': {
    geometry: ['LineString'],
    properties: {
      operator: { test: isNonEmptyString, expect: '空でない文字列' },
      line: { test: isNonEmptyString, expect: '空でない文字列' },
    },
  },
  'stations.geojson': {
    geometry: ['Point'],
    properties: {
      name: { test: isNonEmptyString, expect: '空でない文字列' },
      operator: { test: isNonEmptyString, expect: '空でない文字列' },
      line: { test: isNonEmptyString, expect: '空でない文字列' },
    },
  },
  'facilities.geojson': {
    geometry: ['Point'],
    properties: {
      kind: { test: oneOf(FACILITY_KINDS), expect: FACILITY_KINDS.join(' / ') },
      name: { test: isNonEmptyString, expect: '空でない文字列' },
      subtype: { test: isNonEmptyString, expect: '空でない文字列' },
    },
    category: 'kind',
  },
  'shelters.geojson': {
    geometry: ['Point'],
    properties: {
      name: { test: isNonEmptyString, expect: '空でない文字列' },
      address: { test: (v) => typeof v === 'string', expect: '文字列' },
      ward: { test: isNonEmptyString, expect: '区名（空でない文字列）' },
      ...Object.fromEntries(SHELTER_HAZARDS.map((k) => [k, { test: isBoolean, expect: '真偽値' }])),
      note: { test: isStringOrNull, expect: '文字列または null' },
    },
    collectionCheck: (features) => {
      // 洪水か高潮で使える場所が先、それ以外が後
      const usable = (f) => f?.properties?.flood === true || f?.properties?.tide === true;
      const firstOther = features.findIndex((f) => f?.properties && !usable(f));
      if (firstOther < 0) return [];
      const lateUsable = features.findIndex((f, i) => i > firstOther && f?.properties && usable(f));
      return lateUsable < 0
        ? []
        : [{ where: `features[${lateUsable}]`, message: `洪水か高潮で使える場所は、それ以外より先に並べる（features[${firstOther}] が先にある）` }];
    },
    summarize: (features) => {
      const n = (pred) => features.filter((f) => f?.properties && pred(f.properties)).length;
      return [
        `洪水 ${n((p) => p.flood === true)}、高潮 ${n((p) => p.tide === true)}、洪水または高潮 ${n((p) => p.flood === true || p.tide === true)}`,
      ];
    },
  },
};

// 川（水域の面）。属性は `in`（23区に近いか。近くない川は控えめに描く）だけ（名前は river-labels.json）。面は外周と穴のリングで、外周の面積が 0 でないこと。
GEOJSON_SPECS['rivers.geojson'] = {
  geometry: ['Polygon'],
  properties: { in: { test: isBoolean, expect: '真偽値（23区に近いか）' } },
  extra: (geom) => (polygonArea(geom.coordinates.slice(0, 1)) >= 1 ? null : '外周の面積が 0（1 m² 未満）'),
  summarize: (features) => {
    let area = 0;
    for (const f of features) if (f?.geometry?.type === 'Polygon' && Array.isArray(f.geometry.coordinates)) area += polygonArea(f.geometry.coordinates);
    const near = features.filter((f) => f?.properties?.in === true).length;
    return [`水域の面積の合計: ${(area / 1e6).toFixed(2)} km²、23区に近い面: ${near} / ${features.length}`];
  },
};

export const GEOJSON_FILES = Object.keys(GEOJSON_SPECS);
export const RIVER_LABEL_FILE = 'river-labels.json';
/** 名前の標本・札の根元が、水域の面の上（この距離 m 以内）にあること。標本は水のセル（10 m）の中心。 */
export const RIVER_SAMPLE_TOLERANCE = 25;
export const ELEVATION_FILES = ['elevation.json', 'elevation.bin'];

// ---- 座標・geometry の検査 -------------------------------------------------

/** 1つの position を検査し、問題があれば説明、なければ null。 */
function positionProblem(pos) {
  if (!Array.isArray(pos)) return `座標が配列でない: ${show(pos)}`;
  if (pos.length !== 2) return `座標は [x, y] の2要素のみ（z を含めない）: ${show(pos)}`;
  const [x, y] = pos;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return `座標が有限の数値でない: ${show(pos)}`;
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) return `座標が整数（1m単位）でない: ${show(pos)}`;
  if (x < EXTENT.minX || x > EXTENT.maxX || y < EXTENT.minY || y > EXTENT.maxY) {
    return `座標が EXTENT 外: ${show(pos)}`;
  }
  return null;
}

function positionsProblem(arr, min, label) {
  if (!Array.isArray(arr)) return `${label}が配列でない`;
  if (arr.length < min) return `${label}の点数が ${min} 未満（${arr.length}）`;
  for (const pos of arr) {
    const p = positionProblem(pos);
    if (p) return p;
  }
  return null;
}

function ringProblem(ring) {
  const p = positionsProblem(ring, 4, 'リング');
  if (p) return p;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return 'リングが閉じていない（始点と終点が異なる）';
  return null;
}

function polygonProblem(rings) {
  if (!Array.isArray(rings) || rings.length === 0) return 'Polygon の coordinates が空または配列でない';
  for (const ring of rings) {
    const p = ringProblem(ring);
    if (p) return p;
  }
  return null;
}

/** geometry の構造・座標を検査し、最初の問題を返す（なければ null）。 */
function geometryProblem(geom, allowed) {
  if (geom === null || typeof geom !== 'object') return 'geometry がオブジェクトでない';
  if (!allowed.includes(geom.type)) {
    return `geometry.type は ${allowed.join(' / ')} のみ（実際: ${show(geom.type)}）`;
  }
  switch (geom.type) {
    case 'Point':
      return positionProblem(geom.coordinates);
    case 'LineString':
      return positionsProblem(geom.coordinates, 2, '線');
    case 'Polygon':
      return polygonProblem(geom.coordinates);
    case 'MultiPolygon': {
      if (!Array.isArray(geom.coordinates) || geom.coordinates.length === 0) {
        return 'MultiPolygon の coordinates が空または配列でない';
      }
      for (const poly of geom.coordinates) {
        const p = polygonProblem(poly);
        if (p) return p;
      }
      return null;
    }
    default:
      return `未対応の geometry.type: ${show(geom.type)}`;
  }
}

/** geometry 内の全 position を順に渡す（検査済みの geometry 用）。 */
function forEachPosition(geom, fn) {
  const walk = (c) => {
    if (typeof c[0] === 'number') fn(c);
    else for (const child of c) walk(child);
  };
  walk(geom.coordinates);
}

// ---- GeoJSON ---------------------------------------------------------------

/**
 * GeoJSON（パース済みオブジェクト）を fileName の仕様で検証する。
 * @returns {{ summary: string[], violations: {where:string, message:string}[], violationCount: number }}
 */
export function validateGeoJson(fileName, json) {
  const spec = GEOJSON_SPECS[fileName];
  if (!spec) throw new Error(`仕様にないファイル名: ${fileName}`);
  const v = new Violations();
  const summary = [];

  if (json === null || typeof json !== 'object' || json.type !== 'FeatureCollection') {
    v.add('(root)', `type が FeatureCollection でない（実際: ${show(json?.type)}）`);
    return finish(summary, v);
  }
  if (!Array.isArray(json.features)) {
    v.add('(root)', 'features が配列でない');
    return finish(summary, v);
  }

  if (json.features.length === 0) v.add('features', '地物が0件（1件以上あること）');

  const geomCounts = {};
  const categoryCounts = {};
  const firstSeen = new Map();
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let population = 0;

  json.features.forEach((feature, i) => {
    const where = `features[${i}]`;
    if (feature === null || typeof feature !== 'object' || feature.type !== 'Feature') {
      v.add(where, `type が Feature でない（実際: ${show(feature?.type)}）`);
      return;
    }

    // geometry
    const gType = feature.geometry?.type;
    geomCounts[gType] = (geomCounts[gType] ?? 0) + 1;
    let problem = geometryProblem(feature.geometry, spec.geometry);
    if (!problem && spec.extra) problem = spec.extra(feature.geometry);
    if (problem) {
      v.add(`${where}.geometry`, problem);
    } else {
      forEachPosition(feature.geometry, ([x, y]) => {
        if (x < bbox[0]) bbox[0] = x;
        if (y < bbox[1]) bbox[1] = y;
        if (x > bbox[2]) bbox[2] = x;
        if (y > bbox[3]) bbox[3] = y;
      });
    }

    // properties
    const props = feature.properties;
    if (props === null || typeof props !== 'object' || Array.isArray(props)) {
      v.add(`${where}.properties`, 'properties がオブジェクトでない');
      return;
    }
    for (const [key, rule] of Object.entries(spec.properties)) {
      if (!(key in props)) {
        v.add(`${where}.properties`, `項目 ${key} がない`);
      } else if (!rule.test(props[key])) {
        v.add(`${where}.properties.${key}`, `値 ${show(props[key])} が不正（期待: ${rule.expect}）`);
      }
    }
    if (spec.rowCheck && Object.entries(spec.properties).every(([key, rule]) => key in props && rule.test(props[key]))) {
      const problem = spec.rowCheck(props);
      if (problem) v.add(`${where}.properties`, problem);
    }
    if (spec.unique && typeof props[spec.unique] === 'string') {
      const key = props[spec.unique];
      if (firstSeen.has(key)) {
        v.add(`${where}.properties.${spec.unique}`, `値 ${show(key)} が ${firstSeen.get(key)} と重複している`);
      } else {
        firstSeen.set(key, where);
      }
    }
    if (spec.category && spec.category in props) {
      const c = props[spec.category];
      categoryCounts[c] = (categoryCounts[c] ?? 0) + 1;
    }
    if (isNonNegativeNumber(props.population)) population += props.population;
  });

  if (spec.collectionCheck) for (const x of spec.collectionCheck(json.features)) v.add(x.where, x.message);

  summary.push(`件数: ${json.features.length}`);
  summary.push(`geometry: ${formatCounts(geomCounts)}`);
  if (spec.summarize) summary.push(...spec.summarize(json.features));
  if (spec.category) summary.push(`${spec.category}: ${formatCounts(categoryCounts)}`);
  if (fileNameHasPopulation(spec)) summary.push(`人口合計: ${population.toLocaleString('en-US')}`);
  if (bbox[0] !== Infinity) summary.push(`範囲: x ${bbox[0]}..${bbox[2]}, y ${bbox[1]}..${bbox[3]}`);
  return finish(summary, v);
}

const fileNameHasPopulation = (spec) => 'population' in spec.properties;

const formatCounts = (counts) =>
  Object.entries(counts)
    .map(([k, n]) => `${k}=${n}`)
    .join(', ') || '(なし)';

function finish(summary, v) {
  return { summary, violations: v.items, violationCount: v.total };
}

// ---- 標高 ------------------------------------------------------------------

/**
 * elevation.json（パース済み）と elevation.bin（Uint8Array / Buffer）を検証する。
 * min / max の一致は ELEVATION_MINMAX_TOLERANCE（0.05m）までの差を許容する。
 * wards（createWards の戻り値）を渡すと、セルの中心がどの区にも含まれないのに有効値が入っているセルを違反にする。
 */
export function validateElevation(meta, bin, { wards = null } = {}) {
  const v = new Violations();
  const summary = [];
  const W = 'elevation.json';

  if (meta === null || typeof meta !== 'object') {
    v.add(W, 'JSON がオブジェクトでない');
    return finish(summary, v);
  }
  const num = (k) => typeof meta[k] === 'number' && Number.isFinite(meta[k]);
  for (const k of ['width', 'height', 'cellSize', 'minX', 'minY', 'maxX', 'maxY', 'min', 'max']) {
    if (!num(k)) v.add(W, `項目 ${k} が有限の数値でない（実際: ${show(meta[k])}）`);
  }
  const expectEq = (k, expected) => {
    if (num(k) && meta[k] !== expected) v.add(W, `${k} は ${expected} であること（実際: ${meta[k]}）`);
  };
  expectEq('width', ELEVATION_SPEC.width);
  expectEq('height', ELEVATION_SPEC.height);
  expectEq('cellSize', ELEVATION_SPEC.cellSize);
  expectEq('minX', EXTENT.minX);
  expectEq('minY', EXTENT.minY);
  expectEq('maxX', EXTENT.maxX);
  expectEq('maxY', EXTENT.maxY);

  const expectedBytes = ELEVATION_SPEC.width * ELEVATION_SPEC.height * 4;
  const bytes = bin.byteLength;
  if (bytes !== expectedBytes) {
    v.add('elevation.bin', `バイト数は width × height × 4 = ${expectedBytes} であること（実際: ${bytes}）`);
  }

  // bin の走査（4バイト単位。端数は無視する）
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const count = Math.floor(bytes / 4);
  let min = Infinity;
  let max = -Infinity;
  let valid = 0;
  let nan = 0;
  let nonFinite = 0;
  for (let i = 0; i < count; i++) {
    const x = view.getFloat32(i * 4, true);
    if (Number.isNaN(x)) {
      nan += 1;
    } else if (!Number.isFinite(x)) {
      nonFinite += 1;
    } else {
      valid += 1;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  if (nonFinite > 0) v.add('elevation.bin', `±Infinity が ${nonFinite} セルある（データなしは NaN にする）`);
  if (valid === 0) {
    v.add('elevation.bin', '有効値（NaN 以外）が1つもない');
  } else {
    const tol = ELEVATION_MINMAX_TOLERANCE + 1e-4; // Float32 の表現誤差（標高の桁で 1e-5 程度）で、ちょうど 0.05m の差が落ちないようにする
    if (num('min') && Math.abs(meta.min - min) > tol) {
      v.add(W, `min が bin の最小値と一致しない（json: ${meta.min}, bin: ${min}）`);
    }
    if (num('max') && Math.abs(meta.max - max) > tol) {
      v.add(W, `max が bin の最大値と一致しない（json: ${meta.max}, bin: ${max}）`);
    }
  }

  // 区の外にあるセルの有効値（bin の大きさが仕様どおりのときだけ、仕様の格子として調べる）
  let outside = null;
  if (wards && bytes === expectedBytes) {
    const { width, height, cellSize } = ELEVATION_SPEC;
    outside = 0;
    let firstCell = null;
    for (let row = 0; row < height; row++) {
      const y = EXTENT.maxY - (row + 0.5) * cellSize;
      for (let col = 0; col < width; col++) {
        if (Number.isNaN(view.getFloat32((row * width + col) * 4, true))) continue;
        const x = EXTENT.minX + (col + 0.5) * cellSize;
        if (wards.contains(x, y)) continue;
        outside += 1;
        firstCell ??= { row, col, x, y };
      }
    }
    if (outside > 0) {
      v.add(
        'elevation.bin',
        `セルの中心がどの区にも含まれないのに有効値が入っているセルが ${outside} 個ある（例: row ${firstCell.row}, col ${firstCell.col}, 中心 x=${firstCell.x}, y=${firstCell.y}。区の外は NaN にする）`,
      );
    }
  }

  summary.push(`格子: ${meta.width} × ${meta.height}, cellSize ${meta.cellSize}m, ${bytes.toLocaleString('en-US')} bytes`);
  summary.push(`有効セル: ${valid}, NaN: ${nan}`);
  if (valid > 0) summary.push(`標高: min ${round3(min)}, max ${round3(max)}（json: ${meta.min}, ${meta.max}）`);
  if (wards) {
    summary.push(outside === null ? '区の外のセル: 検査できない（bin の大きさが仕様と異なる）' : `区の外の有効セル: ${outside}`);
  }
  return finish(summary, v);
}

// ---- 浸水想定（洪水・高潮）------------------------------------------------------

/**
 * 浸水想定の格子（標高と同じ 720×720、50m）の仕様。値は Uint8 で、区の外は 255、区内で浸水なしは 0。
 * 高潮の浸水継続時間は、1週間以上をすべてランク 5 にまとめるので、最大は 5（洪水の継続時間は 7）。
 */
export const FLOOD_BINS = [
  { key: 'riverDepth', file: FLOOD_FILES.riverDepth, maxRank: DEPTH_RANKS.length, required: true },
  { key: 'tideDepth', file: FLOOD_FILES.tideDepth, maxRank: DEPTH_RANKS.length, required: true },
  { key: 'riverDuration', file: FLOOD_FILES.riverDuration, maxRank: DURATION_RANKS.length, required: true },
  { key: 'tideDuration', file: FLOOD_FILES.tideDuration, maxRank: TIDE_DURATION_RANKS.length, required: true },
];

/** 検査の対象にするファイル名（flood.json と格子）。 */
export const FLOOD_ALL_FILES = [FLOOD_FILES.meta, ...FLOOD_BINS.map((b) => b.file)];

function rankListProblem(list, expected, name) {
  if (!Array.isArray(list)) return `${name} が配列でない`;
  if (list.length !== expected.length) return `${name} は ${expected.length} 件であること（実際: ${list.length}）`;
  for (let i = 0; i < expected.length; i++) {
    const item = list[i];
    if (item === null || typeof item !== 'object') return `${name}[${i}] がオブジェクトでない`;
    if (item.rank !== expected[i].rank) return `${name}[${i}].rank は ${expected[i].rank} であること（実際: ${show(item.rank)}）`;
    if (!isNonEmptyString(item.label)) return `${name}[${i}].label が空でない文字列でない（実際: ${show(item.label)}）`;
  }
  return null;
}

/**
 * flood.json（パース済み）と、格子（キーは FLOOD_BINS の key、値は Uint8Array / Buffer。なければ undefined）を検証する。
 * wards（createWards の戻り値）を渡すと、セルの中心が区の外なのに 255 でない（または区内なのに 255）のセルを違反にする。
 */
export function validateFlood(meta, bins, { wards = null } = {}) {
  const v = new Violations();
  const summary = [];
  const W = FLOOD_FILES.meta;

  if (meta === null || typeof meta !== 'object') {
    v.add(W, 'JSON がオブジェクトでない');
    return finish(summary, v);
  }
  const num = (k) => typeof meta[k] === 'number' && Number.isFinite(meta[k]);
  for (const k of ['width', 'height', 'cellSize', 'minX', 'minY', 'maxX', 'maxY']) {
    if (!num(k)) v.add(W, `項目 ${k} が有限の数値でない（実際: ${show(meta[k])}）`);
  }
  const expectEq = (k, expected) => {
    if (num(k) && meta[k] !== expected) v.add(W, `${k} は ${expected} であること（実際: ${meta[k]}）`);
  };
  expectEq('width', ELEVATION_SPEC.width);
  expectEq('height', ELEVATION_SPEC.height);
  expectEq('cellSize', ELEVATION_SPEC.cellSize);
  expectEq('minX', EXTENT.minX);
  expectEq('minY', EXTENT.minY);
  expectEq('maxX', EXTENT.maxX);
  expectEq('maxY', EXTENT.maxY);
  for (const [key, expected] of [['depthRanks', DEPTH_RANKS], ['durationRanks', DURATION_RANKS], ['tideDurationRanks', TIDE_DURATION_RANKS]]) {
    const p = rankListProblem(meta[key], expected, key);
    if (p) v.add(W, p);
  }
  if (!isNonEmptyString(meta.tideDurationNote)) v.add(W, 'tideDurationNote（高潮の継続時間のランクの注記）が空でない文字列でない');
  if (meta.sources === null || typeof meta.sources !== 'object') {
    v.add(W, 'sources がオブジェクトでない');
  } else {
    for (const k of ['river', 'tide']) {
      if (!isNonEmptyString(meta.sources[k]?.attribution)) v.add(W, `sources.${k}.attribution（出典の文面）が空でない文字列でない`);
    }
  }

  const { width, height, cellSize } = ELEVATION_SPEC;
  const expectedBytes = width * height;
  const nonMissing = (b) => b !== undefined && b !== null;

  for (const { key, file, maxRank, required } of FLOOD_BINS) {
    const bin = bins[key];
    if (meta.files?.[key] !== file) v.add(W, `files.${key} は ${show(file)} であること（実際: ${show(meta.files?.[key])}）`);
    if (!nonMissing(bin)) {
      if (required) v.add(file, 'ファイルがない（flood.json があるのに、格子がない）');
      continue;
    }
    if (bin.byteLength !== expectedBytes) {
      v.add(file, `バイト数は width × height = ${expectedBytes} であること（実際: ${bin.byteLength}）`);
      continue;
    }
    const counts = new Array(maxRank + 1).fill(0);
    let outsideCells = 0;
    let badValue = 0;
    let firstBad = null;
    let outsideNotMarked = 0;
    let insideMarked = 0;
    let firstCell = null;
    for (let row = 0; row < height; row++) {
      const y = EXTENT.maxY - (row + 0.5) * cellSize;
      for (let col = 0; col < width; col++) {
        const value = bin[row * width + col];
        if (value === OUTSIDE) outsideCells += 1;
        else if (value > maxRank) {
          badValue += 1;
          firstBad ??= { row, col, value };
        } else counts[value] += 1;
        if (wards) {
          const x = EXTENT.minX + (col + 0.5) * cellSize;
          const inside = wards.contains(x, y);
          if (inside && value === OUTSIDE) {
            insideMarked += 1;
            firstCell ??= { row, col, x, y };
          } else if (!inside && value !== OUTSIDE) {
            outsideNotMarked += 1;
            firstCell ??= { row, col, x, y };
          }
        }
      }
    }
    if (badValue > 0) {
      v.add(file, `値が 0〜${maxRank} と 255（区の外）以外のセルが ${badValue} 個ある（例: row ${firstBad.row}, col ${firstBad.col} = ${firstBad.value}）`);
    }
    if (outsideNotMarked > 0) {
      v.add(file, `セルの中心がどの区にも含まれないのに 255 でないセルが ${outsideNotMarked} 個ある（例: row ${firstCell.row}, col ${firstCell.col}, 中心 x=${firstCell.x}, y=${firstCell.y}。区の外は 255 にする）`);
    }
    if (insideMarked > 0) {
      v.add(file, `セルの中心が区の中なのに 255 のセルが ${insideMarked} 個ある（255 は区の外だけ。浸水なしは 0）`);
    }
    const inside = width * height - outsideCells;
    const flooded = inside - counts[0];
    summary.push(
      `${file}: ${bin.byteLength.toLocaleString('en-US')} bytes、区の外 ${outsideCells}、区内 ${inside}（浸水 ${flooded}）、` +
        `ランク別 ${counts.slice(1).map((n, i) => `${i + 1}=${n}`).join(' ')}`,
    );
  }
  return finish(summary, v);
}

// ---- 避難場所 ---------------------------------------------------------------

/**
 * shelters.geojson（パース済み）の各地点が、区の多角形の内側にあり、ward が座標から求めた区名と一致するかを検査する。
 * 地物の構造は validateGeoJson で検査済みの前提（壊れた地物は読み飛ばす）。wards は createWards の戻り値。
 */
export function validateSheltersInWards(json, wards) {
  const v = new Violations();
  let checked = 0;
  (json?.features ?? []).forEach((f, i) => {
    const c = f?.geometry?.coordinates;
    if (f?.geometry?.type !== 'Point' || !Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return;
    checked += 1;
    const ward = wards.wardAt(c[0], c[1]);
    if (!ward) v.add(`features[${i}].geometry`, `座標 ${show(c)} がどの区にも含まれない（23区内だけを残す）`);
    else if (f.properties?.ward !== ward.name) {
      v.add(`features[${i}].properties.ward`, `値 ${show(f.properties?.ward)} が座標から求めた区名 ${show(ward.name)} と違う`);
    }
  });
  return finish([`区の内側の検査: ${checked} 件`], v);
}

/**
 * shelters.json（パース済み）を検査する。
 *  - { updated, total, wards: [{ code, name, total, flood, tide, published, updated? }...] }
 *  - wards はコードの昇順で重複なし。total は区ごとの total の合計。published は total > 0 と一致
 *  - boundaryWards（boundary.geojson の区の { code, name } の配列）を渡すと、区の集合・名称が一致することを求める
 *  - geojson（shelters.geojson のパース済み）を渡すと、区ごとの件数（total・flood・tide）と全体の件数を突き合わせる
 */
export function validateShelterSummary(json, { geojson = null, boundaryWards = null } = {}) {
  const v = new Violations();
  const summary = [];
  const W = 'shelters.json';

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    v.add(W, 'JSON がオブジェクトでない');
    return finish(summary, v);
  }
  if (!isIsoDate(json.updated)) v.add(`${W}.updated`, `値 ${show(json.updated)} が不正（期待: YYYY-MM-DD の日付）`);
  if (!isNonNegativeInteger(json.total)) v.add(`${W}.total`, `値 ${show(json.total)} が不正（期待: 0以上の整数）`);
  if (!Array.isArray(json.wards)) {
    v.add(`${W}.wards`, 'wards が配列でない');
    return finish(summary, v);
  }

  let sum = 0;
  let prevCode = null;
  const seen = new Set();
  json.wards.forEach((w, i) => {
    const where = `${W}.wards[${i}]`;
    if (w === null || typeof w !== 'object') {
      v.add(where, 'オブジェクトでない');
      return;
    }
    if (typeof w.code !== 'string' || !/^\d{5}$/.test(w.code)) v.add(`${where}.code`, `値 ${show(w.code)} が不正（期待: 5桁の数字の文字列）`);
    else {
      if (seen.has(w.code)) v.add(`${where}.code`, `値 ${show(w.code)} が重複している`);
      else if (prevCode !== null && w.code < prevCode) v.add(`${where}.code`, `コードの昇順に並べる（${prevCode} の次に ${w.code}）`);
      seen.add(w.code);
      prevCode = w.code;
    }
    if (!isNonEmptyString(w.name)) v.add(`${where}.name`, `値 ${show(w.name)} が不正（期待: 空でない文字列）`);
    for (const k of ['total', 'flood', 'tide']) {
      if (!isNonNegativeInteger(w[k])) v.add(`${where}.${k}`, `値 ${show(w[k])} が不正（期待: 0以上の整数）`);
    }
    if (!isBoolean(w.published)) v.add(`${where}.published`, `値 ${show(w.published)} が不正（期待: 真偽値）`);
    if ('updated' in w && !isIsoDate(w.updated)) v.add(`${where}.updated`, `値 ${show(w.updated)} が不正（期待: YYYY-MM-DD の日付）`);
    if (isNonNegativeInteger(w.total)) {
      sum += w.total;
      if (isNonNegativeInteger(w.flood) && w.flood > w.total) v.add(where, `flood ${w.flood} が total ${w.total} を上回っている`);
      if (isNonNegativeInteger(w.tide) && w.tide > w.total) v.add(where, `tide ${w.tide} が total ${w.total} を上回っている`);
      if (isBoolean(w.published) && w.published !== w.total > 0) {
        v.add(`${where}.published`, `published は total > 0 と一致すること（total ${w.total}、published ${w.published}）`);
      }
    }
  });
  if (isNonNegativeInteger(json.total) && sum !== json.total) {
    v.add(`${W}.total`, `total ${json.total} が区ごとの total の合計 ${sum} と一致しない`);
  }

  if (boundaryWards) {
    const expected = new Map(boundaryWards.map((b) => [b.code, b.name]));
    const actual = new Map(json.wards.filter((w) => w && typeof w.code === 'string').map((w) => [w.code, w.name]));
    for (const [code, name] of expected) {
      if (!actual.has(code)) v.add(`${W}.wards`, `区 ${code} ${name} がない（boundary.geojson の全区を入れる）`);
      else if (actual.get(code) !== name) v.add(`${W}.wards`, `区 ${code} の名称 ${show(actual.get(code))} が boundary.geojson の ${show(name)} と違う`);
    }
    for (const code of actual.keys()) {
      if (!expected.has(code)) v.add(`${W}.wards`, `区 ${code} は boundary.geojson にない`);
    }
  }

  if (geojson && Array.isArray(geojson.features)) {
    const counts = new Map();
    for (const f of geojson.features) {
      const p = f?.properties;
      if (!p || typeof p.ward !== 'string') continue;
      const c = counts.get(p.ward) ?? { total: 0, flood: 0, tide: 0 };
      c.total += 1;
      if (p.flood === true) c.flood += 1;
      if (p.tide === true) c.tide += 1;
      counts.set(p.ward, c);
    }
    if (isNonNegativeInteger(json.total) && json.total !== geojson.features.length) {
      v.add(`${W}.total`, `total ${json.total} が shelters.geojson の件数 ${geojson.features.length} と一致しない`);
    }
    for (const w of json.wards) {
      if (!w || typeof w.name !== 'string') continue;
      const c = counts.get(w.name) ?? { total: 0, flood: 0, tide: 0 };
      for (const k of ['total', 'flood', 'tide']) {
        if (isNonNegativeInteger(w[k]) && w[k] !== c[k]) v.add(`${W}.wards(${w.name}).${k}`, `${w[k]} が shelters.geojson の数え直し ${c[k]} と一致しない`);
      }
      counts.delete(w.name);
    }
    for (const [name, c] of counts) v.add(`${W}.wards`, `shelters.geojson に ${name}（${c.total} 件）があるのに、shelters.json の wards にない`);
  }

  summary.push(`更新日: ${show(json.updated)}、合計 ${show(json.total)} 件、区 ${json.wards.length}`);
  const unpublished = json.wards.filter((w) => w && w.published === false).map((w) => w.name);
  summary.push(`未公開の区: ${unpublished.length === 0 ? '(なし)' : unpublished.join('、')}`);
  return finish(summary, v);
}

// ---- 川の名前 ---------------------------------------------------------------

/**
 * river-labels.json（パース済み）を検査する。
 *  - { names, trunk, anchors: [{ name, trunk, x, y }], samples: [[x, y, 名前の番号]] }
 *  - names は川の名前（実データは scripts/lib/river-names.mjs の RIVER_NAMES、仮データは仮の名前）、trunk はその一部（幹となる川）。
 *    anchors は names の川ごとに 1 点以内で、trunk の川は必ず 1 点（札の根元）。
 *  - samples の名前の番号は -1（対象外の川）か names の添字。座標は整数（1 m 単位）で EXTENT の内側。
 *  - rivers（rivers.geojson のパース済み）を渡すと、anchors と samples が水域の面の上（RIVER_SAMPLE_TOLERANCE 以内）にあることを求める。
 */
export function validateRiverLabels(json, { rivers = null } = {}) {
  const v = new Violations();
  const summary = [];
  const W = RIVER_LABEL_FILE;
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    v.add(W, 'JSON がオブジェクトでない');
    return finish(summary, v);
  }
  const names = Array.isArray(json.names) ? json.names : [];
  if (!Array.isArray(json.names) || names.length === 0 || !names.every(isNonEmptyString) || new Set(names).size !== names.length) {
    v.add(`${W}.names`, `値 ${show(json.names)} が不正（期待: 空でない文字列の配列で、重複しない）`);
  }
  const trunk = Array.isArray(json.trunk) ? json.trunk : [];
  if (!Array.isArray(json.trunk) || !trunk.every((n) => names.includes(n))) v.add(`${W}.trunk`, `値 ${show(json.trunk)} が不正（期待: names の中の名前の配列）`);
  const inExtent = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= EXTENT.minX && x <= EXTENT.maxX && y >= EXTENT.minY && y <= EXTENT.maxY;
  const polygons = rivers && Array.isArray(rivers.features) ? rivers.features.map((f) => f?.geometry?.coordinates).filter(Array.isArray) : null;
  const boxes = polygons
    ? polygons.map((rings) => {
        const b = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of rings[0] ?? []) {
          b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
        }
        return b;
      })
    : null;
  /** 点が、いずれかの面の縁の上か内側か（外周の内側、または縁から tolerance 以内）。 */
  const onWater = (x, y) => {
    const tol = RIVER_SAMPLE_TOLERANCE;
    for (let i = 0; i < polygons.length; i++) {
      const b = boxes[i];
      if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) continue;
      const rings = polygons[i];
      // 外周の内側（偶奇則）か、縁に近い
      let inside = false;
      const ring = rings[0];
      for (let a = 0, c = ring.length - 2; a < ring.length - 1; c = a++) {
        const [xa, ya] = ring[a];
        const [xc, yc] = ring[c];
        if (ya > y !== yc > y && x < ((xc - xa) * (y - ya)) / (yc - ya) + xa) inside = !inside;
      }
      if (inside || distanceToRings([x, y], rings) <= tol) return true;
    }
    return false;
  };

  if (!Array.isArray(json.anchors)) v.add(`${W}.anchors`, 'anchors が配列でない');
  else {
    const seen = new Set();
    json.anchors.forEach((a, i) => {
      const where = `${W}.anchors[${i}]`;
      if (!a || !names.includes(a.name)) return v.add(where, `name ${show(a?.name)} が names にない`);
      if (seen.has(a.name)) v.add(where, `name ${show(a.name)} が重複している`);
      seen.add(a.name);
      if (a.trunk !== trunk.includes(a.name)) v.add(where, `trunk ${show(a.trunk)} が trunk の一覧と合わない`);
      if (!inExtent(a.x, a.y)) v.add(where, `座標 (${show(a.x)}, ${show(a.y)}) が整数でない、または EXTENT 外`);
      else if (polygons && !onWater(a.x, a.y)) v.add(where, `座標 (${a.x}, ${a.y}) が水域の面の上にない`);
    });
    const missing = trunk.filter((n) => !seen.has(n));
    if (missing.length > 0) v.add(`${W}.anchors`, `幹となる川の札の根元がない: ${missing.join('、')}`);
    summary.push(`札の根元: ${json.anchors.map((a) => a?.name).join('、')}`);
  }
  if (!Array.isArray(json.samples)) v.add(`${W}.samples`, 'samples が配列でない');
  else {
    const counts = new Map();
    let off = 0;
    json.samples.forEach((s, i) => {
      const where = `${W}.samples[${i}]`;
      if (!Array.isArray(s) || s.length !== 3) return v.add(where, `[x, y, 名前の番号] でない: ${show(s)}`);
      const [x, y, k] = s;
      if (!inExtent(x, y)) return v.add(where, `座標 (${show(x)}, ${show(y)}) が整数でない、または EXTENT 外`);
      if (!Number.isInteger(k) || k < -1 || k >= names.length) return v.add(where, `名前の番号 ${show(k)} が不正（-1 か 0〜${names.length - 1}）`);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (polygons && off < 1e9 && !onWater(x, y)) {
        off += 1;
        if (off <= 5) v.add(where, `座標 (${x}, ${y}) が水域の面の上にない`);
      }
    });
    if (off > 5) v.add(`${W}.samples`, `水域の面の上にない標本が合計 ${off} 点`);
    for (let k = 0; k < names.length; k++) if (!counts.get(k)) v.add(`${W}.samples`, `${names[k]} の標本がない`);
    summary.push(`標本: ${json.samples.length} 点（対象外の川 ${counts.get(-1) ?? 0}）`);
  }
  return finish(summary, v);
}

// ---- ファイルサイズ ---------------------------------------------------------

/** @param {{name:string,size:number}[]} files */
export function validateFileSizes(files, limits = SIZE_LIMITS) {
  const v = new Violations();
  let total = 0;
  for (const { name, size } of files) {
    total += size;
    if (size > limits.maxFileBytes) {
      v.add(name, `${formatBytes(size)} が 1ファイルの上限 ${formatBytes(limits.maxFileBytes)} を超えている`);
    }
  }
  if (total > limits.maxTotalBytes) {
    v.add('(合計)', `${formatBytes(total)} が合計の上限 ${formatBytes(limits.maxTotalBytes)} を超えている`);
  }
  const summary = [`ファイル数: ${files.length}, 合計: ${formatBytes(total)}（上限 ${formatBytes(limits.maxTotalBytes)}）`];
  return finish(summary, v);
}

export function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

// ---- ディレクトリ検証 --------------------------------------------------------

async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push({ name: path.relative(base, full), size: (await stat(full)).size });
  }
  return out;
}

const missingResult = (names, requireAll) => ({
  status: requireAll ? 'ng' : 'missing',
  summary: [],
  violations: requireAll ? [{ where: names, message: 'ファイルが存在しない（--require-all）' }] : [],
  violationCount: requireAll ? 1 : 0,
});

function parseJson(buf, where) {
  try {
    return { value: JSON.parse(buf.toString('utf8')) };
  } catch (e) {
    return { error: { where, message: `JSON として読めない: ${e.message}` } };
  }
}

function withStatus(result) {
  return { ...result, status: result.violationCount > 0 ? 'ng' : 'ok' };
}

/**
 * ディレクトリ内の全データを検証する。
 * @returns {Promise<{ dir: string, entries: Array<{name:string,status:'ok'|'ng'|'missing',summary:string[],violations:object[],violationCount:number}>, totalViolations: number, ok: boolean }>}
 */
export async function validateDirectory(dir, { requireAll = false } = {}) {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`ディレクトリがない: ${dir}`);

  const entries = [];
  let wards = null; // boundary.geojson が仕様どおりのときだけ、標高の範囲の検査に使う
  let boundaryUnusable = false;
  const parsedJson = new Map(); // ファイル名 → パース済みの JSON（読めたもの）

  for (const name of GEOJSON_FILES) {
    const buf = await readIfExists(path.join(dir, name));
    if (buf === null) {
      entries.push({ name, ...missingResult(name, requireAll) });
      continue;
    }
    const parsed = parseJson(buf, name);
    if (parsed.error) {
      if (name === 'boundary.geojson') boundaryUnusable = true;
      entries.push({ name, status: 'ng', summary: [], violations: [parsed.error], violationCount: 1 });
    } else {
      const result = validateGeoJson(name, parsed.value);
      parsedJson.set(name, parsed.value);
      if (name === 'boundary.geojson') {
        if (result.violationCount === 0) wards = createWards(parsed.value.features);
        else boundaryUnusable = true;
      }
      entries.push({ name, ...withStatus(result) });
    }
  }

  // 避難場所：区の内側か、shelters.json との整合
  const geojsonEntry = (name) => entries.find((e) => e.name === name);
  const sheltersGeoJson = parsedJson.get('shelters.geojson');
  const sheltersEntry = geojsonEntry('shelters.geojson');
  if (sheltersEntry && sheltersGeoJson && wards && sheltersEntry.violationCount === 0) {
    const extra = validateSheltersInWards(sheltersGeoJson, wards);
    sheltersEntry.summary.push(...extra.summary);
    sheltersEntry.violations.push(...extra.violations);
    sheltersEntry.violationCount += extra.violationCount;
    sheltersEntry.status = sheltersEntry.violationCount > 0 ? 'ng' : 'ok';
  } else if (sheltersEntry && sheltersGeoJson && sheltersEntry.violationCount === 0) {
    sheltersEntry.summary.push('区の内側の検査: boundary.geojson がないか違反があるため検査していない');
  }
  const summaryName = 'shelters.json';
  const summaryBuf = await readIfExists(path.join(dir, summaryName));
  if (summaryBuf === null) {
    entries.push({ name: summaryName, ...missingResult(summaryName, requireAll) });
  } else {
    const parsed = parseJson(summaryBuf, summaryName);
    if (parsed.error) {
      entries.push({ name: summaryName, status: 'ng', summary: [], violations: [parsed.error], violationCount: 1 });
    } else {
      const boundaryJson = wards ? parsedJson.get('boundary.geojson') : null;
      const result = validateShelterSummary(parsed.value, {
        geojson: sheltersEntry?.violationCount === 0 ? sheltersGeoJson : null,
        boundaryWards: boundaryJson ? boundaryJson.features.map((f) => ({ code: f.properties.code, name: f.properties.name })) : null,
      });
      entries.push({ name: summaryName, ...withStatus(result) });
    }
  }

  // 川の名前（rivers.geojson と対）。rivers.geojson が仕様どおりのときは、標本と札の根元が水域の面の上にあることも検査する
  {
    const name = RIVER_LABEL_FILE;
    const buf = await readIfExists(path.join(dir, name));
    if (buf === null) {
      entries.push({ name, ...missingResult(name, requireAll) });
    } else {
      const parsed = parseJson(buf, name);
      if (parsed.error) entries.push({ name, status: 'ng', summary: [], violations: [parsed.error], violationCount: 1 });
      else {
        const riversEntry = geojsonEntry('rivers.geojson');
        const rivers = riversEntry?.violationCount === 0 ? parsedJson.get('rivers.geojson') : null;
        const result = validateRiverLabels(parsed.value, { rivers });
        if (!rivers) result.summary.push('水域の面の上か: rivers.geojson がないか違反があるため検査していない');
        entries.push({ name, ...withStatus(result) });
      }
    }
  }

  const label = 'elevation.json + elevation.bin';
  const metaBuf = await readIfExists(path.join(dir, 'elevation.json'));
  const binBuf = await readIfExists(path.join(dir, 'elevation.bin'));
  if (metaBuf === null && binBuf === null) {
    entries.push({ name: label, ...missingResult(label, requireAll) });
  } else if (metaBuf === null || binBuf === null) {
    const absent = metaBuf === null ? 'elevation.json' : 'elevation.bin';
    entries.push({
      name: label,
      status: 'ng',
      summary: [],
      violations: [{ where: absent, message: 'ペアの片方しか存在しない' }],
      violationCount: 1,
    });
  } else {
    const parsed = parseJson(metaBuf, 'elevation.json');
    if (parsed.error) {
      entries.push({ name: label, status: 'ng', summary: [], violations: [parsed.error], violationCount: 1 });
    } else {
      const result = validateElevation(parsed.value, binBuf, { wards });
      if (boundaryUnusable) result.summary.push('区の外のセル: boundary.geojson に違反があるため検査していない');
      entries.push({ name: label, ...withStatus(result) });
    }
  }

  // 浸水想定（flood.json と、flood-*.bin）。1つも作られていなければ「未作成」
  {
    const label = 'flood.json + flood-*.bin';
    const metaBuf = await readIfExists(path.join(dir, FLOOD_FILES.meta));
    const bins = {};
    for (const { key, file } of FLOOD_BINS) bins[key] = (await readIfExists(path.join(dir, file))) ?? undefined;
    if (metaBuf === null && Object.values(bins).every((b) => b === undefined)) {
      entries.push({ name: label, ...missingResult(label, requireAll) });
    } else if (metaBuf === null) {
      entries.push({
        name: label,
        status: 'ng',
        summary: [],
        violations: [{ where: FLOOD_FILES.meta, message: 'ファイルがない（格子だけがある）' }],
        violationCount: 1,
      });
    } else {
      const parsed = parseJson(metaBuf, FLOOD_FILES.meta);
      if (parsed.error) {
        entries.push({ name: label, status: 'ng', summary: [], violations: [parsed.error], violationCount: 1 });
      } else {
        const result = validateFlood(parsed.value, bins, { wards });
        if (boundaryUnusable) result.summary.push('区の外のセル: boundary.geojson に違反があるため検査していない');
        else if (!wards) result.summary.push('区の外のセル: boundary.geojson がないので検査していない');
        entries.push({ name: label, ...withStatus(result) });
      }
    }
  }

  const sizeResult = validateFileSizes(await listFiles(dir));
  entries.push({ name: 'ファイルサイズ', ...withStatus(sizeResult) });

  const totalViolations = entries.reduce((n, e) => n + e.violationCount, 0);
  return { dir, entries, totalViolations, ok: totalViolations === 0 };
}

// ---- 表示 ------------------------------------------------------------------

/** validateDirectory の結果を表示用の文字列にする。違反は各ファイル先頭 maxShown 件まで。 */
export function formatReport(report, { maxShown = 10 } = {}) {
  const tag = { ok: 'OK', ng: 'NG', missing: '未作成' };
  const lines = [`検証対象: ${report.dir}`, ''];
  for (const e of report.entries) {
    lines.push(`[${tag[e.status]}] ${e.name}`);
    for (const s of e.summary) lines.push(`    ${s}`);
    if (e.violationCount > 0) {
      const shown = Math.min(maxShown, e.violations.length);
      lines.push(`    違反 ${e.violationCount} 件${shown < e.violationCount ? `（先頭 ${shown} 件を表示）` : ''}:`);
      for (const x of e.violations.slice(0, shown)) lines.push(`      - ${x.where}: ${x.message}`);
    }
  }
  lines.push('');
  lines.push(report.ok ? '結果: 違反なし' : `結果: 違反 ${report.totalViolations} 件`);
  return lines.join('\n');
}
