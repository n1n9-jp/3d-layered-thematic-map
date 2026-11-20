import { describe, expect, it } from 'vitest';
import type { StackState } from '../stack';
import type { Position } from '../types';
import { DENSITY_CLASSES, ZERO_COLOR } from '../layers/population/classes';
import {
  buildStationSet,
  describeFacilityStation,
  describeStationPopulation,
  facilityStationLinks,
  groupStations,
  heightsOf,
  linkAvailable,
  linkHeights,
  linkStyle,
  parseLinksQuery,
  stationPopulationLinks,
  summarizeFacilityStation,
  summarizeStationPopulation,
} from './linksModel';

const stack = (over: Partial<StackState> = {}): StackState => ({
  order: ['elevation', 'population', 'roads', 'transit', 'facilities'],
  visible: { elevation: true, population: true, roads: true, transit: true, facilities: true },
  solo: null,
  spacing: 12000,
  ...over,
});

describe('parseLinksQuery', () => {
  it('書かれた関係だけオン。未指定は両方オフ', () => {
    expect(parseLinksQuery(null)).toEqual({ 'facility-station': false, 'station-population': false });
    expect(parseLinksQuery('facility-station')).toEqual({ 'facility-station': true, 'station-population': false });
    expect(parseLinksQuery('station-population, facility-station')).toEqual({ 'facility-station': true, 'station-population': true });
  });
  it('不正な値は無視する', () => {
    expect(parseLinksQuery('foo,,bar')).toEqual({ 'facility-station': false, 'station-population': false });
  });
});

describe('linkAvailable / linkHeights', () => {
  it('2つの段がどちらも表示中のときだけ使える', () => {
    expect(linkAvailable('facility-station', stack())).toBe(true);
    expect(linkAvailable('station-population', stack())).toBe(true);
    const noTransit = stack({ visible: { elevation: true, population: true, roads: true, transit: false, facilities: true } });
    expect(linkAvailable('facility-station', noTransit)).toBe(false);
    expect(linkAvailable('station-population', noTransit)).toBe(false);
    const noRoads = stack({ visible: { elevation: true, population: true, roads: false, transit: true, facilities: true } });
    expect(linkAvailable('facility-station', noRoads)).toBe(true);
  });
  it('単独表示では使えない', () => {
    expect(linkAvailable('facility-station', stack({ solo: 'transit' }))).toBe(false);
  });
  it('段の並べ替えに追従して高さを返す', () => {
    const swapped = stack({ order: ['facilities', 'transit', 'roads', 'population', 'elevation'] });
    const z = heightsOf(swapped);
    expect(linkHeights('facility-station', z)).toEqual([0, 12000]);
    expect(linkHeights('station-population', z)).toEqual([12000, 36000]);
    expect(linkHeights('station-population', { ...z, population: null })).toBeNull();
  });
});

describe('groupStations', () => {
  it('同じ駅名で近い点は1つにまとめ、代表は重心にいちばん近い点', () => {
    const pts: Position[] = [[0, 0], [300, 0], [600, 0], [5000, 5000]];
    const names = ['東京', '東京', '東京', '渋谷'];
    const g = groupStations(pts, names, 500);
    // 0 と 300 は同じまとまり。600 は 0 から 500 を超えるので別（アンカー 0 から数える）
    expect(g.map((x) => [x.name, x.members])).toEqual([['東京', 2], ['東京', 1], ['渋谷', 1]]);
    expect(g[0].pos).toEqual([0, 0]); // 重心 150。0 と 300 は等距離なので最初の点
    expect(g[0].points).toEqual([[0, 0], [300, 0]]);
  });
  it('同じ駅名でも離れた点は別の駅', () => {
    const g = groupStations([[0, 0], [8000, 0]], ['本町', '本町']);
    expect(g).toHaveLength(2);
  });
  it('入力で最初に現れた順に並ぶ', () => {
    const g = groupStations([[0, 0], [900, 0], [10, 10]], ['A', 'B', 'A']);
    expect(g.map((x) => x.name)).toEqual(['A', 'B']);
  });
});

describe('facilityStationLinks', () => {
  const stations = buildStationSet(
    [[1000, 0], [0, 3000], [1100, 50]],
    ['甲', '乙', '甲'], // 甲は2点をまとめる
  );
  const fac = (x: number, y: number, kind: 'school' | 'hospital' = 'school') => ({ pos: [x, y] as Position, kind, name: `f${x},${y}` });

  it('最寄り駅へ引き、距離は水平距離。1 km 以内に駅がない施設には引かない', () => {
    const r = facilityStationLinks([fac(900, 0), fac(0, 2500, 'hospital'), fac(-5000, -5000)], stations);
    expect(r.facilityCount).toBe(3);
    // (900,0) は甲まで 100 m、(0,2500) は乙まで 500 m、(-5000,-5000) はどの駅も 1 km 以内にない
    expect(r.links.map((l) => [l.name, l.station, l.distance])).toEqual([
      ['f900,0', '甲', 100],
      ['f0,2500', '乙', 500],
    ]);
    expect(r.noStation).toBe(1);
  });

  it('距離の境界：ちょうど 1000 m は引く、超えると引かない', () => {
    const s = buildStationSet([[0, 0]], ['駅']);
    expect(facilityStationLinks([fac(1000, 0)], s).links).toHaveLength(1);
    expect(facilityStationLinks([fac(1000.5, 0)], s).links).toHaveLength(0);
  });

  it('駅は円の外でもよい。線は施設の点から駅の点へ、色の種別を持つ', () => {
    const s = buildStationSet([[500, 0]], ['遠い駅']);
    const r = facilityStationLinks([fac(0, 0, 'hospital')], s);
    expect(r.links).toEqual([
      { kind: 'hospital', name: 'f0,0', from: [0, 0], to: [500, 0], station: '遠い駅', distance: 500 },
    ]);
  });

  it('駅をまとめても、最寄りの駅の点（描かれた点）へ引く。距離はその点まで', () => {
    // 甲の2点 (1000,0) (1100,50)。(1090,40) からは (1100,50) のほうが近い
    const r = facilityStationLinks([fac(1090, 40)], stations);
    expect(r.links).toHaveLength(1);
    expect(r.links[0].station).toBe('甲');
    expect(r.links[0].to).toEqual([1100, 50]);
    expect(r.links[0].distance).toBeCloseTo(Math.hypot(10, 10), 9);
  });
  it('駅がまったくなくても落ちない', () => {
    const none = buildStationSet([], []);
    const r = facilityStationLinks([fac(0, 0)], none);
    expect(r.links).toEqual([]);
    expect(r.noStation).toBe(1);
  });
});

describe('stationPopulationLinks', () => {
  const circle = { x: 0, y: 0, r: 1000 };
  it('円の中の駅ごとに1本。色は直下の人口密度の段階の色', () => {
    const st = buildStationSet([[100, 0], [-200, 300], [5000, 0]], ['A', 'B', 'C']);
    const dens: Record<string, number | null> = { '100,0': 12000, '-200,300': 31000 };
    const r = stationPopulationLinks(st, circle, (x, y) => dens[`${x},${y}`] ?? null);
    expect(r.links.map((l) => l.station)).toEqual(['A', 'B']); // C は円の外
    expect(r.links[0].color).toEqual(DENSITY_CLASSES[2].color); // 10,000〜15,000
    expect(r.links[1].color).toEqual(DENSITY_CLASSES[6].color); // 30,000 以上
    expect(r.links[0].at).toEqual([100, 0]);
  });
  it('密度 0 とメッシュなしは、凡例の「0」の色', () => {
    const st = buildStationSet([[0, 0], [10, 10]], ['A', 'B']);
    const r = stationPopulationLinks(st, circle, (x) => (x === 0 ? 0 : null));
    expect(r.links.map((l) => l.density)).toEqual([0, null]);
    for (const l of r.links) expect(l.color).toEqual(ZERO_COLOR);
  });
  it('同じ駅名は、離れた点でも1本にまとまる', () => {
    const st = buildStationSet([[0, 0], [700, 0]], ['本町', '本町']); // 500 m を超えて離れているので、駅のまとめは2つ
    expect(st.groups).toHaveLength(2);
    const r = stationPopulationLinks(st, circle, () => 5000);
    expect(r.links).toHaveLength(1);
    expect(r.links[0].at).toEqual([0, 0]);
  });
  it('同じ駅名の点は1本にまとまる。円の中にある点を使う', () => {
    // 乗換駅：2点のうち 1点だけが円の中（縁の外にもう1点）
    const st = buildStationSet([[990, 0], [1200, 0]], ['乗換', '乗換']);
    const r = stationPopulationLinks(st, circle, () => 5000);
    expect(r.links).toHaveLength(1);
    expect(r.links[0].at).toEqual([990, 0]);
  });
});

describe('要約', () => {
  it('施設 → 最寄り駅：本数、平均・最大の距離、駅がない施設の数が、線と一致する', () => {
    const links = [100, 200, 600].map((d, i) => ({
      kind: (i === 2 ? 'hospital' : 'school') as 'school' | 'hospital',
      name: `f${i}`,
      from: [0, 0] as Position,
      to: [d, 0] as Position,
      station: 'x',
      distance: d,
    }));
    const s = summarizeFacilityStation({ links, facilityCount: 5, noStation: 2 });
    expect(s).toEqual({
      lineCount: 3,
      byKind: { school: 2, hospital: 1 },
      facilityCount: 5,
      noStation: 2,
      meanDistance: 300,
      maxDistance: 600,
    });
    expect(describeFacilityStation(s)).toEqual([
      '線 3 本（学校 2・病院 1）',
      '最寄り駅まで 平均 300m（最大 600m）',
      '1km 以内に駅がない施設 2件',
    ]);
  });
  it('施設 → 最寄り駅：線がないとき、平均・最大は null で文に出さない', () => {
    const s = summarizeFacilityStation({ links: [], facilityCount: 2, noStation: 2 });
    expect(s.meanDistance).toBeNull();
    expect(s.maxDistance).toBeNull();
    expect(describeFacilityStation(s)).toEqual(['線 0 本（学校 0・病院 0）', '1km 以内に駅がない施設 2件']);
  });
  it('駅 → 直下の人口：平均・最大はメッシュのある駅だけ。密度 0 とメッシュなしは「人が住んでいない」に数える', () => {
    const mk = (density: number | null) => ({ station: 's', at: [0, 0] as Position, density, color: ZERO_COLOR });
    const s = summarizeStationPopulation({ links: [mk(10000), mk(20000), mk(0), mk(null)] });
    expect(s).toEqual({ lineCount: 4, meanDensity: 10000, maxDensity: 20000, noResidents: 2 });
    expect(describeStationPopulation(s)[1]).toBe('直下の人口密度 平均 10,000人/km²（最大 20,000）');
    expect(describeStationPopulation(s)[2]).toBe('直下に人が住んでいない駅 2駅');
  });
  it('駅 → 直下の人口：駅がないとき', () => {
    const s = summarizeStationPopulation({ links: [] });
    expect(s).toEqual({ lineCount: 0, meanDensity: null, maxDensity: null, noResidents: 0 });
  });
});

describe('linkStyle', () => {
  it('本数が増えるほど細く、薄くなる（単調）。少ないうちは最大、多いと最小', () => {
    let prev = linkStyle(1);
    expect(prev).toEqual({ width: 2.2, alpha: 235 });
    for (const n of [5, 12, 20, 40, 100, 200, 250, 400, 1000]) {
      const s = linkStyle(n);
      expect(s.width).toBeLessThanOrEqual(prev.width);
      expect(s.alpha).toBeLessThanOrEqual(prev.alpha);
      prev = s;
    }
    expect(linkStyle(400).width).toBeCloseTo(1, 9);
    expect(linkStyle(400).alpha).toBe(100);
  });
  it('0 本や不正な値でも有限の値を返す', () => {
    for (const n of [0, -3, NaN]) {
      const s = linkStyle(n);
      expect(Number.isFinite(s.width)).toBe(true);
      expect(Number.isFinite(s.alpha)).toBe(true);
    }
  });
});
