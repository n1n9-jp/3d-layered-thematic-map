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

/** レイヤー間隔（m）。 */
export const SPACING = { min: 0, max: 12000, default: 5000 } as const;

/** データの取得元。URL クエリ `data=fixture` で `public/data-fixture/` に切り替える。 */
export const DATA_BASE: string =
  (typeof location !== 'undefined' && new URLSearchParams(location.search).get('data') === 'fixture'
    ? `${import.meta.env.BASE_URL}data-fixture/`
    : `${import.meta.env.BASE_URL}data/`);
