# Family Meal Planner

A browser app for a South Indian family with an 8-month-old and a 4-year-old who goes to school.

- **Calendar**: plan each day's meals (baby, school lunchbox, family dinner) and schedule, then **approve** the day. Each date shows whether it is approved, waiting for approval, or has nothing planned, plus a count of what is still pending (unapproved plan, reminders not done, items not packed). Editing an approved day sends it back to "waiting for approval".
- **Recipes**: list what's in the kitchen and get recipes made from it. With the AI on, Claude writes the recipes; every recipe is then checked in code for age safety (no honey, salt, sugar or whole nuts for the baby, soft textures only, nut-free school lunchboxes). Recipes that fail are dropped. Saved recipes work offline.
- **Shopping**: one list, grouped by aisle, with store filters and a big-checkbox "I'm at the store" mode. Pull missing ingredients from the next 7 days of meals; quantities merge (500 g + 1 kg toor dal = 1.5 kg) and Indian names match (sooji = rava, tuvar = toor).
- **To bring**: school bag on school days, diaper bag when the baby goes out, plus one-off items per date.
- **Reminders**: school events, vaccines, birthdays, with repeats, a "missed" list, and alerts while the app is open.

All data lives in the browser (localStorage). There is a backup download and restore.

## Run it

```bash
cd meal-planner
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start      # AI recipes on, http://localhost:3000
npm run start:mock                          # no key needed: AI answers come from the built-in recipe book
npm test                                    # unit tests (node:test)
```

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `AI_MODE` | `live` if `ANTHROPIC_API_KEY` is set, else `off` | `live` calls Claude, `mock` returns built-in recipes with no network, `off` makes `/api/recipes` answer 503 |
| `ANTHROPIC_API_KEY` | | Claude API key (server side only, never sent to the browser) |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used for recipes |
| `AI_TIMEOUT_MS` | `60000` | Server-side timeout for the AI call |
| `PORT` | `3000` | |

### When the AI or the server is down

The app never depends on the AI. If `/api/recipes` fails, times out (60 s, with a Cancel button), or the server can't be reached at all (for example when the `public/` folder is opened from GitHub Pages), the Recipes tab shows the best matches from the built-in recipe book and says why. The calendar, shopping list, bring list and reminders are fully local and keep working offline.

## For testers

- `?today=YYYY-MM-DD` in the URL pins "today", e.g. `http://localhost:3000/?today=2026-10-22`.
- Key elements carry `data-testid` attributes (`approve-day`, `day-status` with `data-status`, `cal-day-YYYY-MM-DD` with `data-status` and `data-pending`, `generate-recipes`, `recipe-card` with `data-safe`, `shop-item`, `store-mode`, `bring-item`, `rem-add`, …).
- `window.__mealPlanner` exposes the live state in the browser console.
- Pure logic is in `public/shared/` and can be unit tested directly:
  - `safety.js`: `checkRecipe(recipe, { age: "baby" | "kid", lunchbox })`, `checkForAudience(recipe)`
  - `plan.js`: `pendingFor(state, date, today)`, `dayStatus`, `approveDay`, `markEdited`
  - `shopping.js`: `mergeItems`, `normName`, `aisleFor`, `missingFromPantry`
  - `dates.js`: local date keys (no UTC conversions), `monthGrid`, `occurrences`
- API: `GET /api/health` → `{ ok, ai, model }`; `POST /api/recipes` with `{ ingredients: string[], forWhom: "baby"|"kid"|"family"|"both", mealType, notes, count }` → `{ recipes, rejected, mode, ms }`, or 503 `{ error }` when the AI is unavailable.

## Layout

```
meal-planner/
  server.js           static files + /api routes (Node, no framework)
  lib/ai.js           Claude call with structured output, mock/off modes, safety screening
  public/             the browser app (plain ES modules, no build step)
    app.js            UI
    store.js          localStorage persistence
    shared/           pure logic shared by server, browser and tests
  tests/              node:test unit tests
```
