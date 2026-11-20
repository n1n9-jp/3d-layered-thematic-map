import { useEffect, useRef, useState } from 'react';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';

export type ZMap = Record<LayerId, number | null>;

/** 目標値へ近づく速さの時定数（ms）。 */
const TAU = 90;
/** この距離（m）より近づいたら目標値に合わせて止める。 */
const SNAP = 0.5;

const sameZ = (a: ZMap, b: ZMap) => LAYER_IDS.every((id) => a[id] === b[id]);

/**
 * 各レイヤーの「表示用の高さ」。目標値が変わると requestAnimationFrame で滑らかに近づける。
 * `immediate` のとき（スライダーを動かしている間）は補間せず、目標値をそのまま返す。
 * 新しく表示されるレイヤーは、目標の高さにそのまま現れる。
 */
export function useDisplayedZ(targets: ZMap, immediate: boolean): ZMap {
  const [shown, setShown] = useState<ZMap>(targets);
  const cur = useRef<ZMap>(targets);
  const goal = useRef<ZMap>(targets);
  goal.current = targets;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const next = {} as ZMap;
      let moving = false;
      for (const id of LAYER_IDS) {
        const t = goal.current[id];
        const c = cur.current[id];
        if (t === null || c === null || immediate) {
          next[id] = t;
        } else {
          let v = c + (t - c) * (1 - Math.exp(-dt / TAU));
          if (Math.abs(t - v) < SNAP) v = t;
          else moving = true;
          next[id] = v;
        }
      }
      if (!sameZ(next, cur.current)) {
        cur.current = next;
        setShown(next);
      }
      if (moving) raf = requestAnimationFrame(tick);
    };

    tick(last);
    return () => cancelAnimationFrame(raf);
  }, [targets, immediate]);

  return immediate ? targets : shown;
}
