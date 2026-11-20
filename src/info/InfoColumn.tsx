import { useEffect, useMemo } from 'react';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { CloseupStack, RadiusButtons, useCloseupCut } from '../closeup/Closeup';
import type { CloseupCircle } from '../closeup/closeupModel';
import type { CloseupCut } from '../closeup/cut';
import { registry } from '../layers';
import { LINK_KINDS, LINK_LABEL, LINK_LAYERS, describeFacilityStation, describeStationPopulation, linkAvailable } from '../links/linksModel';
import type { LinkKind } from '../links/linksModel';
import type { LinkSet } from '../links/compute';
import { useLinkSet } from '../links/useLinks';
import { FACILITY_COLOR } from '../layers/facilitiesModel';
import { installProbeKeys, releaseProbe } from '../probe/controller';
import { cachedDistrictLookup } from '../probe/district';
import { DENSITY_CLASSES } from '../layers/population/classes';
import { layerZ } from '../stack';
import { useMapStore } from '../store';
import type { BoundaryData } from '../types';
import { RIGHT_PANEL_W } from '../view/layout';
import { useElementSize } from '../view/useElementSize';
import { areaHeading, buildRows, columnMode, coordsText, valueText, valueTitle } from './infoModel';
import type { Cell, InfoRow } from './infoModel';
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
        {pinned && (
          <span className="ic-release">
            <span className="ic-dim">Esc か</span>
            <button type="button" className="ic-btn" onClick={releaseProbe}>
              解除
            </button>
          </span>
        )}
      </div>
      {!pinned && <div className="ic-coords">{coordsText(p)}</div>}
    </header>
  );
}

function CellView({ cell, layerLabel }: { cell: Cell; layerLabel: string }) {
  if (cell.state === 'loading') return <span className="ic-dim">読み込み中…</span>;
  if (cell.state === 'error') return <span className="ic-dim">読み込み失敗</span>;
  if (cell.state === 'none') return <span className="ic-dim">—</span>;
  return (
    <>
      {cell.values.map((v, i) => {
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

/** レイヤーごとの値の表。areaTitle があれば、「この地点」と「半径 ○km 内」の2列、なければ「この地点」だけ。 */
function InfoTable({ rows, areaTitle }: { rows: InfoRow[]; areaTitle: string | null }) {
  return (
    <table className="ic-table" data-testid="info-table" data-columns={areaTitle ? 2 : 1}>
      <colgroup>
        <col className="ic-col-name" />
        <col />
        {areaTitle && <col />}
      </colgroup>
      <thead>
        <tr>
          <th scope="col">レイヤー</th>
          <th scope="col">この地点</th>
          {areaTitle && (
            <th scope="col" data-testid="info-area-title">
              {areaTitle}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} data-layer={r.id}>
            <th scope="row">{r.label}</th>
            <td>
              <CellView cell={r.point} layerLabel={r.label} />
            </td>
            {r.area && (
              <td>
                <CellView cell={r.area} layerLabel={r.label} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** カーソルを置いただけ：区名と「この地点」の値だけ。 */
function HoverBody({ p }: { p: Point }) {
  const rows = useRows(p, null);
  return (
    <>
      <Head p={p} pinned={false} />
      <div className="ic-scroll ic-scroll-solo">
        <InfoTable rows={rows} areaTitle={null} />
      </div>
    </>
  );
}

/** 切り替えの横に添える、関係が示すものの色見本。 */
function Swatches({ kind }: { kind: LinkKind }) {
  const chips =
    kind === 'facility-station'
      ? [FACILITY_COLOR.school, FACILITY_COLOR.hospital]
      : [DENSITY_CLASSES[0].color, DENSITY_CLASSES[2].color, DENSITY_CLASSES[4].color, DENSITY_CLASSES[6].color];
  return (
    <span className="ic-swatches" aria-hidden="true">
      {chips.map((c, i) => (
        <span key={i} className="ic-swatch" style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }} />
      ))}
    </span>
  );
}

/** 対応の線を出し入れする切り替え。関係する2つの段がどちらも表示中のときだけ使える。 */
function LinkToggles() {
  const order = useMapStore((s) => s.order);
  const visible = useMapStore((s) => s.visible);
  const solo = useMapStore((s) => s.solo);
  const spacing = useMapStore((s) => s.spacing);
  const links = useMapStore((s) => s.links);
  const stack = { order, visible, solo, spacing };
  return (
    <div className="ic-links" role="group" aria-label="対応の線" data-testid="link-toggles">
      <span className="ic-links-title">対応の線</span>
      {LINK_KINDS.map((kind) => {
        const available = linkAvailable(kind, stack);
        const [a, b] = LINK_LAYERS[kind];
        return (
          <label
            key={kind}
            className="ic-link"
            data-disabled={!available}
            title={available ? undefined : `${LABELS[a]}と${LABELS[b]}の両方を表示すると使えます`}
          >
            <input
              type="checkbox"
              data-testid={`link-toggle-${kind}`}
              checked={links[kind]}
              disabled={!available}
              onChange={(e) => useMapStore.getState().setLink(kind, e.target.checked)}
            />
            {LINK_LABEL[kind]}
            <Swatches kind={kind} />
          </label>
        );
      })}
    </div>
  );
}

/** オンにしている関係の要約（線が示す内容の数値）。切り替えのすぐ下、レイヤーごとの表の上に置く。 */
function LinkSummary({ links }: { links: LinkSet | null }) {
  const order = useMapStore((s) => s.order);
  const visible = useMapStore((s) => s.visible);
  const solo = useMapStore((s) => s.solo);
  const spacing = useMapStore((s) => s.spacing);
  const on = useMapStore((s) => s.links);
  const stack = { order, visible, solo, spacing };
  const shown = LINK_KINDS.filter((k) => on[k] && linkAvailable(k, stack));
  if (!links || shown.length === 0) return null;
  return (
    <table className="ic-table ic-link-summary" data-testid="link-summary">
      <colgroup>
        <col className="ic-col-name" />
        <col />
      </colgroup>
      <tbody>
        {shown.map((kind) => {
          const lines =
            kind === 'facility-station'
              ? links.facilityStation && describeFacilityStation(links.facilityStation.summary)
              : links.stationPopulation && describeStationPopulation(links.stationPopulation.summary);
          return (
            <tr key={kind} data-link={kind}>
              <th scope="row">{LINK_LABEL[kind]}</th>
              <td>
                {lines ? lines.map((t, i) => <div key={i} className="ic-v">{t}</div>) : <span className="ic-dim">読み込み中…</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 固定中：上にクローズアップ（円形の積層と半径のボタン）、下に表（「この地点」と「半径 ○km 内」）。 */
function PinnedBody({ p }: { p: Point }) {
  const radius = useMapStore((s) => s.closeupRadius);
  const circle = useMemo<CloseupCircle>(() => ({ x: p.x, y: p.y, r: radius }), [p.x, p.y, radius]);
  const cut = useCloseupCut(circle);
  const rows = useRows(p, cut.summaries);
  const linkSet = useLinkSet(circle);
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
      <LinkToggles />
      <div className="ic-scroll" data-testid="info-scroll">
        <LinkSummary links={linkSet} />
        <InfoTable rows={rows} areaTitle={areaHeading(radius)} />
      </div>
    </>
  );
}

/**
 * 「選んだ地点の情報」の列。全体の地図の右隣（右上のパネルの左）に、中身の有無にかかわらず常に同じ幅で置く。
 * 探針がなければ操作の手がかり、カーソルを置いただけなら区名と「この地点」の値、固定していればクローズアップと表。
 */
export default function InfoColumn({ width }: { width: number }) {
  useEffect(() => installProbeKeys(), []);
  const probe = useMapStore((s) => s.probe);
  const pinned = useMapStore((s) => s.probePinned);
  const mode = columnMode(probe, pinned);
  return (
    <section
      className="ic"
      data-testid="info-column"
      data-mode={mode}
      aria-label="選んだ地点の情報"
      style={{ right: RIGHT_PANEL_W, width, paddingBottom: BOTTOM_RESERVE }}
    >
      {mode === 'empty' || probe === null ? (
        <div className="ic-hint" data-testid="info-hint">
          <p>平面にカーソルを置くと、その地点の各層の値を読めます。</p>
          <p>クリックで固定すると、周辺のクローズアップと、半径内の集計が出ます。</p>
        </div>
      ) : mode === 'hover' ? (
        <HoverBody p={probe} />
      ) : (
        <PinnedBody p={probe} />
      )}
    </section>
  );
}
