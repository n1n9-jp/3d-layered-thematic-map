import { useLayoutEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { registry } from '../layers';
import { FACILITY_SECTION_RADIUS } from '../layers/facilitiesModel';
import { STATION_SECTION_RADIUS } from '../layers/transitModel';
import { lineLength } from '../lib/section';
import { cachedDistrictLookup } from '../probe/district';
import { layerZ } from '../stack';
import { useMapStore } from '../store';
import type { LayerStatus } from '../store';
import type { BoundaryData, SectionLine, SectionMarks, SectionSeries, SectionTrack } from '../types';
import { releaseSection } from './controller';
import {
  bandQuads,
  cappedMax,
  distanceTicks,
  dToX,
  edgeRuns,
  formatAlong,
  formatLength,
  groupByColor,
  isNearMark,
  readoutText,
  summaryLine,
  valueAt,
  valueTicks,
  xToD,
} from './model';
import type { XScale } from './model';
import { useSectionTracks } from './tracks';
import './SectionPanel.css';

/** グラフの左（縦軸の目盛り）と右の余白（px）。すべてのグラフで同じ。 */
const ML = 52;
const MR = 12;
/** グラフの縦の余白（px）。 */
const PAD_Y = 3;
/** カーソルの位置の線の色（全体の地図の、探針と同じ水色）。 */
const CURSOR = '#5adcff';
/** カーソルが指す交差や地物を探す範囲（px）。 */
const READ_TOLERANCE_PX = 8;

const LABELS = Object.fromEntries(LAYER_IDS.map((id) => [id, registry[id].label])) as Record<LayerId, string>;

/** レイヤーごとのグラフの高さ（px）。 */
const CHART_H: Record<LayerId, number> = { elevation: 70, population: 70, roads: 36, transit: 64, facilities: 56 };

const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const fix = (v: number) => v.toFixed(1);

/** 点 (x, y) の区名。区境界が読み込めていなければ null。 */
function useDistrictOf(p: { x: number; y: number }): string | null {
  const boundary = useMapStore((s) => s.data.boundary);
  const ready = useMapStore((s) => s.status.boundary === 'ready');
  return ready && boundary ? cachedDistrictLookup(boundary as BoundaryData)(p.x, p.y) : null;
}

/** 要素の幅（px）。中身が空でも測れる（高さを条件にしない）。要素が後から現れても追う（コールバック ref）。 */
function useElementWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) {
      setWidth(0);
      return;
    }
    const measure = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

/* ---------- 1枚のグラフ ---------- */

interface ChartProps {
  id: LayerId;
  tracks: SectionTrack[];
  length: number;
  width: number;
  hoverD: number | null;
  onHover(d: number | null): void;
}

function nearRadius(id: LayerId): number {
  return id === 'transit' ? STATION_SECTION_RADIUS : FACILITY_SECTION_RADIUS;
}

function SeriesContent({ series, sc, ph }: { series: SectionSeries; sc: XScale; ph: number }) {
  const y = (t: number) => PAD_Y + (1 - t) * ph;
  const base = y(0);
  const groups = useMemo(() => groupByColor(bandQuads(series)), [series]);
  const runs = useMemo(() => edgeRuns(series), [series]);
  return (
    <>
      {groups.map((g, i) => {
        const color = rgb(g.color);
        const d = g.quads
          .map((q) => {
            const x0 = dToX(sc, q.d0);
            const x1 = dToX(sc, q.d1);
            return `M${fix(x0)} ${fix(base)}L${fix(x1)} ${fix(base)}L${fix(x1)} ${fix(y(q.t1))}L${fix(x0)} ${fix(y(q.t0))}Z`;
          })
          .join('');
        return <path key={i} d={d} fill={color} stroke={color} strokeWidth={0.6} />;
      })}
      {runs.map((r, i) => (
        <polyline key={i} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth={1.1} strokeLinejoin="round" points={r.points.map((p) => `${fix(dToX(sc, p.d))},${fix(y(p.t))}`).join(' ')} />
      ))}
      {runs.flatMap((r, i) => {
        // 縦軸の上端を超えた区間は、上端に白い太い線を引く（地図の中の帯と同じ）。
        const out: ReactElement[] = [];
        let cur: string[] = [];
        const flush = () => {
          if (cur.length >= 2) out.push(<polyline key={`${i}-${out.length}`} data-testid="section-cap" fill="none" stroke="#fff" strokeWidth={3} points={cur.join(' ')} />);
          cur = [];
        };
        for (const p of r.points) {
          if (p.capped) cur.push(`${fix(dToX(sc, p.d))},${fix(y(1))}`);
          else flush();
        }
        flush();
        return out;
      })}
    </>
  );
}

function MarksContent({ id, tracks, sc, ph }: { id: LayerId; tracks: SectionMarks[]; sc: XScale; ph: number }) {
  const marks = tracks.flatMap((t) => t.marks);
  const crossings = marks.filter((m) => !isNearMark(m));
  const near = marks.filter(isNearMark);
  const R = nearRadius(id);
  const mid = PAD_Y + ph / 2;
  const yOf = (offset: number) => mid - (offset / R) * (ph / 2 - 5);
  return (
    <>
      {near.length > 0 || id === 'facilities' ? <line x1={sc.left} x2={sc.left + sc.width} y1={mid} y2={mid} stroke="rgba(255,255,255,0.22)" strokeDasharray="3 3" /> : null}
      {crossings.map((m, i) => (
        <line key={`c${i}`} x1={fix(dToX(sc, m.d))} x2={fix(dToX(sc, m.d))} y1={PAD_Y} y2={PAD_Y + ph} stroke={rgb(m.color)} strokeWidth={1.5} strokeOpacity={0.9} />
      ))}
      {near.map((m, i) => {
        const cx = dToX(sc, m.d);
        const cy = yOf(m.offset);
        return m.category === 'hospital' ? (
          <rect key={`n${i}`} x={cx - 3.6} y={cy - 3.6} width={7.2} height={7.2} transform={`rotate(45 ${fix(cx)} ${fix(cy)})`} fill={rgb(m.color)} stroke="rgba(0,0,0,0.8)" strokeWidth={0.8} />
        ) : (
          <circle key={`n${i}`} cx={fix(cx)} cy={fix(cy)} r={3.6} fill={rgb(m.color)} stroke="rgba(0,0,0,0.8)" strokeWidth={0.8} />
        );
      })}
    </>
  );
}

function Chart({ id, tracks, length, width, hoverD, onHover }: ChartProps) {
  const ph = CHART_H[id];
  const height = ph + 2 * PAD_Y;
  const pw = Math.max(1, width - ML - MR);
  const sc: XScale = { left: ML, width: pw, length };
  const series = tracks.find((t): t is SectionSeries => t.kind === 'series');
  const markTracks = tracks.filter((t): t is SectionMarks => t.kind === 'marks');
  const hasNear = markTracks.some((t) => t.marks.some(isNearMark)) || id === 'facilities' || id === 'transit';
  const xt = useMemo(() => distanceTicks(length), [length]);
  const yTicks = series ? valueTicks(series.domain) : [];
  const yOfValue = (v: number) => (series ? PAD_Y + (1 - (v - series.domain[0]) / (series.domain[1] - series.domain[0])) * ph : 0);
  const R = nearRadius(id);

  const readout = hoverD === null ? null : readoutText(tracks, hoverD, (READ_TOLERANCE_PX * length) / pw);
  const hoverValue = series && hoverD !== null ? valueAt(series, hoverD) : null;
  const capped = series ? cappedMax(series) : null;

  const handle = (e: React.PointerEvent<SVGRectElement>) => {
    // x は SVG の左端から測る（sc.left は、その左端から始点までの余白）。
    const r = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    onHover(xToD(sc, e.clientX - r.left));
  };

  return (
    <div className="sc-chart" data-testid="section-chart" data-layer={id}>
      <div className="sc-row">
        <span className="sc-name">{LABELS[id]}</span>
        <span className="sc-read" data-testid="section-readout">
          {hoverD !== null ? (readout ?? <span className="ic-dim">{series ? 'データなし' : '該当なし'}</span>) : ''}
        </span>
      </div>
      <div className="sc-sum" data-testid="section-summary">
        {summaryLine(id, tracks)}
        {capped !== null && series && <span className="ic-dim">（{series.domain[1].toLocaleString('ja-JP')} 超は頭打ち、白い太線。最大 {Math.round(capped).toLocaleString('ja-JP')}）</span>}
      </div>
      <svg className="sc-svg" width={width} height={height} role="img" aria-label={`${LABELS[id]}の断面`}>
        <rect x={ML} y={PAD_Y} width={pw} height={ph} fill="#0b0f16" />
        {xt.map((t) => (
          <line key={t.d} x1={fix(dToX(sc, t.d))} x2={fix(dToX(sc, t.d))} y1={PAD_Y} y2={PAD_Y + ph} stroke="rgba(255,255,255,0.07)" />
        ))}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={ML} x2={ML + pw} y1={fix(yOfValue(v))} y2={fix(yOfValue(v))} stroke="rgba(255,255,255,0.14)" />
            <text x={ML - 4} y={yOfValue(v) + 3.5} textAnchor="end" className="sc-tick">
              {v.toLocaleString('ja-JP')}
            </text>
          </g>
        ))}
        {hasNear && (
          <>
            <text x={ML - 4} y={PAD_Y + 9} textAnchor="end" className="sc-tick">
              左 {R}m
            </text>
            <text x={ML - 4} y={PAD_Y + ph / 2 + 3.5} textAnchor="end" className="sc-tick">
              線上
            </text>
            <text x={ML - 4} y={PAD_Y + ph - 2} textAnchor="end" className="sc-tick">
              右 {R}m
            </text>
          </>
        )}
        {series ? <SeriesContent series={series} sc={sc} ph={ph} /> : <MarksContent id={id} tracks={markTracks} sc={sc} ph={ph} />}
        {hoverD !== null && (
          <g pointerEvents="none">
            <line x1={fix(dToX(sc, hoverD))} x2={fix(dToX(sc, hoverD))} y1={PAD_Y} y2={PAD_Y + ph} stroke={CURSOR} strokeWidth={1.5} data-testid="section-cursor" />
            {series && hoverValue !== null && <circle cx={fix(dToX(sc, hoverD))} cy={fix(yOfValue(Math.min(series.domain[1], Math.max(series.domain[0], hoverValue))))} r={3.5} fill="#fff" stroke={CURSOR} strokeWidth={1.5} />}
          </g>
        )}
        <rect x={ML} y={0} width={pw} height={height} fill="transparent" onPointerMove={handle} onPointerLeave={() => onHover(null)} style={{ cursor: 'crosshair' }} data-testid="section-plot" />
      </svg>
    </div>
  );
}

/** 横軸（線に沿った距離、km）。スクロールしても見えるよう、下端に貼り付く。カーソルの位置の距離も出す。 */
function Axis({ length, width, hoverD }: { length: number; width: number; hoverD: number | null }) {
  const pw = Math.max(1, width - ML - MR);
  const sc: XScale = { left: ML, width: pw, length };
  const ticks = useMemo(() => distanceTicks(length), [length]);
  return (
    <div className="sc-axis" data-testid="section-axis">
      <svg width={width} height={24} role="img" aria-label="線に沿った距離（km）">
        <line x1={ML} x2={ML + pw} y1={4} y2={4} stroke="rgba(255,255,255,0.35)" />
        {ticks.map((t) => (
          <g key={t.d}>
            <line x1={fix(dToX(sc, t.d))} x2={fix(dToX(sc, t.d))} y1={4} y2={8} stroke="rgba(255,255,255,0.35)" />
            <text x={fix(dToX(sc, t.d))} y={19} textAnchor="middle" className="sc-tick">
              {t.label}
            </text>
          </g>
        ))}
        <text x={ML - 4} y={19} textAnchor="end" className="sc-tick">
          km
        </text>
        {hoverD !== null && (
          <g>
            <line x1={fix(dToX(sc, hoverD))} x2={fix(dToX(sc, hoverD))} y1={0} y2={8} stroke={CURSOR} strokeWidth={1.5} />
            <text x={Math.min(ML + pw - 20, Math.max(ML + 20, dToX(sc, hoverD)))} y={19} textAnchor="middle" className="sc-tick sc-tick-hot" data-testid="section-axis-d">
              {formatAlong(hoverD, length)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

/* ---------- 列の中身 ---------- */

function Ends({ line }: { line: SectionLine }) {
  const a = useDistrictOf({ x: line.ax, y: line.ay });
  const b = useDistrictOf({ x: line.bx, y: line.by });
  return (
    <div className="sc-ends" data-testid="section-ends">
      <span className="sc-end">
        <b className="sc-badge">A</b> {a ?? '区の外'}
      </span>
      <span className="ic-dim">→</span>
      <span className="sc-end">
        <b className="sc-badge sc-badge-b">B</b> {b ?? '区の外'}
      </span>
    </div>
  );
}

function Placeholder({ status, label }: { status: LayerStatus; label: string }) {
  return (
    <div className="sc-chart">
      <div className="sc-row">
        <span className="sc-name">{label}</span>
      </div>
      <div className="sc-sum ic-dim">{status === 'error' ? '読み込み失敗' : '読み込み中…'}</div>
    </div>
  );
}

/** 「断面」のときの、右の列の中身。 */
export default function SectionBody() {
  const { line, tracks } = useSectionTracks();
  const start = useMapStore((s) => s.sectionStart);
  const hoverD = useMapStore((s) => s.sectionHover);
  const setHover = useMapStore((s) => s.setSectionHover);
  const order = useMapStore((s) => s.order);
  const visible = useMapStore((s) => s.visible);
  const solo = useMapStore((s) => s.solo);
  const spacing = useMapStore((s) => s.spacing);
  const status = useMapStore((s) => s.status);
  const [box, width] = useElementWidth<HTMLDivElement>();

  if (!line) {
    return (
      <div className="ic-hint" data-testid="section-hint" data-state={start ? 'start' : 'empty'}>
        {start ? (
          <>
            <p>
              始点（A）を置きました。<b>終点（B）</b>をクリックしてください。カーソルまでの線が下書きで出ます。
            </p>
            <p>
              やめるときは <span className="ic-dim">Esc</span> か{' '}
              <button type="button" className="ic-btn" onClick={releaseSection}>
                やめる
              </button>
            </p>
          </>
        ) : (
          <>
            <p>全体の地図の平面を1回クリックすると始点（A）、もう1回クリックすると終点（B）が決まります。</p>
            <p>2点を結ぶ線で全レイヤーを縦に切り、線に沿った変化を、地図の中に立てたグラフと、ここの平らなグラフで見比べられます。</p>
            <p>線を引いたあとは、両端の印か線をドラッグして動かせます。端点の外をクリックすると引き直し、Esc で消します。</p>
          </>
        )}
      </div>
    );
  }

  const length = lineLength(line);
  const ids = [...order].reverse().filter((id) => layerZ({ order, visible, solo, spacing }, id) !== null);
  return (
    <>
      <header className="ic-head" data-testid="section-head">
        <div className="ic-title">
          <span className="ic-district">断面</span>
          <span className="sc-len" data-testid="section-length">
            {formatLength(length)}
          </span>
          <span className="ic-release">
            <span className="ic-dim">Esc か</span>
            <button type="button" className="ic-btn" onClick={releaseSection} data-testid="section-clear">
              消す
            </button>
          </span>
        </div>
        <Ends line={line} />
      </header>
      <div className="ic-scroll ic-scroll-solo sc-scroll" data-testid="section-scroll">
        <div className="sc-body">
          {/* 幅は、余白（padding）を除いたこの要素で測る。中身がまだ空でも測れるよう、高さは条件にしない。 */}
          <div ref={box}>
            {width > 0 &&
              ids.map((id) =>
                tracks[id] ? (
                  <Chart key={id} id={id} tracks={tracks[id] as SectionTrack[]} length={length} width={width} hoverD={hoverD} onHover={setHover} />
                ) : (
                  <Placeholder key={id} status={status[id]} label={LABELS[id]} />
                ),
              )}
            {width > 0 && <Axis length={length} width={width} hoverD={hoverD} />}
          </div>
        </div>
      </div>
    </>
  );
}
