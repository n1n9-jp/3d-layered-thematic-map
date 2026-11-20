import { describe, expect, it } from 'vitest';
import type { FacilityCollection, FacilityProps, SectionLine, SectionMarks } from '../types';
import { lineLength, reverseLine } from '../lib/section';
import facilities from './facilities';
import { FACILITY_SECTION_RADIUS, buildFacilityData, facilitySectionIndex, sectionFacilities, subsetFacilities } from './facilitiesModel';

const fac = (xy: [number, number], props: Partial<FacilityProps>) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: xy },
  properties: { kind: 'school' as const, name: '', subtype: '', ...props },
});
const L = (ax: number, ay: number, bx: number, by: number): SectionLine => ({ ax, ay, bx, by });
const color = (k: string): [number, number, number] => (k === 'school' ? [1, 1, 1] : [2, 2, 2]);

const data = buildFacilityData({
  type: 'FeatureCollection',
  features: [
    fac([100, 150], { name: '第一小学校' }), // 左（北）150
    fac([400, -300], { kind: 'hospital', name: '中央病院' }), // 右（南）300：ちょうど 300 m（含む）
    fac([450, 301], { name: '遠い中学校' }), // 301 m（除く）
    fac([-20, 10], { name: '手前の学校' }), // 足が始点より手前（除く）
    fac([1020, 10], { name: '先の学校' }), // 足が終点より先（除く）
    fac([1000, -40], { kind: 'hospital', name: '' }), // 足が終点ちょうど。名前なし
    fac([100, 250], { name: '第一小学校' }), // 同じ名前でも、駅と違ってまとめない
  ],
} as FacilityCollection);
const line = L(0, 0, 1000, 0);
const track = (d = data, ln = line): SectionMarks => {
  const t = facilities.section(d, ln);
  expect(t).toHaveLength(1);
  return t[0] as SectionMarks;
};

describe('facilities.section', () => {
  it('線から 300 m 以内で、足が線分の内側の学校と病院。d は足の位置、offset は左が正', () => {
    const t = track();
    expect(t).toMatchObject({ kind: 'marks', label: '近くの学校・病院' });
    expect(t.marks.map((k) => [k.name, k.category, k.categoryLabel, k.d, k.offset, k.x, k.y])).toEqual([
      ['第一小学校', 'school', '学校', 100, 150, 100, 150],
      ['第一小学校', 'school', '学校', 100, 250, 100, 250],
      ['中央病院', 'hospital', '病院', 400, -300, 400, -300],
      ['病院', 'hospital', '病院', 1000, -40, 1000, -40], // 名前がなければ、データの名前（種別の名前）
    ]);
    expect(FACILITY_SECTION_RADIUS).toBe(300);
  });
  it('向きを逆にすると、d は「長さ − d」、offset は符号が逆になる', () => {
    const f = track().marks;
    const r = track(data, reverseLine(line)).marks;
    const len = lineLength(line);
    // d が同じ施設の並びは問わない（d、offset の順にそろえて比べる）
    const norm = (rows: (string | number)[][]) => rows.sort((a, b) => (a[1] as number) - (b[1] as number) || (a[2] as number) - (b[2] as number));
    expect(norm(r.map((k) => [k.name!, k.d, k.offset + 0]))).toEqual(norm(f.map((k) => [k.name!, len - k.d, -k.offset + 0])));
  });
  it('色は凡例（地図の配色）と同じ', () => {
    const t = track();
    const school = t.marks.find((k) => k.category === 'school')!;
    const hospital = t.marks.find((k) => k.category === 'hospital')!;
    expect(facilities.legend.map((e) => e.color)).toContainEqual(school.color);
    expect(facilities.legend.map((e) => e.color)).toContainEqual(hospital.color);
    expect(school.color).not.toEqual(hospital.color);
    expect(sectionFacilities(data, line, color).marks[0].color).toEqual([1, 1, 1]);
  });
  it('長さ 0 の線、範囲の外の線、施設がないデータは空', () => {
    expect(track(data, L(100, 0, 100, 0)).marks).toEqual([]);
    expect(track(data, L(9000, 9000, 9500, 9000)).marks).toEqual([]);
    expect(track(buildFacilityData({ type: 'FeatureCollection', features: [] }), line).marks).toEqual([]);
  });
  it('数と offset が、全施設の総当たりと一致する（乱数の施設）', () => {
    let seed = 5;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const features = Array.from({ length: 1500 }, (_, i) => fac([rnd() * 10000, rnd() * 10000], { name: `F${i}`, kind: i % 5 === 0 ? 'hospital' : 'school' }));
    const d = buildFacilityData({ type: 'FeatureCollection', features } as FacilityCollection);
    for (let k = 0; k < 20; k++) {
      const ln = L(rnd() * 10000, rnd() * 10000, rnd() * 10000, rnd() * 10000);
      const len = lineLength(ln);
      const expected = new Map<string, number>();
      for (const f of features) {
        const [px, py] = f.geometry.coordinates;
        const dx = ln.bx - ln.ax;
        const dy = ln.by - ln.ay;
        const along = ((px - ln.ax) * dx + (py - ln.ay) * dy) / len;
        const off = (dx * (py - ln.ay) - dy * (px - ln.ax)) / len;
        if (along >= 0 && along <= len && Math.abs(off) <= 300) expected.set(f.properties.name, off);
      }
      const got = track(d, ln).marks;
      expect(got).toHaveLength(expected.size);
      for (const m of got) expect(m.offset).toBeCloseTo(expected.get(m.name!)!, 6);
    }
  });
  it('subset の結果にも使える。索引はデータごとに1回だけ作る', () => {
    const sub = subsetFacilities(data, 100, 150, 120);
    expect(track(sub).marks.map((k) => k.name)).toEqual(['第一小学校', '第一小学校']);
    expect(facilitySectionIndex(data)).toBe(facilitySectionIndex(data));
  });
});
