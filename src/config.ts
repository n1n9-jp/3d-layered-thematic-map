/** 描画範囲（ローカルのメートル座標）。README の座標系を参照。 */
export const EXTENT = {
  minX: -19000,
  minY: -19000,
  maxX: 17000,
  maxY: 17000,
} as const;

/** レイヤーID。下から上の順。 */
export const LAYER_IDS = ['elevation', 'population', 'roads', 'transit', 'facilities'] as const;

export type LayerId = (typeof LAYER_IDS)[number];
