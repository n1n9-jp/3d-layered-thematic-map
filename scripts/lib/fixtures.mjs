// 仮データ（原点を中心とする半径約13kmの円形の「仮の都市」）の生成。
// 乱数は種を固定した mulberry32 のみを使うので、何度実行しても同じ出力になる。
import { EXTENT } from './projection.mjs';
import { ELEVATION_SPEC } from './validate.mjs';

export const CITY_RADIUS = 13000;
const SEED = 20240601;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rad = (deg) => (deg * Math.PI) / 180;
const polar = (r, angle) => [Math.round(r * Math.cos(angle)), Math.round(r * Math.sin(angle))];
const feature = (geometry, properties) => ({ type: 'Feature', geometry, properties });
const collection = (features) => ({ type: 'FeatureCollection', features });
const pad = (n, width) => String(n).padStart(width, '0');

/** 隣接する同一座標の重複点を除く（丸めで重なった点の整理）。 */
function dedupe(points) {
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}

// ---- 区境界 ----------------------------------------------------------------

function makeBoundary(rand) {
  const SECTORS = 6;
  const start = rad(15);
  // 扇の境界角。等分から少しずらして区の大きさに差をつける。
  const edges = [];
  for (let i = 0; i < SECTORS; i++) edges.push(start + (i * 2 * Math.PI) / SECTORS + rad((rand() - 0.5) * 16));
  edges.push(edges[0] + 2 * Math.PI);

  const names = 'ABCDEFGH';
  const features = [];
  for (let i = 0; i < SECTORS; i++) {
    const a0 = edges[i];
    const a1 = edges[i + 1];
    const steps = Math.ceil((a1 - a0) / rad(3));
    const ring = [[0, 0]];
    for (let s = 0; s <= steps; s++) ring.push(polar(CITY_RADIUS, a0 + ((a1 - a0) * s) / steps));
    ring.push([0, 0]);
    features.push(
      feature({ type: 'Polygon', coordinates: [dedupe(ring)] }, { code: String(13101 + i), name: `仮${names[i]}区` }),
    );
  }
  return collection(features);
}

// ---- 人口メッシュ -----------------------------------------------------------

function makePopulation(rand) {
  const CELL = 500;
  const AREA_KM2 = (CELL * CELL) / 1e6;
  const features = [];
  const n = Math.ceil(CITY_RADIUS / CELL);
  let id = 0;
  for (let j = -n; j < n; j++) {
    for (let i = -n; i < n; i++) {
      const x0 = i * CELL;
      const y0 = j * CELL;
      const r = Math.hypot(x0 + CELL / 2, y0 + CELL / 2);
      if (r > CITY_RADIUS) continue;
      // 中心ほど高い密度（人/km²）。±20%の揺らぎ。
      const density = 500 + 24000 * Math.exp(-r / 4500);
      const population = Math.round(density * AREA_KM2 * (0.8 + 0.4 * rand()));
      id += 1;
      features.push(
        feature(
          {
            type: 'Polygon',
            coordinates: [[[x0, y0], [x0 + CELL, y0], [x0 + CELL, y0 + CELL], [x0, y0 + CELL], [x0, y0]]],
          },
          { meshCode: pad(id, 4), population, density: population / AREA_KM2 },
        ),
      );
    }
  }
  return collection(features);
}

// ---- 標高 ------------------------------------------------------------------

function makeElevation(rand) {
  const { width, height, cellSize } = ELEVATION_SPEC;
  const phase = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const data = new Float32Array(width * height);
  let min = Infinity;
  let max = -Infinity;
  for (let row = 0; row < height; row++) {
    const y = EXTENT.maxY - (row + 0.5) * cellSize; // 行は北から南
    for (let col = 0; col < width; col++) {
      const x = EXTENT.minX + (col + 0.5) * cellSize; // 列は西から東
      if (Math.hypot(x, y) > CITY_RADIUS) {
        data[row * width + col] = NaN;
        continue;
      }
      const slope = 38 * (1 - (x + CITY_RADIUS) / (2 * CITY_RADIUS)); // 西が高く東が低い
      const bumps =
        5 * Math.sin(x / 2800 + phase[0]) * Math.cos(y / 2300 + phase[1]) + 3 * Math.sin((x + y) / 1700 + phase[2]);
      const h = Math.min(50, Math.max(0, 2 + slope + bumps));
      const v = Math.fround(Math.round(h * 10) / 10); // 0.1m 単位に丸める
      data[row * width + col] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const bin = Buffer.alloc(data.length * 4);
  data.forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const meta = { width, height, cellSize, ...EXTENT, min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 };
  return { meta, bin };
}

// ---- 道路 ------------------------------------------------------------------

function makeRoads(rand) {
  const features = [];
  const road = (cls, name, coordinates) =>
    features.push(feature({ type: 'LineString', coordinates: dedupe(coordinates) }, { class: cls, name }));

  /** 角度 angle の放射線（r0〜r1）。中心線から横に少し蛇行させる。 */
  const radial = (cls, name, angle, r0, r1) => {
    const wiggle = 60 + rand() * 40;
    const ph = rand() * 6.28;
    const pts = [];
    for (let r = r0; r <= r1; r += 500) {
      const off = wiggle * Math.sin(r / 2200 + ph);
      pts.push([Math.round(r * Math.cos(angle) - off * Math.sin(angle)), Math.round(r * Math.sin(angle) + off * Math.cos(angle))]);
    }
    road(cls, name, pts);
  };
  /** 半径 r の環状線（閉じた LineString）。 */
  const ring = (cls, name, r) => {
    const n = Math.max(24, Math.round((2 * Math.PI * r) / 400));
    const pts = [];
    for (let k = 0; k < n; k++) pts.push(polar(r, (2 * Math.PI * k) / n));
    pts.push(pts[0]);
    road(cls, name, pts);
  };

  // 高速道路：環状1本 + 放射3本
  ring('motorway', '仮環状高速', 9000);
  for (let k = 0; k < 3; k++) radial('motorway', `仮高速${k + 1}号`, rad(20 + k * 120), 3000, 12800);
  // 国道：環状1本 + 放射6本
  ring('national', '仮環状国道', 5500);
  for (let k = 0; k < 6; k++) radial('national', `国道${k + 1}号（仮）`, rad(50 + k * 60), 500, 12800);
  // 県道：環状1本 + 放射12本
  ring('prefectural', '仮環状県道', 3000);
  for (let k = 0; k < 12; k++) radial('prefectural', `県道${k + 1}号（仮）`, rad(5 + k * 30), 1000, 12800);
  // その他：1500m間隔の格子（円内に収まる区間のみ）
  const lim = 12500;
  for (let c = -9000; c <= 9000; c += 1500) {
    const half = Math.floor(Math.sqrt(lim * lim - c * c) / 250) * 250;
    const horizontal = [];
    const vertical = [];
    for (let t = -half; t <= half; t += 250) {
      horizontal.push([t, c]);
      vertical.push([c, t]);
    }
    road('other', c % 3000 === 0 ? `仮通り東西${c / 1500 + 6}` : null, horizontal);
    road('other', c % 3000 === 0 ? `仮通り南北${c / 1500 + 6}` : null, vertical);
  }
  return collection(features);
}

// ---- 鉄道・駅 ----------------------------------------------------------------

function makeRail(rand) {
  const railFeatures = [];
  const stationFeatures = [];

  /**
   * 路線を作る。points(t) は媒介変数 t（m）の位置、stationTs は駅の t、
   * vertexTs は線の頂点の t。駅の位置は必ず線の頂点になるようにする。
   */
  const addLine = ({ operator, line, short, points, stationTs, vertexTs, closed }) => {
    const ts = [...new Set([...vertexTs, ...stationTs])].sort((a, b) => a - b);
    const coords = ts.map(points);
    if (closed) coords.push(coords[0]);
    railFeatures.push(feature({ type: 'LineString', coordinates: coords }, { operator, line }));
    stationTs.forEach((t, k) =>
      stationFeatures.push(feature({ type: 'Point', coordinates: points(t) }, { name: `仮${short}${pad(k + 1, 2)}駅`, operator, line })),
    );
  };

  // 環状線：半径4500m、駅は約1.5km間隔（19駅）
  const RING_R = 4500;
  const circumference = 2 * Math.PI * RING_R;
  const ringStations = 19;
  addLine({
    operator: '仮鉄道',
    line: '仮環状線',
    short: '環',
    points: (t) => polar(RING_R, t / RING_R),
    stationTs: Array.from({ length: ringStations }, (_, k) => (k * circumference) / ringStations),
    vertexTs: Array.from({ length: 72 }, (_, k) => (k * circumference) / 72),
    closed: true,
  });

  // 中心を通る3路線：媒介変数 t は中心からの距離（-L〜L）。中心で横ずれ0になる曲がりを与える。
  const L = 12500;
  const diameters = [
    { operator: '仮メトロ', line: '仮東西線', short: '東西', angle: rad(8) },
    { operator: '仮メトロ', line: '仮南北線', short: '南北', angle: rad(97) },
    { operator: '仮電鉄', line: '仮斜行線', short: '斜', angle: rad(52) },
  ];
  for (const d of diameters) {
    const amp = 300 + rand() * 300;
    const points = (t) => {
      const off = amp * Math.sin((Math.PI * t) / L);
      return [
        Math.round(t * Math.cos(d.angle) - off * Math.sin(d.angle)),
        Math.round(t * Math.sin(d.angle) + off * Math.cos(d.angle)),
      ];
    };
    const stationTs = [];
    for (let t = -L + 500; t <= L - 500; t += 1000 + rand() * 1000) stationTs.push(Math.round(t));
    addLine({
      ...d,
      points,
      stationTs,
      vertexTs: Array.from({ length: 101 }, (_, k) => -L + (k * 2 * L) / 100),
      closed: false,
    });
  }
  return { rail: collection(railFeatures), stations: collection(stationFeatures) };
}

// ---- 施設 ------------------------------------------------------------------

function makeFacilities(rand) {
  const features = [];
  /** 円内に、中心寄りの分布で点を置く。 */
  const place = () => polar((CITY_RADIUS - 600) * Math.pow(rand(), 0.7), rand() * 2 * Math.PI);
  const pick = (list) => list[Math.floor(rand() * list.length)];

  const schoolTypes = ['小学校', '小学校', '小学校', '中学校', '中学校', '高等学校'];
  for (let i = 1; i <= 150; i++) {
    const subtype = pick(schoolTypes);
    features.push(feature({ type: 'Point', coordinates: place() }, { kind: 'school', name: `仮${subtype}${pad(i, 3)}`, subtype }));
  }
  const hospitalTypes = ['病院', '診療所', '診療所'];
  for (let i = 1; i <= 40; i++) {
    const subtype = pick(hospitalTypes);
    features.push(feature({ type: 'Point', coordinates: place() }, { kind: 'hospital', name: `仮${subtype}${pad(i, 2)}`, subtype }));
  }
  return collection(features);
}

/**
 * 全仮データをメモリ上に生成する。
 * @returns {{ geojson: Record<string, object>, elevation: { meta: object, bin: Buffer } }}
 */
export function generateFixtures() {
  const rand = mulberry32(SEED);
  const boundary = makeBoundary(rand);
  const population = makePopulation(rand);
  const elevation = makeElevation(rand);
  const roads = makeRoads(rand);
  const { rail, stations } = makeRail(rand);
  const facilities = makeFacilities(rand);
  return {
    geojson: {
      'boundary.geojson': boundary,
      'population.geojson': population,
      'roads.geojson': roads,
      'rail.geojson': rail,
      'stations.geojson': stations,
      'facilities.geojson': facilities,
    },
    elevation,
  };
}
