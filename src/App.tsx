import ProbePanel from './probe/ProbePanel';
import LayerPanel from './panel/LayerPanel';
import SpacingSlider from './panel/SpacingSlider';
import StackView from './view/StackView';

const panelStyle = {
  position: 'absolute',
  background: 'rgba(20, 20, 20, 0.85)',
  color: '#fff',
  padding: 12,
  borderRadius: 6,
  font: '14px sans-serif',
} as const;

export default function App() {
  return (
    <>
      <StackView />
      <div style={{ ...panelStyle, top: 12, right: 12, width: 220, display: 'grid', gap: 12 }}>
        <SpacingSlider />
        <LayerPanel />
      </div>
      <div style={{ position: 'absolute', left: 12, bottom: 12, color: '#fff', font: '14px sans-serif' }}>
        <ProbePanel />
      </div>
    </>
  );
}
