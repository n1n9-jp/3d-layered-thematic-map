import { useEffect, useMemo } from 'react';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { CloseupStack, RadiusButtons, useCloseupCut } from '../closeup/Closeup';
import type { CloseupCircle } from '../closeup/closeupModel';
import type { CloseupCut } from '../closeup/cut';
import { registry } from '../layers';
import { installProbeKeys } from '../probe/controller';
import SectionBody from '../section/SectionPanel';
import { cachedDistrictLookup } from '../probe/district';
import { layerZ } from '../stack';
import { useMapStore } from '../store';
import type { BoundaryData, ProbeValue } from '../types';
import { RIGHT_PANEL_W } from '../view/layout';
import { useElementSize } from '../view/useElementSize';
import Overall, { ExposureTable } from './Overall';
import { areaHeading, buildRows, columnMode, coordsText, splitCell, valueText, valueTitle } from './infoModel';
import type { Cell, InfoRow } from './infoModel';
import type { ReactNode } from 'react';
import './InfoColumn.css';

/** 列の下端に空ける高さ（px）。右下の出典の1行（画面の下端から約 24 px）を避ける。 */
const BOTTOM_RESERVE = 30;

type Point = { x: number; y: number };

const LABELS = Object.fromEntries(LAYER_IDS.map((id) => [id, registry[id].label])) as Record<LayerId, string>;

/** 点 p の区名。区境界が読み込めていなければ null（「区の外」と同じ表示になる）。 */
function useDistrict(p: Point): string | null {
  const boundary = useMapStore((s) => s.data.boundary);
  const ready = useMapStore((s) => s.status.boundary === 'ready');
  return ready && boundary ? cachedDistrictLookup(boundary as BoundaryData)(p.x, p.y) : null;
}

/** 表の行。表示中のレイヤーを上の段から並べ、点 p の値を読む。summaries を渡すと、「半径 ○km 内」の集計も付く。 */
function useRows(p: Point, summaries: CloseupCut['summaries'] | null): InfoRow[] {
  const order = useMapStore((s) => s.order);
  const visible = useMapStore((s) => s.visible);
  const solo = useMapStore((s) => s.solo);
  const spacing = useMapStore((s) => s.spacing);
  const data = useMapStore((s) => s.data);
  const status = useMapStore((s) => s.status);
  const stack = { order, visible, solo, spacing };
  const ids = [...order].reverse().filter((id) => layerZ(stack, id) !== null);
  return buildRows({
    ids,
    labels: LABELS,
    status,
    sample: (id) => registry[id].sample(data[id], p.x, p.y),
    summaries,
    onError: (id, e) => console.error(`[probe] ${id}.sample`, e),
  });
}

function Head({ p, pinned }: { p: Point; pinned: boolean }) {
  const district = useDistrict(p);
  return (
    <header className="ic-head">
      <div className="ic-title">
        <span className="ic-district" data-testid="info-district">
          {district ?? '区の外'}
        </span>
        {pinned && <span className="ic-pin">● 固定中</span>}
      </div>
      {!pinned && <div className="ic-coords">{coordsText(p)}</div>}
    </header>
  );
}

/** 値の並び（見出し付き）。 */
function Values({ values, layerLabel }: { values: ProbeValue[]; layerLabel: string }) {
  return (
    <>
      {values.map((v, i) => {
        const title = valueTitle(v, layerLabel);
        return (
          <div key={i} className="ic-v">
            {title && <span className="ic-dim">{title} </span>}
            {valueText(v)}
          </div>
        );
      })}
    </>
  );
}

/** 値でないマス（読み込み中・失敗・値なし）の文字。値のあるマスは null。 */
function stateText(cell: Cell): string | null {
  if (cell.state === 'loading') return '読み込み中…';
  if (cell.state === 'error') return '読み込み失敗';
  if (cell.state === 'none') return '—';
  return null;
}

/**
 * 1つのレイヤーの行。閉じているときは「レイヤー名と、この地点の主な値1つ」だけ。押すと、残りの値と、半径内の集計（あれば）が開く。
 * extra は、開いたときの末尾に足すもの（浸水の行の、円の中の「浸水が想定される区域に住む人」の表）。
 */
function InfoRowView({ row, areaTitle, open, extra }: { row: InfoRow; areaTitle: string | null; open: boolean; extra?: ReactNode }) {
  const toggleOpen = useMapStore((s) => s.toggleOpen);
  const scenario = useMapStore((s) => s.options.floodScenario);
  const split = splitCell(row.id, row.point.values, row.label, scenario);
  const state = stateText(row.point);
  const bodyId = `info-row-${row.id}`;
  const hasBody = split.rest.length > 0 || row.area !== null || !!extra;
  return (
    <li className="ic-row" data-layer={row.id} data-open={open} data-testid="info-row">
      <button
        type="button"
        className="ic-row-toggle"
        aria-expanded={hasBody ? open : undefined}
        aria-controls={hasBody ? bodyId : undefined}
        disabled={!hasBody}
        data-testid={`info-row-toggle-${row.id}`}
        onClick={() => toggleOpen('row', row.id)}
      >
        <span className="ic-caret" aria-hidden="true">
          {hasBody ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="ic-row-name">{row.label}</span>
        <span className="ic-row-main" data-testid="info-row-main">
          {state ? (
            <span className="ic-dim">{state}</span>
          ) : (
            <>
              {split.primary?.title && <span className="ic-dim">{split.primary.title} </span>}
              {split.primary?.text}
            </>
          )}
        </span>
      </button>
      {open && hasBody && (
        <div className="ic-row-body" id={bodyId} data-testid="info-row-body">
          {split.rest.length > 0 && <Values values={split.rest} layerLabel={row.label} />}
          {row.area && (
            <div className="ic-area" data-testid="info-area">
              <div className="ic-area-title" data-testid="info-area-title">
                {areaTitle}
              </div>
              {stateText(row.area) ? <span className="ic-dim">{stateText(row.area)}</span> : <Values values={row.area.values} layerLabel={row.label} />}
            </div>
          )}
          {extra}
        </div>
      )}
    </li>
  );
}

/** レイヤーごとの行の一覧。areaTitle があれば、行を開いたときに「半径 ○km 内」の集計も出る。開けるのは同時に1行だけ。 */
function InfoList({ rows, areaTitle, extras }: { rows: InfoRow[]; areaTitle: string | null; extras?: Partial<Record<LayerId, ReactNode>> }) {
  const openRow = useMapStore((s) => s.open.row);
  return (
    <ul className="ic-rows" data-testid="info-table" data-columns={areaTitle ? 2 : 1}>
      {rows.map((r) => (
        <InfoRowView key={r.id} row={r} areaTitle={areaTitle} open={openRow === r.id} extra={extras?.[r.id]} />
      ))}
    </ul>
  );
}

/** カーソルを置いただけ：区名と「この地点」の値だけ。 */
function HoverBody({ p }: { p: Point }) {
  const rows = useRows(p, null);
  return (
    <>
      <Head p={p} pinned={false} />
      <div className="ic-scroll ic-scroll-solo">
        <InfoList rows={rows} areaTitle={null} />
      </div>
    </>
  );
}

/** 固定中：上にクローズアップ（円形の積層と半径のボタン）、下に表（「この地点」と「半径 ○km 内」）。 */
function PinnedBody({ p }: { p: Point }) {
  const radius = useMapStore((s) => s.closeupRadius);
  const circle = useMemo<CloseupCircle>(() => ({ x: p.x, y: p.y, r: radius }), [p.x, p.y, radius]);
  const cut = useCloseupCut(circle);
  const rows = useRows(p, cut.summaries);
  const [canvasBox, size] = useElementSize<HTMLDivElement>();
  return (
    <>
      <Head p={p} pinned />
      <div className="ic-closeup-bar">
        <span className="ic-coords" data-testid="info-coords">
          {coordsText(p)}
        </span>
        <RadiusButtons radius={radius} />
      </div>
      <div className="cu-canvas ic-canvas" ref={canvasBox} data-testid="closeup">
        {size && <CloseupStack cut={cut} size={size} />}
      </div>
      <div className="ic-scroll" data-testid="info-scroll">
        <InfoList
          rows={rows}
          areaTitle={areaHeading(radius)}
          extras={{
            flood: cut.exposure && (
              <ExposureTable exposure={cut.exposure} testId="closeup-exposure" caption={`${areaHeading(radius)}：浸水が想定される区域に住む人`} />
            ),
          }}
        />
      </div>
    </>
  );
}

/**
 * 「選んだ地点の情報」の列。全体の地図の右隣（右上のパネルの左）に、中身の有無にかかわらず常に同じ幅で置く。
 * 「全体」「地点」「断面」の切り替え（と、地図での最初の操作の手がかり）は、画面上端の帯（`ModeBand`）にあり、列の上はその高さ（top）だけ空ける。
 * 「全体」は23区全体の集計。「地点」は、地点がなければ空（カーソルを置いただけなら区名と「この地点」の値、固定していればクローズアップと表）。
 * 「断面」は線を引く前の例の線のボタンと説明、または線に沿ったグラフ。
 */
export default function InfoColumn({ width, top }: { width: number; top: number }) {
  useEffect(() => installProbeKeys(), []);
  const uiMode = useMapStore((s) => s.mode);
  const probe = useMapStore((s) => s.probe);
  const pinned = useMapStore((s) => s.probePinned);
  // 列の中身。「全体」「断面」のときは、探針（固定を含む）の有無にかかわらずそれぞれの中身を出す。
  const mode = uiMode === 'point' ? columnMode(probe, pinned) : uiMode;
  return (
    <section
      className="ic"
      data-testid="info-column"
      data-mode={mode}
      aria-label="選んだ地点の情報"
      style={{ right: RIGHT_PANEL_W, width, paddingTop: top, paddingBottom: BOTTOM_RESERVE }}
    >
      {mode === 'section' ? (
        <SectionBody />
      ) : mode === 'overview' ? (
        <div className="ic-scroll ic-scroll-solo ic-overall" data-testid="overall-scroll">
          <Overall />
        </div>
      ) : mode === 'empty' || probe === null ? null : mode === 'hover' ? (
        <HoverBody p={probe} />
      ) : (
        <PinnedBody p={probe} />
      )}
    </section>
  );
}
