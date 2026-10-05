import { Link } from 'react-router';
import { t } from '../copy/zh-TW';
import { type ApiFailure, isSpaceError } from '../lib/api';
import { bytes } from '../lib/format';

/** The red explanation under a refused download or retry: numbers, not just "no space". */
export function SpaceShort({
  error,
  onClose,
  retry = false,
}: {
  error: ApiFailure;
  onClose: () => void;
  retry?: boolean;
}) {
  if (!isSpaceError(error)) return null;
  const d = error.details;
  const film = d.needBytes - d.previewBytes;
  const text =
    error.code === 'DISK_FULL'
      ? t.space.diskFull(bytes(d.shortBytes))
      : retry
        ? t.space.retryShort(bytes(d.needBytes), bytes(d.freeBytes), bytes(d.shortBytes))
        : t.space.limitShort(
            bytes(film),
            d.previewBytes > 0 ? bytes(d.previewBytes) : null,
            bytes(d.freeBytes),
            bytes(d.shortBytes),
          );
  return (
    <div className="banner bad" role="alert">
      <span>{text}</span>
      <div className="frow">
        <Link className="btn" to="/storage">
          {t.common.goStorage}
        </Link>
        <button type="button" onClick={onClose}>
          {t.common.gotIt}
        </button>
      </div>
    </div>
  );
}
