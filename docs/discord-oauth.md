# Přepnutí z dev přihlášení na reálné Discord OAuth

KachnaDocs nikde nevětví, odkud identita přišla. Jediné místo, které se na to dívá, je
`pickIdentityProvider()` v `backend/src/auth/auth.controller.ts` — vybere implementaci
`IdentityProvider` (`backend/src/auth/identity-provider.ts`) podle přítomnosti credentialů.
Zbytek aplikace (ACL, JWT, `AuthService`, frontend) se chová úplně stejně v obou režimech, což je
důvod, proč fází 1 prochází celým testovacím gate bez jakýchkoli Discord přihlašovacích údajů.

**Zapnutí reálného OAuth je jen nastavení proměnných prostředí.** Žádný kód se měnit nemusí.

---

## 1. Vytvoření aplikace v Discord Developer Portal

1. Otevřít <https://discord.com/developers/applications> → **New Application**.
2. V levém menu **OAuth2**:
   - zkopírovat **Client ID** → `DISCORD_CLIENT_ID`
   - **Reset Secret** → `DISCORD_CLIENT_SECRET` (zobrazí se jen jednou)
3. **OAuth2 → Redirects → Add Redirect**:

   ```
   http://localhost:3000/api/auth/discord/callback
   ```

   Musí sedět **přesně** včetně `/api` prefixu (Nest ho nastavuje v `bootstrap.ts`) a bez lomítka
   na konci. Neshoda se projeví chybou `OAuth2 redirect URI is invalid` už při přesměrování,
   nikoli až v callbacku. Pro nasazení přidat druhý redirect na `https://<doména>/api/auth/discord/callback`.

Rozsah, který aplikace žádá, je `identify guilds` (`buildAuthorizeUrl()` v
`backend/src/auth/discord-identity.provider.ts`):

| scope      | proč                                                 |
| ---------- | ---------------------------------------------------- |
| `identify` | `id`, `username`, avatar — identity stačí `id`       |
| `guilds`   | seznam serverů uživatele, ze kterých odvozujeme role |

## 2. Nastavení prostředí

Do `.env` v kořeni repo (popis všech proměnných je v `.env.example`):

```dotenv
DISCORD_CLIENT_ID=123456789012345678
DISCORD_CLIENT_SECRET=abcd…
DISCORD_REDIRECT_URI=http://localhost:3000/api/auth/discord/callback
FRONTEND_ORIGIN=http://localhost:5173
JWT_SECRET=…               # v produkci opravdu tajný, čte ho auth.service.ts
```

Při `DISCORD_CLIENT_ID` **a** `DISCORD_CLIENT_SECRET` se aplikace přepne:

- `pickIdentityProvider()` vrátí `DiscordIdentityProvider` místo `DevIdentityProvideru`
- `POST /api/auth/dev-login` vrací **404** — production se handlem přihlásit nedá
- přihlašovací formulář na frontendu přestane hádat režim a zeptá se `/api/auth/discord/authorize-url`;
  když existuje, zobrazí tlačítko **Přihlásit přes Discord** místo pole pro handle
- `GET /api/health` zůstává bez tokenů, aby probe nefungoval jen v jednom režimu

## 3. Průběh přihlášení

```
prohlížeč                          backend                          Discord
   │  GET /api/auth/discord/authorize-url?state=…
   │ ◄── { url } ───────────────────│
   │  přesměrování na discord.com/oauth2/authorize
   │ ──────────────────────────────────────────────────────────────►  consent
   │  ◄─── GET /api/auth/discord/callback?code=… ────────────────────│
   │                              │ POST /api/v10/oauth2/token
   │                              │ GET  /api/v10/users/@me
   │                              │ resolveIdentity() → rows v users + synchronizace rolí
   │                              │ JWT (HS256, TTL JWT_TTL_SECONDS, default 12 h)
   │ ◄── 302 FRONTEND_ORIGIN#token=… │
   │  stores/auth.ts: adoptTokenFromUrl() token přečte a sofort
   │  smaže z URL přes history.replaceState
```

Token putuje v **fragmentu** (`#token=`), ne v query stringu: fragment se nikdy neposílá serveru,
nevadí v `Referer` a nedostane se do logů proxy. I tak je to po jednu navigaci kredenciál v adresním
řádku — tvrdší varianta (httpOnly cookie relace + CSRF token) je úmyslně mimo fázi 1, viz niže.

## 4. Jak se role dostanou do ACL

`DiscordIdentityProvider.fetchRoleMembership()` zavolá `/users/@me/guilds` a pro každý guild
`/guilds/{id}/roles` a výsledek zapíše do `discord_roles` / `user_discord_roles`
(SPEC.md:86). `AuthService.login()` synchronizuje členství při každém přihlášení:

- role, kterou Discord nevrátil, se z `user_discord_roles` **smaže** — odebrání role na serveru
  musí okamžitě sebrat přístup, jinak by ACL odpovídalo stavu z prvního přihlášení navěky
- test `drops access when role membership is synced away` v `backend/test/acl.e2e-spec.ts` to hlídá

**Omezení, které je třeba znát:** `/guilds/{id}/roles` vrací _definice_ rolí na serveru, ne role
_konkrétního uživatele_ — a vyžaduje guild, kde má aplikace co číst. Bez bot tokena a scope
`guilds.members.read` tedy seznam rolí neodpovídá přesně realitě. Správný postup pro produkci:

1. Vytvořit bota (stejná aplikace, menu **Bot**), přidat ho na server.
2. Žádat i scope `guilds.members.read`; bot token mít na serveru, nikdy neposílat do prohlížeče.
3. Místo `/guilds/{id}/roles` volat `GET /guilds/{guild.id}/members/{user.id}` s bot tokenem
   a číst `roles` z odpovědi — to jsou role, které má _daný uživatel_.
   Dokumentační odkazy:
   - OAuth2 scope reference: <https://discord.com/developers/docs/resources/user#get-current-user-guilds>
   - Guild member resource: <https://discord.com/developers/docs/resources/guild#get-guild-member>
   - Authorization code flow: <https://discord.com/developers/docs/topics/oauth2#authorization-code-grant>
   - Uložení session / refresh tokenů: <https://discord.com/developers/docs/topics/oauth2#authorization-code-grant-refresh-token-examples>

Tenhle krok je schválně _mimo_ fázi 1: ACL pracuje výhradně s `discord_roles.id`, takže změna
mechanizmu, který role vyrobil, se do dotazů `accessible_*` nepropíše ani o řádek.

## 5. Ověření, že OAuth funguje

Testy na síť nikdy nesahají (`ralph/PLAN.md` §6) — `DiscordIdentityProvider` má vstrčitelného
`fetchImpl` typu `FetchLike`, takže výměnu kódu i `users/@me` testuje mocked fetch. Reálný flow ověřit ručně:

```bash
npm run dev:api        # terminal 1
npm run dev:web        # terminal 2  (nebo npm run build a jeden server na :3000)
```

Otevřít `http://localhost:5173` → tlačítko Discord → souhlas → prohlížeč se vrací na
`http://localhost:5173/` **bez** `#token=` v URL a ve status baru je jméno + Discord role.
Pak `GET /api/permissions/effective` s vydaným tokenem musí ukázat grants se zdrojem
(`z role …`, `zděděno z role — … přes …`).

Nejčastější příznaky:

| příznak                                 | příčina                                               |
| --------------------------------------- | ----------------------------------------------------- |
| `OAuth2 redirect URI is invalid`        | redirect v portalu nesebsedá s `DISCORD_REDIRECT_URI` |
| prázdná stránka po návratu, token v URL | `FRONTEND_ORIGIN` nesedí s originem, kde SPA běží     |
| `Přihlášení … se nepodařilo vytvořit`   | code byl použit dvakrát (jsou jednorázové, ~10 min)   |
| přihlášení proběhlo, role žádné         | bot není na serveru / chybí `guilds.members.read`     |

## 6. Vědomě odloženo

- **httpOnly cookie relace + CSRF token** místo JWT v `localStorage`. Umožňuje to revokaci, ale
  mění i CORS a every-request authentication; patří k nasazení, ne k fázi 1.
- **Logout na serveru** — JWT je stávající do TTL; bez session tabulky neexistuje co zrušit.
- **Refresh tokeny** —Discord je vydává; zatím prostě vyprší relace a SPA hodí znovu na login.
- **Limitace podle guildu** — ACL nekontroluje, že role patří _našemu_ serveru.
