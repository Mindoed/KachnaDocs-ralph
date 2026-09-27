/**
 * pgvector, initialized now rather than in phase 5.
 *
 * The image (pgvector/pgvector:pg17) ships the extension but does not create it,
 * and extensions are per-database — so the dev and test databases each need this
 * migration. Discovering that in phase 5 means the failure surfaces at the point
 * of least context, which is exactly what PLAN §2.1 pre-empts by asking for the
 * extension to be initialized while only the ACL exists.
 *
 * `GET /api/health` reports extversion, so a database that somehow lost it is
 * visible instead of waiting for an INSERT INTO embeddings to fail.
 */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS vector');
};

exports.down = (pgm) => {
  // No phase-5 objects depend on it yet, so dropping is safe today; once
  // embeddings exist this must become a plain no-op or it will fail on cascade.
  pgm.sql('DROP EXTENSION IF EXISTS vector');
};
