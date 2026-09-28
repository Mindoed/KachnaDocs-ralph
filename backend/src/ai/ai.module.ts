import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { BehaviorConfigService } from './behavior-config.service';
import { ChatService, GENERATION_PROVIDER } from './chat.service';
import { EMBEDDING_PROVIDER, HashingEmbeddingProvider, type EmbeddingProvider } from './embedding.provider';
import { StubProvider, type GenerationProvider } from './generation.provider';
import { RetrievalService } from './retrieval.service';

/**
 * The RAG module: real retrieval, stubbed generation (PLAN §2.1).
 *
 * The two provider bindings at the bottom are the seam. `GenerationProvider` and
 * `EmbeddingProvider` are interfaces, so Nest resolves them by token, and this
 * module is the *only* place that names a concrete class. A real model arrives as
 * one new class plus one line of change here — no edit to `ChatService`, the
 * controller, retrieval, or the tests, which is the property PLAN §2.1 asks to be
 * kept true and the reason the stub is not referenced from anywhere else.
 *
 * `RetrievalService` is exported because publishing reindexes through it
 * (`versions.controller.ts`), which gives the CMS a one-line dependency on this
 * module and no dependency on how retrieval works. The module imports nothing: a
 * CMS↔AI cycle would be the natural way to wire that, and this direction keeps the
 * module graph a DAG.
 */
@Module({
  imports: [],
  controllers: [AiController],
  providers: [
    RetrievalService,
    BehaviorConfigService,
    ChatService,
    {
      provide: EMBEDDING_PROVIDER,
      // Deterministic and offline by plan: no API key, no network, deliberately
      // weak so a passing similarity test is never mistaken for answer quality.
      useValue: new HashingEmbeddingProvider() satisfies EmbeddingProvider,
    },
    {
      provide: GENERATION_PROVIDER,
      useValue: new StubProvider() satisfies GenerationProvider,
    },
  ],
  exports: [RetrievalService, ChatService],
})
export class AiModule {}
