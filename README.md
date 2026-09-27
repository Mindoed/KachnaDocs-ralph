# KachnaDocs

Interní znalostní báze s CMS, kolaboračním editorem, jemnozrnným autorizačním systémem, úkoly a RAG
chatbotem.

## Rozložení

```
SPEC.md        požadavky (source of truth pro to, CO aplikace má dělat)
ralph/         veškeré "jak se to staví" a Ralph orchestration
backend/       NestJS   \
frontend/      Vue 3     > aplikaci generuje Ralph; roste až podle SPEC.md
shared/        sdílené typy a DTO /
docs/          dokumentace aplikace (např. docs/discord-oauth.md)
```

`SPEC.md` zůstává v kořeni společně s kódem, protože je to dokumentace produktu, ne Ralph podklad. Ralph
scaffolding je kompletně v `ralph/`:

- **[ralph/PLAN.md](ralph/PLAN.md)** — stack, architektonická rozhodnutí, bezpečnostní invarianty,
  `npm run verify` gate, fáze buildu a pravidla loopu
- **[ralph/FINDINGS.md](ralph/FINDINGS.md)** — průběžné poznatky, blokády a open otázky z iterací
- **[ralph/DEFERRED.md](ralph/DEFERRED.md)** — funkce odložené z dané fáze a proč
- **`ralph/prompts/phase{1..5}-*.md`** — prompty jednotlivých fází

## Ralph loop

Build probíhá po fázích, každá jako samostatný Ralph loop. Prompty fází jsou v `ralph/prompts/` — během
běžícího loopu je můžete upravovat, změna se projeví od další iterace.

Jediná výjimka je `.claude/ralph-loop.local.md` — runtime stav loopu, který musí zůstat tam, kde ho
hardcodovaně hledá stop hook pluginu. Je gitignored, takže repozitář to nijak nezašpiní.

```bash
head -10 .claude/ralph-loop.local.md   # stav loopu (iterace, limit, promise)
/cancel-ralph                          # zrušení loopu
```

## Vývoj

```bash
cp .env.example .env
npm install
npm run dev         # db + migrace + seed, pak API na :3000 a Vite na :5173
```

Bez `concurrently` (dva terminály):

```bash
npm run dev:api     # API + Swagger na http://localhost:3000/api/docs
npm run dev:web     # Vite; /api proxyuje na :3000
```

`npm run dev` volá `migrate` a `seed` na dev databázi pokaždé — `seed` je idempotentní a rebuilduje
fixture celý, takže vývojář nikdy nezůstane na schématu, ke kterému se migrovalo „kdysi".

Po builté frontendu (`npm run build`) API samo obslouží i SPA na stejném originu — to je cesta, kterou
 používá Playwright, a hodí se i pro jakékoli single-process nasazení.

## Gate

```bash
npm run verify
```

`db:up` → `db:wait` → `migrate` + `migrate:test` → `seed` + `seed:test` → `lint` → `typecheck` →
`build` → `test` (jest unit) → `test:e2e` (jest přes reálné HTTP + Playwright). Podrobnosti a pravidla
v [ralph/PLAN.md](ralph/PLAN.md) §4. Rychlejší cílené kroky:

```bash
npm run test          # jest unit (bez e2e)
npm run test:e2e      # jest e2e + playwright
npx playwright test   # jen prohlížeč (sám nastartuje API i DB)
```

