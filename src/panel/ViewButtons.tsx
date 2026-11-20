import { useMapStore } from '../store';
import { ORBIT_STEP, PRESET_IDS, VIEW_PRESETS, requestView, selectedPreset } from '../view/viewPresets';
import './ViewButtons.css';

/** 視点を切り替えるボタン。決まった視点（真上・斜め・正面）と、方位を45度ずつ回す2つ。 */
export default function ViewButtons() {
  const rotationX = useMapStore((s) => s.viewState.rotationX);
  const rotationOrbit = useMapStore((s) => s.viewState.rotationOrbit);
  const autoFit = useMapStore((s) => s.autoFit);
  const solo = useMapStore((s) => s.solo);
  const selected = selectedPreset({ viewState: { rotationX, rotationOrbit }, autoFit, solo });
  const locked = solo !== null;

  return (
    <div className="vb" role="group" aria-labelledby="vb-title" aria-describedby={locked ? 'vb-hint' : undefined}>
      <div className="vb-head">
        <span className="vb-title" id="vb-title">
          視点
        </span>
        {locked && (
          <span className="vb-hint" id="vb-hint">
            単独表示中は固定
          </span>
        )}
      </div>
      <div className="vb-row vb-presets">
        {PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className="vb-btn"
            aria-pressed={selected === id}
            disabled={locked}
            onClick={() => requestView({ type: 'preset', id })}
          >
            {VIEW_PRESETS[id].label}
          </button>
        ))}
      </div>
      <div className="vb-row vb-rotate">
        <button
          type="button"
          className="vb-btn"
          aria-label={`左へ回す（${ORBIT_STEP}度）`}
          title={`方位を${ORBIT_STEP}度、左へ回す`}
          disabled={locked}
          onClick={() => requestView({ type: 'rotate', dir: -1 })}
        >
          <span className="vb-arrow" aria-hidden="true">
            ↺
          </span>
          左へ回す
        </button>
        <button
          type="button"
          className="vb-btn"
          aria-label={`右へ回す（${ORBIT_STEP}度）`}
          title={`方位を${ORBIT_STEP}度、右へ回す`}
          disabled={locked}
          onClick={() => requestView({ type: 'rotate', dir: 1 })}
        >
          <span className="vb-arrow" aria-hidden="true">
            ↻
          </span>
          右へ回す
        </button>
      </div>
    </div>
  );
}
