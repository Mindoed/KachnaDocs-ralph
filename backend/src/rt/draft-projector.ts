import { Injectable } from '@nestjs/common';
import type * as Y from 'yjs';
import { pmJsonFromYDoc } from './draft-document';
import { renderMarkdown } from '../cms/headings';

/**
 * Y.Doc -> the two columns phase 2 already reads.
 *
 * Plan §2.3 makes Yjs authoritative for the draft while publishing keeps reading
 * `draft_body` and `draft_markdown`. That only works if there is exactly one
 * function that derives the second pair from the first, so it lives here rather
 * than inline in the gateway's persist path: the restore-as-draft endpoint needs
 * the same derivation (it writes a version's content into the draft, which must
 * land as Yjs *and* as the projection), and two implementations would eventually
 * disagree about what a heading looks like in Markdown — at which point the diff
 * after a publish reports changes nobody made.
 *
 * No schema is involved. `pmJsonFromYDoc` walks the Y.XmlFragment, whose items
 * carry their node type names, and `renderMarkdown` consumes that JSON. The
 * schema exists only for the one-way seeding in `draft-document.ts`, which is why
 * this runs per keystroke burst without instantiating an editor.
 */
@Injectable()
export class DraftProjector {
  project(ydoc: Y.Doc): { body: Record<string, unknown>; markdown: string } {
    const body = pmJsonFromYDoc(ydoc);
    return { body, markdown: renderMarkdown(body) };
  }
}
