/** Narrow budget for tests dominated by synchronous child processes. Vitest
 * scores their elapsed time after the synchronous call returns; it cannot
 * interrupt that call. Apply at the smallest spawning scope, leaving other
 * tests on their normal deadline. */
export const SPAWN_HEAVY_TIMEOUT = 30_000;
