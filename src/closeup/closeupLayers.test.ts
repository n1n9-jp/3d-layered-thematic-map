import { describe, expect, it } from 'vitest';
import { circleLayer, circlePath } from './closeupLayers';

describe('circlePath', () => {
  const p = circlePath(100, -200, 1500);
  it('始点に戻る閉じた折れ線で、すべての点が中心から半径の距離にある', () => {
    expect(p[0]).toEqual(p[p.length - 1]);
    for (const [x, y] of p) expect(Math.hypot(x - 100, y + 200)).toBeCloseTo(1500, 6);
  });
  it('分割数 + 1 個の頂点', () => {
    expect(circlePath(0, 0, 10, 16)).toHaveLength(17);
  });
});

describe('circleLayer', () => {
  it('同じ円なら、段の高さが違っても同じデータの参照を使い回す', () => {
    const c = { x: 1, y: 2, r: 1000 };
    const a = circleLayer('a', c, 0);
    const b = circleLayer('b', c, 12000);
    expect(a.props.data).toBe(b.props.data);
    const other = circleLayer('c', { ...c, r: 2000 }, 0);
    expect(other.props.data).not.toBe(a.props.data);
  });
});
