import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  AiAnswerDto,
  AiConversationDetailDto,
  AiConversationDto,
  AskRequestDto,
  AuthUser,
} from '@kachnadocs/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { notFound } from '../http-errors';
import { ChatService } from './chat.service';

/**
 * The chat endpoints (SPEC §5).
 *
 * ## Why this controller carries no `@RequirePermission`
 *
 * Every other controller in the codebase decorates its handlers, and the absence
 * here is deliberate rather than an oversight — it is the one place where
 * `RequirePermissionGuard`'s shape does not fit. That guard asks "may this actor
 * perform P on the resource named by `:id`", and a question has no single target
 * resource: the set it may draw on is *everything the actor can READ*, decided per
 * chunk inside `ai_search_chunks`. Putting `@RequirePermission('READ', …)` on this
 * route would need an id to check, and inventing one (a group, say) would be worse
 * than none: it would imply that access to *that* id is what authorises the answer,
 * when in fact a permitted group must not widen retrieval beyond the documents the
 * actor can read.
 *
 * What is enforced, and where:
 *  - signed in — the guard's default, since no route here is `@Public()`;
 *  - conversation ownership — `user_id` in the conversation's own SQL;
 *  - document access — inside `ai_search_chunks`, per candidate.
 * SPEC §3's "the backend decides" is satisfied by those three; no frontend hiding is
 * relied on for any of them.
 */
@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly chat: ChatService) {}

  /** Ask a question. Creates a conversation when `conversationId` is absent. */
  @Post('ask')
  async ask(@CurrentUser() me: AuthUser, @Body() body: AskRequestDto): Promise<AiAnswerDto> {
    const result = await this.chat.ask(me.id, body?.question ?? '', body?.conversationId);
    return {
      conversationId: result.conversationId,
      messageId: result.messageId,
      question: body.question,
      answer: result.answer,
      citations: result.citations,
      usedConversationContext: result.usedConversationContext,
      unanswerable: result.unanswerable,
      provider: result.provider,
    };
  }

  /** The actor's conversations, newest first. */
  @Get('conversations')
  async conversations(@CurrentUser() me: AuthUser): Promise<AiConversationDto[]> {
    return this.chat.conversationsOf(me.id);
  }

  /** One conversation with its history. Someone else's is a 404, indistinguishable from absent. */
  @Get('conversations/:id')
  async conversation(@CurrentUser() me: AuthUser, @Param('id') id: string): Promise<AiConversationDetailDto> {
    // Fetched by id with the owner in the predicate, not looked up in the list
    // endpoint's page: reusing `conversationsOf` would both run a needless query
    // and 404 any conversation older than that page's limit.
    const summary = await this.chat.conversationOf(id, me.id);
    if (!summary) throw notFound();
    const messages = await this.chat.messagesOf(id, me.id);
    return { ...summary, messages };
  }
}
