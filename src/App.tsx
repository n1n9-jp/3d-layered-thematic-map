import { useEffect, useState } from 'react';
import InfoColumn from './info/InfoColumn';
import Credits from './panel/Credits';
import LayerPanel from './panel/LayerPanel';
import SpacingSlider from './panel/SpacingSlider';
import ViewButtons from './panel/ViewButtons';
import StackView from './view/StackView';
import { PANEL, infoColumnWidth } from './view/layout';

const panelStyle = {
  position: 'absolute',
  background: 'rgba(20, 20, 20, 0.85)',
  color: '#fff',
  padding: 12,
  borderRadius: 6,
  font: '14px sans-serif',
} as const;

/** 出典の1行を置く、画面の下端からの高さ（px）。1行の高さ（約21px）と合わせて、積層の下余白（`GUTTER` = 24px）の内側に収める。 */
const CREDITS_BOTTOM = 3;
/** 出典の1行が画面の下端から占める高さ（px）の見込み。右上のパネルはこの上までに収める。 */
const CREDITS_RESERVE = 32;

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

export default function App() {
  // 全体の地図の右に、「選んだ地点の情報」の列を常に置く（幅は中身によらず一定）。地図の大きさと位置も、探針の有無や固定で変わらない。
  const windowWidth = useWindowWidth();
  const cw = infoColumnWidth(windowWidth);
  return (
    <>
      <StackView columnWidth={cw} />
      <InfoColumn width={cw} />
      <div
        style={{
          ...panelStyle,
          top: PANEL.margin,
          right: PANEL.margin,
          width: PANEL.width,
          padding: PANEL.padding,
          boxSizing: 'content-box',
          maxHeight: `calc(100% - ${2 * (PANEL.margin + PANEL.padding) + CREDITS_RESERVE}px)`, // 収まらないときは中をスクロールする。下端の出典の1行は避ける
          overflowY: 'auto',
          display: 'grid',
          alignContent: 'start',
          gap: 12,
        }}
      >
        <ViewButtons />
        <SpacingSlider />
        <LayerPanel />
      </div>
      {/* 出典（常に1行）。右下に置き、積層の下余白に収める。詳細はほかのパネルに重なって開く。 */}
      <Credits
        style={{
          position: 'absolute',
          right: PANEL.margin,
          bottom: CREDITS_BOTTOM,
          zIndex: 10,
          maxWidth: `min(640px, calc(100vw - ${2 * PANEL.margin}px))`,
        }}
      />
    </>
  );
}
