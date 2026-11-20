import type { LayerId } from '../config';
import type { LayerModule } from '../types';
import elevation from './elevation';
import population from './population';
import roads from './roads';
import transit from './transit';
import facilities from './facilities';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const registry: Record<LayerId, LayerModule<any>> = {
  elevation,
  population,
  roads,
  transit,
  facilities,
};
