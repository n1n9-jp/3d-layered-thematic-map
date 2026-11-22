import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../config';
import type { RailCollection, SectionLine, SectionMarks, StationCollection } from '../types';
import { lineLength, reverseLine } from '../lib/section';
import transit from './transit';
import { STATION_SECTION_RADIUS, buildTransitData, sectionTransit } from './transitModel';

const rail = (line: string, coordinates: [number, number][]) => ({
  type: 'Feature' as const,
  geometry: { type: 'LineString' as const, coordinates },
  properties: { operator: 'A社', line },
});
const station = (name: string, line: string, xy: [number, number]) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: xy },
  properties: { name, operator: 'A社', line },
});
const L = (ax: number, ay: number, bx: number, by: number): SectionLine => ({ ax, ay, bx, by });
const colors = { rail: [1, 1, 1] as [number, number, number], station: [2, 2, 2] as [number, number, number] };

const data = buildTransitData(
  {
    type: 'FeatureCollection',
    features: [
      rail('南北線', [[300, -500], [300, 500]]),
      rail('環状線', [[700, -100], [700, 0], [800, 100]]), // 頂点（700, 0）が線の上：1回だけ数える
      rail('遠い線', [[3000, -500], [3000, 500]]),
    ],
  } as RailCollection,
  {
    type: 'FeatureCollection',
    features: [
      station('中央', '南北線', [300, 100]), // 線の左（北）100 m
      station('中央', '環状線', [320, -50]), // 同名で、線の右（南）50 m：こちらのほうが近い
      station('北', '南北線', [500, 480]), // 480 m（含む）
      station('遠北', '南北線', [500, 520]), // 520 m（除く）
      station('南', '南北線', [600, -300]), // 右 300 m
      station('手前', '南北線', [-50, 10]), // 垂線の足が始点より手前（d = -50）：除く
      station('先', '南北線', [1050, 10]), // 垂線の足が終点より先（d = 1050）：除く
      station('端', '南北線', [1000, 200]), // 垂線の足が終点ちょうど：含む
    ],
  } as StationCollection,
);
const line = L(0, 0, 1000, 0);
const [rails, stations] = sectionTransit(data, line, colors);

describe('sectionTransit', () => {
  it('2つのトラックを返す（路線との交差、近くの駅）', () => {
    expect(rails).toMatchObject({ kind: 'marks', label: '鉄道との交差' });
    expect(stations).toMatchObject({ kind: 'marks', label: '近くの駅' });
    expect(transit.section(data, line, DEFAULT_OPTIONS)).toHaveLength(2);
  });
  it('路線との交点：d、地点、category は rail、name は路線名。距離の順', () => {
    expect(rails.marks.map((k) => [k.d, k.x, k.y, k.category, k.name, k.offset])).toEqual([
      [300, 300, 0, 'rail', '南北線', 0],
      [700, 700, 0, 'rail', '環状線', 0],
    ]);
    expect(rails.marks[0].categoryLabel).toBe('鉄道');
    expect(rails.marks[0].color).toEqual([1, 1, 1]);
  });
  it('駅：500 m 以内で、垂線の足が線分の内側のものだけ。d は足の位置、offset は左が正', () => {
    expect(stations.marks.map((k) => [k.name, k.d, k.offset])).toEqual([
      ['中央', 320, -50], // 同名の2駅のうち、線に近いほう
      ['北', 500, 480],
      ['南', 600, -300],
      ['端', 1000, 200],
    ]);
    expect(stations.marks[0]).toMatchObject({ x: 320, y: -50, category: 'station', categoryLabel: '駅', color: [2, 2, 2] });
    expect(STATION_SECTION_RADIUS).toBe(500);
  });
  it('向きを逆にすると、d は「長さ − d」、offset は符号が逆になる', () => {
    const rev = sectionTransit(data, reverseLine(line), colors);
    const len = lineLength(line);
    expect(rev[0].marks.map((k) => k.d)).toEqual([...rails.marks].reverse().map((k) => len - k.d));
    expect(rev[1].marks.map((k) => [k.name, k.d, k.offset])).toEqual(
      [...stations.marks].reverse().map((k) => [k.name, len - k.d, -k.offset]),
    );
  });
  it('同じ駅名で線からの距離が同じなら、先に載っている駅を採る', () => {
    const d = buildTransitData(
      { type: 'FeatureCollection', features: [] },
      { type: 'FeatureCollection', features: [station('A', 'x', [100, 50]), station('A', 'y', [400, -50])] } as StationCollection,
    );
    expect(sectionTransit(d, line, colors)[1].marks.map((k) => k.d)).toEqual([100]);
  });
  it('長さ 0 の線、範囲の外の線は、どちらのトラックも空', () => {
    for (const bad of [L(300, 0, 300, 0), L(9000, 9000, 9500, 9000)]) {
      const t = sectionTransit(data, bad, colors);
      expect(t).toHaveLength(2);
      expect(t[0].marks).toEqual([]);
      expect(t[1].marks).toEqual([]);
    }
  });
  it('駅の数と offset が、全駅の総当たりと一致する（乱数の駅）', () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const features = Array.from({ length: 800 }, (_, i) => station(`S${i}`, 'x', [rnd() * 10000, rnd() * 10000]));
    const d = buildTransitData({ type: 'FeatureCollection', features: [] }, { type: 'FeatureCollection', features } as StationCollection);
    for (let k = 0; k < 20; k++) {
      const ln = L(rnd() * 10000, rnd() * 10000, rnd() * 10000, rnd() * 10000);
      const len = lineLength(ln);
      const expected: [string, number][] = [];
      for (const f of features) {
        const [px, py] = f.geometry.coordinates;
        const dx = ln.bx - ln.ax;
        const dy = ln.by - ln.ay;
        const along = ((px - ln.ax) * dx + (py - ln.ay) * dy) / len;
        const off = (dx * (py - ln.ay) - dy * (px - ln.ax)) / len;
        if (along >= 0 && along <= len && Math.abs(off) <= 500) expected.push([f.properties.name, off]);
      }
      const got = sectionTransit(d, ln, colors)[1].marks;
      expect(got).toHaveLength(expected.length);
      const byName = new Map(expected);
      for (const m of got) expect(m.offset).toBeCloseTo(byName.get(m.name!)!, 6);
    }
  });
  it('トラックを返すレイヤー：色は凡例（地図の配色）と同じ', () => {
    const tracks = transit.section(data, line, DEFAULT_OPTIONS) as SectionMarks[];
    expect(tracks[0].marks[0].color).toEqual(transit.legend(DEFAULT_OPTIONS)[0].color);
    expect(tracks[1].marks[0].color).toEqual(transit.legend(DEFAULT_OPTIONS)[1].color);
  });
});
