import { OrbitView } from '@deck.gl/core';
import { describe, expect, it } from 'vitest';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { layerZ } from '../stack';
import { projectPoint, labelAnchors } from '../view/camera';
import type { Size } from '../view/camera';
import { CLOSEUP_LAYOUT } from '../view/layout';
import { PLANE_WIDTH, closeupBox, closeupHeights, closeupSpacing, closeupView, pickCloseupPoint, radiusLabel } from './closeupModel';

const ORDER: LayerId[] = ['elevation', 'population', 'roads', 'transit', 'facilities'];
const visible = Object.fromEntries(LAYER_IDS.map((id) => [id, true])) as Record<LayerId, boolean>;

describe('closeupSpacing', () => {
  it('間隔 ÷ 円の直径 が、全体の「間隔 ÷ 平面の幅」と同じになる', () => {
    for (const spacing of [0, 3000, 12000, 20000])
      for (const r of [1000, 2000, 5000]) expect(closeupSpacing(spacing, r) / (2 * r)).toBeCloseTo(spacing / PLANE_WIDTH, 12);
  });
  it('平面の幅は 36 km。半径 2 km・間隔 12 km なら、約 1.33 km', () => {
    expect(PLANE_WIDTH).toBe(36000);
    expect(closeupSpacing(12000, 2000)).toBeCloseTo(1333.33, 1);
  });
  it('間隔 0 は 0 のまま', () => {
    expect(closeupSpacing(0, 5000)).toBe(0);
  });
});

describe('closeupHeights', () => {
  it('段の順番・表示・非表示・単独表示は、全体の地図と同じで、高さだけが比例して縮む', () => {
    const state = { order: ORDER, visible: { ...visible, roads: false }, solo: null, spacing: 12000 };
    const main = LAYER_IDS.map((id) => layerZ(state, id));
    const close = LAYER_IDS.map((id) => closeupHeights(state, 2000)[id]);
    close.forEach((z, i) => {
      const m = main[i];
      if (m === null) expect(z).toBeNull();
      else expect(z).toBeCloseTo((m * 4000) / 36000, 9);
    });
  });
  it('単独表示は、対象だけが高さ 0', () => {
    const h = closeupHeights({ order: ORDER, visible, solo: 'transit', spacing: 12000 }, 1000);
    expect(h).toEqual({ elevation: null, population: null, roads: null, transit: 0, facilities: null });
  });
});

describe('closeupView', () => {
  const circle = { x: 1550, y: 130, r: 2000 };
  const sizes: Size[] = [
    { width: 480, height: 600 },
    { width: 340, height: 390 },
    { width: 560, height: 800 },
  ];
  for (const size of sizes)
    for (const [rotationX, rotationOrbit] of [[20, 45], [12, 0], [90, 0], [60, 200]])
      for (const top of [0, 1333, 5333]) {
        it(`${size.width}x${size.height} rx=${rotationX} ro=${rotationOrbit} top=${top}: 円が余白の内側に収まる`, () => {
          const vs = closeupView({ circle, rotationX, rotationOrbit, top, size });
          expect(vs.rotationX).toBe(rotationX);
          expect(vs.rotationOrbit).toBe(rotationOrbit);
          const { padding } = CLOSEUP_LAYOUT;
          const pts = [0, top].flatMap((z) =>
            Array.from({ length: 72 }, (_, k) => {
              const t = (2 * Math.PI * k) / 72;
              return projectPoint(vs, size, [circle.x + circle.r * Math.cos(t), circle.y + circle.r * Math.sin(t), z]);
            }),
          );
          const eps = 0.5;
          expect(Math.min(...pts.map((p) => p[0]))).toBeGreaterThanOrEqual(padding.left - eps);
          expect(Math.max(...pts.map((p) => p[0]))).toBeLessThanOrEqual(size.width - padding.right + eps);
          expect(Math.min(...pts.map((p) => p[1]))).toBeGreaterThanOrEqual(padding.top - eps);
          expect(Math.max(...pts.map((p) => p[1]))).toBeLessThanOrEqual(size.height - padding.bottom + eps);
        });
      }

  it('どちらかの辺が余白にほぼ接する大きさまで拡大する', () => {
    const size = { width: 480, height: 600 };
    const vs = closeupView({ circle, rotationX: 90, rotationOrbit: 0, top: 0, size });
    const inner = size.width - CLOSEUP_LAYOUT.padding.left - CLOSEUP_LAYOUT.padding.right;
    // 真上から見た円の直径（px）= 2r · 2^zoom
    expect(2 * circle.r * 2 ** vs.zoom).toBeCloseTo(inner, 0);
  });

  it('半径が2倍になると、拡大率が半分（zoom が1小さい）', () => {
    const size = { width: 480, height: 600 };
    const a = closeupView({ circle: { ...circle, r: 1000 }, rotationX: 20, rotationOrbit: 45, top: 667, size });
    const b = closeupView({ circle: { ...circle, r: 2000 }, rotationX: 20, rotationOrbit: 45, top: 1333, size });
    expect(a.zoom - b.zoom).toBeCloseTo(1, 6);
  });

  it('円の中心は、高さ方向の中央が視点の注視点になる', () => {
    const vs = closeupView({ circle, rotationX: 20, rotationOrbit: 45, top: 1000, size: { width: 480, height: 600 } });
    expect(vs.target[2]).toBe(500);
  });
});

describe('レイヤー名の位置（円）', () => {
  it('円の縁の上（中心から半径だけ離れた点）にある', () => {
    const box = closeupBox({ x: 100, y: -50, r: 2000 });
    for (const [rx, ro] of [[20, 45], [90, 0], [12, 300]]) {
      const [a] = labelAnchors(rx, ro, [0], box);
      expect(Math.hypot(a[0] - 100, a[1] + 50)).toBeCloseTo(2000, 6);
    }
  });
  it('既定の（正方形の）平面では、従来どおり縁の上', () => {
    const [a] = labelAnchors(90, 0, [0]);
    expect(a[0]).toBeCloseTo(17000, 6);
  });
});

describe('radiusLabel', () => {
  it('「半径 2 km」', () => {
    expect(radiusLabel(2000)).toBe('半径 2 km');
    expect(radiusLabel(5000)).toBe('半径 5 km');
  });
});

describe('pickCloseupPoint', () => {
  const circle = { x: 1500, y: 100, r: 2000 };
  const zs = [0, 800, 1600, 2400, 3200];
  const planes = LAYER_IDS.map((id, i) => ({ id, z: zs[i] })).reverse(); // 上の段が先頭
  const size = { width: 400, height: 700 };
  const view = (rotationOrbit: number, rotationX = 30) => {
    const v = closeupView({ circle, rotationX, rotationOrbit, top: 3200, size });
    const vp = new OrbitView({ orthographic: true, fovy: 5 }).makeViewport({ ...size, viewState: v });
    if (!vp) throw new Error('viewport を作れません');
    return vp;
  };

  it('円の中心の上の段の点は、その段の中心を返す（上の段から順に当たる）', () => {
    const vp = view(45);
    const [px, py] = vp.project([circle.x, circle.y, 3200]);
    const p = pickCloseupPoint(vp, px, py, planes, circle);
    expect(p?.layerId).toBe('facilities');
    expect(p?.x).toBeCloseTo(circle.x, 3);
    expect(p?.y).toBeCloseTo(circle.y, 3);
  });
  it('下の段の点をクリックすると、その段のその地点になる（上の段の円の外にある位置）', () => {
    const vp = view(45, 20);
    // 標高の段の、円の縁近くの点。上の段の円からは外れた画面の位置
    const target: [number, number] = [circle.x + 0, circle.y - 1900];
    const [px, py] = vp.project([target[0], target[1], 0]);
    const p = pickCloseupPoint(vp, px, py, planes, circle);
    expect(p).not.toBeNull();
    expect(p?.layerId).toBe('elevation');
    expect(p?.x).toBeCloseTo(target[0], 3);
    expect(p?.y).toBeCloseTo(target[1], 3);
  });
  it('中心から画面の右へずれた位置をクリックすると、視点の向きに応じた方向へ中心が動く', () => {
    for (const ro of [0, 45, 90, 180, -60]) {
      const vp = view(ro, 90); // 真上から見る
      const [cx, cy] = vp.project([circle.x, circle.y, 3200]);
      const p = pickCloseupPoint(vp, cx + 60, cy, planes, circle);
      expect(p).not.toBeNull();
      // 画面の右 = 方位 ro のときの、世界の向き。中心からのずれは、画面の右へ 60 px に当たる距離
      const dx = (p?.x ?? NaN) - circle.x;
      const dy = (p?.y ?? NaN) - circle.y;
      const [rx, ry] = vp.project([circle.x + dx, circle.y + dy, 3200]);
      expect(rx).toBeCloseTo(cx + 60, 3);
      expect(ry).toBeCloseTo(cy, 3);
      expect(Math.hypot(dx, dy)).toBeGreaterThan(1);
      // 方位が違えば、向きも違う（0 度では東、90 度では ro に応じて回る）
      if (ro === 0) {
        expect(dx).toBeGreaterThan(0);
        expect(Math.abs(dy)).toBeLessThan(1e-3);
      }
    }
  });
  it('円の外は何も指さない', () => {
    const vp = view(45);
    expect(pickCloseupPoint(vp, 2, 2, planes, circle)).toBeNull();
    const [px, py] = vp.project([circle.x + circle.r * 1.2, circle.y, 3200]);
    expect(pickCloseupPoint(vp, px, py, [{ id: 'facilities', z: 3200 }], circle)).toBeNull();
  });
  it('段がなければ何も指さない', () => {
    const vp = view(45);
    expect(pickCloseupPoint(vp, 200, 350, [], circle)).toBeNull();
  });
});
