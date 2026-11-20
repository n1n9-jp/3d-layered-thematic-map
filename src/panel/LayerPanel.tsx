import { registry } from '../layers';
import { useMapStore } from '../store';

/** レイヤー名を上から（最上段が先頭）順に並べる。 */
export default function LayerPanel() {
  const order = useMapStore((s) => s.order);
  return (
    <ol style={{ margin: 0, padding: '0 0 0 1.5em', fontSize: 14 }}>
      {[...order].reverse().map((id) => (
        <li key={id}>{registry[id].label}</li>
      ))}
    </ol>
  );
}
