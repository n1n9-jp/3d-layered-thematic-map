export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

/**
 * 標高（m）→ 色の対応。区切りは固定で、データの min / max には依存しない。
 * - 0m 未満（海面より低い土地）：青系。-5m で濃い青、0m 直下で明るい青
 * - 0m 以上：緑 → 黄緑 → 黄 → 淡い黄 → 白に近い色へ、明るさも単調に上がる
 * 範囲外は両端の色に丸める。
 */
const BELOW_SEA: [number, RGB][] = [
  [-5, [44, 84, 214]],
  [0, [96, 176, 255]],
];

const LAND: [number, RGB][] = [
  [0, [52, 120, 72]],
  [10, [138, 178, 82]],
  [20, [220, 208, 104]],
  [35, [248, 226, 170]],
  [50, [255, 248, 235]],
];

function ramp(stops: [number, RGB][], v: number): RGB {
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (v <= first[0]) return first[1];
  if (v >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i];
    if (v <= v1) {
      const [v0, c0] = stops[i - 1];
      const t = (v - v0) / (v1 - v0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t),
      ];
    }
  }
  return last[1];
}

/** 標高 v（m）の色 [r, g, b, a]（0〜255）。NaN（データなし）は完全に透明。 */
export function elevationColor(v: number): RGBA {
  if (Number.isNaN(v)) return [0, 0, 0, 0];
  const [r, g, b] = v < 0 ? ramp(BELOW_SEA, v) : ramp(LAND, v);
  return [r, g, b, 255];
}

/** 凡例の代表的な区切り。色は `elevationColor` から引く。 */
export const LEGEND_STOPS: { value: number; label: string }[] = [
  { value: -5, label: '-5m以下' },
  { value: 0, label: '0m' },
  { value: 10, label: '10m' },
  { value: 20, label: '20m' },
  { value: 35, label: '35m' },
  { value: 50, label: '50m以上' },
];

/** 標高格子 → RGBA のバイト列（行は北から南、そのまま画像の上から下）。 */
export function elevationPixels(values: ArrayLike<number>): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(values.length * 4));
  for (let i = 0; i < values.length; i++) {
    const c = elevationColor(values[i]);
    const o = i * 4;
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = c[3];
  }
  return out;
}
