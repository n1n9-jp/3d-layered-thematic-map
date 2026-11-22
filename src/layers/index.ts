import type { LayerId } from '../config';
import type { LayerModule } from '../types';
import elevation from './elevation';
import flood from './flood';
import population from './population';
import transit from './transit';
import shelters from './shelters';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const registry: Record<LayerId, LayerModule<any>> = {
  elevation,
  flood,
  population,
  transit,
  shelters,
};
