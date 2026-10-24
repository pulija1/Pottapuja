# Family Meal Planner

A browser app for a South Indian family with an 8-month-old and a 4-year-old who goes to school.

The recipes live in plain Markdown in [`recipes/`](recipes/README.md), readable on GitHub without the app or AI: 120+ recipes across South and North Indian, Indian American, Mexican American, American and other cuisines, with an egg breakfast for every day plus milk and nut options for the 4-year-old, and baby-safe purees and mashes.

- **Calendar**: tap a date to see its meals in collapsible sections for the 4-year-old, the 8-month-old and the family, plus the day's schedule and to-dos. Three chips show whether the 4-year-old's day has an **egg**, a **milk/dairy** food and **nuts**, filled in from the planned meals. Each empty day shows **suggested meals** picked from the recipe book by what is in the kitchen (safety-checked for each child, and steered toward an egg at breakfast, dairy in the lunchbox and nuts in the snack); shuffle or swap them, then **Approve these meals** to put them into that day's plan and approve it. Each date shows whether it is approved, waiting for approval, or has nothing planned, plus a count of what is still pending (unapproved plan, reminders not done, to-dos not ticked). Editing an approved day sends it back to "waiting for approval".
- **Recipes**: list what's in the kitchen and see **Ready to cook**: recipe-book recipes you can make right now, and the ones just one item short. You can also get recipes made from it. With the AI on, Claude writes the recipes; every recipe is then checked in code for age safety (no honey, salt, sugar or whole nuts for the baby, soft textures only, nut-free school lunchboxes). Recipes that fail are dropped. Saved recipes work offline.
- **Shopping**: one list, grouped by aisle with big icons and store filters. Every row is a large touch target: tap it (or swipe it right) when it's in the cart and it slides into a collapsed **In the cart** section; swipe left to delete. Both show an **Undo** toast. **+ Add item** opens a sheet from the bottom with one-tap staples, a − / + quantity stepper and unit and store chips; **⋯** on a row opens its details to edit. **I'm at the store** goes full screen with bigger rows, keeps the phone screen on and ends with **Done shopping**. Ticking an item as bought adds it to the kitchen, so the next suggestions use it. Pull missing ingredients from the next 7 days of meals; quantities merge (500 g + 1 kg toor dal = 1.5 kg) and Indian names match (sooji = rava, tuvar = toor).
- **To do**: things to do or bring for the kids (pack the school bag, buy dresses, doctor's appointment), defaulting to tomorrow, with one-tap ideas, a "not done yet" list and the coming week. Rows work like the shopping list: tap or swipe right to tick, swipe left to delete, **⋯** to edit, and **+ Add to do** opens a bottom sheet.
- **Reminders**: school events, vaccines, birthdays, with repeats, a "missed" list, and alerts while the app is open.

All data lives in the browser (localStorage), with a backup download and restore. If saving fails (storage full or blocked) a warning stays at the top until it works again, and a change made in another tab of the app is picked up instead of being overwritten. With family sync on, it is also kept in Firebase so every phone in the family sees the same data.

### Family sync (Firebase)

Sign in with Google, start a family space, and add the rest of the family by their Google email; their phone shows who started the space and asks before joining. Every change saves on its own and shows on the other phones within seconds; with no signal the app works from the phone's copy and catches up later. Each write is a Firestore transaction that merges this phone's edit into the cloud's current value, so two phones changing the same list, day or item at once both keep their changes. Only people listed in the family space can read or change its data (see `firestore.rules`). The first time a phone signs in, its own data is added to the family's: nothing is thrown away. **Export backup** downloads a copy at any time. (This replaces the earlier GitHub check-in.)

Setup (once, free): [docs/firebase-setup.md](docs/firebase-setup.md). Until `public/firebase-config.js` has a project in it, the app works on one device as before.

- `public/cloud.js`: Google sign-in, the family space, and the Firestore listener and writes.
- `public/shared/cloud-sync.js`: how the data is split into documents (a field per item) and the merge: inside objects key by key, lists of items by id, the kitchen and store lists as sets.
- `npm run test:firebase`: rules tests and two-phone sync tests against the Firebase emulator (Java 21).

### AI recipes on GitHub Pages (your own Claude API key)

GitHub Pages has no server, so the site can't hold an API key. Instead, tap the AI chip or 👤 → **Claude API key**, and paste a key from [console.anthropic.com](https://console.anthropic.com) → API Keys. The key is kept only in that browser (never synced to the family or put in backups), and the browser calls Claude directly with the same prompt, answer schema and age-safety screening as the server (`public/shared/ai-prompt.js`). Set a monthly spend limit in the Console. When the site has its own AI server, that is used first.

## Run it

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start      # AI recipes on, http://localhost:3000
npm run start:mock                          # no key needed: AI answers come from the recipe book in recipes/
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
| `AI_PER_MINUTE` | `10` | Live AI requests allowed per visitor (IP address) per minute; more get 429 and the app falls back to the recipe book |
| `PORT` | `3000` | |

### When the AI or the server is down

The app never depends on the AI. If `/api/recipes` fails, times out (50 s in the browser and 40 s on the server, with a Cancel button), or the server can't be reached at all (for example when the `public/` folder is opened from GitHub Pages), the Recipes tab shows the best matches from the recipe book (`recipes/*.md`) and says why. The calendar, shopping list, to-dos and reminders are fully local and keep working offline.

## For testers

- `?today=YYYY-MM-DD` in the URL pins "today", e.g. `http://localhost:3000/?today=2026-10-22`.
- Key elements carry `data-testid` attributes (`approve-day`, `day-status` with `data-status`, `cal-day-YYYY-MM-DD` with `data-status` and `data-pending`, `generate-recipes`, `recipe-card` with `data-safe`, `shop-item`, `shop-fab`, `shop-more`, `shop-cart`, `store-mode`, `todo-item`, `todo-fab`, `toast-undo`, `meal-group-kid`, `day-suggestions`, `suggest-approve`, `rem-add`, …).
- `window.__mealPlanner` exposes the live state in the browser console.
- The recipe book can be checked with `npm test`: every recipe in `recipes/*.md` must parse and pass the age-safety rules (`tests/recipe-book.test.js`).
- Pure logic is in `public/shared/` and can be unit tested directly:
  - `safety.js`: `checkRecipe(recipe, { age: "baby" | "kid", lunchbox })`, `checkForAudience(recipe)`
  - `plan.js`: `pendingFor(state, date, today)`, `dayStatus`, `approveDay`, `markEdited`
  - `shopping.js`: `mergeItems`, `normName`, `aisleFor`, `missingFromPantry`
  - `dates.js`: local date keys (no UTC conversions), `monthGrid`, `occurrences`
  - `recipe-book.js`: `parseRecipeMarkdown(markdown, file)`, `parseIngredient(line)`, `nutritionTags(recipe)`
  - `recipes.js`: `LIBRARY` (loaded from `recipes/*.md`), `readyToCook(pantry, { maxMissing })`, `suggestFromLibrary`
- API: `GET /api/health` → `{ ok, ai, model }`; `POST /api/recipes` with `{ ingredients: string[], forWhom: "baby"|"kid"|"family"|"both", mealType, notes, count }` → `{ recipes, rejected, mode, ms }`, or 503 `{ error }` when the AI is unavailable.

## Layout

```
./
  recipes/            the family recipe book, plain Markdown (see recipes/README.md)
  server.js           static files + /api routes (Node, no framework); serves recipes/ at /recipes/
  lib/ai.js           Claude call with structured output, mock/off modes, safety screening
  public/             the browser app (plain ES modules, no build step)
    app.js            UI
    store.js          localStorage persistence
    shared/           pure logic shared by server, browser and tests
      recipe-book.js  reads the Markdown recipe book
      recipes.js      loads the book (from disk in Node, over HTTP in the browser) and matches it to the pantry
      dataset.js      grocery items with regional names, generated from the research dataset
  scripts/import-dataset.mjs   regenerate dataset.js: node scripts/import-dataset.mjs path/to/indian-groceries-recipes.json
  tests/              node:test unit tests
```
