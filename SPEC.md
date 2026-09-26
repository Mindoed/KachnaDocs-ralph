# KachnaDocs Specifikace

Jendá se o webovou aplikaci, která kombinuje několik typů systémů:
interní znalostní bázi, CMS s verzováním, Google-Docs-like collaborative editor, Discord identity provider, jemnozrnný autorizační systém, fulltextové vyhledávání, úkoly/checklisty a self-hosted RAG/AI systém.

## Technický stack je následující:
- Prog. Jazyk:	Typescript
- BE Framework:	NestJS
- FE Framework:	Vue
- Databáze:	PostgreSQL/pgvector
- Ostatní použitelné techniky/knihovny:
    - Yjs Docs ... kolaborační editace (podporuje jen některé editory)
	- Tiptap editor ... OS .md editor
	- Swagger.io ... vytváření API + její dokumentace
	- Bruno ... testování API

## Uživatelské rozhraní:
UI je dost obdobné od Visual Studio Code a Obsidianu. Vyskytuje se zde v levo ribbon kterým je možne otevřít okna/sidebar **pohledů**. Každý **pohled** je obsažen ve vlastním okně, či v nějakém ze dvou sidebarů (levý, pravý). Kde se daný modul vyskytuje nechám na tvém zvážení.

## Hlavní pohledy aplikace
### 1. CMS s verzováním dokumentů

#### Účel
Pohled slouží ke správě dokumentace, její struktury, publikování a historie změn.

#### Funkce
- Zobrazit hierarchii dokumentace: skupiny, kategorie a dokumenty.
- Vytvářet, přejmenovávat, přesouvat, archivovat a mazat dokumenty.
- Rozlišovat mezi pracovní verzí dokumentu **Draft** a publikovanou verzí.
- Umožnit publikování aktuálního draftu.
- Při publikování vytvořit neměnnou verzi dokumentu.
- Zobrazit historii verzí včetně autora, času a případného komentáře ke změně.
- Umožnit otevřít starší verzi a porovnat ji s aktuální verzí.
- Umožnit obnovení starší verze jako nového draftu.
- Zobrazovat stav dokumentu: Draft / Published / Archived.
- Respektovat oprávnění uživatele pro čtení, editaci, publikování a správu dokumentu.

#### Očekávané chování
Běžný čtenář vidí pouze publikovanou verzi. Editor může pracovat s draftem bez ovlivnění publikované verze. Publikování vytvoří novou položku v historii verzí a informuje ostatní klienty o změně.

---

### 2. Google-Docs-like Collaborative Editor

#### Účel
Pohled slouží k vytváření a úpravě dokumentů více uživateli současně v reálném čase.

#### Funkce
- WYSIWYG editor dokumentů.
- Podpora nadpisů, odstavců, seznamů, odkazů, tabulek, obrázků, kódu a checklistů.
- Automatické ukládání změn.
- Realtime synchronizace změn mezi připojenými uživateli.
- Zobrazit aktuálně připojené spolupracovníky.
- Zobrazit kurzor nebo výběr ostatních uživatelů.
- Každému nadpisu přidělit stabilní ID pro vytvoření přímého odkazu.
- Umožnit kopírování odkazu na konkrétní část dokumentu.
- Umožnit zobrazování textu obsažen v jiném nadpisu i v nadpisu v jiném dokumentu.
- Podporovat interní odkazy mezi dokumenty.
- Zobrazit stav ukládání, například `Ukládání… / Uloženo`.
- Umožnit přechod mezi editací a náhledem dokumentu.
- Respektovat oprávnění `READ` a `WRITE`.

#### Očekávané chování
Změna provedená jedním uživatelem se bez obnovení stránky zobrazí ostatním uživatelům. Současné změny nesmí přepisovat práci ostatních. Editor pracuje s draftem dokumentu a změny se zveřejní až explicitním publikováním.

---

### 3. Jemnozrnný autorizační systém

#### Účel
Pohled slouží ke správě toho, kdo může jednotlivé části KachnaDocs vidět, upravovat nebo spravovat.

#### Funkce
- Nastavit oprávnění pro uživatele a Discord role.
- Nastavit oprávnění na úrovni skupiny a dokumentu.
- Podporovat minimálně oprávnění:
  - `READ`
  - `WRITE`
  - `MANAGE`
- Zobrazit efektivní oprávnění konkrétního uživatele.
- Umožnit dědění oprávnění ze skupiny na dokument.
- Umožnit přepsání zděděného oprávnění na úrovni dokumentu.
- Vyhledat a přidat práva konkrétnímu uživateli nebo Discord roli.
- Zobrazit zdroj oprávnění, například `zděděno z HR` nebo `přiděleno přímo`.
- Synchronizovat Discord role uživatelů.
- Zabránit přístupu k obsahu bez potřebného oprávnění.
- Preferovat vázat vlastníky dokumentu jako discord roli.

#### Očekávané chování
Autorizace musí být vždy kontrolována backendem. Skrytí prvku v UI není považováno za zabezpečení. Uživatel bez `READ` nesmí získat obsah dokumentu přes API, vyhledávání, WebSocket ani AI chatbot.

---

### 4. Úkoly a checklisty

#### Účel
Pohled slouží ke správě jednoduchých úkolů, postupů a společných checklistů spojených s činností organizace.

#### Funkce
- Vytvářet checklisty.
- Přidávat, upravovat, řadit a mazat položky.
- Označit položku jako dokončenou nebo nedokončenou.
- Přiřadit úkol konkrétnímu uživateli.
- Volitelně nastavit termín dokončení s možností bez termínu dokončení.
- Umožnit checklist opakovat, či resetovat jeho stav dokončení.
- Zobrazit stav checklistu a procento dokončení.
- Zobrazit autora změny a čas poslední úpravy.
- Synchronizovat změny checklistu mezi uživateli v reálném čase.
- Umožnit vytvoření checklistu z jednoduchého textového formátu.
- Umožnit propojení checklistu s dokumentem.
- Filtrovat úkoly podle uživatele, stavu a termínu.
- Respektovat oprávnění skupiny nebo dokumentu.

#### Očekávané chování
Pokud jeden uživatel označí úkol jako dokončený, změna se okamžitě zobrazí ostatním. Uživatel musí být schopen rychle zjistit, co je hotové, co zbývá a kdo je za úkol odpovědný.

---

### 5. AI Chatbot

#### Účel
Pohled umožňuje uživateli získávat odpovědi na otázky nad dokumentací KachnaDocs pomocí přirozeného jazyka.

#### Funkce
- Textový chat s historií zpráv.
- Uživatel může položit otázku nad dostupnou dokumentací.
- Chatbot vyhledá relevantní části dokumentů pomocí RAG.
- Do kontextu AI se smějí dostat pouze dokumenty, ke kterým má aktuální uživatel `READ` oprávnění.
- Odpověď musí být založena primárně na obsahu KachnaDocs.
- U odpovědi zobrazit použité zdroje.
- Zdroj musí obsahovat odkaz přímo na dokument nebo konkrétní nadpis.
- Kliknutí na zdroj otevře odpovídající část dokumentu.
- Pokud dokumentace odpověď neobsahuje, chatbot to musí přiznat místo vymýšlení informace.
- Podporovat navazující otázky v rámci konverzace.
- Pravidla chování chatbota načítat z konfiguračního Markdown souboru.
- AI nesmí obejít autorizační systém.

#### Očekávané chování
Tok dotazu:

`Uživatel → autorizace → vyhledání pouze povoleného obsahu → RAG → LLM → odpověď + citované zdroje`

Chatbot nesmí uživateli ani nepřímo potvrdit existenci dokumentu, ke kterému nemá oprávnění.