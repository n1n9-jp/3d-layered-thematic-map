/**
 * `load(base)` の結果（Promise）を、base ごとに1回だけ作って使い回す。
 * 同じレイヤーのデータを、複数の場所（描画と、23区全体の集計など）が読むとき、同じファイルを2回取得・構築しないために使う。
 */
export function memoLoad<D>(load: (base: string) => Promise<D>): (base: string) => Promise<D> {
  const cache = new Map<string, Promise<D>>();
  return (base) => {
    let p = cache.get(base);
    if (!p) {
      p = load(base);
      cache.set(base, p);
    }
    return p;
  };
}
