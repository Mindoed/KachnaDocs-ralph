// Runs before the test framework loads modules, so db.ts reads the test
// database when it initialises its pool. Without this an accidental run against
// the dev database would truncate seeded data through seed()'s TRUNCATE.
process.env.NODE_ENV = 'test';
