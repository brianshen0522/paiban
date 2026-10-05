import { buildApp } from './app.js';
import { assertSafeEnvironment } from './env.js';
import { createLogger } from './log.js';

const log = createLogger('api');
assertSafeEnvironment(process.env, log);

const app = buildApp({ logger: false });
const port = Number(process.env.PORT ?? 3000);

await app.listen({ host: '0.0.0.0', port });
log.info({ port }, 'api listening');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
