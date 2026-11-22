/** 描画範囲（ローカルのメートル座標）。README の座標系を参照。 */
export const EXTENT = {
  minX: -19000,
  minY: -19000,
  maxX: 17000,
  maxY: 17000,
} as const;

/**
 * 23区のデータ（区境界の全頂点）を、少し余裕をもって囲む凸多角形（ローカル座標、m）。
 * 描画範囲（EXTENT）の正方形より小さく、4隅にはデータがない。全体の積層を画面に収めるとき、
 * 正方形の外枠ではなくこの範囲を、パネルやクローズアップに重ならないようにする（外枠の角は、ほかの領域の下に少し入ってよい）。
 * 区境界から 15 度刻みの24方向の支持線で囲んだもの（余裕 300 m）。`src/view/dataOutline.test.ts` が、実データの全頂点を囲んでいることを確かめる。
 */
export const DATA_OUTLINE: readonly (readonly [number, number])[] = [
  [15587, 2974], [13310, 11471], [13239, 11594], [11892, 12941], [9004, 14609], [5383, 15579],
  [-1747, 15579], [-11829, 12877], [-16047, 10442], [-17102, 9387], [-17203, 9212], [-17231, 9108],
  [-17231, 2310], [-14754, -6936], [-14714, -7004], [-7119, -14599], [-4374, -16184], [-803, -17141],
  [5568, -17141], [5645, -17121], [5713, -17081], [6970, -15824], [14140, -3405], [15587, 1994],
];

/** レイヤーID。下から上の順（標高、浸水、人口、公共交通、避難）。 */
export const LAYER_IDS = ['elevation', 'flood', 'population', 'transit', 'shelters'] as const;

export type LayerId = (typeof LAYER_IDS)[number];

/** 浸水の想定：洪水と高潮の大きいほう（既定）、洪水、高潮。洪水と高潮は別々の災害の想定で、足し合わせない。 */
export const FLOOD_SCENARIOS = ['max', 'river', 'tide'] as const;
export type FloodScenario = (typeof FLOOD_SCENARIOS)[number];
/** 浸水で見るもの：深さ（既定）、水が引くまでの期間（浸水継続時間）。 */
export const FLOOD_VIEWS = ['depth', 'duration'] as const;
export type FloodView = (typeof FLOOD_VIEWS)[number];
/** 人口で見るもの：総人口（既定）、65歳以上（人口密度で塗る）。 */
export const POPULATION_VIEWS = ['total', 'elderly'] as const;
export type PopulationView = (typeof POPULATION_VIEWS)[number];

/** レイヤー一覧の行にある切り替えの状態。描画・凡例・断面・クローズアップの集計が、これに従う。 */
export interface LayerOptions {
  floodScenario: FloodScenario;
  floodView: FloodView;
  populationView: PopulationView;
}
export const DEFAULT_OPTIONS: LayerOptions = { floodScenario: 'max', floodView: 'depth', populationView: 'total' };

/** レイヤー間隔（m）。 */
export const SPACING = { min: 0, max: 20000, default: 12000 } as const;

/** 視点の上下限。zoom は 2^zoom px/m、rotationX は水平面からの見下ろし角（度）。 */
export const VIEW_LIMITS = { minZoom: -9, maxZoom: -1, minRotationX: 8, maxRotationX: 90 } as const;

/** 初期視点の角度（度）。 */
export const DEFAULT_ANGLES = { rotationX: 20, rotationOrbit: 45 } as const;

/** クローズアップの半径（m）の選択肢と既定値。 */
export const CLOSEUP_RADII = [1000, 2000, 5000] as const;
export type CloseupRadius = (typeof CLOSEUP_RADII)[number];
export const DEFAULT_CLOSEUP_RADIUS: CloseupRadius = 2000;

/** データの取得元。URL クエリ `data=fixture` で `public/data-fixture/` に切り替える。 */
export const DATA_BASE: string =
  (typeof location !== 'undefined' && new URLSearchParams(location.search).get('data') === 'fixture'
    ? `${import.meta.env.BASE_URL}data-fixture/`
    : `${import.meta.env.BASE_URL}data/`);
