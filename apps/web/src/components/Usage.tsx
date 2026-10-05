import { USAGE_BAD_FREE_BYTES, USAGE_WARN_FREE_BYTES, type Usage } from '@paiban/shared';
import { t } from '../copy/zh-TW';
import { bytes } from '../lib/format';

const ORDER = ['movies', 'exports', 'previews', 'reserved', 'partial'] as const;
const CLS = { movies: 'u-mv', exports: 'u-ex', previews: 'u-px', reserved: 'u-rs', partial: 'u-pt' } as const;

/** The segmented bar (docs/10-storage.md, "介面上的呈現"). */
export function UsageBar({ usage, big = false }: { usage: Usage; big?: boolean }) {
  const scale = Math.max(usage.limitBytes, usage.usedBytes, 1);
  return (
    <div
      className={`usage${big ? ' big' : ''}`}
      role="img"
      aria-label={t.storage.used(bytes(usage.usedBytes), bytes(usage.limitBytes))}
    >
      {ORDER.map((k) =>
        usage.categories[k] > 0 ? (
          <i
            key={k}
            className={CLS[k]}
            style={{ width: `${(usage.categories[k] / scale) * 100}%` }}
            title={t.storage.categories[k]}
          />
        ) : null,
      )}
    </div>
  );
}

export function UsageLegend({ usage }: { usage: Usage }) {
  return (
    <ul className="ulegend">
      {ORDER.map((k) => (
        <li key={k}>
          <i className={CLS[k]} aria-hidden="true" />
          {t.storage.categories[k]} <b className="mono">{bytes(usage.categories[k])}</b>
        </li>
      ))}
    </ul>
  );
}

export function meterLevel(u: Usage): '' | 'warn' | 'bad' {
  if (u.over || u.limitBytes === 0 || u.freeBytes < USAGE_BAD_FREE_BYTES) return 'bad';
  if (u.freeBytes < USAGE_WARN_FREE_BYTES) return 'warn';
  return '';
}
