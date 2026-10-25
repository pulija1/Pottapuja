// Estimated nutrition for a recipe, worked out from its ingredient list. Each food below has
// rough values per 100 g (USDA FoodData Central and the Indian Food Composition Tables, rounded)
// and the weight of a cup and of one piece, so "1½ cups rice" or "2 eggs" can be turned into grams.
// These are estimates for planning, not lab values. Pure functions, no I/O here.

// Per 100 g: kcal, protein g, carbs g, fiber g, fat g, iron mg, calcium mg.
export const NUTRIENTS = [
  { key: "kcal", label: "Calories", unit: "kcal" },
  { key: "protein", label: "Protein", unit: "g" },
  { key: "carbs", label: "Carbs", unit: "g" },
  { key: "fiber", label: "Fiber", unit: "g" },
  { key: "fat", label: "Fat", unit: "g" },
  { key: "iron", label: "Iron", unit: "mg" },
  { key: "calcium", label: "Calcium", unit: "mg" },
];

// What a child needs in a day (US Dietary Reference Intakes): 7 to 12 months, and 4 to 8 years.
// Calories are a typical amount for the age. A baby still gets much of this from breast milk or formula.
export const DAILY_NEEDS = {
  baby: { label: "8-month-old", kcal: 700, protein: 11, carbs: 95, fat: 30, iron: 11, calcium: 260 },
  kid: { label: "4-year-old", kcal: 1400, protein: 19, carbs: 130, fiber: 25, iron: 10, calcium: 1000 },
};

// [match, [kcal, protein, carbs, fiber, fat, iron, calcium], grams for { cup, pc, slice, bunch }].
// The first match wins, so specific names come before general ones ("coconut milk" before "milk").
// A match is a regex on the ingredient name; `note` also checks the ingredient's note.
const F = (re, v, w = {}, note) => ({ re, v, w, note });
const SPICE = [325, 12, 55, 25, 12, 20, 400];
const OIL = [884, 0, 0, 0, 100, 0, 0];
const FOODS = [
  // Water, salt and things used by the drop or for colour add nothing worth counting.
  F(/\b(water|salt|baking (powder|soda)|vanilla|saffron|orange zest|curry leaves)\b/, [0, 0, 0, 0, 0, 0, 0]),

  // Spice mixes, before "chana" in "chana masala powder" is read as chickpeas.
  F(/\bmasala\b|(sambar|rasam|kuzhambu|curry) powder/, SPICE, { cup: 120 }),

  // Milks and creams that are not dairy, then nut butters, before milk and butter.
  F(/coconut milk/, [197, 2, 2.8, 0, 21, 1.6, 18], { cup: 240 }),
  F(/peanut butter/, [590, 25, 20, 6, 50, 1.9, 49], { cup: 256 }),
  F(/peanut powder|peanuts?\b/, [567, 26, 16, 8.5, 49, 4.6, 92], { cup: 100 }),
  F(/almond/, [579, 21, 22, 12.5, 50, 3.7, 269], { cup: 100 }),
  F(/cashew/, [553, 18, 30, 3.3, 44, 6.7, 37], { cup: 110 }),
  F(/walnut/, [654, 15, 14, 6.7, 65, 2.9, 98], { cup: 100 }),
  F(/pistachio/, [560, 20, 28, 10, 45, 3.9, 105], { cup: 100 }),
  F(/tahini/, [595, 17, 21, 9.3, 54, 8.9, 426], { cup: 240 }),
  F(/sesame seeds?/, [573, 18, 23, 12, 50, 14.6, 975], { cup: 144 }),
  F(/flax/, [534, 18, 29, 27, 42, 5.7, 255], { cup: 112 }),
  F(/desiccated coconut/, [660, 6.9, 24, 16, 64, 3.3, 26], { cup: 80 }),
  F(/fresh coconut/, [354, 3.3, 15, 9, 33, 2.4, 14], { cup: 80, pc: 350 }),
  F(/coconut oil|sesame oil|olive oil|\boil\b/, OIL, { cup: 218 }),
  F(/coconut/, [354, 3.3, 15, 9, 33, 2.4, 14], { cup: 80 }),

  // Dairy and eggs.
  F(/\beggs?\b/, [143, 12.6, 0.7, 0, 9.5, 1.75, 56], { pc: 50 }),
  F(/ghee/, [900, 0, 0, 0, 100, 0, 0], { cup: 205 }),
  F(/butter\b/, [717, 0.9, 0.1, 0, 81, 0, 24], { cup: 227 }),
  F(/sour cream/, [198, 2.4, 4.6, 0, 19, 0.07, 101], { cup: 230 }),
  F(/cream/, [340, 2.8, 2.7, 0, 36, 0.03, 66], { cup: 238 }),
  F(/paneer/, [265, 18, 3.5, 0, 20, 0.2, 480], { cup: 130 }),
  F(/cheese slice/, [310, 16, 7, 0, 25, 0.4, 600], { slice: 20 }),
  F(/parmesan/, [392, 36, 3.2, 0, 26, 0.8, 1180], { cup: 100 }),
  F(/feta/, [264, 14, 4, 0, 21, 0.65, 493], { cup: 150 }),
  F(/queso fresco/, [300, 18, 3, 0, 24, 0.2, 566], { cup: 120 }),
  F(/cotija/, [366, 20, 3.5, 0, 30, 0.4, 800], { cup: 120 }),
  F(/mozzarella/, [300, 22, 2.2, 0, 22, 0.4, 505], { cup: 113 }),
  F(/cheddar|monterey|jack|cheese/, [400, 25, 1.3, 0, 33, 0.7, 720], { cup: 113, slice: 21 }),
  F(/curd|yogh?urt|dahi/, [61, 3.5, 4.7, 0, 3.3, 0.05, 121], { cup: 245 }),
  F(/\bmilk\b/, [61, 3.2, 4.8, 0, 3.3, 0.03, 113], { cup: 244 }),

  // Dals, beans and tofu. Dals are dry unless the note says cooked; beans are cooked unless it says soaked or dry.
  F(/\bdal\b|pappu/, [116, 7, 20, 4, 0.4, 1.5, 20], { cup: 200 }, /cooked/),
  F(/toor|kandi pappu|arhar/, [343, 22, 63, 15, 1.5, 5, 73], { cup: 200 }),
  F(/moong|pesara/, [348, 24, 60, 8, 1.2, 4, 75], { cup: 200 }),
  F(/masoor(?!i)/, [352, 25, 60, 11, 1.1, 7, 56], { cup: 190 }),
  F(/chana dal/, [360, 21, 60, 17, 5, 5, 56], { cup: 190 }),
  F(/urad/, [341, 25, 59, 18, 1.6, 7.6, 138], { cup: 200 }),
  F(/roasted gram|pottukadalai|putnalu/, [370, 22, 58, 17, 5, 5, 58], { cup: 150 }),
  F(/rajma|kidney beans/, [333, 24, 60, 25, 0.8, 8.2, 143], { cup: 185 }),
  F(/chickpeas?|chana|chole/, [364, 19, 61, 17, 6, 6.2, 105], { cup: 200 }, /soak|dry|dried/),
  F(/chickpeas?|chana|chole/, [164, 8.9, 27, 7.6, 2.6, 2.9, 49], { cup: 164 }),
  F(/black beans/, [132, 8.9, 23.7, 8.7, 0.5, 2.1, 27], { cup: 172 }),
  F(/pinto beans/, [143, 9, 26, 9, 0.65, 2.1, 46], { cup: 171 }),
  F(/hummus/, [166, 7.9, 14, 6, 9.6, 2.4, 38], { cup: 240 }),
  F(/silken tofu/, [55, 4.8, 2.9, 0.1, 2.7, 0.8, 30], { cup: 240 }),
  F(/tofu/, [144, 17, 3, 2, 9, 2.7, 350], { cup: 250 }),

  // Meat.
  F(/chicken breast/, [120, 22.5, 0, 0, 2.6, 0.4, 5]),
  F(/chicken/, [140, 20, 0, 0, 6.5, 0.8, 10]),

  // Grains, flours and breads (dry weight, unless the note says cooked).
  F(/poha|flattened rice|atukulu/, [350, 6.6, 77, 1.5, 1.2, 4, 20], { cup: 80 }),
  F(/rice flour/, [366, 6, 80, 2.4, 1.4, 0.35, 10], { cup: 160 }),
  F(/idli podi|gunpowder|podi/, [400, 18, 50, 12, 14, 7, 200], { cup: 140 }),
  F(/idli.*batter|dosa batter/, [140, 4.5, 29, 1.5, 0.5, 1, 15], { cup: 250 }),
  F(/idli/, [130, 4, 27, 1.5, 0.4, 0.8, 15], { pc: 10 }),
  F(/appam/, [180, 3, 35, 1, 3, 0.5, 10], { pc: 50 }),
  F(/ragi|finger millet|nachni/, [330, 7.3, 72, 11, 1.3, 3.9, 344], { cup: 120 }),
  F(/rava|sooji|semolina/, [360, 12.7, 73, 3.9, 1, 1.2, 17], { cup: 170 }),
  F(/vermicelli|semiya/, [350, 12, 75, 3, 1.5, 1.5, 20], { cup: 90 }),
  F(/oats/, [380, 13, 68, 10, 6.5, 4.3, 52], { cup: 80 }),
  F(/granola/, [470, 10, 64, 6, 20, 3, 60], { cup: 120 }),
  F(/atta|wheat flour/, [340, 13, 72, 11, 2.5, 3.6, 34], { cup: 120 }),
  F(/pasta|macaroni|penne|fusilli|spaghetti|noodles/, [158, 5.8, 31, 1.8, 0.9, 1.3, 7], { cup: 140 }, /cooked/),
  F(/pasta|macaroni|penne|fusilli|spaghetti|noodles/, [370, 13, 75, 3.2, 1.5, 3, 21], { cup: 100 }),
  F(/\brice\b/, [130, 2.7, 28, 0.4, 0.3, 0.2, 10], { cup: 158 }, /cooked|leftover|day-old/),
  F(/\brice\b/, [360, 7, 79, 1.3, 0.6, 0.8, 10], { cup: 185 }),
  F(/paratha/, [320, 8, 45, 5, 12, 2.5, 30], { pc: 70 }),
  F(/chapati|roti|phulka/, [300, 10, 55, 7, 6, 3, 30], { pc: 40 }),
  F(/naan/, [290, 9, 50, 2, 6, 3, 80], { pc: 90 }),
  F(/pav|bun/, [280, 9, 50, 2.5, 4.5, 3, 100], { pc: 40 }),
  F(/pita/, [275, 9, 56, 2.2, 1.2, 2.6, 86], { pc: 60 }),
  F(/bread/, [250, 12, 43, 6, 3.5, 2.5, 160], { slice: 30 }),
  F(/corn tortilla/, [218, 5.7, 45, 6.3, 2.9, 1.2, 80], { pc: 25 }),
  F(/tortilla|wrap/, [300, 8, 50, 3.5, 7.5, 3.2, 140], { pc: 45 }),
  F(/besan|gram flour|senaga ?pindi/, [387, 22, 58, 11, 6.7, 4.9, 45], { cup: 92 }),
  F(/cornstarch|corn flour/, [381, 0.3, 91, 0.9, 0.1, 0.5, 2], { cup: 128 }),

  // Vegetables (raw weight).
  F(/spinach|palak/, [23, 2.9, 3.6, 2.2, 0.4, 2.7, 99], { cup: 30, bunch: 250 }),
  F(/kasuri methi/, [323, 23, 58, 25, 6.4, 28, 176], { cup: 25 }),
  F(/methi|fenugreek leaves/, [49, 4.4, 6, 4.9, 0.9, 2, 395], { cup: 40, bunch: 150 }),
  F(/gongura/, [56, 1.7, 10, 3, 1.1, 2.3, 172], { cup: 40, bunch: 200 }),
  F(/tomato puree|tomato sauce|tomato paste/, [38, 1.7, 9, 1.9, 0.2, 1.8, 18], { cup: 250 }),
  F(/tomato|tamata/, [18, 0.9, 3.9, 1.2, 0.2, 0.3, 10], { cup: 180, pc: 120 }),
  F(/onion|ullipaya/, [40, 1.1, 9.3, 1.7, 0.1, 0.2, 23], { cup: 160, pc: 110 }),
  F(/sweet potato/, [86, 1.6, 20, 3, 0.05, 0.6, 30], { cup: 133, pc: 150 }),
  F(/small potato/, [77, 2, 17, 2.2, 0.1, 0.8, 12], { pc: 100 }),
  F(/potato|bangaladumpa|aloo/, [77, 2, 17, 2.2, 0.1, 0.8, 12], { cup: 150, pc: 170 }),
  F(/carrot/, [41, 0.9, 9.6, 2.8, 0.2, 0.3, 33], { cup: 128, pc: 60 }),
  F(/peas/, [81, 5.4, 14.5, 5.1, 0.4, 1.5, 25], { cup: 145 }),
  F(/corn/, [86, 3.3, 19, 2, 1.4, 0.5, 2], { cup: 150 }),
  F(/broccoli/, [34, 2.8, 6.6, 2.6, 0.4, 0.7, 47], { cup: 90 }),
  F(/cauliflower/, [25, 1.9, 5, 2, 0.3, 0.4, 22], { cup: 107, pc: 600 }),
  F(/cabbage/, [25, 1.3, 5.8, 2.5, 0.1, 0.5, 40], { cup: 90, pc: 700 }),
  F(/capsicum|bell pepper/, [26, 1, 6, 2.1, 0.3, 0.4, 7], { cup: 150, pc: 120 }),
  F(/beans/, [31, 1.8, 7, 2.7, 0.2, 1, 37], { cup: 110, pc: 5 }),
  F(/okra|bendakaya|bhindi/, [33, 1.9, 7.5, 3.2, 0.2, 0.6, 82], { cup: 100, pc: 12 }),
  F(/brinjal|vankaya|eggplant|baingan/, [25, 1, 5.9, 3, 0.2, 0.2, 9], { cup: 80, pc: 60 }),
  F(/bottle gourd|sorakaya|lauki/, [15, 0.6, 3.4, 0.5, 0, 0.2, 26], { cup: 115, pc: 700 }),
  F(/ridge gourd|beerakaya/, [20, 1.2, 4.4, 1.1, 0.2, 0.4, 20], { cup: 100, pc: 200 }),
  F(/ivy gourd|dondakaya|tindora/, [18, 1.2, 3.1, 1.6, 0.1, 0.4, 40], { cup: 100, pc: 10 }),
  F(/drumstick|munagakaya/, [37, 2.1, 8.5, 3.2, 0.2, 0.4, 30], { pc: 50 }),
  F(/pumpkin puree/, [34, 1.1, 8, 2.9, 0.3, 1.4, 26], { cup: 245 }),
  F(/pumpkin|gummadikaya/, [26, 1, 6.5, 0.5, 0.1, 0.8, 21], { cup: 116 }),
  F(/raw banana|aratikaya|plantain/, [122, 1.3, 32, 2.3, 0.4, 0.6, 3], { pc: 180 }),
  F(/raw mango|mamidikaya/, [60, 0.7, 15, 1.2, 0.1, 0.3, 15], { pc: 200 }),
  F(/cucumber|dosakaya/, [15, 0.65, 3.6, 0.5, 0.1, 0.3, 16], { cup: 120, pc: 200, slice: 7 }),
  F(/snake gourd|potlakaya/, [18, 0.6, 3.7, 0.6, 0.3, 0.3, 26], { cup: 100, pc: 400 }),
  F(/bitter gourd|kakarakaya|karela/, [17, 1, 3.7, 2.8, 0.2, 0.4, 19], { cup: 95, pc: 100 }),
  F(/taro|chamadumpa|arbi|colocasia/, [112, 1.5, 26, 4.1, 0.2, 0.55, 43], { cup: 105, pc: 60 }),
  F(/radish|mullangi|mooli/, [16, 0.7, 3.4, 1.6, 0.1, 0.3, 25], { cup: 116, pc: 150 }),
  F(/\byam\b|kandagadda|suran/, [118, 1.5, 28, 4.1, 0.2, 0.5, 17], { cup: 150 }),
  F(/amaranth|thotakura/, [23, 2.5, 4, 2.2, 0.3, 2.3, 215], { cup: 30, bunch: 200 }),
  F(/(dry|dried) red chill/, [318, 12, 57, 27, 17, 7.8, 148], { pc: 0.5 }),
  F(/zucchini/, [17, 1.2, 3.1, 1, 0.3, 0.4, 16], { cup: 120, pc: 200 }),
  F(/celery/, [16, 0.7, 3, 1.6, 0.2, 0.2, 40], { cup: 100 }),
  F(/mixed vegetables/, [60, 3, 12, 4, 0.4, 0.9, 30], { cup: 135 }),
  F(/avocado|guacamole/, [160, 2, 8.5, 6.7, 14.7, 0.55, 12], { cup: 150, pc: 150 }),
  F(/coriander chutney|green chutney/, [60, 2, 6, 3, 3, 1.5, 50], { cup: 240 }),
  F(/coriander leaves|kothimeera|cilantro/, [23, 2.1, 3.7, 2.8, 0.5, 1.8, 67], { cup: 16, bunch: 100 }),
  F(/mint/, [70, 3.8, 15, 8, 0.9, 5, 243], { cup: 30, bunch: 50 }),
  F(/basil/, [23, 3.2, 2.7, 1.6, 0.6, 3.2, 177], { cup: 24 }),
  F(/ginger garlic paste/, [110, 4, 25, 2, 0.6, 1.1, 90], { cup: 240 }),
  F(/garlic|vellulli/, [149, 6.4, 33, 2.1, 0.5, 1.7, 181], { pc: 3 }),
  F(/ginger|allam/, [80, 1.8, 18, 2, 0.75, 0.6, 16], { cup: 96 }),
  F(/green chil|pachi mirapakaya/, [40, 2, 9.5, 1.5, 0.2, 1, 18], { pc: 4 }),
  F(/chipotle/, [80, 2, 12, 5, 3, 2, 30], { pc: 10 }),
  F(/lemon|lime/, [22, 0.35, 6.9, 0.3, 0.2, 0.1, 6], { cup: 244, pc: 30 }),
  F(/tamarind|chintapandu/, [239, 2.8, 62, 5.1, 0.6, 2.8, 74], { cup: 240 }),

  // Fruit.
  F(/banana/, [89, 1.1, 23, 2.6, 0.3, 0.26, 5], { cup: 225, pc: 118 }),
  F(/apple/, [52, 0.3, 14, 2.4, 0.2, 0.12, 6], { cup: 125, pc: 180 }),
  F(/pear/, [57, 0.4, 15, 3.1, 0.1, 0.2, 9], { cup: 140, pc: 180 }),
  F(/plum/, [46, 0.7, 11, 1.4, 0.3, 0.17, 6], { pc: 66 }),
  F(/mango pulp/, [70, 0.5, 18, 1, 0.2, 0.3, 10], { cup: 250 }),
  F(/mango/, [60, 0.8, 15, 1.6, 0.4, 0.16, 11], { cup: 165, pc: 200 }),
  F(/papaya/, [43, 0.5, 11, 1.7, 0.3, 0.25, 20], { cup: 145 }),
  F(/strawberr|berries/, [32, 0.7, 7.7, 2, 0.3, 0.4, 16], { cup: 150 }),
  F(/pomegranate/, [83, 1.7, 19, 4, 1.2, 0.3, 10], { cup: 174 }),
  F(/dates?\b|date paste/, [282, 2.5, 75, 8, 0.4, 1, 39], { cup: 150, pc: 10 }),
  F(/raisins?|kishmish/, [299, 3.1, 79, 3.7, 0.5, 1.9, 50], { cup: 145 }),
  F(/jam/, [250, 0.4, 65, 1, 0.1, 0.5, 20], { cup: 320 }),

  // Sweeteners and treats.
  F(/jaggery|bellam|gur/, [383, 0.4, 98, 0, 0.1, 2.6, 80], { cup: 200 }),
  F(/powdered sugar|icing sugar/, [389, 0, 100, 0, 0, 0, 1], { cup: 120 }),
  F(/sugar/, [387, 0, 100, 0, 0, 0, 1], { cup: 200 }),
  F(/honey/, [304, 0.3, 82, 0.2, 0, 0.4, 6], { cup: 340 }),
  F(/chocolate/, [480, 4.2, 64, 6, 24, 3, 32], { cup: 170 }),

  // Sauces and stocks.
  F(/soy sauce/, [53, 8, 5, 0.8, 0.6, 1.5, 33], { cup: 255 }),
  F(/salsa/, [36, 1.5, 7, 1.9, 0.2, 0.4, 30], { cup: 260 }),
  F(/enchilada sauce/, [40, 1, 6, 1.5, 1.5, 0.8, 15], { cup: 250 }),
  F(/stock|broth/, [6, 0.5, 1, 0, 0.2, 0.1, 5], { cup: 240 }),

  // Spices. A teaspoon weighs 2 to 3 g, so they add a little iron and not much else.
  F(/turmeric|pasupu/, [312, 9.7, 67, 22.7, 3.25, 55, 168], { cup: 140 }),
  F(/jeera|cumin/, [375, 18, 44, 10.5, 22, 66, 931], { cup: 100 }),
  F(/mustard/, [508, 26, 28, 12, 36, 9.2, 266], { cup: 160 }),
  F(/fenugreek seeds|methi seeds|menthulu/, [323, 23, 58, 25, 6.4, 33.5, 176], { cup: 180 }),
  F(/coriander (powder|seeds)|dhania/, [298, 12, 55, 42, 18, 16.3, 709], { cup: 96 }),
  F(/chilli powder|chili powder|paprika|cayenne/, [282, 13.5, 50, 35, 14, 17.3, 330], { cup: 130 }),
  F(/masala|powder|pepper|cardamom|cinnamon|clove|oregano|spice|seeds|hing|asafoetida|bay lea/, SPICE, { cup: 120, pc: 1 }),
];

const VOLUME = { cup: 1, tbsp: 1 / 16, tsp: 1 / 48 };
// Grams for units a food doesn't set itself. A pinch is too small to count.
const UNIT_GRAMS = { g: 1, kg: 1000, ml: 1, l: 1000, pinch: 0.3, handful: 30, slice: 30, clove: 3, sprig: 1, inch: 6, bunch: 200, can: 400, packet: 100 };

const clean = (s) => String(s || "").toLowerCase().replace(/\(([^)]*)\)/g, " $1 ").replace(/\s+/g, " ").trim();

// The food entry for one ingredient, or null when the ingredient isn't in the table.
export function findFood(ingredient) {
  const name = clean(typeof ingredient === "string" ? ingredient : ingredient?.name);
  const note = clean(ingredient?.note);
  if (!name) return null;
  return FOODS.find((f) => f.re.test(name) && (!f.note || f.note.test(note))) || null;
}

// Grams of one ingredient line, or null when the amount can't be worked out ("Salt, to taste").
export function ingredientGrams(ingredient, food = findFood(ingredient)) {
  const q = Number(ingredient?.quantity);
  if (!food || !Number.isFinite(q) || q <= 0) return null;
  const u = ingredient.unit || "pcs";
  if (VOLUME[u]) return q * VOLUME[u] * (food.w.cup || 240);
  if (u === "pcs") return q * (food.w.pc || 50);
  if (u === "dozen") return q * 12 * (food.w.pc || 50);
  if (food.w[u]) return q * food.w[u];
  if (u === "clove" && food.w.pc) return q * food.w.pc;
  return UNIT_GRAMS[u] != null ? q * UNIT_GRAMS[u] : null;
}

// How many servings a recipe makes: the **Serves** line, else one portion for the baby or the
// 4-year-old and four for a family dinner.
export function recipeServings(recipe) {
  const n = Number(recipe?.servings);
  if (Number.isFinite(n) && n > 0) return n;
  return recipe?.forWhom === "family" ? 4 : 1;
}

const round = (key, x) => key === "kcal" || key === "calcium" ? Math.round(x) : Math.round(x * 10) / 10;

// Estimated nutrition for one serving. `missing` lists ingredients that weren't counted
// (not in the table, or no amount given); salt, water and the like are not listed.
export function estimateNutrition(recipe) {
  const servings = recipeServings(recipe);
  const total = Object.fromEntries(NUTRIENTS.map((n) => [n.key, 0]));
  const missing = [];
  let counted = 0;
  for (const ing of recipe?.ingredients || []) {
    const food = findFood(ing);
    const grams = ingredientGrams(ing, food);
    if (food && grams == null && !food.v.some(Boolean)) continue;
    if (food && grams == null && (ing.unit === "pinch" || /taste|garnish|optional/i.test(ing.note || ""))) continue;
    if (!food || grams == null) { missing.push(ing.name); continue; }
    if (food.v.some(Boolean)) counted++;
    NUTRIENTS.forEach((n, i) => { total[n.key] += (food.v[i] * grams) / 100; });
  }
  const perServing = Object.fromEntries(NUTRIENTS.map((n) => [n.key, round(n.key, total[n.key] / servings)]));
  return { servings, perServing, counted, missing };
}

// Share of the day's need for the baby or the 4-year-old, as whole percents. Empty for family recipes.
export function dailyShare(perServing, forWhom) {
  const need = DAILY_NEEDS[forWhom];
  if (!need) return {};
  return Object.fromEntries(NUTRIENTS.filter((n) => need[n.key]).map((n) => [n.key, Math.round((perServing[n.key] / need[n.key]) * 100)]));
}
