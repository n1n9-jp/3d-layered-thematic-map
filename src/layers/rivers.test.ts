import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cutCloseup } from '../closeup/cut';
import { DEFAULT_OPTIONS, EXTENT } from '../config';
import type { LayerStatus } from '../store';
import type { Position } from '../types';
import { PATH_TOLERANCE, RIVER_GRID_M, bankPaths, RIVER_COLOR, RIVER_FAR_COLOR, RIVER_FAR_LINE_PX, RIVER_LINE_PX, RIVER_TIERS, THIN_WIDTH_M, clipRivers, loadRivers, polygonWidth, riverLayers } from './rivers';
import type { RiverData } from './rivers';

const rect = (x0: number, y0: number, x1: number, y1: number): Position[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const areaOf = (ring: Position[]) => {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(s) / 2;
};
const boxOf = (rings: Position[][]): [number, number, number, number] => {
  const xs = rings[0].map((p) => p[0]);
  const ys = rings[0].map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

const partOf = (polygons: Position[][][]) => ({ polygons, paths: polygons.flat(), boxes: polygons.map(boxOf) });
const empty = partOf([]);

describe('clipRivers', () => {
  // 東西に走る川（幅 200 m）と、遠く離れた池
  const polygons: Position[][][] = [[rect(-5000, -100, 5000, 100)], [rect(8000, 8000, 8500, 8500)]];
  const data = { near: partOf(polygons), far: empty };

  it('円の中の部分だけを返す。面積は、円と川の重なり（幅 200 m、長さ 2r）にほぼ等しい', () => {
    const r = 1000;
    const out = clipRivers(data, 0, 0, r).near;
    expect(out.polygons).toHaveLength(1);
    const area = areaOf(out.polygons[0][0]);
    // 帯（幅 200）と円の重なり。長さ 2r の長方形より、円の端の丸みのぶん少し小さい
    expect(area).toBeLessThan(200 * 2 * r);
    expect(area).toBeGreaterThan(200 * 2 * r * 0.98);
    for (const [x, y] of out.polygons[0][0]) expect(Math.hypot(x, y)).toBeLessThanOrEqual(r + 1e-6);
  });
  it('縁の線は、円の中の部分だけ（円の縁には線を引かない）。川の上下の岸の 2 本', () => {
    const out = clipRivers(data, 0, 0, 1000).near;
    expect(out.paths.length).toBeGreaterThanOrEqual(2);
    for (const p of out.paths) for (const [x, y] of p) expect(Math.hypot(x, y)).toBeLessThanOrEqual(1000 + 1e-6);
    // 円の縁にある点（岸と円の交点）以外の縁（x = ±1000 付近を縦に結ぶ線）を含まない
    for (const p of out.paths) expect(p.some(([, y]) => Math.abs(y) > 150)).toBe(false);
  });
  it('円と重ならない面は含まない。円が川から離れていれば空', () => {
    expect(clipRivers(data, 0, 3000, 1000).near.polygons).toEqual([]);
    expect(clipRivers(data, 8250, 8250, 1000).near.polygons).toHaveLength(1);
  });
  it('円に完全に入る面は、そのまま（頂点の数も同じ）', () => {
    const out = clipRivers(data, 8250, 8250, 2000).near;
    expect(areaOf(out.polygons[0][0])).toBeCloseTo(500 * 500, 3);
    expect(out.paths).toHaveLength(1);
  });
  it('入力を変更しない', () => {
    const before = JSON.stringify(polygons);
    clipRivers(data, 0, 0, 1000);
    expect(JSON.stringify(polygons)).toBe(before);
  });
  it('穴（中の島）も、円で切って残す', () => {
    const hole = [...rect(-50, -50, 50, 50)].reverse();
    const withHole = { near: partOf([[rect(-1000, -300, 1000, 300), hole]]), far: empty };
    const out = clipRivers(withHole, 0, 0, 500).near;
    expect(out.polygons[0]).toHaveLength(2);
  });
  it('23区に近い川と、離れた川は、別々に切り出す', () => {
    const both = { near: partOf([[rect(-500, -50, 500, 50)]]), far: partOf([[rect(-500, 300, 500, 400)]]) };
    const out = clipRivers(both, 0, 0, 1000);
    expect(out.near.polygons).toHaveLength(1);
    expect(out.far.polygons).toHaveLength(1);
    expect(areaOf(out.far.polygons[0][0])).toBeCloseTo(1000 * 100, 3);
  });
});

describe('riverLayers', () => {
  const part = { polygons: [[rect(0, 0, 10, 10)]], paths: [rect(0, 0, 10, 10)] };
  const shapes = { near: part, far: part };
  it('離れた川、近い川の順に、塗りと、細い川にも見える線の2つずつ。線が塗りの上', () => {
    const layers = riverLayers(shapes, 'flood', 12000);
    expect(layers.map((l) => l.id)).toEqual(['rivers-fill-far-flood', 'rivers-line-far-flood', 'rivers-fill-near-flood', 'rivers-line-near-flood']);
    expect(layers.every((l) => l.props.pickable === false)).toBe(true);
  });
  it('離れた川は、近い川より暗く、細い', () => {
    const layers = riverLayers(shapes, 'flood', 0);
    const luma = ([r, g, b]: readonly number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(luma(RIVER_FAR_COLOR)).toBeLessThan(0.6 * luma(RIVER_COLOR));
    const fill = (i: number) => (layers[i].props as unknown as { getFillColor: unknown }).getFillColor;
    expect(fill(0)).toEqual(RIVER_FAR_COLOR);
    expect(fill(2)).toEqual(RIVER_COLOR);
    expect(RIVER_FAR_LINE_PX).toBeLessThan(RIVER_LINE_PX);
  });
  it('高さは modelMatrix だけで与える（データは同じ参照）', () => {
    const a = riverLayers(shapes, 'flood', 0);
    const b = riverLayers(shapes, 'flood', 5000);
    expect(a[2].props.data).toBe(b[2].props.data);
    expect((b[2].props.modelMatrix as unknown as number[])[14]).toBe(5000);
  });
  it('面がなければ空。近い川だけでも描ける', () => {
    expect(riverLayers({ near: { polygons: [], paths: [] }, far: { polygons: [], paths: [] } }, 'flood', 0)).toEqual([]);
    expect(riverLayers({ near: part, far: { polygons: [], paths: [] } }, 'flood', 0).map((l) => l.id)).toEqual(['rivers-fill-near-flood', 'rivers-line-near-flood']);
  });
  it('標高と浸水の段に描く', () => {
    expect([...RIVER_TIERS]).toEqual(['elevation', 'flood']);
  });
  it('水色は、浸水・標高の塗りを読む妨げにならない強さ（鮮やかすぎず、明るすぎない）で、水と分かる（青緑〜青の色相）', () => {
    const [r, g, b] = RIVER_COLOR;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    expect((max - min) / max).toBeLessThan(0.8); // 彩度
    expect(max).toBeLessThan(230); // 明るさ
    expect(b).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(r);
  });
});

describe('bankPaths', () => {
  it('切り口（格子の線の上の辺）を除いた、つながった折れ線に分ける', () => {
    const ring: Position[] = [[10, 10], [500, 10], [1000, 10], [1000, 300], [1000, 610], [500, 610], [10, 610], [10, 10]];
    // x = 1000 の辺（(1000,10)→(1000,300)→(1000,610)）が切り口。残りは (10,10)→…→(1000,10) と (1000,610)→…→(10,10)
    const out = bankPaths(ring);
    expect(out).toEqual([
      [[10, 10], [500, 10], [1000, 10]],
      [[1000, 610], [500, 610], [10, 610], [10, 10]],
    ]);
    expect(RIVER_GRID_M).toBe(1000);
  });
  it('切り口がなければ、リングを1本の線として返す', () => {
    const ring: Position[] = [[10, 10], [510, 10], [510, 310], [10, 310], [10, 10]];
    expect(bankPaths(ring)).toEqual([ring]);
  });
});

describe('polygonWidth', () => {
  it('細長い面の幅は、川幅にほぼ等しい（2 × 面積 ÷ 周長）', () => {
    expect(polygonWidth([rect(0, 0, 10000, 50)])).toBeCloseTo((2 * 10000 * 50) / (2 * 10050), 6);
    expect(polygonWidth([rect(0, 0, 10000, 50)])).toBeGreaterThan(49);
  });
  it('穴は面積から引く。周長には足す', () => {
    const hole = [...rect(100, 10, 200, 40)].reverse();
    expect(polygonWidth([rect(0, 0, 10000, 50), hole])).toBeLessThan(polygonWidth([rect(0, 0, 10000, 50)]));
  });
  it('線を重ねる面の幅の上限と、間引きの許容誤差は、初期表示の 1 px（約 70 m）と拡大の上限に照らして決めている', () => {
    expect(THIN_WIDTH_M).toBeLessThanOrEqual(110);
    expect(PATH_TOLERANCE).toBeLessThanOrEqual(10);
  });
});

describe('実データの川', () => {
  const dir = path.join(__dirname, '../../public/data/');
  afterEach(() => vi.unstubAllGlobals());
  const stub = () =>
    vi.stubGlobal('fetch', async (url: string) => {
      const file = url.replace(/^.*\//, '');
      return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(`${dir}${file}`, 'utf8')) };
    });

  it('loadRivers は、面・外接矩形・名前・札の根元・標本を読む。縁の線は、細い面だけを間引いたもの（頂点が面の半分以下）', async () => {
    stub();
    const d = await loadRivers('/data/');
    expect(d.polygons.length).toBeGreaterThan(500);
    expect(d.boxes).toHaveLength(d.polygons.length);
    expect(d.near.polygons.length + d.far.polygons.length).toBe(d.polygons.length);
    expect(d.near.polygons.length).toBeGreaterThan(d.far.polygons.length); // 23区に近い川のほうが多い
    expect(d.far.polygons.length).toBeGreaterThan(50);
    const verts = (rings: Position[][]) => rings.reduce((s, r) => s + r.length, 0);
    expect(verts(d.near.paths)).toBeLessThan(0.45 * verts(d.polygons.flat()));
    expect(d.far.paths).toEqual([]); // 離れた川には、線を引かない
    expect(d.near.paths.length).toBeGreaterThan(0);
    expect(d.names).toContain('荒川');
    expect(d.samples.length).toBeGreaterThan(1000);
    for (const [x0, y0, x1, y1] of d.boxes) {
      expect(x0).toBeGreaterThanOrEqual(EXTENT.minX);
      expect(y0).toBeGreaterThanOrEqual(EXTENT.minY);
      expect(x1).toBeLessThanOrEqual(EXTENT.maxX);
      expect(y1).toBeLessThanOrEqual(EXTENT.maxY);
    }
  });

  it('荒川・隅田川・江戸川・多摩川の位置に、水域がある（地理院の標準地図に輪郭を重ねて確かめた橋の位置）', async () => {
    stub();
    const d = await loadRivers('/data/');
    const water = (x: number, y: number, r: number) => {
      const c = clipRivers(d, x, y, r);
      return [...c.near.polygons, ...c.far.polygons].reduce((s, p) => s + areaOf(p[0]), 0);
    };
    // 隅田川：千住大橋（x=4380, y=6550）、荒川：堀切橋の付近（x=6400, y=7170、幅約 400 m）、江戸川：江戸川大橋の東（x=15200, y=3000）、
    // 荒川（放水路）：小松川の北（x=9500, y=2820）、中川：奥戸橋の付近（x=10500, y=6700）、多摩川：大師橋（x=-780, y=-15330）
    expect(water(4380, 6550, 100)).toBeGreaterThan(8000);
    expect(water(6400, 7170, 150)).toBeGreaterThan(20000);
    expect(water(15200, 3000, 150)).toBeGreaterThan(30000);
    expect(water(9500, 2820, 150)).toBeGreaterThan(20000);
    expect(water(-780, -15330, 200)).toBeGreaterThan(30000);
    // 川でない所（新宿駅、東京駅、渋谷駅）には水域がない
    expect(water(-4471, 1066, 100)).toBe(0);
    expect(water(1548, 133, 100)).toBe(0);
    expect(water(-4383, -2440, 100)).toBe(0);
  });

  it('クローズアップの切り出し（cutCloseup）が、川を円で切って返す。川が読み込めていなければ null', async () => {
    stub();
    const d = await loadRivers('/data/');
    const status = { rivers: 'ready' } as unknown as Record<string, LayerStatus>;
    const cut = cutCloseup({ rivers: d }, status as never, { x: 6100, y: 7740, r: 2000 }, DEFAULT_OPTIONS);
    expect(cut.rivers).not.toBeNull();
    expect(cut.rivers!.near.polygons.length).toBeGreaterThan(0);
    const none = cutCloseup({}, { rivers: 'idle' } as never, { x: 6100, y: 7740, r: 2000 }, DEFAULT_OPTIONS);
    expect(none.rivers).toBeNull();
  });
});

// 型の確認：RiverData が RiverShapes として使える
const _typecheck = (d: RiverData) => riverLayers(d, 'x', 0);
void _typecheck;
