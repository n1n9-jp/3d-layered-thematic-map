// データ仕様（README「データ仕様」）の検証ロジック。
// 純粋関数（validateGeoJson / validateElevation / validateFileSizes）と、
// ディレクトリ全体を検証する validateDirectory、結果の整形 formatReport を提供する。
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { EXTENT } from './projection.mjs';
import { createWards } from './wards.mjs';

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

/**
 * GeoJSON ファイルごとの仕様。
 *  - geometry: 許可する geometry.type
 *  - properties: 項目名 → { test, expect }（expect は違反メッセージ用の説明）
 *  - category: 件数を内訳表示する項目名
 *  - unique: 値が Feature 間で重複してはならない項目名
 *  - extra: 追加の geometry 検査（問題があれば文字列を返す）
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
    },
    extra: (geom) =>
      geom.coordinates.length === 1 && geom.coordinates[0].length === 5
        ? null
        : 'メッシュは外周1つ・4隅（閉じた5点）の Polygon であること',
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
};

export const GEOJSON_FILES = Object.keys(GEOJSON_SPECS);
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

  summary.push(`件数: ${json.features.length}`);
  summary.push(`geometry: ${formatCounts(geomCounts)}`);
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
      if (name === 'boundary.geojson') {
        if (result.violationCount === 0) wards = createWards(parsed.value.features);
        else boundaryUnusable = true;
      }
      entries.push({ name, ...withStatus(result) });
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
