import pg from 'pg';
import { TEST_DATABASE_URL } from './helpers.js';

/** Fails early, with the command to run, when the test PostgreSQL is not up. */
export default async function setup(): Promise<void> {
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.end();
  } catch {
    throw new Error(
      `The server tests need PostgreSQL at ${TEST_DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}. Start it with:\n  docker compose -f deploy/docker-compose.test.yml up -d --wait`,
    );
  }
}
