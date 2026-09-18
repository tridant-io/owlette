import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // one `wrangler dev` for the whole run; the unit files do not use it.
    globalSetup: ['./test/globalSetup.ts'],
    // rooms are addressed by machine id, so files could run in parallel, but a
    // single worker process makes a failure easy to read.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
