import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Auto-load .env so `yarn test` picks up SOLANA_RPC_* without needing
// inline overrides. Won't override values already present in the shell.
loadEnv();

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
  },
});
