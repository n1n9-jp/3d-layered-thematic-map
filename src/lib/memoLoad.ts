/**
 * `load(base)` の結果（Promise）を、base ごとに1回だけ作って使い回す。
 * 別のレイヤーのデータを読む必要があるレイヤー（避難が、区ごとの浸水の想定に人口と浸水想定を読む）が、同じファイルを2回取得・構築しないために使う。
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
