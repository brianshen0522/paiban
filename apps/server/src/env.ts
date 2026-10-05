/**
 * Variables that exist only for development and tests (docs/02-architecture.md, docs/12-auth.md).
 * In production their presence is a deployment mistake, so the services refuse to start rather
 * than silently ignoring them.
 */
export const TEST_ONLY_VARIABLES = ['ALLOW_LOCAL_SOURCES', 'SOURCE_OVERRIDES', 'TORRENT_TEST_PEERS'] as const;

export function testOnlyVariablesInProduction(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== 'production') return [];
  return TEST_ONLY_VARIABLES.filter((name) => (env[name] ?? '') !== '');
}

/** Exits the process when a test-only variable is set in production. */
export function assertSafeEnvironment(env: NodeJS.ProcessEnv, log: { fatal(msg: string): void }): void {
  const offending = testOnlyVariablesInProduction(env);
  if (offending.length > 0) {
    log.fatal(
      `refusing to start: ${offending.join(', ')} must not be set when NODE_ENV=production (development and test only)`,
    );
    process.exit(1);
  }
}
