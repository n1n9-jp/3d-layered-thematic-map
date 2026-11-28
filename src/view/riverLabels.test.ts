import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_OUTLINE, LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import type { RiverAnchor } from '../layers/rivers';
import { fitStack, makeProjector } from './camera';
import type { Size } from './camera';
import { segmentHitsRect, segmentsCross } from './calloutPlacement';
import { bandRect, convexIntersectsRect, infoColumnWidth, RIGHT_PANEL_W } from './layout';
import type { Pt, Rect } from './layout';
import { stackLabelRects } from './labelLayers';
import { layoutRiverLabels, riverLabelLayers } from './riverLabels';

/** 実データの、幹となる川の札の根元。 */
const ANCHORS = (JSON.parse(readFileSync(path.join(__dirname, '../../public/data/river-labels.json'), 'utf8')).anchors as RiverAnchor[]).filter((a) => a.trunk);

const rectsOverlap = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const SIZES: [number, number][] = [
  [2000, 1100],
  [1400, 1000],
];
const VIEWS: [string, number, number][] = [
  ['斜め', 20, 45],
  ['回転 120', 20, 120],
  ['正面', 12, 0],
  ['真上', 90, 0],
];
const SPACINGS = [0, 12000, 20000];
const TARGETS: LayerId[] = ['flood', 'elevation'];

function scene(windowW: number, windowH: number, rotationX: number, rotationOrbit: number, spacing: number, target: LayerId) {
  const size: Size = { width: windowW - RIGHT_PANEL_W, height: windowH };
  const columnWidth = infoColumnWidth(windowW);
  const tiers = LAYER_IDS.map((id, i) => ({ id: id as LayerId, z: i * spacing }));
  const top = (LAYER_IDS.length - 1) * spacing;
  const vs = { rotationX, rotationOrbit, ...fitStack({ rotationX, rotationOrbit, top, size, columnWidth }) };
  const layerNameRects = stackLabelRects({ tiers, viewState: vs, size });
  const z = tiers.find((t) => t.id === target)!.z;
  const layout = layoutRiverLabels({
    anchors: ANCHORS,
    viewState: vs,
    size,
    z,
    otherZs: tiers.filter((t) => t.id !== target).map((t) => t.z),
    columnWidth,
    layerNameRects,
  });
  return { size, columnWidth, vs, tiers, layerNameRects, layout, z };
}

describe('川の名前の札の置き場所', () => {
  it('幹となる川は 5 本（4〜6 本）', () => {
    expect(ANCHORS.map((a) => a.name).sort()).toEqual(['中川', '多摩川', '江戸川', '荒川', '隅田川'].sort());
  });

  for (const [w, h] of SIZES)
    for (const [viewName, rx, ro] of VIEWS)
      for (const spacing of SPACINGS)
        for (const target of TARGETS)
          it(`${w}×${h}・${viewName}・間隔 ${spacing / 1000} km・${target}：札どうし・帯・列・レイヤー名・ほかの段のデータに重ならない`, () => {
            const { size, columnWidth, vs, tiers, layerNameRects, layout } = scene(w, h, rx, ro, spacing, target);
            if (!layout) return; // 全部が画面の外
            const pr = makeProjector(vs, size);
            const hullOf = (z: number) => DATA_OUTLINE.map(([x, y]) => pr.project([x, y, z]) as Pt);
            const colLeft = size.width - columnWidth;
            for (const p of layout.placed) {
              expect(p.rect.left).toBeGreaterThanOrEqual(0);
              expect(p.rect.top).toBeGreaterThanOrEqual(0);
              expect(p.rect.bottom).toBeLessThanOrEqual(size.height);
              expect(p.rect.right).toBeLessThanOrEqual(colLeft);
              expect(rectsOverlap(p.rect, bandRect(size.width))).toBe(false);
              for (const r of layerNameRects) expect(rectsOverlap(p.rect, r)).toBe(false);
              for (const t of tiers) if (t.id !== target) expect(convexIntersectsRect(hullOf(t.z), p.rect)).toBe(false);
            }
            for (let i = 0; i < layout.placed.length; i++)
              for (let j = i + 1; j < layout.placed.length; j++) {
                const a = layout.placed[i];
                const b = layout.placed[j];
                expect(rectsOverlap(a.rect, b.rect)).toBe(false);
                expect(segmentsCross(a.anchor, a.attach, b.anchor, b.attach)).toBe(false);
                expect(segmentHitsRect(a.anchor, a.attach, b.rect)).toBe(false);
                expect(segmentHitsRect(b.anchor, b.attach, a.rect)).toBe(false);
              }
            expect(layout.placed.length + layout.omitted.length).toBeLessThanOrEqual(ANCHORS.length);
          });

  it('既定の視点（1400×1000 と 2000×1100、間隔 12 km）では、5 本の川の札が全部出る（浸水と標高の行を開いたとき）', () => {
    for (const [w, h] of SIZES)
      for (const target of TARGETS) {
        const { layout } = scene(w, h, 20, 45, 12000, target);
        expect(layout!.omitted, `${w}×${h} ${target}`).toEqual([]);
        expect(layout!.placed).toHaveLength(5);
      }
  });

  it('画面の外の川には、札を出さない。描画領域に大きさがない・出す札がないときは null', () => {
    const { vs, size, columnWidth, layerNameRects } = scene(1400, 1000, 20, 45, 12000, 'flood');
    const far = { ...vs, target: [vs.target[0] - 400000, vs.target[1], vs.target[2]] as [number, number, number] };
    expect(layoutRiverLabels({ anchors: ANCHORS, viewState: far, size, z: 12000, otherZs: [], columnWidth, layerNameRects })).toBeNull();
    expect(layoutRiverLabels({ anchors: ANCHORS, viewState: vs, size: null, z: 0, otherZs: [], columnWidth, layerNameRects })).toBeNull();
    expect(layoutRiverLabels({ anchors: [], viewState: vs, size, z: 0, otherZs: [], columnWidth, layerNameRects })).toBeNull();
  });

  it('札の位置は、視点が同じなら変わらない（決定的）', () => {
    const a = scene(2000, 1100, 20, 45, 12000, 'flood').layout;
    const b = scene(2000, 1100, 20, 45, 12000, 'flood').layout;
    expect(a!.placed.map((p) => p.rect)).toEqual(b!.placed.map((p) => p.rect));
  });

  it('レイヤーは、引き出し線（縁取りと線）・根元の丸・札の 4 つ。札がなければ空', () => {
    const { layout } = scene(1400, 1000, 20, 45, 12000, 'flood');
    expect(riverLabelLayers(layout!).map((l) => l.id)).toEqual(['river-callout-leader-halo', 'river-callout-leader', 'river-callout-dot', 'river-callout-text']);
    expect(riverLabelLayers({ ...layout!, placed: [], world: [] })).toEqual([]);
  });
});
