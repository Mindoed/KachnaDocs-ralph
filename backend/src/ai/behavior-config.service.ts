/**
 * The chatbot's behaviour rules, read from a Markdown file.
 *
 * SPEC §5 asks for the rules to live in a config Markdown file; the prompt adds
 * that the file's format has to be documented and that a change in it must be
 * observably change the bot's behaviour. Both requirements hit the same design
 * question, which is what a Markdown file full of prose cannot answer on its own:
 * prose rules are what a *model* would read, and nothing in this phase runs a
 * model. So the file has two kinds of content and they are handled differently,
 * on purpose:
 *
 *  - **Prose** (headings, paragraphs, list bullets that are not `key: value`) is
 *    the instructions themselves. It is concatenated and handed to
 *    `GenerationInput.behaviorRules`, where a real model would consume it as a
 *    system prompt. The stub cannot obey prose, and says so rather than
 *    pretending to.
 *  - **Settings** — bullets of the form `- key: value` — are the subset the
 *    pipeline can execute *without* a model: the retrieval threshold, how many
 *    citations to attach, the non-answer's wording, the answer's prefix. These
 *    are what makes "the config file changed the behaviour" a testable claim
 *    today rather than a promise about a future model.
 *
 * ## File format
 *
 * ```markdown
 * # Chování AI asistenta
 *
 * Odpovídej česky, střídmě, a vždy uveď, ze které sekce odpověď pochází.
 * Nepoužívej odhady: pokud dokumentace mlčí, přiznej to.
 *
 * - threshold: 0.08
 * - maxCitations: 3
 * - answerPrefix: "Podle dokumentace:"
 * - unanswerable: "Tohle dokumentace KachnaDocs nepokrývá."
 * - excerptChars: 320
 * ```
 *
 * Unrecognised keys are kept in `unknownKeys` and reported rather than silently
 * dropped: a silently ignored setting is a config file that lies about the
 * behaviour it produces. Values are trimmed strings; `threshold` and the numeric
 * keys are parsed, and a malformed number falls back to the default *with the key
 * recorded in `invalidKeys`* for the same reason.
 *
 * ## Re-read on change
 *
 * `rules()` stats the file and re-parses when the mtime or size differs, so an
 * edit takes effect on the next question without a restart (SPEC §5's "re-read on
 * change"). Stat-per-question is the cheap version of that and is fine at this
 * scale; the alternative — a watcher — would make the file's absence at boot a
 * startup failure instead of a fallback.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';

export interface BehaviorRules {
  /** Absolute path the rules were read from (or would be). */
  path: string;
  /** True when the file existed and was parsed. */
  loaded: boolean;
  /** Prose instructions, for a model to consume. Empty when the file is missing. */
  instructions: string;
  /** Retrieval score at or above which a chunk counts as relevant. */
  threshold: number;
  /** Upper bound on citations attached to one answer. */
  maxCitations: number;
  /** Opening line of an answer built from chunks. */
  answerPrefix: string;
  /** The whole answer when nothing relevant was retrieved. */
  unanswerable: string;
  /** How much of a cited chunk is quoted. */
  excerptChars: number;
  /** Keys present in the file that this build does not implement. */
  unknownKeys: string[];
  /** Keys whose value could not be parsed; the default was used. */
  invalidKeys: string[];
  /** Short hash of the file contents, so an answer can record what governed it. */
  fingerprint: string;
}

const DEFAULTS = {
  // Calibrated against HashingEmbeddingProvider, not against a model: bag-of-words
  // cosine for an on-topic question and its matching chunk lands well above this,
  // and for an off-topic one well below. A real embedder would need a different
  // number, which is a config edit rather than a code change — the reason the
  // threshold lives here at all.
  threshold: 0.08,
  maxCitations: 3,
  answerPrefix: 'Dokumentace KachnaDocs k tomu říká:',
  unanswerable:
    'Dokumentace KachnaDocs tohle nepokrývá — nic relevantního jsem nenašel, a raději to řeknu přímo, než abych něco vymýšlel.',
  excerptChars: 320,
};

/** `- key: value`, with either kind of quote or none. */
const SETTING = /^\s*[-*]\s*([A-Za-z][\w]*)\s*:\s*(.*)$/;

@Injectable()
export class BehaviorConfigService {
  private readonly logger = new Logger(BehaviorConfigService.name);
  private cached: BehaviorRules | null = null;
  private signature = '';

  /**
   * Where the rules are read from; see `resolveConfigPath`.
   *
   * A getter, not a constructor-assigned field, and that is load-bearing rather
   * than stylistic: "re-read on change" would be a half-truth if the *location*
   * were pinned at boot while the *contents* were live. The e2e suite repoints
   * `AI_BEHAVIOR_FILE` at a temp file while the server is running and asserts that
   * the answer changes; a boot-time path made that test silently exercise the repo
   * config, and its assertions about the temp file would have been about a file
   * nobody was reading.
   */
  get path(): string {
    // Resolution walks up from the backend workspace to the repo root, the same
    // way env.ts finds .env: the process cwd is the workspace when npm runs a
    // workspace script and the repo root when ts-node is invoked directly.
    return resolveConfigPath();
  }

  /** Current rules, re-read if the file changed since last time. */
  rules(): BehaviorRules {
    const signature = this.statSignature();
    if (this.cached && signature === this.signature) return this.cached;
    const next = this.parse();
    this.cached = next;
    this.signature = signature;
    return next;
  }

  /**
   * Path + mtime + size.
   *
   * The path is part of the signature because the cache is one slot: repointing
   * `AI_BEHAVIOR_FILE` at a file with an identical mtime and size would otherwise
   * be served the previous file's rules.
   */
  private statSignature(): string {
    const path = this.path;
    if (!existsSync(path)) return `missing:${path}`;
    const stat = statSync(path);
    return `${path}:${stat.mtimeMs}:${stat.size}`;
  }

  private parse(): BehaviorRules {
    const unknownKeys: string[] = [];
    const invalidKeys: string[] = [];
    const settings: Record<string, string> = {};
    const prose: string[] = [];

    let raw = '';
    let loaded = false;
    try {
      raw = readFileSync(this.path, 'utf8');
      loaded = true;
    } catch {
      // Missing config is not a broken bot: the defaults are a complete, sane
      // behaviour. Loud in the log, quiet in the response — an AI module that
      // takes the docs down because its config file moved would be worse than a
      // bot with default wording.
      this.logger.warn(`behaviour config missing at ${this.path}; using defaults`);
    }

    for (const line of raw.split(/\r?\n/)) {
      const match = SETTING.exec(line);
      const key = match?.[1];
      if (key !== undefined) {
        settings[key] = (match?.[2] ?? '').trim().replace(/^["']|["']$/g, '');
        continue;
      }
      // A bullet that isn't a setting is prose ("always cite the section"), and a
      // heading or paragraph likewise. Blank lines collapse.
      const text = line.trim();
      if (text) prose.push(text.replace(/^#+\s*/, ''));
    }

    const numeric = (key: keyof typeof DEFAULTS, fallback: number): number => {
      const value = settings[key];
      if (value === undefined) return fallback;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        invalidKeys.push(String(key));
        return fallback;
      }
      return parsed;
    };
    const text = (key: keyof typeof DEFAULTS, fallback: string): string => settings[key] ?? fallback;

    for (const key of Object.keys(settings)) {
      if (!(key in DEFAULTS)) unknownKeys.push(key);
    }

    const rules: BehaviorRules = {
      path: this.path,
      loaded,
      instructions: prose.join('\n'),
      threshold: numeric('threshold', DEFAULTS.threshold),
      maxCitations: numeric('maxCitations', DEFAULTS.maxCitations),
      answerPrefix: text('answerPrefix', DEFAULTS.answerPrefix),
      unanswerable: text('unanswerable', DEFAULTS.unanswerable),
      excerptChars: numeric('excerptChars', DEFAULTS.excerptChars),
      unknownKeys,
      invalidKeys,
      fingerprint: createHash('sha256').update(raw).digest('hex').slice(0, 12),
    };

    if (unknownKeys.length || invalidKeys.length) {
      this.logger.warn(
        `behaviour config at ${this.path}: unknown [${unknownKeys.join(', ')}], ` +
          `unparsable [${invalidKeys.join(', ')}]`,
      );
    }
    return rules;
  }
}

/**
 * Where the config lives.
 *
 * `AI_BEHAVIOR_FILE` overrides it, which is what lets the test suite point the
 * bot at a fixture file and assert that a rule change changes the answer — the
 * prompt's "assert a rule that is observable". Without an override the test would
 * have to rewrite the repo's own config mid-suite and leak that change into every
 * later test in the same process.
 */
function resolveConfigPath(): string {
  if (process.env.AI_BEHAVIOR_FILE) return resolve(process.env.AI_BEHAVIOR_FILE);
  for (const dir of [process.cwd(), resolve(__dirname, '../../..')]) {
    const candidate = resolve(dir, 'config/ai-behavior.md');
    if (existsSync(candidate)) return candidate;
  }
  return resolve(process.cwd(), 'config/ai-behavior.md');
}
