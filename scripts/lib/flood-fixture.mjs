// 浸水想定の仮データ（flood.json と flood-*.bin）を、仮データの標高と区から決定的に作る。実在の浸水想定ではない。
// 検証（validate.mjs）のテストが使う。仮データ（public/data-fixture）にも、これを書き出せば足りる。
import { OUTSIDE, createFloodMeta, createGrid, cellCenterX, cellCenterY } from './flood.mjs';

/**
 * @param {Buffer|Uint8Array} elevationBin 標高の bin（Float32 リトルエンディアン。NaN はデータなし）
 * @param {{ contains: (x: number, y: number) => boolean }} wards createWards の戻り値
 * @returns {{ meta: object, bins: { riverDepth: Buffer, tideDepth: Buffer, riverDuration: Buffer } }}
 */
export function generateFloodFixture(elevationBin, wards) {
  const grid = createGrid();
  const view = new DataView(elevationBin.buffer, elevationBin.byteOffset, elevationBin.byteLength);
  const riverDepth = Buffer.alloc(grid.width * grid.height);
  const tideDepth = Buffer.alloc(grid.width * grid.height);
  const riverDuration = Buffer.alloc(grid.width * grid.height);
  for (let row = 0; row < grid.height; row++) {
    const y = cellCenterY(grid, row);
    for (let col = 0; col < grid.width; col++) {
      const i = row * grid.width + col;
      if (!wards.contains(cellCenterX(grid, col), y)) {
        riverDepth[i] = tideDepth[i] = riverDuration[i] = OUTSIDE;
        continue;
      }
      const raw = view.getFloat32(i * 4, true);
      const e = Number.isNaN(raw) ? 0 : raw; // 水面は低地として扱う
      riverDepth[i] = e < 0 ? 4 : e < 2 ? 3 : e < 5 ? 2 : e < 8 ? 1 : 0;
      tideDepth[i] = e < 1 ? 3 : e < 3 ? 2 : e < 5 ? 1 : 0;
      riverDuration[i] = e < 0 ? 6 : e < 2 ? 5 : e < 5 ? 3 : e < 8 ? 1 : 0;
    }
  }
  return { meta: createFloodMeta(grid), bins: { riverDepth, tideDepth, riverDuration } };
}
