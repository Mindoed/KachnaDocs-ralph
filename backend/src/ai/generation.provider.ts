/**
 * Generation, and the one place a real model would be added.
 *
 * PLAN §2.1: `GenerationProvider` is an interface, `StubProvider` is the only
 * implementation in scope, and adding a real model must mean **one new class
 * implementing this interface** — no change to the controller, the retrieval
 * service, the persistence, or the tests. That constraint is why the interface
 * takes already-retrieved chunks plus the parsed behaviour rules and returns
 * already-attributed citations: everything on either side of those arguments is
 * the part that is real and must not move when the stub is replaced.
 *
 * What the stub deliberately does *not* fake:
 *
 *  - It does not write prose. It quotes retrieved chunk text verbatim, so every
 *    sentence of an answer is traceable to a chunk a reader can open. A
 *    plausible-sounding paraphrase would make the citation ceremony decorative.
 *  - It does not invent an answer when there is nothing to answer with. The
 *    threshold decision is taken *before* it is called (in `chat.service.ts`), and
 *    this class keeps its own empty-input guard so a future caller that forgets
 *    the threshold gets an honest non-answer rather than a confident nothing.
 *  - It does not decide what may be retrieved. It receives whatever it is handed,
 *    which is exactly why this phase's security property lives in the SQL
 *    retrieval query and not here.
 *
 * Swapping in a real model: implement this interface, bind it in `ai.module.ts`
 * (config-selected, the way `IdentityProvider` already works per PLAN §2.2), and
 * keep the rule that the model receives *only* the chunks it was given plus the
 * actor's own question. A model handed documents it did not retrieve has just
 * bypassed the ACL through a side door that no SQL predicate can close.
 */

import { Injectable } from '@nestjs/common';
import type { BehaviorRules } from './behavior-config.service';
import type { RetrievedChunk } from './retrieval.service';

/** What a generator may cite, and what the UI needs to link to it. */
export interface Citation {
  documentId: string;
  documentTitle: string;
  versionNumber: number;
  /** Heading anchor, or null when the source is the document as a whole. */
  anchor: string | null;
  heading: string;
  /** The passage the answer is built from — quoted, not summarised. */
  excerpt: string;
  score: number;
}

export interface GenerationInput {
  /** The current question. */
  question: string;
  /** ACL-filtered, threshold-passed chunks, most relevant first. */
  chunks: RetrievedChunk[];
  /** Previous turns of this conversation, oldest first. */
  history: { role: 'user' | 'assistant'; text: string }[];
  /** The parsed behaviour config; prose plus the settings the stub can execute. */
  rules: BehaviorRules;
  /**
   * True when the conversation's earlier turns are what makes this follow-up
   * answerable — the follow-up's own retrieval was weak. The answer then has to
   * name what it is answering *about*, or it reads as a reply to the bare
   * fragment that was typed.
   */
  contextFromHistory: boolean;
}

export interface GenerationResult {
  text: string;
  citations: Citation[];
}

export interface GenerationProvider {
  readonly name: string;
  generate(input: GenerationInput): Promise<GenerationResult>;
}

/**
 * Deterministic, offline, no network, no key — and honest about being a lookup.
 *
 * The answer is the retrieved chunks' own text plus their citations, in Czech.
 * Deterministic in the strong sense: same question, same permitted content, same
 * config ⇒ byte-identical answer. That is what lets this phase's tests assert an
 * *answer* rather than only its shape — including the security test, which has to
 * reason about every string that could reach a user.
 *
 * The wording comes from the behaviour config, not from here: `answerPrefix`,
 * `maxCitations` and `excerptChars` are read from `rules`, so editing the config
 * file observably changes the answer. That is the phase's "config change alters
 * behavior" test, and it is observable today rather than promised to a future
 * model.
 */
@Injectable()
export class StubProvider implements GenerationProvider {
  readonly name = 'stub-v1';

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const { rules } = input;
    // Guarded here as well as by the caller's threshold: the "documentation does
    // not cover that" outcome must not depend on one caller remembering to check.
    if (input.chunks.length === 0) {
      return { text: rules.unanswerable, citations: [] };
    }

    const quoted = input.chunks.slice(0, Math.max(1, rules.maxCitations));
    const excerptChars = Math.max(40, rules.excerptChars);
    const citations: Citation[] = quoted.map((chunk) => ({
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      versionNumber: chunk.versionNumber,
      anchor: chunk.anchor,
      heading: chunk.heading,
      excerpt: chunk.text.length > excerptChars ? `${chunk.text.slice(0, excerptChars)}…` : chunk.text,
      score: chunk.score,
    }));

    // A follow-up answered from conversation context has to name its subject:
    // quoting chunks chosen against the *earlier* question, in reply to "a jak
    // dlouho?", would otherwise look like an answer about duration in general.
    const subject = input.contextFromHistory
      ? `Navazuji na předchozí dotaz: „${lastQuestion(input.history) ?? input.question}“.\n\n`
      : '';

    const lines = quoted.map((chunk, index) => `${index + 1}. ${chunk.text}`);
    return {
      text:
        `${subject}${rules.answerPrefix}\n\n` +
        `${lines.join('\n\n')}\n\n` +
        `Odpověď vychází pouze z výše citovaných publikovaných částí (${citations.length} ${plural(citations.length)}) — nic dalšího k nim nepřidávám.`,
      citations,
    };
  }
}

/** The most recent user turn, or null if the conversation has none yet. */
function lastQuestion(history: readonly { role: 'user' | 'assistant'; text: string }[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user') return history[i].text.trim();
  }
  return null;
}

/** Czech plural of "zdroj" — an answer that prints "1 zdroje" reports its own bug. */
function plural(count: number): string {
  if (count === 1) return 'zdroj';
  if (count >= 2 && count <= 4) return 'zdroje';
  return 'zdrojů';
}
