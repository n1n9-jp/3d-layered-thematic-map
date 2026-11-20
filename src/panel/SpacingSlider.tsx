import { SPACING } from '../config';
import { useMapStore } from '../store';

export default function SpacingSlider() {
  const spacing = useMapStore((s) => s.spacing);
  const setSpacing = useMapStore((s) => s.setSpacing);
  return (
    <label style={{ display: 'block', fontSize: 14 }}>
      レイヤー間隔 {(spacing / 1000).toFixed(1)} km
      <input
        type="range"
        min={SPACING.min}
        max={SPACING.max}
        step={100}
        value={spacing}
        onChange={(e) => setSpacing(Number(e.target.value))}
        style={{ display: 'block', width: '100%' }}
      />
    </label>
  );
}
