import { describe, expect, it } from 'vitest';
import { DATA_OUTLINE } from '../config';
import type { WardLabel } from '../layers/shelters/model';
import { fitStack, makeProjector } from './camera';
import type { Size } from './camera';
import { convexIntersectsRect, infoColumnWidth, RIGHT_PANEL_W, TITLE_RECT } from './layout';
import type { Pt, Rect } from './layout';
import { stackLabelRects } from './labelLayers';
import { LABEL_LEVELS, layoutWardLabels } from './wardLabels';
import { segmentHitsRect, segmentsCross } from './calloutPlacement';
import type { LayerId } from '../config';
import { LAYER_IDS } from '../config';

/** 実データで求めた、8区の目印（区の最大の外周の重心。ローカル座標 m）。指定なし：江戸川・足立・新宿・文京、未公開：葛飾・墨田・江東・渋谷。 */
const mk = (name: string, status: string, kind: WardLabel['kind'], x: number, y: number): WardLabel => ({
  position: [x, y],
  text: `${name}\n${status}`,
  name,
  status,
  kind,
});
const LABELS: WardLabel[] = [
  mk('足立区', '指定なし', 'none', 4076, 10964),
  mk('江戸川区', '指定なし', 'none', 11379, 1401),
  mk('新宿区', '指定なし', 'none', -3713, 2339),
  mk('文京区', '指定なし', 'none', -246, 4156),
  mk('葛飾区', '未公開', 'unpublished', 9557, 8132),
  mk('墨田区', '未公開', 'unpublished', 5924, 3576),
  mk('江東区', '未公開', 'unpublished', 6038, -1559),
  mk('渋谷区', '未公開', 'unpublished', -4864, -1343),
];

const rectsOverlap = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const inflate = (r: Rect, m: number): Rect => ({ left: r.left - m, top: r.top - m, right: r.right + m, bottom: r.bottom + m });

const SIZES: [number, number][] = [
  [2000, 1100],
  [1400, 1000],
  [1000, 700],
];
const VIEWS: [string, number, number][] = [
  ['斜め', 20, 45],
  ['回転 120', 20, 120],
  ['回転 -60', 20, -60],
  ['正面', 12, 0],
  ['真上', 90, 0],
];
const SPACINGS = [0, 3000, 12000, 20000];

function scene(windowW: number, windowH: number, rotationX: number, rotationOrbit: number, spacing: number) {
  const size: Size = { width: windowW - RIGHT_PANEL_W, height: windowH };
  const columnWidth = infoColumnWidth(windowW);
  const zOf = (i: number) => i * spacing;
  const tiers = LAYER_IDS.map((id, i) => ({ id: id as LayerId, z: zOf(i) }));
  const top = zOf(LAYER_IDS.length - 1);
  const vs = { rotationX, rotationOrbit, ...fitStack({ rotationX, rotationOrbit, top, size, columnWidth }) };
  const layerNameRects = stackLabelRects({ tiers, viewState: vs, size });
  const shelterZ = tiers.find((t) => t.id === 'shelters')!.z;
  const layout = layoutWardLabels({
    labels: LABELS,
    viewState: vs,
    size,
    z: shelterZ,
    otherZs: tiers.filter((t) => t.id !== 'shelters').map((t) => t.z),
    columnWidth,
    layerNameRects,
  });
  return { size, columnWidth, vs, tiers, layerNameRects, layout };
}

describe('区名の札の置き場所', () => {
  for (const [w, h] of SIZES)
    for (const [viewName, rx, ro] of VIEWS)
      for (const spacing of SPACINGS)
        it(`${w}×${h}・${viewName}・間隔 ${spacing / 1000} km：札どうし・題・列・レイヤー名・ほかの段のデータに重ならず、引き出し線が札や線と交わらない`, () => {
          const { size, columnWidth, vs, tiers, layerNameRects, layout } = scene(w, h, rx, ro, spacing);
          expect(layout).not.toBeNull();
          const placed = layout!.placed;
          expect(placed.length).toBeGreaterThan(0);
          const pr = makeProjector(vs, size);
          const shelterZ = tiers.find((t) => t.id === 'shelters')!.z;
          const hullOf = (z: number) => DATA_OUTLINE.map(([x, y]) => pr.project([x, y, z]) as Pt);
          const colLeft = size.width - columnWidth;
          for (const p of placed) {
            // 札は、描画領域の中、右の列の左、題の外
            expect(p.rect.left).toBeGreaterThanOrEqual(0);
            expect(p.rect.top).toBeGreaterThanOrEqual(0);
            expect(p.rect.bottom).toBeLessThanOrEqual(size.height);
            expect(p.rect.right).toBeLessThanOrEqual(colLeft);
            expect(rectsOverlap(p.rect, TITLE_RECT)).toBe(false);
            for (const r of layerNameRects) expect(rectsOverlap(p.rect, r)).toBe(false);
            // ほかの段のデータのある範囲に重ならない
            for (const t of tiers) if (t.id !== 'shelters') expect(convexIntersectsRect(hullOf(t.z), p.rect)).toBe(false);
            // 目印（区の重心）と、札の縁をつなぐ引き出し線がある
            const [ax, ay] = pr.project([...(LABELS.find((l) => l.name === p.label.name)!.position), shelterZ]);
            expect(p.anchor[0]).toBeCloseTo(ax, 3);
            expect(p.anchor[1]).toBeCloseTo(ay, 3);
          }
          for (let i = 0; i < placed.length; i++)
            for (let j = i + 1; j < placed.length; j++) {
              const a = placed[i];
              const b = placed[j];
              expect(rectsOverlap(a.rect, b.rect)).toBe(false);
              expect(segmentsCross(a.anchor, a.attach, b.anchor, b.attach)).toBe(false);
              expect(segmentHitsRect(a.anchor, a.attach, inflate(b.rect, 0))).toBe(false);
              expect(segmentHitsRect(b.anchor, b.attach, inflate(a.rect, 0))).toBe(false);
            }
          // 札を出さなかった区は、omitted に入っている
          expect(placed.length + layout!.omitted.length).toBe(LABELS.length);
        });

  it('大きい画面の既定の視点では、8つの区名が2行の札で全部出る', () => {
    for (const [w, h] of [[2000, 1100], [1400, 1000]] as const) {
      const { layout } = scene(w, h, 20, 45, 12000);
      expect(layout!.omitted).toEqual([]);
      expect(LABEL_LEVELS[layout!.level].twoLines).toBe(true);
    }
  });

  it('画面の外の区には、札を出さない', () => {
    const { vs, size, columnWidth, tiers, layerNameRects } = scene(1400, 1000, 20, 45, 12000);
    // 注視点を大きくずらして、8区を画面の外へ
    const far = { ...vs, target: [vs.target[0] - 400000, vs.target[1], vs.target[2]] as [number, number, number] };
    const layout = layoutWardLabels({ labels: LABELS, viewState: far, size, z: 48000, otherZs: tiers.slice(0, 4).map((t) => t.z), columnWidth, layerNameRects });
    expect(layout).toBeNull();
  });

  it('描画領域に大きさがない・出す札がないときは null', () => {
    const { vs, columnWidth } = scene(1400, 1000, 20, 45, 12000);
    expect(layoutWardLabels({ labels: LABELS, viewState: vs, size: null, z: 0, otherZs: [], columnWidth, layerNameRects: [] })).toBeNull();
    expect(layoutWardLabels({ labels: [], viewState: vs, size: { width: 800, height: 600 }, z: 0, otherZs: [], columnWidth, layerNameRects: [] })).toBeNull();
  });

  it('札の位置は、視点が同じなら変わらない（決定的）', () => {
    const a = scene(2000, 1100, 20, 45, 12000).layout;
    const b = scene(2000, 1100, 20, 45, 12000).layout;
    expect(a!.placed.map((p) => p.rect)).toEqual(b!.placed.map((p) => p.rect));
  });
});

