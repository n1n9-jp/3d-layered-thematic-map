import { useLayoutEffect, useRef, useState } from 'react';
import { hasSize } from './camera';
import type { Size } from './camera';

/**
 * 要素の大きさを追う。幅か高さが 1px に満たない間は null（まだ大きさがないものとして扱い、視点の計算も投影もしない）。
 * 戻り値の ref を測りたい要素に付ける。
 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next = hasSize(r) ? { width: r.width, height: r.height } : null;
      setSize((s) => (s === next || (s && next && s.width === next.width && s.height === next.height) ? s : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}
