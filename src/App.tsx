import DeckGL from '@deck.gl/react';
import { COORDINATE_SYSTEM, OrbitView } from '@deck.gl/core';
import type { OrbitViewState } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';
import { EXTENT } from './config';

const { minX, minY, maxX, maxY } = EXTENT;

const view = new OrbitView({ orthographic: true });

const INITIAL_VIEW_STATE: OrbitViewState = {
  target: [(minX + maxX) / 2, (minY + maxY) / 2, 0],
  rotationX: 45,
  rotationOrbit: 30,
  // 正射影では zoom 0 で 1 ユニット = 1px。36km が 600px 前後に収まる値。
  zoom: Math.log2(600 / (maxX - minX)),
};

const frame = [
  {
    path: [
      [minX, minY, 0],
      [maxX, minY, 0],
      [maxX, maxY, 0],
      [minX, maxY, 0],
      [minX, minY, 0],
    ],
  },
];

const layers = [
  new PathLayer({
    id: 'extent-frame',
    data: frame,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    getPath: (d: (typeof frame)[number]) => d.path as [number, number, number][],
    getColor: [255, 255, 255, 255],
    getWidth: 2,
    widthUnits: 'pixels',
  }),
];

export default function App() {
  return (
    <DeckGL
      views={view}
      initialViewState={INITIAL_VIEW_STATE}
      controller={true}
      layers={layers}
      style={{ background: '#000' }}
    />
  );
}
