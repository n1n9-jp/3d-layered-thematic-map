import { describe, expect, it } from 'vitest';
import type { RoadCollection, RoadProps, SectionLine, SectionMarks } from '../types';
import { lineLength, reverseLine } from '../lib/section';
import roads from './roads';
import { buildRoadData, roadSectionIndex, sectionRoads, subsetRoads } from './roadsModel';

const road = (coordinates: [number, number][], props: Partial<RoadProps>) => ({
  type: 'Feature' as const,
  geometry: { type: 'LineString' as const, coordinates },
  properties: { class: 'other' as const, name: null, ...props },
});
const build = (...features: ReturnType<typeof road>[]) =>
  buildRoadData({ type: 'FeatureCollection', features } as RoadCollection);
const L = (ax: number, ay: number, bx: number, by: number): SectionLine => ({ ax, ay, bx, by });
const color = (cls: string): [number, number, number] => (cls === 'motorway' ? [1, 2, 3] : [9, 9, 9]);
const marks = (data: ReturnType<typeof build>, line: SectionLine): SectionMarks['marks'] => sectionRoads(data, line, color).marks;

const fc = build(
  road([[200, -100], [200, 100]], { class: 'motorway', name: '首都高' }),
  road([[500, -100], [500, 0], [500, 100]], { class: 'national', name: '国道1号' }), // 頂点が線の上
  road([[700, -50], [700, 50], [800, 50], [800, -50]], { class: 'other' }), // コの字：2回交わる
  road([[0, 10], [1000, 10]], { class: 'prefectural' }), // 線に平行
  road([[1200, -100], [1200, 100]], { class: 'other' }), // 線の先
);

describe('sectionRoads', () => {
  it('交点の距離・地点・種別・名前を、線に沿った距離の順に返す', () => {
    const m = marks(fc, L(0, 0, 1000, 0));
    expect(m.map((k) => [k.d, k.x, k.y, k.category, k.categoryLabel, k.name, k.offset])).toEqual([
      [200, 200, 0, 'motorway', '高速道路', '首都高', 0],
      [500, 500, 0, 'national', '国道', '国道1号', 0],
      [700, 700, 0, 'other', '一般道', null, 0],
      [800, 800, 0, 'other', '一般道', null, 0],
    ]);
    expect(m[0].color).toEqual([1, 2, 3]);
    expect(m[1].color).toEqual([9, 9, 9]);
  });
  it('頂点がちょうど線の上にある道路は、1回だけ数える（線の向きを逆にしても）', () => {
    expect(marks(fc, L(0, 0, 1000, 0)).filter((k) => k.name === '国道1号')).toHaveLength(1);
    expect(marks(fc, L(1000, 0, 0, 0)).filter((k) => k.name === '国道1号')).toHaveLength(1);
  });
  it('折れ線の端が線の上にあるときも、1回だけ数える', () => {
    const d = build(road([[300, 0], [300, 100]], {}), road([[400, -100], [400, 0]], {}));
    expect(marks(d, L(0, 0, 1000, 0)).map((k) => k.d)).toEqual([300, 400]);
  });
  it('線の端点ちょうどにある交点も含む。線の外の道路は含まない', () => {
    expect(marks(fc, L(200, 0, 600, 0)).map((k) => k.d)).toEqual([0, 300]);
    expect(marks(fc, L(0, 0, 150, 0))).toEqual([]);
  });
  it('向きを逆にすると、d は「長さ − d」で、地点と種別は同じ', () => {
    const line = L(-50, -30, 1100, 20);
    const len = lineLength(line);
    const f = marks(fc, line);
    const r = marks(fc, reverseLine(line));
    expect(f.length).toBeGreaterThan(3);
    expect(r.map((k) => [k.category, k.name])).toEqual([...f].reverse().map((k) => [k.category, k.name]));
    f.forEach((k, i) => {
      const q = r[r.length - 1 - i];
      expect(q.d).toBeCloseTo(len - k.d, 9);
      expect(q.x).toBeCloseTo(k.x, 9);
      expect(q.y).toBeCloseTo(k.y, 9);
    });
  });
  it('斜めの線でも、交点は線の上にあり、道路の上にもある', () => {
    const line = L(0, 0, 1000, 500);
    for (const k of marks(fc, line)) {
      expect(k.y).toBeCloseTo(k.x / 2, 9); // 線の上
      expect(k.d).toBeCloseTo(Math.hypot(k.x, k.y), 9);
    }
    expect(marks(fc, line).length).toBeGreaterThan(0);
  });
  it('描画用に間引く前の元の形との交点を返す', () => {
    // y = 100 の道路に、高さ 2 m（間引きの許容誤差 3 m 未満）の谷が x = 500 にある
    const d = build(road([[0, 100], [498, 100], [500, 98], [502, 100], [1000, 100]], {}));
    expect(d.paths.other[0]).toHaveLength(2); // 描画用は、谷が消えて直線
    const [k] = marks(d, L(500, 50, 500, 150));
    expect(k.y).toBeCloseTo(98, 9);
    expect(k.d).toBeCloseTo(48, 9);
  });
  it('長さ 0 の線、道路の範囲の外にある線は、交点なし', () => {
    expect(marks(fc, L(300, 300, 300, 300))).toEqual([]);
    expect(marks(fc, L(5000, 5000, 6000, 5000))).toEqual([]);
    expect(marks(build(), L(0, 0, 100, 0))).toEqual([]);
  });
  it('トラックの情報（ラベル、種類）', () => {
    expect(sectionRoads(fc, L(0, 0, 1000, 0), color)).toMatchObject({ kind: 'marks', label: '道路との交差' });
  });
  it('交点の数が、全線分を総当たりで調べた数と一致する（乱数の道路と線）', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const features = [];
    for (let i = 0; i < 300; i++) {
      const path: [number, number][] = [[rnd() * 5000, rnd() * 5000]];
      for (let j = 0; j < 6; j++) path.push([path[j][0] + (rnd() - 0.5) * 400, path[j][1] + (rnd() - 0.5) * 400]);
      features.push(road(path, {}));
    }
    const d = build(...features);
    for (let k = 0; k < 30; k++) {
      const line = L(rnd() * 5000, rnd() * 5000, rnd() * 5000, rnd() * 5000);
      let brute = 0;
      for (const { path } of d.lines)
        for (let i = 0; i + 1 < path.length; i++) {
          const [x1, y1] = path[i];
          const [x2, y2] = path[i + 1];
          const r = [line.bx - line.ax, line.by - line.ay];
          const s = [x2 - x1, y2 - y1];
          const den = r[0] * s[1] - r[1] * s[0];
          const t = ((x1 - line.ax) * s[1] - (y1 - line.ay) * s[0]) / den;
          const u = ((x1 - line.ax) * r[1] - (y1 - line.ay) * r[0]) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) brute++;
        }
      expect(marks(d, line)).toHaveLength(brute);
    }
  });
});

describe('roads.section（レイヤー）', () => {
  it('トラックを1つ返し、色は凡例の色（地図の配色）と同じ', () => {
    const tracks = roads.section(fc, L(0, 0, 1000, 0));
    expect(tracks).toHaveLength(1);
    const t = tracks[0] as SectionMarks;
    expect(t.kind).toBe('marks');
    const legendColors = roads.legend.map((e) => e.color);
    expect(t.marks.map((k) => k.category)).toEqual(['motorway', 'national', 'other', 'other']);
    for (const k of t.marks) expect(legendColors).toContainEqual(k.color);
    expect(t.marks[0].color).not.toEqual(t.marks[2].color);
  });
  it('subset の結果にも使える（円の外の道路は含まれない）', () => {
    const sub = subsetRoads(fc, 200, 0, 120);
    const t = roads.section(sub, L(0, 0, 1000, 0))[0] as SectionMarks;
    expect(t.marks.map((k) => k.d)).toEqual([200]);
  });
  it('索引はデータごとに1回だけ作る', () => {
    expect(roadSectionIndex(fc)).toBe(roadSectionIndex(fc));
  });
});
