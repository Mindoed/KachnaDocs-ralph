/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  moduleNameMapper: {
    '^@kachnadocs/shared$': '<rootDir>/../shared/src',
  },
  // e2e tests boot Nest against a real Postgres; keep suites sequential so
  // they cannot race on the shared test database.
  maxWorkers: 1,
  testTimeout: 30_000,
};
