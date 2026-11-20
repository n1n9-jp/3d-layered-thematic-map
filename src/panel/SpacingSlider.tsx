import { useEffect } from 'react';
import { SPACING } from '../config';
import { useMapStore } from '../store';
import { setSliderActive } from '../view/sliderActivity';

const CSS = `
.spacing-slider { appearance: none; -webkit-appearance: none; width: 100%; height: 20px; margin: 0; background: transparent; cursor: pointer; }
.spacing-slider:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 2px; border-radius: 4px; }
.spacing-slider::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: var(--track, #444); }
.spacing-slider::-moz-range-track { height: 4px; border-radius: 2px; background: #444; }
.spacing-slider::-moz-range-progress { height: 4px; border-radius: 2px; background: #7aa2ff; }
.spacing-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px; border-radius: 50%; border: 2px solid #0b0d12; background: #e8eefc; box-shadow: 0 0 0 1px #7aa2ff; }
.spacing-slider::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; border: 2px solid #0b0d12; background: #e8eefc; box-shadow: 0 0 0 1px #7aa2ff; }
`;

export default function SpacingSlider() {
  const spacing = useMapStore((s) => s.spacing);
  const setSpacing = useMapStore((s) => s.setSpacing);

  // ポインタで動かしている間は、積層の高さが補間せずに追従する。画面の外で離しても解除する。
  useEffect(() => {
    const off = () => setSliderActive(false);
    window.addEventListener('pointerup', off);
    window.addEventListener('pointercancel', off);
    return () => {
      window.removeEventListener('pointerup', off);
      window.removeEventListener('pointercancel', off);
      off();
    };
  }, []);

  const ratio = ((spacing - SPACING.min) / (SPACING.max - SPACING.min)) * 100;
  return (
    <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
      <style>{CSS}</style>
      <label htmlFor="layer-spacing" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ color: '#aab2c5' }}>レイヤー間隔</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: '#fff' }}>
          {(spacing / 1000).toFixed(1)} km
        </span>
      </label>
      <input
        id="layer-spacing"
        className="spacing-slider"
        type="range"
        min={SPACING.min}
        max={SPACING.max}
        step={100}
        value={spacing}
        onPointerDown={() => setSliderActive(true)}
        onBlur={() => setSliderActive(false)}
        onChange={(e) => setSpacing(Number(e.target.value))}
        style={{ ['--track' as string]: `linear-gradient(to right, #7aa2ff ${ratio}%, #444 ${ratio}%)` }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#7d869b' }}>
        <span>重ねる</span>
        <span>{SPACING.max / 1000} km</span>
      </div>
    </div>
  );
}
