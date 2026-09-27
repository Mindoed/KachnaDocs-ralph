<script setup lang="ts">
import { DOCUMENT_STATE_LABEL } from '@kachnadocs/shared';
import { computed, onMounted } from 'vue';
import { useCmsStore } from '../stores/cms';

/**
 * Version history, the opened snapshot, and the diff viewer (SPEC.md §1's
 * "historie verzí", "otevřít starší verzi", "porovnat", "obnovit jako koncept").
 *
 * Three panels in one component because they are one interaction: pick a
 * version, then either read it or compare it, then possibly restore it. The
 * backend decides which of those the caller may do — this file only decides what
 * to offer, and a refusal still lands in `cms.notice` rather than being
 * prevented client-side and thereby invisible.
 */
const cms = useCmsStore();

const canPublish = computed(() => cms.selected !== null && cms.can(cms.selected.id, 'MANAGE'));
const canRestore = computed(() => cms.selected !== null && cms.can(cms.selected.id, 'WRITE'));

// This panel is separately dockable and can be opened first, with the tree
// hidden, so it cannot assume anyone else fetched the hierarchy.
onMounted(() => void cms.ensureLoaded());

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' });
}

function publish(): void {
  // An empty comment is allowed and simply sends nothing; the API stores null
  // rather than an empty string so the panel can say "(bez komentáře)" instead
  // of rendering a blank line that looks like a bug.
  const comment = window.prompt('Komentář ke změně (nepovinný):') ?? '';
  void cms.publish(comment.trim());
}

function restore(number: number): void {
  if (window.confirm(`Obnovit v${number} do konceptu? Současný koncept bude nahrazen.`))
    void cms.restore(number);
}
</script>

<template>
  <div class="history">
    <p v-if="!cms.selected" class="muted note">Vyberte dokument.</p>

    <template v-else>
      <header class="head">
        <h3 class="heading">{{ cms.selected.title }}</h3>
        <span class="badge" :data-state="cms.selected.state">{{
          DOCUMENT_STATE_LABEL[cms.selected.state]
        }}</span>
      </header>

      <div v-if="canPublish" class="publish">
        <button :disabled="cms.busy" @click="publish">Publikovat koncept</button>
      </div>

      <h4 class="heading">Historie</h4>
      <p v-if="cms.versions.length === 0" class="muted note">Zatím nebylo publikováno.</p>
      <ol v-else class="versions">
        <li v-for="v in cms.versions" :key="v.number" :class="{ open: cms.opened?.number === v.number }">
          <div class="line">
            <button class="num" title="Otevřít verzi" @click="cms.openVersion(v.number)">
              v{{ v.number }}
            </button>
            <span class="who">{{ v.authorName ?? 'neznámý autor' }}</span>
            <span class="when muted">{{ when(v.publishedAt) }}</span>
          </div>
          <p class="comment">{{ v.comment ?? '(bez komentáře)' }}</p>
          <div class="ops">
            <button class="op" @click="cms.compare(v.number)">Srovnat s aktuální</button>
            <button v-if="canRestore" class="op" @click="restore(v.number)">Obnovit jako koncept</button>
          </div>
        </li>
      </ol>

      <template v-if="cms.diff">
        <h4 class="heading">
          Srovnání
          <span class="refs muted">{{ cms.diff.from }} → {{ cms.diff.to }}</span>
          <span class="summary muted">
            +{{ cms.diff.summary.added }} / −{{ cms.diff.summary.removed }} /
            {{ cms.diff.summary.unchanged }} beze změny
          </span>
        </h4>
        <ul class="diff">
          <li v-for="(line, i) in cms.diff.lines" :key="i" :class="line.op">
            <span class="gutter muted">{{ line.op === 'add' ? line.after : line.before }}</span>
            <span class="mark">{{ line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' ' }}</span>
            <span class="text">{{ line.text }}</span>
          </li>
        </ul>
        <button class="op close" @click="cms.diff = null">Zavřít srovnání</button>
      </template>

      <template v-else-if="cms.opened">
        <h4 class="heading">
          Verze {{ cms.opened.number }}
          <span class="refs muted">{{ cms.opened.title }}</span>
        </h4>
        <pre class="snapshot">{{ cms.opened.markdown }}</pre>
        <ul v-if="cms.opened.headings.length > 0" class="outline muted">
          <li v-for="h in cms.opened.headings" :key="h.anchor" :style="{ '--depth': h.level }">
            <code>#{{ h.anchor }}</code> {{ h.text }}
          </li>
        </ul>
      </template>
    </template>
  </div>
</template>

<style scoped>
.history {
  display: grid;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
}

.heading {
  margin: 0;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  justify-content: space-between;
}

.head .heading {
  font-size: 0.85rem;
  text-transform: none;
  letter-spacing: normal;
  color: var(--fg);
}

.badge {
  font-family: var(--mono);
  font-size: 0.65rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  background: var(--bg-hover);
  color: var(--fg-dim);
}

.badge[data-state='Published'] {
  color: var(--accent);
}

.badge[data-state='Draft'] {
  color: #e8b464;
}

.publish button {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.25rem 0.6rem;
  font-size: 0.8rem;
  color: var(--accent);
}

.publish button:hover:not(:disabled) {
  background: var(--bg-hover);
}

.note {
  font-size: 0.8rem;
  margin: 0;
}

.versions {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.35rem;
}

.versions li {
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0.35rem 0.45rem;
  display: grid;
  gap: 0.2rem;
}

.versions li.open {
  border-color: var(--accent);
}

.line {
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.num {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--accent);
}

.who {
  font-size: 0.8rem;
}

.when {
  font-size: 0.7rem;
}

.comment {
  margin: 0;
  font-size: 0.8rem;
}

.ops {
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.op {
  font-size: 0.72rem;
  color: var(--fg-dim);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.1rem 0.35rem;
}

.op:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.close {
  justify-self: start;
}

.diff {
  list-style: none;
  margin: 0;
  padding: 0;
  font-family: var(--mono);
  font-size: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 5px;
  overflow: hidden;
}

.diff li {
  display: flex;
  gap: 0.35rem;
  padding: 0.05rem 0.35rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.diff li.add {
  background: rgba(79, 143, 247, 0.14);
  color: #9fc3ff;
}

.diff li.remove {
  background: rgba(224, 108, 108, 0.14);
  color: #eda7a7;
}

.gutter {
  width: 1.5rem;
  text-align: right;
  flex: none;
  font-size: 0.65rem;
}

.mark {
  width: 0.7rem;
  flex: none;
}

.text {
  min-width: 0;
}

.summary {
  font-size: 0.68rem;
  text-transform: none;
  letter-spacing: normal;
}

.refs {
  font-size: 0.68rem;
  text-transform: none;
  letter-spacing: normal;
}

.snapshot {
  margin: 0;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 5px;
  font-family: var(--mono);
  font-size: 0.75rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 18rem;
  overflow-y: auto;
}

.outline {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 0.75rem;
  display: grid;
  gap: 0.1rem;
}

.outline li {
  padding-left: calc(var(--depth) * 0.6rem);
}
</style>
