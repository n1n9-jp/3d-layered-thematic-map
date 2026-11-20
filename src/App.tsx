import ProbePanel from './probe/ProbePanel';
import LayerPanel from './panel/LayerPanel';
import SpacingSlider from './panel/SpacingSlider';
import StackView from './view/StackView';
import { PANEL } from './view/layout';

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
      <div
        style={{
          ...panelStyle,
          top: PANEL.margin,
          right: PANEL.margin,
          width: PANEL.width,
          padding: PANEL.padding,
          boxSizing: 'content-box',
          maxHeight: `calc(100% - ${2 * (PANEL.margin + PANEL.padding)}px)`, // 収まらないときは中をスクロールする
          overflowY: 'auto',
          display: 'grid',
          alignContent: 'start',
          gap: 12,
        }}
      >
        <SpacingSlider />
        <LayerPanel />
      </div>
      <div style={{ position: 'absolute', left: 12, bottom: 12, color: '#fff', font: '14px sans-serif' }}>
        <ProbePanel />
      </div>
    </>
  );
}
