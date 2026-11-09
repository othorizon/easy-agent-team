import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Explicit local browser acceptance; include must replace the default suite.
export default defineConfig({ ...base, test: { ...base.test,
  include: ['scripts/permissions-ui-qa.ts'], testTimeout: 900_000,
} });
