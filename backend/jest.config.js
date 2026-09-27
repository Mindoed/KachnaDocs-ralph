/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts', '<rootDir>/test/**/*.test.ts'],
  moduleNameMapper: {
    '^@kachnadocs/shared$': '<rootDir>/../shared/src',
  },
  // Sets NODE_ENV=test before src/db.ts is imported, so its pool points at the
  // test database rather than the developer's dev database.
  setupFiles: ['<rootDir>/test/env-setup.js'],
  // e2e suites boot Nest against one shared Postgres; parallel workers would
  // race on the seeded fixture, so run them one at a time.
  maxWorkers: 1,
  testTimeout: 60_000,
};
