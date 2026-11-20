import { useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { COORDINATE_SYSTEM, OrbitView } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';
import { EXTENT, LAYER_IDS } from '../config';
import { registry } from '../layers';
import { onClick, onHover, probeLayers } from '../probe/controller';
import { asModelMatrix, layerZ, translationMatrix } from '../stack';
import { useMapStore } from '../store';
import type { MapState } from '../store';
import type { BoundaryData } from '../types';

const view = new OrbitView({ orthographic: true });

const { minX, minY, maxX, maxY } = EXTENT;
const FRAME = [
  {
    path: [
      [minX, minY, 0],
      [maxX, minY, 0],
      [maxX, maxY, 0],
      [minX, maxY, 0],
      [minX, minY, 0],
    ] as [number, number, number][],
  },
];

export default function StackView() {
  const state = useMapStore();
  const { order, visible, solo, spacing, data, status } = state;

  // viewState や探針が変わっても、各レイヤーの deck.gl レイヤー配列は作り直さない。
  const stackLayers = useMemo(() => {
    const boundary = status.boundary === 'ready' ? (data.boundary as BoundaryData) : null;
    const layers: Layer[] = [];
    for (const id of order) {
      const z = layerZ({ order, visible, solo, spacing }, id);
      if (z === null) continue;
      const modelMatrix = translationMatrix(z);
      layers.push(
        new PathLayer({
          id: `frame-${id}`,
          data: FRAME,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          modelMatrix: asModelMatrix(modelMatrix),
          getPath: (d: (typeof FRAME)[number]) => d.path,
          getColor: [255, 255, 255, 255],
          getWidth: 2,
          widthUnits: 'pixels',
        }),
      );
      if (status[id] === 'ready')
        layers.push(
          ...registry[id].render(data[id], { z, modelMatrix, opacity: 1, solo: solo === id, boundary }),
        );
    }
    return layers;
  }, [order, visible, solo, spacing, data, status]);

  return (
    <DeckGL
      views={view}
      viewState={state.viewState}
      onViewStateChange={({ viewState: v }) => {
        const vs = v as MapState['viewState'];
        state.setViewState({ target: vs.target, rotationOrbit: vs.rotationOrbit, rotationX: vs.rotationX, zoom: vs.zoom });
      }}
      controller={true}
      layers={[...stackLayers, ...probeLayers(state)]}
      onHover={onHover}
      onClick={onClick}
      style={{ background: '#000' }}
    />
  );
}
