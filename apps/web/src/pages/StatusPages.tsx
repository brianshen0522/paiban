import { Link } from 'react-router';
import { Empty } from '../components/Bits';
import { t } from '../copy/zh-TW';

export function NotFoundPage() {
  return (
    <Empty title={t.pages.notFound}>
      <Link className="btn" to="/search">
        {t.pages.toSearch}
      </Link>
    </Empty>
  );
}

export function ForbiddenPage() {
  return (
    <Empty title={t.pages.forbidden}>
      <Link className="btn" to="/search">
        {t.pages.toSearch}
      </Link>
    </Empty>
  );
}
