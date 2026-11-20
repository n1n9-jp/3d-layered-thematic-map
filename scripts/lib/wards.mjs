// 23区の判定（前処理スクリプト共通）。「ある地点が23区内か」「どの区か」を、
// public/data/boundary.geojson（ローカル座標）をもとに答える。全レイヤーで同じ輪郭を使うために共有する。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';

/** 1つのポリゴン（外周＋穴）。外接矩形と、y 方向の帯ごとの辺リストを持つ。 */
class PolygonIndex {
  constructor(rings) {
    const edges = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = ring[i];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (i > 0) {
          const [px, py] = ring[i - 1];
          if (py !== y) edges.push(px, py, x, y);
        }
      }
    }
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
    this.edges = Float64Array.from(edges);

    // y を等間隔の帯に分け、各帯と交わる辺の番号を CSR 形式で持つ
    const edgeCount = this.edges.length / 4;
    this.bandCount = Math.max(1, Math.min(256, Math.round(Math.sqrt(edgeCount))));
    this.bandHeight = (maxY - minY) / this.bandCount || 1;
    const counts = new Int32Array(this.bandCount + 1);
    const span = (k) => {
      const y1 = this.edges[k * 4 + 1];
      const y2 = this.edges[k * 4 + 3];
      return [this.#band(Math.min(y1, y2)), this.#band(Math.max(y1, y2))];
    };
    for (let k = 0; k < edgeCount; k++) {
      const [lo, hi] = span(k);
      for (let b = lo; b <= hi; b++) counts[b + 1]++;
    }
    for (let b = 0; b < this.bandCount; b++) counts[b + 1] += counts[b];
    this.bandStart = counts;
    this.bandEdges = new Int32Array(counts[this.bandCount]);
    const fill = counts.slice(0, this.bandCount);
    for (let k = 0; k < edgeCount; k++) {
      const [lo, hi] = span(k);
      for (let b = lo; b <= hi; b++) this.bandEdges[fill[b]++] = k;
    }
  }

  #band(y) {
    return Math.min(this.bandCount - 1, Math.max(0, Math.floor((y - this.minY) / this.bandHeight)));
  }

  /** 点が内側か（偶奇規則。穴は外側になる）。 */
  contains(x, y) {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false;
    const b = this.#band(y);
    const e = this.edges;
    let inside = false;
    for (let i = this.bandStart[b], end = this.bandStart[b + 1]; i < end; i++) {
      const k = this.bandEdges[i] * 4;
      const x1 = e[k];
      const y1 = e[k + 1];
      const x2 = e[k + 2];
      const y2 = e[k + 3];
      if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
  }
}

/** Polygon / MultiPolygon の geometry を、ポリゴンごとの座標（リングの配列）の配列にそろえる。 */
function polygonsOf(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error(`Polygon / MultiPolygon ではありません: ${geometry?.type}`);
}

/**
 * Feature の配列（properties に code と name、geometry はローカル座標の Polygon / MultiPolygon）から、
 * 判定オブジェクトを作る。通常は loadWards を使う。
 */
export function createWards(features) {
  const entries = [];
  for (const feature of features) {
    const { code, name } = feature.properties;
    const ward = { code, name };
    for (const rings of polygonsOf(feature.geometry)) {
      entries.push({ ward, polygon: new PolygonIndex(rings) });
    }
  }

  /** (x, y)（ローカル座標、m）を含む区の { code, name }。どの区にも含まれなければ null。 */
  function wardAt(x, y) {
    for (const { ward, polygon } of entries) {
      if (polygon.contains(x, y)) return { code: ward.code, name: ward.name };
    }
    return null;
  }

  /** (x, y) がどれかの区に含まれるか。 */
  function contains(x, y) {
    for (const { polygon } of entries) {
      if (polygon.contains(x, y)) return true;
    }
    return false;
  }

  return { wardAt, contains, features };
}

/** `public/data/boundary.geojson`（または指定のファイル）を読んで、判定オブジェクトを返す。 */
export function loadWards(file = path.join(DATA_DIR, 'boundary.geojson')) {
  const { features } = JSON.parse(readFileSync(file, 'utf8'));
  return createWards(features);
}
