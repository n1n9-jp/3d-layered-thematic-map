/**
 * 画面の画素 → ワールドの視線（平行投影）→ 平面との交点。
 * `OrbitViewport.unproject([px, py, depth])` の depth は NDC の深度（-1 が near 面、+1 が far 面）。
 */
import type { Viewport } from '@deck.gl/core';
import { EXTENT } from '../config';
import type { LayerId } from '../config';

export type Vec3 = [number, number, number];

/** 視線の直線。`dir` は単位ベクトル。点 = origin + t * dir。 */
export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/** 平面（高さ z の水平面）。 */
export interface Plane {
  id: LayerId;
  z: number;
}

export interface ProbePoint {
  x: number;
  y: number;
  layerId: LayerId;
}

/** 画素 (px, py)（左上原点）を通る視線。平行投影なので、方向はどの画素でも同じ。 */
export function rayFromPixel(viewport: Pick<Viewport, 'unproject'>, px: number, py: number): Ray {
  const near = viewport.unproject([px, py, -1]);
  const far = viewport.unproject([px, py, 1]);
  const dx = far[0] - near[0];
  const dy = far[1] - near[1];
  const dz = far[2] - near[2];
  const len = Math.hypot(dx, dy, dz);
  return {
    origin: [near[0], near[1], near[2]],
    dir: [dx / len, dy / len, dz / len],
  };
}

/** 視線と水平面 z = 定数 の交点の (x, y)。視線が水平面と平行なら null。 */
export function intersectHorizontalPlane(ray: Ray, z: number): { x: number; y: number } | null {
  const dz = ray.dir[2];
  if (!Number.isFinite(dz) || Math.abs(dz) < 1e-9) return null;
  const t = (z - ray.origin[2]) / dz;
  const x = ray.origin[0] + t * ray.dir[0];
  const y = ray.origin[1] + t * ray.dir[1];
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function inExtent(x: number, y: number): boolean {
  return x >= EXTENT.minX && x <= EXTENT.maxX && y >= EXTENT.minY && y <= EXTENT.maxY;
}

/**
 * `planes` を先頭（上の段）から順に試し、交点が EXTENT 内に入った最初の平面を採用する。
 * どの平面にも当たらなければ null。
 */
export function pickProbePoint(
  viewport: Pick<Viewport, 'unproject'>,
  px: number,
  py: number,
  planes: readonly Plane[],
): ProbePoint | null {
  const ray = rayFromPixel(viewport, px, py);
  for (const plane of planes) {
    const hit = intersectHorizontalPlane(ray, plane.z);
    if (hit && inExtent(hit.x, hit.y)) return { x: hit.x, y: hit.y, layerId: plane.id };
  }
  return null;
}
