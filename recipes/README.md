# Family recipe book

All the recipes the meal planner suggests live in these Markdown files. They read fine on GitHub, on a phone, or printed, with no app and no AI. The app reads the same files, so a recipe added or fixed here shows up in the app after the next deploy.

| File | What's in it |
|---|---|
| [kid-4-years.md](kid-4-years.md) | The 4-year-old: an egg breakfast for every day, school lunchboxes, and milk and nut snacks |
| [baby-8-months.md](baby-8-months.md) | The 8-month-old: purees, porridges, mashes and soft finger food |
| [family-dinners.md](family-dinners.md) | One-pot family dinners, each with a step to take out the baby's and the 4-year-old's portions |
| [telugu-curries.md](telugu-curries.md) | Telugu pappu, kura, vepudu, pulusu and charu by their Telugu names, each with a baby portion step |
| [leftover-makeovers.md](leftover-makeovers.md) | Yesterday's curry made into something new: roti quesadillas, kathi rolls, kari dosai, tacos, plus curries worth cooking double |

Cuisines: Telugu, South Indian, North Indian, Indian American, Mexican and Mexican American, Tex-Mex, American, Italian, Middle Eastern and Mediterranean, Japanese, Korean and Chinese.

## A week for the 4-year-old

The daily goal is **one egg, one milk or dairy food, and some nuts**. In the app, each day on the calendar shows three chips (🥚 Egg, 🥛 Milk/dairy, 🥜 Nuts) that turn green as meals are planned, and the suggestions lean toward an egg at breakfast, dairy in the lunchbox and nuts in the snack. Here is one week that covers all three every day:

| Day | Breakfast (🥚) | Lunchbox (🥛) | Snack (🥜) |
|---|---|---|---|
| Monday | [Masala egg bhurji with buttered toast fingers](kid-4-years.md#masala-egg-bhurji-with-buttered-toast-fingers) | [Rajma rice with cucumber raita](kid-4-years.md#rajma-rice-with-cucumber-raita) | [Apple slices with peanut butter dip](kid-4-years.md#apple-slices-with-peanut-butter-dip) |
| Tuesday | [Huevos rancheros soft tacos (mild)](kid-4-years.md#huevos-rancheros-soft-tacos-mild) | [Palak paneer pinwheels](kid-4-years.md#palak-paneer-pinwheels) | [Kesar badam milk](kid-4-years.md#kesar-badam-milk) |
| Wednesday | [Boiled egg podi bites](kid-4-years.md#boiled-egg-podi-bites) | [Bean and cheese burrito pinwheels](kid-4-years.md#bean-and-cheese-burrito-pinwheels) | [Date and dry fruit ladoo (no sugar)](kid-4-years.md#date-and-dry-fruit-ladoo-no-sugar) |
| Thursday | [French toast sticks with cardamom and almond powder](kid-4-years.md#french-toast-sticks-with-cardamom-and-almond-powder) | [Makhani pasta (butter masala pasta)](kid-4-years.md#makhani-pasta-butter-masala-pasta) | [Ragi malt with almond powder](kid-4-years.md#ragi-malt-with-almond-powder) |
| Friday | [Egg rava upma](kid-4-years.md#egg-rava-upma) | [Black bean and corn cheese quesadilla with guacamole](kid-4-years.md#black-bean-and-corn-cheese-quesadilla-with-guacamole) | [Yogurt parfait with granola and chopped almonds](kid-4-years.md#yogurt-parfait-with-granola-and-chopped-almonds) |
| Saturday | [Banana oat egg pancakes with peanut butter](kid-4-years.md#banana-oat-egg-pancakes-with-peanut-butter) | [Mac and cheese with peas and broccoli](kid-4-years.md#mac-and-cheese-with-peas-and-broccoli) | [Mango lassi](kid-4-years.md#mango-lassi) |
| Sunday | [Mild shakshuka with pita and feta](kid-4-years.md#mild-shakshuka-with-pita-and-feta) | [Korean gyeran-bap egg rice bowl](kid-4-years.md#korean-gyeran-bap-egg-rice-bowl) | [Banana muffins with chopped walnuts](kid-4-years.md#banana-muffins-with-chopped-walnuts) |

Swap any recipe for another one from the same section. Search the file for 🥚, 🥛 or 🥜 to find more.

## How the app uses this book

- **Cook by vegetable:** tap one or more vegetables (by their Telugu names) on the Recipes tab and see the family fries and curries made with them, the ones with all the picked vegetables first. ⚡ keeps it to recipes ready in 20 minutes; [telugu-curries.md](telugu-curries.md) has a quick fry and a quick curry for each Telugu vegetable.
- **Ready to cook:** the Recipes tab lists recipes whose ingredients are all in the kitchen list, and the ones that need just one more thing. Water, salt, oil, turmeric and anything used by the pinch don't count.
- **Suggested meals:** empty days on the calendar get suggestions picked from this book, best match to the kitchen first, and checked for each child's safety. The cuisines picked in 👤 Profile (Telugu, Tamil, North Indian, Mexican) come first; "South Indian" counts as Telugu and Tamil.
- **Top picks:** the Recipes tab shows the five easiest recipes that use the vegetables in the kitchen, from the picked cuisines.
- **Leftovers:** when the day before had a curry for the family dinner, one suggestion is a makeover from [leftover-makeovers.md](leftover-makeovers.md), like a roti chicken curry quesadilla for the lunchbox.
- **Shopping:** a planned recipe's missing ingredients go to the shopping list with their quantities.
- **AI recipes** (when the server has an API key) are extra. The book works without the AI, including on GitHub Pages where there is no server.

## Adding or changing a recipe

Copy an existing recipe and change it. The format:

```markdown
### Egg and cheese quesadilla

- **For:** kid
- **Meal:** breakfast
- **Cuisine:** Mexican American
- **Time:** 10 min
- **Good for:** 🥚 Egg · 🥛 Milk/dairy

**Ingredients**

- 1 flour tortilla
- 1 egg, scrambled
- 2 tbsp cheddar cheese, grated
- Salt, to taste

**Steps**

1. Scramble the egg until fully cooked.
2. Fill half the tortilla with egg and cheese, fold, and toast until golden.

**Notes:** Anything you want to remember.
```

- `###` starts a recipe; the title is the recipe's name. `##` headings only group recipes and can be anything.
- **For** is `baby`, `kid` or `family`. **Meal** is `breakfast`, `lunchbox`, `lunch`, `snack` or `dinner`. Both are required.
- Optional lines: **Dish** (`fry` or `curry`: the **Cook by vegetable** card lists the recipe under that heading; without it the title decides, so "vepudu" or "fry" is a fry and "kura", "pulusu" or "pappu" a curry), **Cuisine** (two can be named for fusion, like `Telugu / Mexican fusion`), **Leftover** (what yesterday's dish it uses: `chicken curry`, `paneer curry`, `beans curry`, `vegetable curry`, `dal`, `sambar` or `any curry`), **Time**, **Texture** (baby: `puree`, `mashed`, `porridge`, `soft finger food`), **Nut-free swap** (what to do if the school goes nut-free), **Family favorite:** yes, and **ID** (only for older recipes, so plans that already use them keep working).
- **Good for** is for people reading the file. The app works out egg, milk/dairy and nuts from the ingredients by itself.
- Each ingredient is one line: amount, unit, name, then a comma and any note. `1½ cups rice, washed`, `2 tbsp almond powder`, `6 curry leaves`, `Salt, to taste`. Units the app understands: g, kg, ml, l, tsp, tbsp, cup, pinch, slice, clove, sprig, handful, inch, bunch, can, packet, dozen. Keep the name the way you'd write it on a shopping list (`paneer`, `cheddar cheese`, `black beans`) so it matches the kitchen list.
- Steps are a numbered list.
- If a recipe can't be read (no **For**, no ingredients or no steps), the app skips it and says which file and line on the Recipes tab.

### Safety rules the app checks

Every recipe is checked when the app loads it, and the tests in `tests/recipe-book.test.js` fail if a recipe in this book breaks a rule:

- **Baby:** no honey, no added salt or sugar (or jaggery), no whole or chopped nuts (fine powder or a thin nut butter only), eggs fully cooked, nothing hard or round (whole grapes, raw carrot sticks, whole peas). Write "no salt" or "unsalted" where it matters; the checker understands that.
- **4-year-old:** nuts chopped, slivered, powdered or as a butter, never whole. Grapes and cherry tomatoes cut lengthwise. No caffeine.
- **School nut-free** (a setting in the app, off by default): lunchbox and snack recipes with nuts are hidden or swapped.

General guidance only, not medical advice. Check new foods and allergies with your paediatrician.

## Adding a new file

Add the file here, then add its name to `RECIPE_FILES` in `public/shared/recipe-book.js` so the app loads it.
