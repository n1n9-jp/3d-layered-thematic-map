/** スライダーを直接動かしている間 true。積層の高さが補間せず、遅れずに追従するための合図。 */
let active = false;
const listeners = new Set<() => void>();

export function setSliderActive(v: boolean): void {
  if (active === v) return;
  active = v;
  listeners.forEach((l) => l());
}

export function subscribeSliderActive(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const getSliderActive = (): boolean => active;
