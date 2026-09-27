import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { query } from './db';

interface DbProbe {
  ok: number;
  extversion: string | null;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  /**
   * Deliberately unauthenticated, and deliberately more than `res.send('ok')`.
   *
   * Two things break silently in this project and are invisible to a process
   * that answers HTTP: the database is unreachable, and pgvector is absent from
   * the image (which only surfaces in phase 5, far from its cause). So this
   * probe SELECTs and reads the extension version.
   *
   * Reports `degraded` as 503 rather than throwing: a health endpoint that
   * itself 500s is indistinguishable from a crash loop, and the body is the
   * diagnosis the operator needs.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness plus a real database and pgvector probe' })
  async check(@Res() res: Response): Promise<void> {
    let body: { status: 'ok' | 'degraded'; database: 'up' | 'down'; pgvector: string | null };
    try {
      const rows = await query<DbProbe>(
        `SELECT 1::int AS ok,
                (SELECT extversion FROM pg_extension WHERE extname = 'vector')::text AS extversion`,
      );
      const row = rows[0];
      // `rows[0]` is `DbProbe | undefined` under noUncheckedIndexedAccess, and
      // that is correct: a pool that answered with no rows is not healthy.
      if (!row || row.ok !== 1) throw new Error('SELECT 1 did not return a row');
      body = { status: 'ok', database: 'up', pgvector: row.extversion ?? null };
    } catch {
      body = { status: 'degraded', database: 'down', pgvector: null };
    }
    await res.status(body.status === 'ok' ? 200 : 503).json(body);
  }
}
