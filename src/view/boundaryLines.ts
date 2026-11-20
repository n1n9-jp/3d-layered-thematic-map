import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';
import { asModelMatrix, translationMatrix } from '../stack';
import { simplifyPath } from '../layers/simplify';
import type { BoundaryData, Position } from '../types';

/** 区境界の1本の線（リング1つぶん）。 */
export type BoundaryPath = readonly Position[];

/** 全段に重ねる区境界線の見た目。控えめな細い線。 */
export const BOUNDARY_COLOR: [number, number, number, number] = [235, 240, 250, 140];
export const BOUNDARY_WIDTH_PX = 1;
/**
 * 描画用に線を間引く許容誤差（m）。1 px の線で、初期表示では 1 px が約 70 m、最大に拡大しても約 2 m。
 * 探針の区名の判定は元の境界（BoundaryData）で行うので、この値は表示だけに効く。
 */
export const BOUNDARY_DRAW_TOLERANCE = 3;

/** 区境界（Polygon / MultiPolygon）を、リングごとの線に分ける（描画用に間引く）。段が変わっても作り直さない。 */
export function boundaryPaths(boundary: BoundaryData): BoundaryPath[] {
  const out: BoundaryPath[] = [];
  for (const f of boundary.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const rings of polys) {
      for (const ring of rings) {
        const drawn = simplifyPath(ring, BOUNDARY_DRAW_TOLERANCE);
        if (drawn.length > 1) out.push(drawn);
      }
    }
  }
  return out;
}

// アクセサは参照を固定する（段の高さが変わっても属性を再計算させない）。
const getPath = (d: BoundaryPath) => d as Position[];

/** 高さ z の段に重ねる区境界線。データとアクセサの参照は固定で、高さは modelMatrix だけで与える。 */
export function boundaryLayer(paths: BoundaryPath[], tier: string, z: number): PathLayer<BoundaryPath> {
  return new PathLayer<BoundaryPath>({
    id: `boundary-lines-${tier}`,
    data: paths,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    modelMatrix: asModelMatrix(translationMatrix(z)),
    getPath,
    positionFormat: 'XY',
    getColor: BOUNDARY_COLOR,
    getWidth: BOUNDARY_WIDTH_PX,
    widthUnits: 'pixels',
    capRounded: true,
    jointRounded: true,
    billboard: true,
    pickable: false,
  });
}
