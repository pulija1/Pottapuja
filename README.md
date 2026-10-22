# Family Meal Planner

A browser app for a South Indian family with an 8-month-old and a 4-year-old who goes to school.

- **Calendar**: tap a date to see its meals in collapsible sections for the 4-year-old, the 8-month-old and the family, plus the day's schedule and to-dos. Each empty day shows **suggested meals** picked from what is in the kitchen (safety-checked for each child); shuffle or swap them, then **Approve these meals** to put them into that day's plan and approve it. Each date shows whether it is approved, waiting for approval, or has nothing planned, plus a count of what is still pending (unapproved plan, reminders not done, to-dos not ticked). Editing an approved day sends it back to "waiting for approval".
- **Recipes**: list what's in the kitchen and get recipes made from it. With the AI on, Claude writes the recipes; every recipe is then checked in code for age safety (no honey, salt, sugar or whole nuts for the baby, soft textures only, nut-free school lunchboxes). Recipes that fail are dropped. Saved recipes work offline.
- **Shopping**: one list, grouped by aisle, with store filters and a big-checkbox "I'm at the store" mode. Ticking an item as bought adds it to the kitchen, so the next suggestions use it. Pull missing ingredients from the next 7 days of meals; quantities merge (500 g + 1 kg toor dal = 1.5 kg) and Indian names match (sooji = rava, tuvar = toor).
- **To do**: things to do for the kids (buy dresses, check the school schedule, doctor's appointment), defaulting to tomorrow, with one-tap ideas, a "not done yet" list and the coming week.
- **Reminders**: school events, vaccines, birthdays, with repeats, a "missed" list, and alerts while the app is open.

All data lives in the browser (localStorage). There is a backup download and restore.

### Sign in and Check in (GitHub)

On first launch the app offers a sign-in page (skipped automatically when GitHub can't be reached, or with "Use on this device only"). Signing in takes a private GitHub repository (`owner/name`) and a fine-grained token limited to that repository with **Contents: Read and write**; GitHub doesn't allow apps to sign in with a password. The token stays in that browser only.

- **⬆ Check in** (top right) commits everything to `output/` in the private repository as readable Markdown: `meal-plan.md`, `shopping-list.md`, `todo.md`, `reminders.md`, `kitchen.md`, `recipes.md` and `README.md`, plus a session log in `output/sessions/` with what changed since the last check-in. A dot on the button means there are changes not checked in yet.
- **⬇ Load latest** (profile menu) reads those Markdown files back. The exact data sits in an HTML comment at the end of each file, so the readable part can be edited without breaking anything.
- If another device checked in since this one last synced, Check in asks whether to load theirs or keep yours instead of overwriting.
- Public repositories are refused, so the family's data can't end up readable by everyone.

### AI recipes on GitHub Pages (your own Claude API key)

GitHub Pages has no server, so the site can't hold an API key. Instead, tap the AI chip or 👤 → **Claude API key**, and paste a key from [console.anthropic.com](https://console.anthropic.com) → API Keys. The key is kept only in that browser (never in check-ins or backups), and the browser calls Claude directly with the same prompt, answer schema and age-safety screening as the server (`public/shared/ai-prompt.js`). Set a monthly spend limit in the Console. When the site has its own AI server, that is used first.

## Run it

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start      # AI recipes on, http://localhost:3000
npm run start:mock                          # no key needed: AI answers come from the built-in recipe book
npm test                                    # unit and API tests (node:test)
npm run test:e2e                            # browser tests (Playwright, Chromium)
```

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `AI_MODE` | `live` if `ANTHROPIC_API_KEY` is set, else `off` | `live` calls Claude, `mock` returns built-in recipes with no network, `off` makes `/api/recipes` answer 503 |
| `ANTHROPIC_API_KEY` | | Claude API key (server side only, never sent to the browser) |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used for recipes |
| `AI_TIMEOUT_MS` | `40000` | Server-side timeout for the AI call |
| `PORT` | `3000` | |

### When the AI or the server is down

The app never depends on the AI. If `/api/recipes` fails, times out (50 s in the browser and 40 s on the server, with a Cancel button), or the server can't be reached at all (for example when the `public/` folder is opened from GitHub Pages), the Recipes tab shows the best matches from the built-in recipe book and says why. The calendar, shopping list, to-dos and reminders are fully local and keep working offline.

## For testers

- `?today=YYYY-MM-DD` in the URL pins "today", e.g. `http://localhost:3000/?today=2026-10-22`.
- Key elements carry `data-testid` attributes (`approve-day`, `day-status` with `data-status`, `cal-day-YYYY-MM-DD` with `data-status` and `data-pending`, `generate-recipes`, `recipe-card` with `data-safe`, `shop-item`, `store-mode`, `todo-item`, `meal-group-kid`, `day-suggestions`, `suggest-approve`, `rem-add`, …).
- `window.__mealPlanner` exposes the live state in the browser console.
- Pure logic is in `public/shared/` and can be unit tested directly:
  - `safety.js`: `checkRecipe(recipe, { age: "baby" | "kid", lunchbox })`, `checkForAudience(recipe)`
  - `plan.js`: `pendingFor(state, date, today)`, `dayStatus`, `approveDay`, `markEdited`
  - `shopping.js`: `mergeItems`, `normName`, `aisleFor`, `missingFromPantry`
  - `dates.js`: local date keys (no UTC conversions), `monthGrid`, `occurrences`
- API: `GET /api/health` → `{ ok, ai, model }`; `POST /api/recipes` with `{ ingredients: string[], forWhom: "baby"|"kid"|"family"|"both", mealType, notes, count }` → `{ recipes, rejected, mode, ms }`, or 503 `{ error }` when the AI is unavailable.

## Layout

```
./
  server.js           static files + /api routes (Node, no framework)
  lib/ai.js           Claude call with structured output, mock/off modes, safety screening
  public/             the browser app (plain ES modules, no build step)
    app.js            UI
    store.js          localStorage persistence
    shared/           pure logic shared by server, browser and tests
      dataset.js      generated from the grocery/recipe research dataset (83 items with regional names, 20 recipes)
  scripts/import-dataset.mjs   regenerate dataset.js: node scripts/import-dataset.mjs path/to/indian-groceries-recipes.json
  tests/              node:test unit tests
```
