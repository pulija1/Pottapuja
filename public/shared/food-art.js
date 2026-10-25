// Food pictures without photos: an emoji and a colour for a recipe, a dish name or a grocery item.
// Emoji are drawn by the phone itself, so they cost nothing to download and work offline.

// First match wins, so dish names come before the ingredients they contain
// ("sweet potato" before "potato", "egg dosa" is a dosa).
const ART = [
  [/dosa|uttapam|pesarattu|chilla|cheela|pancake|crepe|adai|appam/, "🥞"],
  [/idli/, "🍚"],
  [/kozhukattai|modak|momo|dumpling/, "🥟"],
  [/quesadilla|taco|burrito|nacho/, "🌮"],
  [/kathi|wrap|roll|frankie/, "🌯"],
  [/sandwich/, "🥪"],
  [/pizza/, "🍕"],
  [/burger/, "🍔"],
  [/noodle|ramen/, "🍜"],
  [/pasta|macaroni|spaghetti|vermicelli|semiya|sevai/, "🍝"],
  [/roti|chapati|chapathi|phulka|paratha|parotta|naan|puri|poori|pulka|tortilla|thepla|flatbread/, "🫓"],
  [/vada|vadai|bonda|pakora|pakoda|bajji|bhaji|cutlet|tikki|falafel|punugulu/, "🧆"],
  [/payasam|kheer|leche|pudding|halwa|kesari|custard/, "🍮"],
  [/ladoo|laddu|chikki/, "🟠"],
  [/cake|muffin/, "🧁"],
  [/biscuit|cookie|cracker/, "🍪"],
  [/smoothie|milkshake|shake|lassi|juice/, "🥤"],
  [/salad|kosambari/, "🥗"],
  [/soup|rasam|saaru|shorba|broth/, "🍲"],
  [/shakshuka|omelet|omelette|bhurji|scrambled|egg fry|egg curry|anda/, "🍳"],
  [/chicken|kodi|murgh/, "🍗"],
  [/mutton|lamb|goat|keema/, "🍖"],
  [/fish|chepa|meen/, "🐟"],
  [/prawn|shrimp|royya/, "🍤"],
  [/biryani|pulao|pulav|fried rice|pulihora|lemon rice|tamarind rice|curd rice|bisi bele|annam|\brice\b|\bbath\b/, "🍚"],
  [/upma|poha|pongal|khichdi|kichdi|kichadi|porridge|kanji|\bjaava\b|java|oats|cereal|puree|mash|muesli|granola/, "🥣"],
  [/curry leaves|karivepaku|coriander|kothimeera|cilantro|mint|pudina|herb/, "🌿"],
  [/spinach|palak|greens|leaves|leafy|methi|menthikura|gongura|thotakura|amaranth|cabbage|lettuce|kale/, "🥬"],
  [/curry|kura|koora|pulusu|sambar|sambhar|kootu|kuzhambu|korma|masala|gravy|pappu|\bdal\b|dhal|chana|rajma|chole/, "🍛"],
  [/fry|vepudu|poriyal|stir|thoran|palya/, "🥘"],
  [/egg/, "🥚"],
  [/paneer|cheese/, "🧀"],
  [/toast|bread|bun|pav/, "🍞"],
  [/sweet potato|chilagada/, "🍠"],
  [/potato|aloo|bangaladumpa/, "🥔"],
  [/banana|arati/, "🍌"],
  [/mango|mamidi/, "🥭"],
  [/apple/, "🍎"],
  [/pear/, "🍐"],
  [/grape|draksha/, "🍇"],
  [/orange|kamala/, "🍊"],
  [/watermelon|puchakaya|melon/, "🍉"],
  [/strawberr/, "🍓"],
  [/blueberr|berries|berry/, "🫐"],
  [/kiwi/, "🥝"],
  [/peach|plum|apricot/, "🍑"],
  [/pineapple/, "🍍"],
  [/avocado/, "🥑"],
  [/papaya|boppayi|guava|jama|sapota|chikoo|pomegranate|danimma|fruit/, "🍈"],
  [/carrot/, "🥕"],
  [/corn/, "🌽"],
  [/broccoli|cauliflower/, "🥦"],
  [/brinjal|eggplant|vankaya|aubergine/, "🍆"],
  [/tomato|tamata/, "🍅"],
  [/pumpkin|gummadi/, "🎃"],
  [/peas|batani|beans|chikkudu|okra|bendakaya|bhindi|ladies? ?finger|drumstick|munaga/, "🫛"],
  [/cucumber|dosakaya|gourd|sorakaya|beerakaya|dondakaya|potlakaya|kakarakaya|zucchini/, "🥒"],
  [/capsicum|bell pepper/, "🫑"],
  [/chilli|chili|mirapa/, "🌶️"],
  [/mushroom/, "🍄"],
  [/onion|ullipaya|shallot/, "🧅"],
  [/garlic|vellulli/, "🧄"],
  [/ginger|allam/, "🫚"],
  [/coconut|kobbari/, "🥥"],
  [/lemon|lime|nimma/, "🍋"],
  [/peanut|almond|cashew|walnut|pista|\bnuts?\b/, "🥜"],
  [/milk|curd|yogurt|yoghurt|buttermilk|majjiga|raita/, "🥛"],
  [/butter|ghee/, "🧈"],
  [/\boil\b/, "🫗"],
  [/honey|jaggery|sugar|bellam/, "🍯"],
  [/salt/, "🧂"],
  [/tea|coffee/, "☕"],
  [/flour|atta|maida|rava|sooji|semolina|ragi|wheat|millet|jowar|bajra/, "🌾"],
  [/dal|lentil|gram|moong|toor|urad|masoor|chickpea/, "🫘"],
  [/frozen|ice/, "🧊"],
  [/chips|fries/, "🍟"],
  [/diaper|wipes/, "🧷"],
  [/soap|shampoo|detergent|cleaner/, "🧴"],
];

const MEAL_ART = { breakfast: "🥞", lunchbox: "🍱", lunch: "🍛", snack: "🍪", dinner: "🍲" };

// The colour of a picture tile: one per meal, otherwise picked from the name so the same
// item always has the same colour.
const MEAL_TONE = { breakfast: 0, lunchbox: 1, lunch: 2, snack: 3, dinner: 4 };
export const TONES = 6;

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h;
}

// foodArt("Ragi porridge") or foodArt(recipe) -> { emoji: "🥣", tone: 0..5 }
export function foodArt(x) {
  const title = String((typeof x === "string" ? x : x?.title) || "").toLowerCase();
  const meal = typeof x === "object" && x ? String(x.mealType || "").toLowerCase() : "";
  const hit = ART.find(([re]) => re.test(title));
  const emoji = hit ? hit[1] : MEAL_ART[meal] || "🍽️";
  const tone = meal in MEAL_TONE ? MEAL_TONE[meal] : hash(title) % TONES;
  return { emoji, tone };
}
