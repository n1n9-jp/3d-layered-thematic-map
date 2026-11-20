import { DEFAULT_ANGLES } from '../config';
import type { LayerId } from '../config';
import type { ViewState } from '../store';
import { nearestAngle } from './camera';

/** ボタンで移れる、決まった視点。 */
export type ViewPresetId = 'top' | 'oblique' | 'front';

export interface Angles {
  rotationX: number;
  rotationOrbit: number;
}

/**
 * 決まった視点の角度。
 * - top：真上から見下ろす（北が上）
 * - oblique：初期表示と同じ角度
 * - front：南側から低い角度で見る。平面が薄い帯になり、5枚が上下に並んで読める。
 *   平面の奥行き（36 km）は rotationX 12 度で約 7.5 km の高さに見え、既定の間隔 12 km（見た目 約 11.7 km）より小さい。
 */
export const VIEW_PRESETS: Record<ViewPresetId, Angles & { label: string }> = {
  top: { rotationX: 90, rotationOrbit: 0, label: '真上' },
  oblique: { ...DEFAULT_ANGLES, label: '斜め' },
  front: { rotationX: 12, rotationOrbit: 0, label: '正面' },
};

export const PRESET_IDS: readonly ViewPresetId[] = ['top', 'oblique', 'front'];

/** 方位を回すときの1回の角度（度）。 */
export const ORBIT_STEP = 45;

/**
 * 回す向き。-1 が「左へ回す」、1 が「右へ回す」。
 * 「右へ回す」は、見ている地図が画面の上で時計回りに回る向き（rotationOrbit は減る）。
 */
export type RotateDir = -1 | 1;

export type ViewCommand = { type: 'preset'; id: ViewPresetId } | { type: 'rotate'; dir: RotateDir };

/** 角度の一致とみなす許容（度）。 */
export const ANGLE_TOLERANCE = 0.5;

/** `from` からボタンで移る先の角度。方位は、いまの値から近い向きに回る（360度の整数倍の違いは区別しない）。 */
export function resolveAngles(cmd: ViewCommand, from: Angles): Angles {
  if (cmd.type === 'preset') {
    const p = VIEW_PRESETS[cmd.id];
    return { rotationX: p.rotationX, rotationOrbit: nearestAngle(p.rotationOrbit, from.rotationOrbit) };
  }
  return { rotationX: from.rotationX, rotationOrbit: from.rotationOrbit - cmd.dir * ORBIT_STEP };
}

const wrap360 = (a: number) => ((a % 360) + 360) % 360;
/** 2つの方位の差（度、0〜180）。 */
export function orbitDiff(a: number, b: number): number {
  const d = wrap360(a - b);
  return Math.min(d, 360 - d);
}

/** 角度が決まった視点のどれかと一致するならその ID、なければ null。 */
export function matchPreset(a: Angles, tolerance = ANGLE_TOLERANCE): ViewPresetId | null {
  for (const id of PRESET_IDS) {
    const p = VIEW_PRESETS[id];
    if (Math.abs(a.rotationX - p.rotationX) <= tolerance && orbitDiff(a.rotationOrbit, p.rotationOrbit) <= tolerance) return id;
  }
  return null;
}

/**
 * ボタンで選択中と表示する視点。
 * 単独表示のあいだ（2D 表示に固定されている）と、利用者がドラッグなどで動かした後（`autoFit` が false）は null。
 */
export function selectedPreset(s: { viewState: Pick<ViewState, 'rotationX' | 'rotationOrbit'>; autoFit: boolean; solo: LayerId | null }): ViewPresetId | null {
  if (s.solo !== null || !s.autoFit) return null;
  return matchPreset(s.viewState);
}

/* ---------- ボタンから積層の描画（StackView）への合図 ---------- */

const listeners = new Set<(cmd: ViewCommand) => void>();

/** 視点を移す命令を出す。StackView が受けて、アニメーションで移す。 */
export function requestView(cmd: ViewCommand): void {
  listeners.forEach((l) => l(cmd));
}

export function subscribeViewCommand(l: (cmd: ViewCommand) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
