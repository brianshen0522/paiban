import { assertSafeEnvironment } from './env.js';
import { runIdle } from './idle.js';
import { createLogger } from './log.js';

const log = createLogger('torrent');
assertSafeEnvironment(process.env, log);
runIdle(log);
