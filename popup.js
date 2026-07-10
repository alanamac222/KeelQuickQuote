// Duke Estimating - Popup Script (clean rewrite)

// ── Helpers ───────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showStatus(msg, type, duration) {
  type = type || 'info'; duration = duration === undefined ? 3500 : duration;
  const bar = $('status-bar');
  bar.textContent = msg;
  bar.className = 'status-bar ' + type;
  bar.classList.remove('hidden');
  if (duration > 0) setTimeout(function() { bar.classList.add('hidden'); }, duration);
}

function sendMsg(action, data) {
  data = data || {};
  return new Promise(function(resolve, reject) {
    chrome.runtime.sendMessage(Object.assign({ action: action }, data), function(res) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!res || !res.ok) { reject(new Error((res && res.error) || 'Unknown error')); return; }
      resolve(res);
    });
  });
}

// ── AI Constants ──────────────────────────────────────────────────────────────

const AI_LABELS = {
  exterior_doors: '# Exterior Doors',
  windows:        '# Windows',
  baths:          '# Baths',
  staircases:     '# Staircases',
  porch_columns:  '# Porch Columns',
  garage_doors:   '# Garage Doors',
  interior_doors: '# Interior Doors',
};

const AI_KEY_MAP = {
  exterior_doors: '# of exterior doors',
  windows:        '# of windows',
  baths:          '# of baths',
  staircases:     '# of staircases',
  porch_columns:  '# of front porch columns',
  garage_doors:   '# of garage doors',
  interior_doors: '# of interior doors',
};

let lastAiResult    = null;
let lastImageBase64 = null;
let lastImageMime   = null;

let lastReasoning   = null; // full GPT-4o text before the JSON
// ── GPT-4o Two-Pass Analysis ──────────────────────────────────────────────────

function gptCall(openaiKey, systemPrompt, userContent, maxTokens) {
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: maxTokens || 4096,
      temperature: 0,          // deterministic — same image = same answer every time
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  }
      ]
    })
  }).then(function(res) {
    if (!res.ok) return res.json().then(function(e) {
      throw new Error('OpenAI ' + res.status + ': ' + ((e && e.error && e.error.message) || res.statusText));
    });
    return res.json();
  }).then(function(d) {
    return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
  });
}

// imgs: array of base64 strings OR {base64, mime} objects
function buildImageContent(imgs) {
  const c = [];
  imgs.forEach(function(img, i) {
    const b64  = (typeof img === 'string') ? img : img.base64;
    const mime = (typeof img === 'string') ? 'image/png' : (img.mime || 'image/png');
    if (imgs.length > 1) c.push({ type: 'text', text: 'Page ' + (i + 1) + ':' });
    c.push({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64, detail: 'high' } });
  });
  return c;
}

async function pass1Count(imgs, key) {
  const SYS = 'You are a construction estimator. Count exactly: # of exterior doors, # of windows, # of baths, # of staircases, # of front porch columns, # of garage doors, # of interior doors. Be specific and show your reasoning.\n\nDoor rules: one arc = 1 door. Two arcs same opening = 2 doors. Hand-drawn arcs count. Exterior = outer wall. Interior = between rooms. Garage overhead = separate category.\n\nAfter your reasoning end with this JSON on its own line:\n{"exterior_doors":N,"windows":N,"baths":N,"staircases":N,"porch_columns":N,"garage_doors":N,"interior_doors":N}';
  const content = [{ type: 'text', text: 'Count all elements. Show reasoning then give the JSON.' }].concat(buildImageContent(imgs));
  const text = await gptCall(key, SYS, content, 2000);
  console.log('[Duke P1]', text);
  const m = text.match(/\{"exterior_doors":\s*\d[^}]*\}/);
  if (!m) throw new Error('Count pass failed. Response: ' + text.slice(0, 300));
  return JSON.parse(m[0]);
}

async function pass2Locate(imgs, key, counts) {
  const summary = Object.entries(counts).map(function(e) { return e[1] + ' ' + e[0].replace(/_/g, ' '); }).join(', ');
  const SYS = 'You are annotating a floor plan. Verified counts: ' + summary + '.\n\nFor each element give the x,y location of EVERY instance as a percentage of the image (0,0=top-left, 100,100=bottom-right). Place each point directly ON the symbol itself.\n\nReturn ONLY valid JSON, no other text:\n{"exterior_doors":{"count":' + counts.exterior_doors + ',"locations":[]},"windows":{"count":' + counts.windows + ',"locations":[]},"baths":{"count":' + counts.baths + ',"locations":[]},"staircases":{"count":' + counts.staircases + ',"locations":[]},"porch_columns":{"count":' + counts.porch_columns + ',"locations":[]},"garage_doors":{"count":' + counts.garage_doors + ',"locations":[]},"interior_doors":{"count":' + counts.interior_doors + ',"locations":[]}}';
  const content = [{ type: 'text', text: 'Locate all ' + summary + '. Return JSON.' }].concat(buildImageContent(imgs));
  const text = await gptCall(key, SYS, content, 4096);
  console.log('[Duke P2]', text.slice(0, 150));
  const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Location pass failed. Response: ' + text.slice(0, 200));
  const r = JSON.parse(m[0]);
  Object.keys(counts).forEach(function(k) { if (r[k]) r[k].count = counts[k]; });
  return r;
}

// ── Few-shot training examples ────────────────────────────────────────────────
// Loads verified floor plan images from extension bundle as base64

async function loadTrainingImage(filename) {
  const url = chrome.runtime.getURL('training/' + filename);
  const res  = await fetch(url);
  const blob = await res.blob();
  return new Promise(function(resolve) {
    const reader = new FileReader();
    reader.onload = function(e) { resolve(e.target.result.split(',')[1]); };
    reader.readAsDataURL(blob);
  });
}

// Returns few-shot messages array to prepend to every analysis call
// Each example = [user message with images] + [assistant message with correct reasoning + JSON]
async function buildFewShotMessages() {
  try {
    const [kf1, kf2, bf1, bf2] = await Promise.all([
      loadTrainingImage('kiawah_floor1.jpg'),
      loadTrainingImage('kiawah_floor2.jpg'),
      loadTrainingImage('bonaire_floor1.png'),
      loadTrainingImage('bonaire_floor2.png'),
    ]);

    return [
      // ── KIAWAH EXAMPLE ──
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Walk through this floor plan room by room, count every element, then output the JSON.' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + kf1, detail: 'low' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + kf2, detail: 'low' } }
        ]
      },
      {
        role: 'assistant',
        content: 'KIAWAH: Ext Doors=3 (covered porch + front entry + garage man-door), Windows=27 (16 floor1+11 floor2), Baths=3.5 (Bath2+PWDR on floor1, PrimaryBath1+Bath3 on floor2), Stairs=1 (UP in foyer), Columns=2 (porch corners), Garage=1 (OHD in 2-CAR GARAGE), Int Doors=27 (11 floor1+16 floor2).\n\n{"exterior_doors":{"count":3,"locations":[]},"windows":{"count":27,"locations":[]},"baths":{"count":3.5,"locations":[]},"staircases":{"count":1,"locations":[]},"porch_columns":{"count":2,"locations":[]},"garage_doors":{"count":1,"locations":[]},"interior_doors":{"count":27,"locations":[]}}'
      },

      // ── BONAIRE EXAMPLE ──
      {
        role: "user",
        content: [
          { type: "text", text: "Walk through this floor plan room by room, count every element, then output the JSON." },
          { type: "image_url", image_url: { url: "data:image/png;base64," + bf1, detail: "low" } },
          { type: "image_url", image_url: { url: "data:image/png;base64," + bf2, detail: "low" } }
        ]
      },
      {
        role: "assistant",
        content: "This is the BONAIRE plan specifically. BONAIRE counts: Ext Doors=4 (2 arcs at front entry porch + 2 arcs at rear covered porch), Windows=22 (15 floor1 + 7 floor2), Baths=3.5, Stairs=1, Columns=7 (specific to this plan's porch), Garage=1, Int Doors=26. These numbers are ONLY for Bonaire — other plans will differ.\n\n{\"exterior_doors\":{\"count\":4,\"locations\":[]},\"windows\":{\"count\":22,\"locations\":[]},\"baths\":{\"count\":3.5,\"locations\":[]},\"staircases\":{\"count\":1,\"locations\":[]},\"porch_columns\":{\"count\":7,\"locations\":[]},\"garage_doors\":{\"count\":1,\"locations\":[]},\"interior_doors\":{\"count\":26,\"locations\":[]}}"
      },
    ];
  } catch (e) {
    console.warn('[Duke] Could not load training images:', e.message);
    return []; // fall back to no few-shot if images fail to load
  }
}

// ── Core GPT-4o analysis ──────────────────────────────────────────────────────

const ANALYSIS_SYSTEM = `You are a professional residential construction estimator analyzing floor plan drawings. Count only what you can visually see in the image. Do not assume or infer based on room type — count only the actual symbols present.

SYMBOL IDENTIFICATION
─────────────────────
WALL: thick double parallel lines forming the building perimeter or interior room dividers.
DIMENSION LINE: thin single line with arrows and a measurement number (e.g. 18'-11½"). IGNORE these — they are not walls.

WINDOW SYMBOL: a gap in a wall with 2–3 thin parallel lines inside the gap. NO arc attached.
DOOR SYMBOL: same wall gap WITH a quarter-circle arc (pie-slice/fan shape) showing the door swing. The arc is the key difference from a window.
- Gap + parallel lines + NO arc = WINDOW
- Gap + parallel lines + arc = DOOR
- Hand-drawn version: the arc may be rough or imperfect but is still an arc shape
- Double door (Z or mirrored-arc shape): two arcs at one opening = 2 doors

COLUMN SYMBOL: small solid filled black square positioned inside a porch area.
GARAGE OVERHEAD DOOR: large dashed/dotted rectangle spanning the full garage opening, often labeled OHD or with dimensions like 16080.
STAIRCASE: parallel step lines with an UP or DN arrow.
TOILET: oval/rectangle with small tank rectangle at one end.
BATHTUB: large oval or rectangle with inner oval, sometimes diagonal line.
SHOWER: rectangle with dashed X or diagonal lines.

COUNTING RULES
─────────────────────

EXTERIOR DOORS
- Exterior doors are ANY door arc on a wall that separates an interior room from an outdoor space: covered porch, entry porch, rear porch, deck, or directly outside. They are NOT limited to the outer building perimeter — porches can be inside the roofline.
- COUNT EACH INDIVIDUAL DOOR ARC. Do NOT count porch areas — count door openings. If a porch has 2 separate door arcs leading to it, count 2 exterior doors, not 1.
- A pair of french doors (two arcs side by side at one porch opening) = 2 exterior doors.
- A single door at one porch opening = 1 exterior door.
- Check EVERY porch on the plan: covered porch, entry porch, rear porch, side porch. Each may have 1 or 2 door arcs — do NOT assume every porch has 2.
- CAD PLANS: Find every door size code on a wall adjacent to a porch/outdoor space.
- HAND-DRAWN PLANS: Count every door arc on walls adjacent to porch or exterior spaces.
- Do NOT count garage overhead doors. Do NOT count interior-to-interior doors.

WINDOWS
- CAD PLANS: Look for window size codes printed next to wall openings on EXTERIOR walls only. Common codes: 3060, 3040, 2040, 3030, 2640, 3050, 4040, 2030, 2438, etc. Count each code = 1 window.
- TWIN or DOUBLE windows (labeled "TWIN 3060", "TWO8 3060", "DOUBLE", or similar): count as 1 window — one opening regardless of pane count.
- Count windows on ALL exterior walls including garage walls and basement walls.
- EXHAUSTIVE METHOD — name every room that touches an exterior wall, then count the window codes on that room's exterior wall(s). Do this for EVERY room on EVERY floor before summing. Large houses have 20–30+ windows across 2 floors.
- SECOND FLOOR WARNING: The 2nd floor almost always has FEWER windows than the 1st floor. If you count more 2nd floor windows than 1st floor windows, you are almost certainly miscounting — recheck.
- Do NOT count codes in schedule/legend tables. Do NOT count door size codes (door codes sit INSIDE an arc; window codes are next to a wall gap with no arc).
- After counting, if your total is under 15 for a large 2-story house, you missed rooms — go back and check every exterior-wall room again.

BATHS
BATHS
- Count ONLY rooms you can explicitly see labeled as a bath. Do NOT infer a room exists because a similarly-numbered room exists (e.g. do not assume 'Bath 1' exists just because 'Bath 2' is labeled).
- POWDER / PWDR / HALF BATH = 0.5. BATH 2 / BATH 3 / PRIMARY BATH / MASTER BATH = 1.0 each.
- Unlabeled room with toilet + tub or shower = 1.0. Toilet + sink only = 0.5.
- List every bath room you can see labeled, then add their values. Do not add rooms you cannot see.

STAIRCASES
STAIRCASES
- Before counting: ask yourself TWO questions: (1) Is this stair symbol fully inside the building floor plan, away from exterior walls? (2) Does it have 10 or more step lines with a high number like UP 14, UP 16, DN 12?
- If NO to either question, count = 0.
- INTERIOR stairs look like: a rectangular grid of many small rectangles (two rows of box shapes), labeled UP or DN with a high number (12+), inside the building.
- EXTERIOR steps look like: a simple 3-5 line rectangle AT THE BUILDING PERIMETER next to an exterior door, labeled DN with no number or a small number.
- If you are unsure whether stairs are interior or exterior, count 0.

FRONT PORCH COLUMNS
- Count ONLY the small solid filled black square symbols you can actually see. Do NOT guess or assume a number based on any pattern.
- Columns appear at porch corners, along porch edges, and sometimes in a row along the front face of steps. Count what is VISIBLE — some plans have 2, others 7, others 12.
- Trace the ENTIRE perimeter of every porch area on the plan (entry porch, covered porch, front porch, rear porch, side porch).
- Count each individual square separately — a cluster of 4 = 4 columns.
- Do NOT count general wall corners or structural wall intersections — only the small isolated squares clearly within porch areas.
GARAGE OVERHEAD DOORS
- HARD RULE: You must be able to READ the word GARAGE on the plan. Spell it out — G-A-R-A-G-E. If you cannot find and read that word, count = 0.
- If you CAN read GARAGE, also look for a dashed rectangle inside that room. Both required.
- Never assume a garage exists. Never count 1 unless you can read the word GARAGE.
- CAD PLANS: Count every door size code (2868, 3068, 2668, 2468, 2068, 1668, etc.) printed inside the arc sweep of door symbols inside the building.
- Each code inside an arc = 1 door. The code sits INSIDE the quarter-circle fan shape.
- Include closet doors, WIC doors, WC doors, shower doors, linen closet doors — every arc with a code counts.
- Primary Bath: look for multiple codes — each sub-space (WC, shower, linen closet, WIC) has its own arc with its own code.
- CASED OPENING: any opening labeled "CASED OPENING" or "CO" on the plan is NOT a door — do not count it. These are open archways with no door. If you count one, your total will be too high by 1.
- Do NOT count codes in door schedule/legend tables.
- Do NOT count exterior doors (those are on walls leading to porches/outside).
- HAND-DRAWN PLANS: Count every arc symbol inside the building on interior walls only. Before finalizing, subtract any openings labeled "CASED OPENING".
- Count both floors separately and add.

SECOND FLOOR WINDOWS: [same]
TOTAL WINDOWS: [sum]

FIRST FLOOR INTERIOR DOORS: [list each room and arc count seen]
SECOND FLOOR INTERIOR DOORS: [same]
TOTAL INTERIOR DOORS: [sum]

[same breakdown for all other categories]

Then end with ONLY this JSON on its own line:
{"exterior_doors":0,"windows":0,"baths":0,"staircases":0,"porch_columns":0,"garage_doors":0,"interior_doors":0}

REFERENCE COUNTS from verified plans:
KIAWAH: Ext Doors=3, Windows=27, Baths=3.5, Stairs=1, Columns=2, Garage Doors=1, Int Doors=27
SANIBEL: Ext Doors=4, Windows=23, Baths=4, Stairs=1, Columns=12, Garage Doors=1, Int Doors=27
VERO: Ext Doors=2, Windows=24, Baths=3, Stairs=1, Columns=3, Garage Doors=1, Int Doors=21
BONAIRE: Ext Doors=4, Windows=22, Baths=3.5, Stairs=1, Columns=7, Garage Doors=1, Int Doors=26
SULLIVAN: Ext Doors=2, Windows=10, Baths=3, Stairs=0, Columns=3, Garage Doors=0, Int Doors=15
CAROLINE: Ext Doors=3, Windows=27 (14 floor1+13 floor2), Baths=3.5, Stairs=1, Columns=2, Garage Doors=1, Int Doors=28 (9 floor1+19 floor2)  ← large house

SCALE REMINDER: Large homes regularly have 20–35 windows and 25–35 interior doors across 2 floors. If your window count is under 15 or door count under 20 for a large 2-story house, you are very likely missing rooms. Count EVERY room on EVERY floor before finalizing.`;

// ── Symbol reference images ───────────────────────────────────────────────────
// Loaded once and prepended to every analysis so GPT-4o sees what each symbol
// looks like in this plan style before analyzing a new plan

let _symbolCache = null;

async function loadSymbolReferences() {
  if (_symbolCache !== null) return _symbolCache;
  const FILES = [
    { file: "double_door_symbol_examples.png", caption: "DOUBLE DOOR SYMBOLS: Two arcs at one opening = 2 doors. Hand-drawn versions may look like a Z or mirrored arcs — still 2 doors." },
    { file: "bonaire_7_columns_annotated.png", caption: "COLUMN SYMBOL EXAMPLE — 7 IN THIS PLAN: Red boxes show 7 column squares in this specific plan. YOUR plan may have more or fewer. Count only the squares you can see — do not assume 7." },
    { file: "bonaire_floor1_15_windows_annotated.png", caption: "BONAIRE FIRST FLOOR WINDOWS — 15 TOTAL: Red boxes show all 15 window locations. Do not stop at 12 — trace every exterior wall section." },
    { file: "bonaire_floor2_7_windows_annotated.png", caption: "BONAIRE SECOND FLOOR WINDOWS — 7 TOTAL: Only 7 windows on floor 2 vs 15 on floor 1. Floor 2 always has fewer. If you count 12+ on floor 2, you are overcounting." },
    { file: "bonaire_4_ext_doors_annotated.png", caption: "BONAIRE EXTERIOR DOORS — 4 TOTAL: 2 arcs at front entry porch + 2 arcs at rear covered porch. Count each arc individually." },
    { file: "sullivan_10_windows_annotated.png", caption: "CAD PLAN WINDOWS — 10: Red boxes mark 10 window size codes (3060, 3040, 2040, etc.) on exterior walls. Each code = 1 window. Do NOT count door codes or dimension lines as windows." },
    { file: "sullivan_2_exterior_doors_annotated.png", caption: "CAD EXTERIOR DOORS — 2: Red boxes mark 2 exterior door arcs on perimeter walls. Same quarter-circle arc as interior doors but on outer wall adjacent to porch/outside." },
    { file: "sullivan_15_interior_doors_annotated.png", caption: "CAD PLAN INTERIOR DOORS — 15: Red boxes mark 15 door arcs. Count every arc including closets, WIC, WC, shower — each sub-space has its own arc." },
  ];

  const msgs = [];
  for (const f of FILES) {
    try {
      const url  = chrome.runtime.getURL('training/symbols/' + f.file);
      const res  = await fetch(url);
      const blob = await res.blob();
      const b64  = await new Promise(function(resolve) {
        const reader = new FileReader();
        reader.onload = function(e) { resolve(e.target.result.split(',')[1]); };
        reader.readAsDataURL(blob);
      });
      msgs.push({ type: 'text',      text: f.caption });
      msgs.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64, detail: 'low' } });
    } catch (e) {
      console.warn('[Duke] Could not load symbol image:', f.file, e.message);
    }
  }
  _symbolCache = msgs;
  return msgs;
}

let _fewShotCache = null;

async function getFewShot() {
  if (_fewShotCache !== null) return _fewShotCache;
  _fewShotCache = await buildFewShotMessages();
  return _fewShotCache;
}

async function runOnce(imagesBase64, openaiKey) {
  const [fewShot, symbolRefs] = await Promise.all([getFewShot(), loadSymbolReferences()]);



  // Symbol reference images + plan images in one user message
  const symbolHeader = [{ type: 'text', text: 'SYMBOL REFERENCE: Study these annotated examples to learn what each symbol looks like in this plan style. Red boxes mark the correct symbols. The same symbols appear in any orientation — rotated, flipped, or hand-drawn.' }];
  const planInstruction = [{ type: 'text', text: '⚠ CRITICAL: The floor plan images below are a NEW plan you have never seen. The example plans shown earlier in this conversation (Kiawah, Bonaire, etc.) are TRAINING EXAMPLES ONLY — do NOT copy their counts. Every plan is different. You must count from scratch by looking at the images below.\n\nAnalyze THIS floor plan only. Count what you can see in these images.\n\nIMPORTANT: Many residential plans are single-story with NO interior staircases and NO garage. It is completely normal to count 0 for both. Do not assume they exist.\n\nIF THIS IS A CAD PLAN (clean lines with size codes):\n\nWINDOWS: Look for window size codes (3060, 3040, 2040, 3030, 2640, etc.) next to wall openings on the perimeter. Count each code = 1 window. Trace top, right, bottom, left walls.\n\nINTERIOR DOORS: Look for door size codes (2868, 3068, 2668, 2468, 2068, 1668, etc.) inside door arc swings. Count each = 1 door.\n\nEXTERIOR DOORS: Look for code 3080 on outer perimeter walls.\n\nIF THIS IS A HAND-DRAWN PLAN:\nCount arc symbols for doors, wall gap marks for windows.\n\nBATHS: Check every room. PWDR/POWDER = 0.5, BATH/PRIMARY BATH = 1.0.\n\nSTAIRCASES — PROVE IT BEFORE COUNTING:\nBefore writing any number > 0, answer: Where exactly is the staircase? What room is it in? Is it at least 10 feet from every exterior wall? Does it have 10+ step lines? If you cannot answer YES to all of these, write 0.\n\nGARAGE DOORS — PROVE IT BEFORE COUNTING:\nBefore writing any number > 0, answer: What room is labeled GARAGE on this plan? Can you read the letters G-A-R-A-G-E? If you cannot find and read that exact word as a room label, write 0. Do not count a garage door if you cannot confirm the word GARAGE exists on the plan.\n\nWrite full reasoning then JSON.' }];
  const userContent = symbolHeader.concat(symbolRefs).concat(planInstruction).concat(buildImageContent(imagesBase64));
  // Build messages: system + few-shot examples + current plan
  const messages = [
    { role: 'system', content: ANALYSIS_SYSTEM },
    ...fewShot,
    { role: 'user', content: userContent }
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 1500, temperature: 0, messages: messages })
  });
  if (!res.ok) {
    const e = await res.json().catch(function(){return{};});
    throw new Error('OpenAI ' + res.status + ': ' + ((e && e.error && e.error.message) || res.statusText));
  }
  const data = await res.json();
  const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
  console.log('[Duke GPT]', text.slice(0, 500));
  lastReasoning = text; // store full response for display

  const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const m = clean.match(/\{[^{}]*\x22exterior_doors\x22[^{}]*\}/);
  if (!m) throw new Error('GPT-4o did not return JSON. Response: ' + text.slice(0, 400));
  const raw = JSON.parse(m[0]);
  const KEYS = ['exterior_doors','windows','baths','staircases','porch_columns','garage_doors','interior_doors'];
  const result = {};
  KEYS.forEach(function(k) {
    const v = raw[k];
    result[k] = { count: (v !== null && typeof v === 'object') ? (v.count || 0) : (Number(v) || 0), locations: [] };
  });
  return result;
}
// Majority vote — run 3 times, take the median count for each category
// More expensive (~$0.06) but significantly more reliable
// ── Split-pass focused prompts ────────────────────────────────────────────────

const WINDOWS_PASS_PROMPT = `You are counting WINDOWS ONLY on a residential floor plan. Ignore doors, columns, baths, and everything else.

WINDOW = a gap in an exterior wall with parallel lines inside and NO arc.

CRITICAL — COUNTING GROUPS: Windows very often appear side-by-side in pairs or triples. Count EACH individual opening separately:
- 2 windows side by side = 2 (not 1)
- 3 windows in a row = 3 (not 1)
- A large bank of 4 windows = 4 (not 1)
Each separate parallel-line gap in the wall = 1 window, regardless of how close together they are.

MANDATORY METHOD — complete every step:
1. List the name of EVERY room that has at least one exterior wall. Include: dining, family room, living, office, bedroom, guest bedroom, primary bedroom, mudroom, garage, gym, bath, primary bath, loft, laundry, sauna — any room touching the outside perimeter.
2. For each room, look at ALL of its exterior walls (a corner room has 2 exterior walls). Count every individual window opening on each wall.
3. Do this for EVERY floor shown.
4. Sum all rooms all floors.

Large homes have 20–30+ windows. If your total is under 20 for a large 2-story plan, you missed rooms or undercounted groups — recheck every room.

Return ONLY this JSON on the last line: {"windows": NUMBER}`;

const INT_DOORS_PASS_PROMPT = `You are counting INTERIOR DOORS ONLY on a residential floor plan. Ignore windows, exterior doors, and everything else.

INTERIOR DOOR = a quarter-circle arc on a wall INSIDE the building (not on a wall that leads to a porch or outside).
Count EVERY arc: bedroom doors, closet (CL) doors, WIC doors, laundry doors, WC doors, shower (SHR) doors, linen closet doors, pantry (BP) doors, office doors, storage doors, gym doors, sauna doors — every arc counts.
CASED OPENING = NOT a door, do not count it.

CRITICAL — PRIMARY BATH AND COMPLEX BATH AREAS: A Primary Bath suite is a cluster of sub-rooms, each with its own door arc. Typical count: 1 entry from bedroom + 1 WC door + 1 shower door + 1 or 2 WIC doors + 1 CL door = 5–6 arcs just in that one suite. Count every single arc you can see in that area.

MANDATORY METHOD:
1. List EVERY room on EVERY floor including all sub-spaces (WC, SHR, CL, WIC, BP, storage, sauna, gym, loft, laundry).
2. For each room/sub-space, count every arc entering or exiting it.
3. A door shared between two rooms is counted ONCE total (do not count from both sides).
4. Large 2-story homes typically have 25–35 interior doors. If your count is under 20, you missed rooms or sub-spaces.

Return ONLY this JSON on the last line: {"interior_doors": NUMBER}`;

const OTHERS_PASS_PROMPT = `You are analyzing a residential floor plan for EXTERIOR DOORS, BATHS, STAIRCASES, PORCH COLUMNS, and GARAGE DOORS only.

EXTERIOR DOORS: Door arcs on walls that lead to a porch, covered porch, or directly outside. Each arc = 1 door. A double (french) door = 2 arcs = 2 doors. A single door = 1 arc = 1 door. Check every porch. Do NOT count garage overhead doors.

BATHS: PWDR / POWDER / HALF BATH = 0.5. All other labeled baths = 1.0 each. List each labeled bath room, then sum.

STAIRCASES: Interior staircases only — must be inside the building, have 10+ step lines, labeled UP or DN with a high number. Count 0 if none visible or unsure.

PORCH COLUMNS: Small solid filled black squares at porch areas. Count ONLY the squares you can actually see — do not guess or apply any formula. Some plans have 2, some have 7, some have 12.

GARAGE DOORS: Only count if you can read the word GARAGE on the plan. Count the dashed OHD rectangle inside the garage room.

Return ONLY this JSON on the last line: {"exterior_doors": N, "baths": N, "staircases": N, "porch_columns": N, "garage_doors": N}`;

async function loadSymbolImg(filename) {
  try {
    const url  = chrome.runtime.getURL('training/symbols/' + filename);
    const res  = await fetch(url);
    const blob = await res.blob();
    const b64  = await new Promise(function(resolve) {
      const reader = new FileReader();
      reader.onload = function(e) { resolve(e.target.result.split(',')[1]); };
      reader.readAsDataURL(blob);
    });
    return { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64, detail: 'low' } };
  } catch(e) { return null; }
}

// ── Claude (Anthropic) API call ───────────────────────────────────────────────

function buildClaudeImageContent(imgs) {
  const c = [];
  imgs.forEach(function(img, i) {
    const b64  = (typeof img === 'string') ? img : img.base64;
    const mime = (typeof img === 'string') ? 'image/png' : (img.mime || 'image/png');
    if (imgs.length > 1) c.push({ type: 'text', text: 'Page ' + (i + 1) + ':' });
    c.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
  });
  return c;
}

async function callClaudeFocused(claudeKey, sysPrompt, refs, planContent) {
  const refContent = refs.length ? [
    { type: 'text', text: 'REFERENCE EXAMPLES (red boxes show correct symbols in verified plans):' }
  ].concat(refs.map(function(r) {
    const b64  = r.image_url ? r.image_url.url.split(',')[1] : '';
    return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } };
  })) : [];
  const claudePlan = planContent.map(function(c) {
    if (c.type === 'image_url') return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: c.image_url.url.split(',')[1] } };
    return c;
  });
  const userContent = refContent.concat([
    { type: 'text', text: '⚠ This is a NEW floor plan. Count only the element(s) described in the system prompt. Return ONLY the JSON requested.' }
  ]).concat(claudePlan);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 600,
      system: sysPrompt,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(function(){return{};});
    throw new Error('Claude ' + res.status + ': ' + ((e && e.error && e.error.message) || res.statusText));
  }
  const data = await res.json();
  return ((data.content && data.content[0] && data.content[0].text) || '').trim();
}

// ── Gemini (Google) API call ──────────────────────────────────────────────────

function buildGeminiParts(refs, planContent, instructionText) {
  const parts = [];
  if (refs.length) {
    parts.push({ text: 'REFERENCE EXAMPLES (red boxes show correct symbols in verified plans):' });
    refs.forEach(function(r) {
      const b64 = r.image_url ? r.image_url.url.split(',')[1] : '';
      parts.push({ inline_data: { mime_type: 'image/png', data: b64 } });
    });
  }
  parts.push({ text: instructionText });
  planContent.forEach(function(c, i) {
    if (c.type === 'text') { parts.push({ text: c.text }); return; }
    if (c.type === 'image_url') {
      const url = c.image_url.url;
      const comma = url.indexOf(',');
      const mimeMatch = url.match(/data:([^;]+);/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/png';
      parts.push({ inline_data: { mime_type: mime, data: url.slice(comma + 1) } });
    }
  });
  return parts;
}

async function callGeminiFocused(geminiKey, sysPrompt, refs, planContent) {
  const instruction = '⚠ This is a NEW floor plan. Count only the element(s) described below. Return ONLY the JSON requested.\n\n' + sysPrompt;
  const parts = buildGeminiParts(refs, planContent, instruction);
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: parts }] })
  });
  if (!res.ok) {
    const e = await res.json().catch(function(){return{};});
    throw new Error('Gemini ' + res.status + ': ' + ((e && e.error && e.error.message) || res.statusText));
  }
  const data = await res.json();
  return ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '').trim();
}

// ── Split-pass (shared logic, model-agnostic) ─────────────────────────────────

async function runSplitPass(imagesBase64, openaiKey, model, claudeKey, geminiKey) {
  const planContent = buildImageContent(imagesBase64);

  // Load annotated reference images for each pass (fire in parallel)
  const [
    // windows
    bWin1, bWin2, sWin, cWin1, cWin2,
    // interior doors
    sDoors, cDoors1, cDoors2, primBath,
    // exterior doors
    dblDoor, bExt, sExt, cExt,
    // columns / others
    bCol, sanCol, sCol,
    // stairs
    stairRef, stairHand, stairNeg,
  ] = await Promise.all([
    // windows
    loadSymbolImg('bonaire_floor1_15_windows_annotated.png'),
    loadSymbolImg('bonaire_floor2_7_windows_annotated.png'),
    loadSymbolImg('sullivan_10_windows_annotated.png'),
    loadSymbolImg('caroline_floor1_14_windows_annotated.png'),
    loadSymbolImg('caroline_floor2_13_windows_annotated.png'),
    // interior doors
    loadSymbolImg('sullivan_15_interior_doors_annotated.png'),
    loadSymbolImg('caroline_floor1_9_int_doors_annotated.png'),
    loadSymbolImg('caroline_floor2_19_int_doors_annotated.png'),
    loadSymbolImg('primary_bath_5_doors_annotated.png'),
    // exterior doors
    loadSymbolImg('double_door_symbol_examples.png'),
    loadSymbolImg('bonaire_4_ext_doors_annotated.png'),
    loadSymbolImg('sullivan_2_exterior_doors_annotated.png'),
    loadSymbolImg('caroline_3_ext_doors_annotated.png'),
    // columns
    loadSymbolImg('bonaire_7_columns_annotated.png'),
    loadSymbolImg('sanibel_12_porch_columns_annotated.png'),
    loadSymbolImg('sullivan_3_columns_annotated.png'),
    // stairs
    loadSymbolImg('interior_stairs_reference.png'),
    loadSymbolImg('interior_stairs_handdrawn.png'),
    loadSymbolImg('sullivan_plan_0_stairs_0_garage.jpg'),
  ]);

  const windowRefs  = [bWin1, bWin2, sWin, cWin1, cWin2].filter(Boolean);
  const doorRefs    = [sDoors, cDoors1, cDoors2, primBath].filter(Boolean);
  const extDoorRefs = [dblDoor, bExt, sExt, cExt].filter(Boolean);
  const othersRefs  = [bCol, sanCol, sCol, stairRef, stairHand, stairNeg].filter(Boolean);

  async function callFocused(sysPrompt, refs) {
    if (model === 'claude') return callClaudeFocused(claudeKey, sysPrompt, refs, planContent);
    if (model === 'gemini') return callGeminiFocused(geminiKey, sysPrompt, refs, planContent);
    // default: gpt4o
    const refContent = refs.length ? [
      { type: 'text', text: 'REFERENCE EXAMPLES (red boxes show correct symbols in verified plans):' }
    ].concat(refs) : [];
    const userContent = refContent.concat([
      { type: 'text', text: '⚠ This is a NEW floor plan. Count only the element(s) described in the system prompt. Return ONLY the JSON requested.' }
    ]).concat(planContent);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 600, temperature: 0,
        messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userContent }] })
    });
    if (!res.ok) {
      const e = await res.json().catch(function(){return{};});
      throw new Error('OpenAI ' + res.status + ': ' + ((e && e.error && e.error.message) || res.statusText));
    }
    const data = await res.json();
    return (data.choices[0].message.content || '').trim();
  }

  function parseJSON(text) {
    const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
    const m = clean.match(/\{[^{}]+\}/);
    if (!m) return {};
    try { return JSON.parse(m[0]); } catch(e) { return {}; }
  }

  const [winText, doorsText, othersText] = await Promise.all([
    callFocused(WINDOWS_PASS_PROMPT, windowRefs),
    callFocused(INT_DOORS_PASS_PROMPT, doorRefs),
    callFocused(OTHERS_PASS_PROMPT, extDoorRefs.concat(othersRefs)),
  ]);

  console.log('[Duke windows pass]', winText.slice(0, 200));
  console.log('[Duke doors pass]', doorsText.slice(0, 200));
  console.log('[Duke others pass]', othersText.slice(0, 200));
  lastReasoning = 'WINDOWS PASS:\n' + winText + '\n\nINTERIOR DOORS PASS:\n' + doorsText + '\n\nOTHERS PASS:\n' + othersText;

  const win    = parseJSON(winText);
  const doors  = parseJSON(doorsText);
  const others = parseJSON(othersText);

  const merged = {
    exterior_doors: others.exterior_doors || 0,
    windows:        win.windows           || 0,
    baths:          others.baths          || 0,
    staircases:     others.staircases     || 0,
    porch_columns:  others.porch_columns  || 0,
    garage_doors:   others.garage_doors   || 0,
    interior_doors: doors.interior_doors  || 0,
  };

  // Wrap in the {count, locations:[]} shape the rest of the code expects
  const KEYS = ['exterior_doors','windows','baths','staircases','porch_columns','garage_doors','interior_doors'];
  const out = {};
  KEYS.forEach(function(k) { out[k] = { count: merged[k], locations: [] }; });
  return out;
}

async function callGPT4oFromPanel(imagesBase64, openaiKey, useVoting, model, claudeKey, geminiKey) {
  model = model || 'gpt4o';
  if (!useVoting) return runSplitPass(imagesBase64, openaiKey, model, claudeKey, geminiKey);

  const RUNS = 3;
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    try { results.push(await runSplitPass(imagesBase64, openaiKey, model, claudeKey, geminiKey)); }
    catch (e) { console.warn('[Duke vote ' + i + ' failed]', e.message); }
  }
  if (!results.length) throw new Error('All analysis attempts failed.');

  const keys = ['exterior_doors','windows','baths','staircases','porch_columns','garage_doors','interior_doors'];
  const consensus = {};
  keys.forEach(function(k) {
    const counts = results.map(function(r) { return (r[k] && r[k].count) || 0; }).sort(function(a,b){return a-b;});
    const median = counts[Math.floor(counts.length / 2)];
    const bestRun = results.find(function(r) { return r[k] && r[k].count === median; }) || results[0];
    consensus[k] = { count: median, locations: (bestRun[k] && bestRun[k].locations) || [] };
  });
  console.log('[Duke consensus]', JSON.stringify(consensus).slice(0, 200));
  return consensus;
}

// ── Auto-crop whitespace ──────────────────────────────────────────────────────

function autoCropToFloorPlan(base64) {
  return new Promise(function(resolve) {
    const img = new Image();
    img.onload = function() {
      const W = img.width, H = img.height;
      const tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = H;
      const ctx = tmp.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, W, H).data;
      let minX = W, minY = H, maxX = 0, maxY = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (data[i] < 238 || data[i+1] < 238 || data[i+2] < 238) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX <= minX || maxY <= minY) { resolve({ base64: base64 }); return; }
      const pad = 40;
      minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
      maxX = Math.min(W, maxX + pad);  maxY = Math.min(H, maxY + pad);
      const cW = maxX - minX, cH = maxY - minY;
      const out = document.createElement('canvas');
      out.width = cW; out.height = cH;
      out.getContext('2d').drawImage(tmp, minX, minY, cW, cH, 0, 0, cW, cH);
      resolve({ base64: out.toDataURL('image/png').split(',')[1] });
    };
    img.onerror = function() { resolve({ base64: base64 }); };
    img.src = 'data:image/png;base64,' + base64;
  });
}

// ── PDF rendering (uses pdfjsLib from pdfjs-init.js) ─────────────────────────

function waitForPDFjs() {
  if (window.pdfjsReady && window.pdfjsLib) return Promise.resolve();
  return new Promise(function(resolve, reject) {
    const t = setTimeout(function() { reject(new Error('PDF engine not ready. Try uploading a PNG/JPG instead.')); }, 5000);
    document.addEventListener('pdfjs-ready', function() { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Parse page range string → array of 1-based page numbers
// "2-4" → [2,3,4]   "2,3" → [2,3]   "3" → [3]   "" → null (all pages)
function parsePageRange(str, totalPages) {
  if (!str || !str.trim()) return null; // null = all pages
  const nums = new Set();
  str.split(',').forEach(function(part) {
    part = part.trim();
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= Math.min(b, totalPages); i++) nums.add(i);
    } else if (!isNaN(parseInt(part))) {
      const n = parseInt(part);
      if (n >= 1 && n <= totalPages) nums.add(n);
    }
  });
  return nums.size > 0 ? Array.from(nums).sort(function(a,b){return a-b;}) : null;
}

// Auto-detect floor plan pages by looking for room label keywords
// Returns array of page numbers that look like floor plans
async function detectFloorPlanPages(pdf) {
  const floorPlanPages = [];

  // Must have these drawing indicators to be a floor plan page
  const FLOOR_PLAN_SIGNALS = /\b(floor\s*plan|first\s*floor|second\s*floor|third\s*floor|main\s*level|upper\s*level|a1\.|a2\.|a1\.1|a1\.2|sheet\s*a)/i;

  // Disqualify pages that look like spec/cover/detail sheets
  const SPEC_SHEET_SIGNALS = /\b(included\s*features|specifications|copyright\s*notice|general\s*notes|drawing\s*index|cover\s*sheet|elevation|section|electrical|plumbing|mechanical|detail|schedule|legend|symbol|not\s*for\s*construction.*cover)\b/i;

  for (let p = 1; p <= pdf.numPages; p++) {
    try {
      const page    = await pdf.getPage(p);
      const content = await page.getTextContent();
      const text    = content.items.map(function(i) { return i.str; }).join(' ');

      const isFloorPlan = FLOOR_PLAN_SIGNALS.test(text);
      const isSpecSheet = SPEC_SHEET_SIGNALS.test(text);

      // Page must look like a floor plan AND not look like a spec/cover sheet
      if (isFloorPlan && !isSpecSheet) floorPlanPages.push(p);
    } catch (_) {}
  }

  // Fallback: if nothing detected, use all pages (capped at 6)
  if (floorPlanPages.length === 0) {
    const total = Math.min(pdf.numPages, 6);
    for (let i = 1; i <= total; i++) floorPlanPages.push(i);
  }
  return floorPlanPages;
}

async function renderPDFInPanel(base64String, pageRangeStr) {
  await waitForPDFjs();
  const binary = atob(base64String);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

  // Determine which pages to render
  let pagesToRender;
  const rangeFromInput = parsePageRange(pageRangeStr, pdf.numPages);
  if (rangeFromInput) {
    pagesToRender = rangeFromInput;
    setProgress(15, 'Rendering pages ' + pageRangeStr + '…');
  } else {
    setProgress(12, 'Detecting floor plan pages…');
    pagesToRender = await detectFloorPlanPages(pdf);
    setProgress(18, 'Found floor plan pages: ' + pagesToRender.join(', '));
  }

  const pages = [];
  for (let idx = 0; idx < pagesToRender.length; idx++) {
    const p        = pagesToRender[idx];
    const page     = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2.5 });
    const canvas   = document.createElement('canvas');
    canvas.width   = Math.round(viewport.width);
    canvas.height  = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    pages.push(canvas.toDataURL('image/png').split(',')[1]);
    canvas.remove();
    setProgress(18 + Math.round((idx + 1) / pagesToRender.length * 40), 'Rendered page ' + p + ' of ' + pdf.numPages);
  }
  return pages;
}

// ── Upload Plans ──────────────────────────────────────────────────────────────

let uploadedFiles = [];

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function readFileAsBase64(file) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload  = function(e) { resolve(e.target.result.split(',')[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function openUploadedFile(f) {
  try {
    var mime  = f.mimeType || (f.isPDF ? 'application/pdf' : 'image/png');
    var bytes = atob(f.base64);
    var arr   = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    var blob  = new Blob([arr], { type: mime });
    var url   = URL.createObjectURL(blob);
    chrome.tabs.create({ url: url });
  } catch (e) { showStatus('Could not open file: ' + e.message, 'error', 3000); }
}

function renderUploadList() {
  var list = $('upload-file-list');
  list.innerHTML = '';
  uploadedFiles.forEach(function(f, i) {
    var item = document.createElement('div');
    item.className = 'upload-file-item';
    var nameSpan = document.createElement('span');
    nameSpan.className = 'fname';
    nameSpan.title = 'Click to open ' + f.name;
    nameSpan.textContent = f.name;
    nameSpan.style.cssText = 'cursor:pointer;text-decoration:underline;color:#2b6cb0';
    nameSpan.dataset.idx = i;
    var metaSpan = document.createElement('span');
    metaSpan.className = 'fmeta';
    metaSpan.textContent = formatBytes(f.size) + (f.isPDF ? ' · PDF' : '');
    var removeSpan = document.createElement('span');
    removeSpan.className = 'fremove';
    removeSpan.title = 'Remove';
    removeSpan.textContent = '✕';
    removeSpan.dataset.idx = i;
    item.appendChild(nameSpan);
    item.appendChild(metaSpan);
    item.appendChild(removeSpan);
    list.appendChild(item);
  });
  list.querySelectorAll('.fname').forEach(function(el) {
    el.addEventListener('click', function(e) {
      openUploadedFile(uploadedFiles[parseInt(e.target.dataset.idx)]);
    });
  });
  list.querySelectorAll('.fremove').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      uploadedFiles.splice(parseInt(e.target.dataset.idx), 1);
      if (uploadedFiles.length === 0) $('upload-info').classList.add('hidden');
      else renderUploadList();
    });
  });
  $('upload-info').classList.remove('hidden');
}

async function handleFiles(fileList) {
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (!allowed.includes(file.type) && !file.name.endsWith('.pdf')) continue;
    const base64 = await readFileAsBase64(file);
    const isPDF  = file.type === 'application/pdf' || file.name.endsWith('.pdf');
    uploadedFiles.push({ name: file.name, size: file.size, base64: base64, mimeType: file.type, isPDF: isPDF });
  }
  if (uploadedFiles.length > 0) renderUploadList();
}

function setProgress(pct, label) {
  $('progress-bar').style.width = pct + '%';
  $('progress-label').textContent = label;
  if (pct > 0) $('upload-progress').classList.remove('hidden');
}

// ── PDF.js ready indicator ────────────────────────────────────────────────────

function initPDFjsIndicator() {
  const bar   = $('pdfjs-bar');
  const label = $('pdfjs-label');
  if (!bar || !label) return;

  if (window.pdfjsReady) {
    bar.classList.add('ready');
    label.classList.add('ready');
    label.textContent = '✓ PDF Engine Ready';
    return;
  }

  bar.classList.add('loading');
  label.textContent = 'Loading PDF engine…';

  const poll = setInterval(function() {
    if (window.pdfjsReady) {
      clearInterval(poll);
      bar.classList.remove('loading');
      bar.classList.add('ready');
      label.classList.add('ready');
      label.textContent = '✓ PDF Engine Ready';
      const btn = $('btn-analyze-upload');
      if (btn) btn.disabled = false;
    }
  }, 150);

  setTimeout(function() {
    if (!window.pdfjsReady) {
      clearInterval(poll);
      bar.style.background = '#fc8181';
      bar.classList.remove('loading');
      bar.style.width = '100%';
      label.textContent = 'PDF unavailable — upload PNG/JPG instead';
      label.style.color = '#e53e3e';
      const btn = $('btn-analyze-upload');
      if (btn) btn.disabled = false;
    }
  }, 4000);
}

function initUploadPanel() {
  const analyzeBtn = $('btn-analyze-upload');
  if (analyzeBtn && !window.pdfjsReady) analyzeBtn.disabled = true;
  initPDFjsIndicator();

  const dropZone  = $('drop-zone');
  const fileInput = $('file-input');
  if (!dropZone || !fileInput) return;

  dropZone.addEventListener('dragover',  function(e) { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', function()  { dropZone.classList.remove('drag-over'); });
  dropZone.addEventListener('drop', function(e) {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', function() { handleFiles(fileInput.files); fileInput.value = ''; });
  $('btn-browse').addEventListener('click', function(e) { e.stopPropagation(); fileInput.click(); });
  $('btn-analyze-upload').addEventListener('click', analyzeUploads);
  $('btn-clear-upload').addEventListener('click', function() {
    uploadedFiles = [];
    $('upload-info').classList.add('hidden');
    $('upload-progress').classList.add('hidden');
    $('progress-bar').style.width = '0%';
  });
}

async function analyzeUploads() {
  if (!uploadedFiles.length) { showStatus('Add a file first', 'error', 3000); return; }
  const cfg = await new Promise(function(r) { chrome.storage.local.get(['openaiKey','claudeKey','geminiKey'], r); });

  const modelSel = $('ai-model-select');
  const model = modelSel ? modelSel.value : 'gpt4o';
  const modelNames = { gpt4o: 'GPT-4o', claude: 'Claude 3.5 Sonnet', gemini: 'Gemini 2.0 Flash' };
  const modelLabel = modelNames[model] || 'GPT-4o';

  if (model === 'gpt4o' && !cfg.openaiKey) { showStatus('Add your OpenAI API key in ⚙ Settings first', 'error', 5000); return; }
  if (model === 'claude' && !cfg.claudeKey) { showStatus('Add your Anthropic (Claude) API key in ⚙ Settings first', 'error', 5000); return; }
  if (model === 'gemini' && !cfg.geminiKey) { showStatus('Add your Google Gemini API key in ⚙ Settings first', 'error', 5000); return; }

  const btn = $('btn-analyze-upload');
  btn.disabled = true; btn.textContent = 'Analyzing…';
  $('ai-results').classList.add('hidden');
  $('ai-loading').classList.remove('hidden');
  setProgress(5, 'Preparing files…');

  try {
    const allImages = []; // array of {base64, mime}
    for (let fi = 0; fi < uploadedFiles.length; fi++) {
      const f   = uploadedFiles[fi];
      const pct = Math.round((fi / uploadedFiles.length) * 55) + 5;
      setProgress(pct, 'Processing ' + f.name + '…');
      if (f.isPDF) {
        const pageRangeStr = ($('page-range-input') && $('page-range-input').value.trim()) || '';
        const pages = await renderPDFInPanel(f.base64, pageRangeStr);
        setProgress(pct + 10, f.name + ': ' + pages.length + ' floor plan page(s) ready');
        pages.forEach(function(p) { allImages.push({ base64: p, mime: 'image/png' }); });
      } else {
        // Use the actual file MIME type — critical for JPEG files
        const mime = f.mimeType || 'image/png';
        allImages.push({ base64: f.base64, mime: mime });
      }
    }
    if (!allImages.length) throw new Error('No pages could be extracted.');

    const MAX_PAGES   = 6;
    const pagesToSend = allImages.slice(0, MAX_PAGES);
    if (allImages.length > MAX_PAGES) showStatus('Large PDF: using first ' + MAX_PAGES + ' of ' + allImages.length + ' pages', 'info', 4000);

    const useVoting = $('chk-vote') && $('chk-vote').checked;
    setProgress(70, useVoting ? 'Running 3× majority vote…' : 'Sending to ' + modelLabel + '…');
    showStatus(modelLabel + ' analyzing plan…', 'info', 0);
    const result = await callGPT4oFromPanel(pagesToSend, cfg.openaiKey, useVoting, model, cfg.claudeKey, cfg.geminiKey);

    setProgress(100, 'Done!');
    lastAiResult    = result;
    lastImageBase64 = pagesToSend[0].base64 || pagesToSend[0];
    lastImageMime   = pagesToSend[0].mime   || 'image/png';

    displayAiResults(result, modelLabel + ' · ' + pagesToSend.length + ' page' + (pagesToSend.length > 1 ? 's' : ''));
    showStatus('✓ Done — ' + pagesToSend.length + ' page(s) analyzed', 'success');

  } catch (e) {
    showStatus('Error: ' + e.message, 'error', 10000);
  } finally {
    btn.disabled = false; btn.textContent = 'Analyze Plan';
    $('ai-loading').classList.add('hidden');
    setTimeout(function() { $('upload-progress').classList.add('hidden'); }, 2500);
  }
}

// ── AI Plan Analysis (from BuilderTrend tab) ──────────────────────────────────

async function runAiAnalysis() {
  $('ai-loading').classList.remove('hidden');
  $('ai-results').classList.add('hidden');
  $('btn-analyze').disabled = true;

  try {
    showStatus('Fetching PDF from BuilderTrend…', 'info', 0);
    try {
      const pdfRes = await sendMsg('ANALYZE_PDF');
      lastAiResult    = pdfRes.result;
      lastImageBase64 = null;
      lastImageMime   = 'image/png';
      displayAiResults(pdfRes.result, 'Full PDF · ' + (pdfRes.pages || 1) + ' page(s)');
      showStatus('✓ Analyzed full PDF at full resolution', 'success');
      return;
    } catch (pdfErr) {
      showStatus('PDF grab failed — falling back to screenshot…', 'info', 0);
    }

    showStatus('Capturing plan screenshot…', 'info', 0);
    const imageData = await sendMsg('CAPTURE_TAB_SCREENSHOT');
    if (!imageData || !imageData.base64) throw new Error('Could not capture plan. Make sure the BuilderTrend takeoff page is open.');

    lastImageBase64 = imageData.base64;
    lastImageMime   = imageData.mimeType || 'image/png';
    showStatus('Sending to GPT-4o…', 'info', 0);
    const res = await sendMsg('ANALYZE_PLAN', { imageBase64: lastImageBase64, mimeType: lastImageMime });
    lastAiResult = res.result;
    displayAiResults(res.result, 'Screenshot');
    showStatus('✓ Analysis complete', 'success');

  } catch (e) {
    showStatus('Error: ' + e.message, 'error', 8000);
  } finally {
    $('ai-loading').classList.add('hidden');
    $('btn-analyze').disabled = false;
  }
}

function displayAiResults(result, badge) {
  if (badge) { var b = $('ai-confidence'); if (b) b.textContent = badge; }
  var grid = $('ai-grid');
  grid.innerHTML = "";

  // Store corrected counts (start equal to AI counts, user can adjust)
  if (!lastAiResult) lastAiResult = result;

  Object.keys(AI_LABELS).forEach(function(key) {
    var rawCount = result[key] ? result[key].count : 0;
    var isHalf   = (rawCount % 1 !== 0); // e.g. baths = 3.5
    var count    = typeof rawCount === 'number' ? rawCount : 0;

    var item = document.createElement('div');
    item.className = 'ai-item';

    if (isHalf) {
      // Non-integer (baths): show static value, no stepper
      item.innerHTML =
        '<span class="ai-item-label">' + AI_LABELS[key] + '</span>' +
        '<span class="ai-adj-val">' + count + '</span>';
    } else {
      item.innerHTML =
        '<span class="ai-item-label">' + AI_LABELS[key] + '</span>' +
        '<div class="ai-item-adj">' +
          '<button class="ai-adj-btn" data-key="' + key + '" data-delta="-1">−</button>' +
          '<span class="ai-adj-val" data-key="' + key + '">' + count + '</span>' +
          '<button class="ai-adj-btn" data-key="' + key + '" data-delta="1">+</button>' +
        '</div>';
    }
    grid.appendChild(item);
  });

  // +/− button handlers
  grid.querySelectorAll('.ai-adj-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key   = btn.dataset.key;
      var delta = parseInt(btn.dataset.delta);
      var val   = lastAiResult[key] ? (lastAiResult[key].count || 0) : 0;
      val = Math.max(0, val + delta);
      lastAiResult[key] = { count: val, locations: [] };
      var span = grid.querySelector('.ai-adj-val[data-key="' + key + '"]');
      if (span) span.textContent = val;
      // Keep manual inputs and grab grid in sync
      var mapKey = AI_KEY_MAP[key];
      if (mapKey) {
        var input = document.querySelector('.manual-row input[data-key="' + mapKey + '"]');
        if (input) input.value = val;
      }
      mergeAiIntoGrab(lastAiResult);
    });
  });

  $('ai-results').classList.remove('hidden');
  // Reasoning toggle
  var rBox = $('ai-reasoning');
  var rBtn = $('btn-show-reasoning');
  if (rBox && rBtn) {
    rBox.classList.add('hidden');
    rBtn.textContent = 'Show Reasoning ▾';
    if (lastReasoning) {
      var stripped = lastReasoning.replace(/\{[\s\S]*\}[\s]*$/, "").trim();
      rBox.textContent = stripped.length > 10 ? stripped : "GPT skipped reasoning — counts only returned.";
      rBtn.style.display = "";
    } else {
      rBtn.style.display = "none";
    }
  }
  // Pre-fill manual inputs
  Object.keys(AI_KEY_MAP).forEach(function(key) {
    var count = result[key] && result[key].count;
    if (count !== undefined) {
      var input = document.querySelector('.manual-row input[data-key="' + AI_KEY_MAP[key] + '"]');
      if (input) input.value = count;
    }
  });

  // Merge AI counts into the grab section if it is visible
  mergeAiIntoGrab(result);
}

function mergeAiIntoGrab(result) {
  var grabResults = $('grab-results');
  if (!grabResults || grabResults.classList.contains('hidden')) return;
  var grid = $('grab-grid');
  if (!grid) return;
  // Update grab grid items whose keys match AI results
  Object.keys(AI_KEY_MAP).forEach(function(aiKey) {
    var grabKey = AI_KEY_MAP[aiKey];
    var count = result[aiKey] && result[aiKey].count;
    if (count === undefined || count === null) return;
    // Find the grab item for this key by label text
    var grabLabel = GRAB_LABELS[grabKey];
    if (!grabLabel) return;
    var items = grid.querySelectorAll('.grab-item');
    items.forEach(function(item) {
      var lbl = item.querySelector('.g-label');
      if (lbl && lbl.textContent === grabLabel) {
        var valEl = item.querySelector('.g-val');
        if (valEl) {
          valEl.textContent = count;
          item.classList.toggle('zero', count === 0);
          // also update grabbedData so Write All to Sheet sends correct value
          if (typeof grabbedData !== 'undefined') grabbedData[grabKey] = count;
        }
      }
    });
  });
  $('grab-status').textContent = 'AI counts merged in — press Write All to Sheet to save';
}

async function writeAiToSheet() {
  if (!lastAiResult) return;
  const values = {};
  for (const key in AI_KEY_MAP) {
    const count = lastAiResult[key] && lastAiResult[key].count;
    if (count !== undefined && count !== null) values[AI_KEY_MAP[key]] = count;
  }
  showStatus('Writing AI counts to sheet…', 'info', 0);
  try {
    const res = await sendMsg('WRITE_VALUES', { values: values });
    showStatus('✓ Wrote ' + res.written + ' values to sheet', 'success');
    setTimeout(function() { loadSheetTab(activeTab); }, 1200);
  } catch (e) {
    showStatus('Write error: ' + e.message, 'error', 6000);
  }
}

// ── Grab Takeoff ──────────────────────────────────────────────────────────────

const GRAB_LABELS = {
  // Areas (from takeoff)
  'basement':                 'Basement',
  '1st floor':                '1st Floor',
  '2nd floor':                '2nd Floor',
  '3rd floor':                '3rd Floor',
  'attic with storage':       'Attic w/ Storage',
  'habitable attic':          'Habitable Attic',
  'front porch':              'Front Porch',
  'rear porch':               'Rear Porch',
  'rear deck':                'Rear Deck',
  'garage':                   'Garage',
  'cabinets lf':              'Cabinets LF',
  'countertops lf':           'Countertops LF',
  // Counts (from AI analysis + takeoff)
  '# of exterior doors':      '# Exterior Doors',
  '# of interior doors':      '# Interior Doors',
  '# of windows':             '# Windows',
  '# of baths':               '# Baths',
  '# of staircases':          '# Staircases',
  '# of front porch columns': '# Porch Columns',
  '# of garage doors':        '# Garage Doors',
  // Flooring
  'sf of carpet':             'SF Carpet',
  'sf of hardwood':           'SF Hardwood',
  'sf of tile':               'SF Tile',
};

let grabbedData = {};

async function grabTakeoff() {
  const btn = $('btn-write-grab');
  btn.disabled = true; btn.textContent = 'Scanning…';
  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(function(t) { return t.url && t.url.includes('squaretakeoff'); })
             || tabs.find(function(t) { return t.url && t.url.includes('buildertrend'); })
             || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab) throw new Error('No SquareTakeoff or BuilderTrend tab found.');

    try {
      const probe = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () { return !!window.__dukeListenerRegistered; }
      });
      if (!probe[0]?.result) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      }
    } catch (_) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch (_2) {}
    }

    const res = await new Promise(function (resolve, reject) {
      chrome.tabs.sendMessage(tab.id, { action: 'GRAB_TAKEOFF' }, { frameId: 0 }, function (r) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!r) { reject(new Error('No response from content script')); return; }
        resolve(r);
      });
    });
    if (!res.ok) throw new Error(res.error || 'Scrape failed');

    grabbedData = res.data;
    const found = res.found || 0;
    showStatus('✓ Grabbed ' + found + ' takeoff value(s)', 'success');
  } catch (e) {
    showStatus('Grab failed: ' + e.message, 'error', 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Grab & Write to Sheet';
  }
}

// ── Write to Estimate ─────────────────────────────────────────────────────────

let _writeTabId = null;

function stopWrite() {
  if (_writeTabId) {
    chrome.scripting.executeScript({
      target: { tabId: _writeTabId },
      func: function() { window.__dukeWriteStop = true; }
    }).catch(function(){});
  }
}

async function writeToEstimate() {
  const btn = $('btn-write-estimate');
  const stopBtn = $('btn-stop-write');
  const logEl = $('estimate-log');
  btn.disabled = true; btn.textContent = 'Working…';
  if (stopBtn) { stopBtn.style.display = 'inline-block'; }
  logEl.textContent = ''; logEl.classList.remove('hidden');
  const lender = $('chk-lender') && $('chk-lender').checked;

  function log(msg) {
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  try {
    log('Reading sheet values…');
    const cells = await sendMsg('READ_CELLS_BATCH', {
      ranges: ['I13','D32','D46','D50','D56','D59','D62','D68','I9','I10','I11',
               'I18','I19','I23','I24','I26',
               'D86','D88','D89','D90','D91','D92','D93','D94','D99']
    });
    const c = cells.data;
    const n = function(v) { return parseFloat(String(v || '0').replace(/[^0-9.-]/g, '')) || 0; };

    const items = [
      { name: 'Total Fixed Cost',                                                    qty: 1 },
      { name: 'Total Finished SF & Unfinished (Under Roof)',                         qty: n(c['I13']) },
      { name: 'Total Finished SF',                                                   qty: n(c['D46']) },
      { name: 'Total Finished SF & Unfinished SF (Under Roof Excluding Porches)',     qty: n(c['D32']) },
      { name: 'Total Garage SF',                                                     qty: n(c['D62']) },
      { name: 'Total 1st Floor Finished, 1st Floor Unfinished & Garage',            qty: n(c['D56']) },
      { name: 'Total 1st Floor, Garage & Porch SF',                                 qty: n(c['D50']) },
      { name: 'Total Finished 1st Floor SF',                                        qty: n(c['D59']) },
      { name: 'Total for Decks & Porches',                                          qty: n(c['I9']) + n(c['I10']) + n(c['I11']) },
      { name: 'Interior Stairs',    qty: n(c['I23']) },
      { name: 'Exterior Doors',     qty: n(c['I18']) },
      { name: 'Windows',            qty: n(c['I19']) },
      { name: 'Porch Columns',      qty: n(c['I24']) },
      { name: 'Interior Doors',     qty: n(c['I26']) },
      { name: 'Garage Door',        qty: n(c['D68']) },
      { name: 'Number of Baths',    qty: n(c['D93']) },
      { name: 'Accessories Allowance',       qty: n(c['D86']) },
      { name: 'Appliance Allowance',         qty: 1 },
      { name: 'Cabinet Allowance',           qty: n(c['D88']) },
      { name: 'Carpet Allowance',            qty: n(c['D89']) },
      { name: 'Countertop Allowance',        qty: n(c['D90']) },
      { name: 'Hardwood Flooring Allowance', qty: n(c['D91']) },
      { name: 'Lighting Fixture Allowance',  qty: n(c['D92']) },
      { name: 'Plumbing Fixture Allowance',  qty: n(c['D93']) },
      { name: 'Tile Allowance',              qty: n(c['D94']) },
      { name: 'Clearing Allowance',    qty: 1 },
      { name: 'Driveway Allowance',    qty: 1 },
      { name: 'Landscaping Allowance', qty: n(c['D99']) },
      { name: 'Tap Fees',              qty: 1 },
    ];
    if (lender) items.push({ name: 'Preferred Lender Incentive', qty: 1 });

    // Read site option dropdowns from extension panel
    const EXT_SITE_MAP = {
      'ext-so-sewer': {
        'City (No Septic)':    { row: 2,  parentGroup: '11 - Septic/Sewer',           title: 'Sewer - City (No Septic)',          existingLine: null },
        'Conventional Septic': { row: 3,  parentGroup: '11 - Septic/Sewer',           title: 'Sewer - Conventional Septic',       existingLine: null },
        'Engineered Septic':   { row: 4,  parentGroup: '11 - Septic/Sewer',           title: 'Sewer - Engineered Septic',         existingLine: null },
      },
      'ext-so-water': {
        'Well':                { row: 6,  parentGroup: 'Well Allowance',               title: 'Water - Well',                      existingLine: null },
      },
      'ext-so-tap': {
        'None (Well/Septic)':  { row: 7,  parentGroup: '06 - Municipal Tap Fees',     title: 'Municipal Tap Fees - None (Well/Septic)', existingLine: 'Tap Fees' },
        'Standard (12K)':      { row: 8,  parentGroup: '06 - Municipal Tap Fees',     title: 'Municipal Tap Fees - Standard',     existingLine: 'Tap Fees' },
        'High (18K)':          { row: 9,  parentGroup: '06 - Municipal Tap Fees',     title: 'Municipal Tap Fees - High',         existingLine: 'Tap Fees' },
      },
      'ext-so-clearing': {
        'Light':               { row: 10, parentGroup: '09 - Lot Clearing/Site Prep', title: 'Lot Clearing - Light',              existingLine: 'Clearing Allowance' },
        'Moderate':            { row: 11, parentGroup: '09 - Lot Clearing/Site Prep', title: 'Lot Clearing - Moderate',           existingLine: 'Clearing Allowance' },
        'Heavy':               { row: 12, parentGroup: '09 - Lot Clearing/Site Prep', title: 'Lot Clearing - Heavy',              existingLine: 'Clearing Allowance' },
      },
      'ext-so-driveway': {
        'Short Gravel':        { row: 13, parentGroup: 'Driveway Allowance',           title: 'Driveway - Short Gravel',           existingLine: 'Driveway Allowance' },
        'Standard (Gravel)':   { row: 14, parentGroup: 'Driveway Allowance',           title: 'Driveway - Standard (Gravel)',      existingLine: 'Driveway Allowance' },
        'Long Gravel':         { row: 15, parentGroup: 'Driveway Allowance',           title: 'Driveway - Long Gravel',            existingLine: 'Driveway Allowance' },
        'Asphalt':             { row: 16, parentGroup: 'Driveway Allowance',           title: 'Driveway - Asphalt',               existingLine: 'Driveway Allowance' },
      },
      'ext-so-landscaping': {
        'Basic':               { row: 17, parentGroup: '62 - Landscaping',             title: 'Landscaping - Basic',               existingLine: 'Landscaping Allowance' },
        'Standard':            { row: 18, parentGroup: '62 - Landscaping',             title: 'Landscaping - Standard',            existingLine: 'Landscaping Allowance' },
        'Extensive':           { row: 19, parentGroup: '62 - Landscaping',             title: 'Landscaping - Extensive',           existingLine: 'Landscaping Allowance' },
      },
    };
    const selectedSiteItems = [];
    Object.keys(EXT_SITE_MAP).forEach(function(id) {
      const el = document.getElementById(id);
      const val = el ? el.value : '';
      const map = EXT_SITE_MAP[id];
      if (val && map && map[val]) {
        const entry = map[val];
        selectedSiteItems.push({ name: entry.title, row: entry.row, parentGroup: entry.parentGroup, existingLine: entry.existingLine || null });
      }
    });

    const siteOptions = [];
    if (selectedSiteItems.length) {
      log('Reading SITE OPTIONS pricing…');
      const soResp = await sendMsg('READ_CELLS_RANGE_TAB', { tab: 'SITE OPTIONS', range: 'C2:C19' });
      const cRows = soResp.data || [];
      selectedSiteItems.forEach(function(item) {
        const rowData = cRows[item.row - 2];
        const unitCost = parseFloat(String((rowData && rowData[0]) || '0').replace(/[^0-9.-]/g, '')) || 0;
        siteOptions.push({ name: item.name, parentGroup: item.parentGroup, unitCost: unitCost, existingLine: item.existingLine });
      });
    }

    // Read custom selection allowances from static Write to Estimate panel
    const customItems = [];
    document.querySelectorAll('#ext-custom-rows .ext-custom-row').forEach(function(row) {
      const name  = (row.querySelector('.ext-custom-name')  || {}).value || '';
      const price = parseFloat((row.querySelector('.ext-custom-price') || {}).value || '0') || 0;
      if (name.trim() && price > 0) customItems.push({ name: name.trim(), unitCost: price });
    });

    log('Found ' + items.length + ' items to write. Opening BuilderTrend…');

    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(function(t) { return t.url && t.url.includes('buildertrend') && t.url.toLowerCase().includes('estimate'); })
             || tabs.find(function(t) { return t.url && t.url.includes('buildertrend'); });
    if (!tab) throw new Error('No BuilderTrend Estimate tab found. Open buildertrend.net/app/Estimate.');

    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise(function(r) { setTimeout(r, 400); });

    _writeTabId = tab.id;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function() { window.__dukeWriteStop = false; }
    }).catch(function(){});

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async function(itemsList, siteOptionsList, customItemsList) { try {
        var _log = [];
        var _delay = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

        function reactSet(input, val) {
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, String(val));
          input.dispatchEvent(new Event('input',  { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        async function setQty(name, qty, isUnitCost) {
          var needle = name.toLowerCase();
          var words = needle.split(/\s+/).filter(Boolean);
          var startTime = performance.now();
          var stepStartTime = startTime;

          function logTiming(label) {
            var elapsed = performance.now() - stepStartTime;
            console.log('[TIMING] ' + label + ' — ' + elapsed.toFixed(0) + 'ms');
            stepStartTime = performance.now();
          }

          // Smart wait: detect when modal closes instead of blind waiting
          function waitForModalClose(maxWaitMs) {
            maxWaitMs = maxWaitMs || 2000;
            return new Promise(function(resolve) {
              var startWait = performance.now();
              var checkInterval = setInterval(function() {
                var modal = document.querySelector('.ant-modal-wrap, .ant-modal-root, [class*="modal"][class*="show"]');
                var elapsed = performance.now() - startWait;

                if (!modal || elapsed >= maxWaitMs) {
                  clearInterval(checkInterval);
                  resolve(elapsed);
                }
              }, 50); // Check every 50ms
            });
          }

          // 1. Focus the correct Ant Design Select search input (line items search)
          // Retry up to 20x (2s total) in case the page hasn't rendered it yet
          var si = null;
          for (var wi = 0; wi < 20; wi++) {
            // Primary: try rc_select_17 (current correct ID next to "Collapse all")
            si = document.getElementById('rc_select_17');

            // Secondary: try legacy ID
            if (!si) si = document.getElementById('rc_select_1');

            // Tertiary: find by context (next to "Collapse all" button)
            if (!si) {
              var collapseBtn = Array.from(document.querySelectorAll('button')).find(function(btn) {
                return btn.textContent && btn.textContent.includes('Collapse all');
              });
              if (collapseBtn) {
                var parent = collapseBtn.closest('[class*="header"], [class*="control"], div');
                if (parent) si = parent.querySelector('input[role="combobox"].ant-select-selection-search-input');
              }
            }

            // Fallback: find by excluding rc_select_0 and other non-line-item searches
            if (!si) {
              var candidates = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
              // Filter: skip rc_select_0 (wrong one), savedFilterDropdown, and numbered IDs
              candidates = candidates.filter(function(el) {
                var id = el.id || '';
                return id && id.startsWith('rc_select_') && id !== 'rc_select_0' && id !== 'savedFilterDropdown' && !id.match(/^\d+$/);
              });
              si = candidates[0];
            }

            if (si) break;
            await _delay(100);
          }
          logTiming('Found search bar (retries)');
          if (!si) { _log.push('✗ ' + name + ' — search bar not found'); return; }

          // Click the parent .ant-select-selector container to open the dropdown first
          var container = si.closest('.ant-select-selector') || si.parentElement;
          if (container) { container.click(); await _delay(200); }

          si.focus();
          await _delay(100);

          // Type the name to filter — use nativeSetter so React picks up the change
          var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(si, name);
          si.dispatchEvent(new Event('input',  { bubbles: true }));
          si.dispatchEvent(new Event('change', { bubbles: true }));
          stepStartTime = performance.now();
          await _delay(500);
          logTiming('Waited for dropdown after typing name (500ms)');

          // 2. Click the matching LineItem result (skip Group results)
          var opts = document.querySelectorAll('.LineItemResult.LineItem');
          var clicked = false;
          for (var o = 0; o < opts.length; o++) {
            var optTxt = (opts[o].innerText || '').trim().toLowerCase();
            if (words.every(function(w){ return optTxt.includes(w); })) {
              opts[o].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              opts[o].dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
              opts[o].click();
              clicked = true;
              break;
            }
          }
          if (!clicked) { _log.push('○ ' + name + ' — not in dropdown'); return; }

          // 3. Find the ValueDisplay whose text matches the item name, skipping group header rows
          // Retry up to 15 times (1.5s total) to handle virtual scroll rendering delay
          var el = null;

          function isInGroupHeader(node) {
            var ownCls = node.className || '';
            if (ownCls.includes('proposalFormatGroupCellTitle') || ownCls.includes('proposalFormatGroupCellTitleReadonly')) return true;
            var n = node.parentElement;
            while (n && n !== document.body) {
              var c = n.className || '';
              if (c.includes('WorksheetGroupCellActions') || c.includes('proposalFormatGroupCell')) return true;
              n = n.parentElement;
            }
            return false;
          }

          function findValueDisplay() {
            var vds = document.querySelectorAll('.ValueDisplay');
            // Pass 1: exact match
            for (var v = 0; v < vds.length; v++) {
              if (!vds[v].offsetHeight || isInGroupHeader(vds[v])) continue;
              if ((vds[v].innerText || '').trim().toLowerCase() === needle) return vds[v];
            }
            // Pass 2: word match
            for (var v2 = 0; v2 < vds.length; v2++) {
              if (!vds[v2].offsetHeight || isInGroupHeader(vds[v2])) continue;
              var t = (vds[v2].innerText || '').trim().toLowerCase();
              if (words.every(function(w) { return t.includes(w); })) return vds[v2];
            }
            return null;
          }

          // Retry up to 15x (100ms each) to handle virtual scroll rendering delay
          stepStartTime = performance.now();
          for (var attempt = 0; attempt < 15; attempt++) {
            el = findValueDisplay();
            if (el) break;
            await _delay(100);
          }
          logTiming('Found ValueDisplay (retries: ' + attempt + ')');
          if (!el) { _log.push('○ ' + name + ' — ValueDisplay not found'); return; }

          // 4. Click the ValueDisplay to open the qty/cost popup
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          await _delay(300);
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
          el.click();
          stepStartTime = performance.now();
          await _delay(400);
          logTiming('Waited for popup after clicking ValueDisplay (400ms)');

          // 5. Find the input — unit cost field for Realtor Fees, qty spinbutton for everything else
          stepStartTime = performance.now();
          var qtyInput = null;
          if (isUnitCost) {
            qtyInput = document.querySelector('input[data-testid="unitCost"], input#unitCost');
          }
          if (!qtyInput) {
            qtyInput = document.querySelector('input[role="spinbutton"].ant-input-number-input')
                    || document.querySelector('input[role="spinbutton"]')
                    || document.querySelector('input.ant-input-number-input');
          }
          logTiming('Found qty input');
          if (!qtyInput) { _log.push('○ ' + name + ' — qty input not found (popup may not have opened)'); return; }

          // 6. Focus, clear, then type each character so React state updates properly
          qtyInput.focus();
          await _delay(150);

          // Select all and delete existing value
          qtyInput.select();
          qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, ctrlKey: true, bubbles: true }));
          await _delay(50);
          qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', keyCode: 46, bubbles: true }));
          reactSet(qtyInput, '');
          qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
          await _delay(100);

          // Type each character of the value — round to 2 decimal places
          var roundedQty = Math.round(qty * 100) / 100;
          var valStr = String(roundedQty);
          var setter2 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          stepStartTime = performance.now();
          for (var ci = 0; ci < valStr.length; ci++) {
            var ch = valStr[ci];
            var code = ch.charCodeAt(0);
            qtyInput.dispatchEvent(new KeyboardEvent('keydown',  { key: ch, keyCode: code, bubbles: true }));
            qtyInput.dispatchEvent(new KeyboardEvent('keypress', { key: ch, keyCode: code, bubbles: true }));
            setter2.call(qtyInput, valStr.slice(0, ci + 1));
            qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
            qtyInput.dispatchEvent(new KeyboardEvent('keyup',    { key: ch, keyCode: code, bubbles: true }));
            await _delay(20);
          }
          await _delay(200);
          logTiming('Typed ' + valStr.length + ' characters (40ms each)');

          // 7. Click the Save button to persist the value
          stepStartTime = performance.now();
          var saveBtn = document.querySelector('[data-testid="saveButton"], #saveButton');
          if (!saveBtn) {
            // Wait up to 1.5s for it to appear
            for (var s = 0; s < 15; s++) {
              await _delay(100);
              saveBtn = document.querySelector('[data-testid="saveButton"], #saveButton');
              if (saveBtn) break;
            }
          }
          logTiming('Found save button');
          if (saveBtn) {
            saveBtn.click();
            stepStartTime = performance.now();
            var actualWait = await waitForModalClose(2000);
            logTiming('Smart wait: modal closed (' + actualWait.toFixed(0) + 'ms)');
          } else {
            // Fallback: Enter to submit
            qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            stepStartTime = performance.now();
            await _delay(500);
            logTiming('Fallback: Enter submit (500ms)');
          }

          var totalTime = performance.now() - startTime;
          console.log('[TIMING] TOTAL for ' + name + ': ' + totalTime.toFixed(0) + 'ms');
          _log.push('✓ ' + name + ' → ' + qty + (isUnitCost ? ' (unit cost)' : ' (qty)') + ' (' + totalTime.toFixed(0) + 'ms)');
        }

        async function createLineItem(title, unitCost) {
          var nsL = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          var siL = document.getElementById('rc_select_17') || document.getElementById('rc_select_1');
          if (!siL) {
            var candsL = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
            siL = candsL.find(function(el){ var id=el.id||''; return id.startsWith('rc_select_') && id!=='rc_select_0'; });
          }
          if (siL) {
            var contL = siL.closest('.ant-select-selector') || siL.parentElement;
            if (contL) { contL.click(); await _delay(200); }
            siL.focus(); await _delay(100);
            nsL.call(siL, 'Custom Selection Allowances');
            siL.dispatchEvent(new Event('input',{bubbles:true}));
            siL.dispatchEvent(new Event('change',{bubbles:true}));
            await _delay(900);
            var liResult = null;
            var liBTags = document.querySelectorAll('b');
            for (var lbi=0; lbi<liBTags.length; lbi++) {
              if ((liBTags[lbi].textContent||'').trim().toLowerCase() === 'custom selection allowances') { liResult = liBTags[lbi]; break; }
            }
            if (!liResult) {
              var liItems = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
              for (var lii=0; lii<liItems.length; lii++) {
                if ((liItems[lii].innerText||'').toLowerCase().includes('custom selection allowances')) { liResult = liItems[lii]; break; }
              }
            }
            if (liResult) {
              var liClick = liResult.closest('.LineItemResult') || liResult.closest('[class*="Result"]') || liResult;
              liClick.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
              liClick.click(); await _delay(700);
            }
          }
          var plusBtnL = null;
          for (var lwi=0; lwi<20; lwi++) {
            var lrows = document.querySelectorAll('.WorksheetGroupCellActions');
            for (var lri=0; lri<lrows.length; lri++) {
              var ltitleEl = lrows[lri].querySelector('.proposalFormatGroupCellTitle');
              if (ltitleEl && (ltitleEl.innerText||'').trim().toLowerCase() === 'custom selection allowances') {
                var lcand = lrows[lri].querySelector('button.AddItemsDropdown');
                if (lcand) { plusBtnL = lcand; break; }
              }
            }
            if (plusBtnL) break;
            await _delay(150);
          }
          if (!plusBtnL) { _log.push('✗ createLineItem: + button not found'); return; }
          plusBtnL.scrollIntoView({ behavior:'instant', block:'center' }); await _delay(300);
          var existingIdsL = new Set(Array.from(document.querySelectorAll('[data-testid*="itemTitle"]')).map(function(e){ return e.id; }));
          plusBtnL.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          plusBtnL.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
          plusBtnL.click(); await _delay(600);
          var itemOptL = null;
          for (var lwi2=0; lwi2<15; lwi2++) {
            var lopts = document.querySelectorAll('.ant-dropdown-menu-title-content');
            for (var loi=0; loi<lopts.length; loi++) {
              if ((lopts[loi].textContent||'').trim() === 'Item') { itemOptL = lopts[loi]; break; }
            }
            if (itemOptL) break; await _delay(100);
          }
          if (!itemOptL) { _log.push('✗ createLineItem: Item option not found'); return; }
          itemOptL.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          itemOptL.click(); await _delay(600);
          if (siL) { nsL.call(siL, ''); siL.dispatchEvent(new Event('input',{bubbles:true})); siL.dispatchEvent(new Event('change',{bubbles:true})); await _delay(600); }
          var newTitleElL = null;
          for (var la=0; la<30; la++) {
            var editRowL = document.querySelector('tr.editing');
            if (editRowL) { newTitleElL = editRowL.querySelector('input[id*="itemTitle"], [data-testid*="itemTitle"]'); if (newTitleElL) break; }
            var allTitlesL = document.querySelectorAll('[data-testid*="itemTitle"], input[id*="itemTitle"]');
            for (var ltt=0; ltt<allTitlesL.length; ltt++) { if (!existingIdsL.has(allTitlesL[ltt].id)) { newTitleElL = allTitlesL[ltt]; break; } }
            if (newTitleElL) break; await _delay(150);
          }
          if (!newTitleElL) { _log.push('✗ createLineItem: new title input not found'); return; }
          newTitleElL.scrollIntoView({ behavior:'instant', block:'center' });
          newTitleElL.focus(); await _delay(150); newTitleElL.select();
          nsL.call(newTitleElL, title);
          newTitleElL.dispatchEvent(new Event('input',{bubbles:true}));
          newTitleElL.dispatchEvent(new Event('change',{bubbles:true})); await _delay(300);
          var keyBaseL = (newTitleElL.getAttribute('data-testid') || newTitleElL.id || '').replace(/\.itemTitle$/, '');
          var ccInputL = document.querySelector('[id="' + keyBaseL + '.costCodeId"]');
          if (ccInputL) {
            var ccWrapL = ccInputL.closest('.ant-select') || ccInputL.parentElement;
            if (ccWrapL) { ccWrapL.click(); await _delay(300); }
            ccInputL.focus(); await _delay(100);
            nsL.call(ccInputL, 'Custom Selection Allowances');
            ccInputL.dispatchEvent(new Event('input',{bubbles:true})); ccInputL.dispatchEvent(new Event('change',{bubbles:true})); await _delay(800);
            var ccOptL = null;
            var allCcOptsL = document.querySelectorAll('.ant-select-item-option-content');
            for (var lco=0; lco<allCcOptsL.length; lco++) { if ((allCcOptsL[lco].textContent||'').trim() === 'Custom Selection Allowances') { ccOptL = allCcOptsL[lco]; break; } }
            if (ccOptL) { ccOptL.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); ccOptL.click(); await _delay(400); }
            else { _log.push('⚠ createLineItem: cost code option not found — continuing'); }
          }
          var pgInputL = document.getElementById('parentId');
          if (pgInputL) {
            var pgWrapL = pgInputL.closest('.ant-select') || pgInputL.parentElement;
            if (pgWrapL) { pgWrapL.click(); await _delay(300); }
            pgInputL.focus(); await _delay(100);
            nsL.call(pgInputL, 'Custom Selection Allowances');
            pgInputL.dispatchEvent(new Event('input',{bubbles:true})); pgInputL.dispatchEvent(new Event('change',{bubbles:true})); await _delay(600);
            var pgOptsL = document.querySelectorAll('.ant-select-item-option-content');
            var pgOptL = null;
            for (var lpo=0; lpo<pgOptsL.length; lpo++) { if ((pgOptsL[lpo].textContent||'').trim() === 'Custom Selection Allowances') { pgOptL = pgOptsL[lpo]; break; } }
            if (pgOptL) { pgOptL.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); pgOptL.click(); await _delay(400); }
            else { _log.push('⚠ createLineItem: parent group option not found — continuing'); }
          }
          var ucInputL = document.querySelector('[data-testid="' + keyBaseL + '.unitCost"]') || document.querySelector('[id="' + keyBaseL + '.unitCost"]');
          if (ucInputL) {
            ucInputL.focus(); await _delay(150); ucInputL.select();
            nsL.call(ucInputL, ''); ucInputL.dispatchEvent(new Event('input',{bubbles:true})); await _delay(50);
            nsL.call(ucInputL, String(Math.round(parseFloat(unitCost) * 100) / 100));
            ucInputL.dispatchEvent(new Event('input',{bubbles:true})); ucInputL.dispatchEvent(new Event('change',{bubbles:true})); await _delay(200);
          } else { _log.push('⚠ createLineItem: unit cost input not found — continuing'); }
          var sideElL = document.querySelector('.ant-layout-sider, aside');
          var saveXL = sideElL ? sideElL.getBoundingClientRect().right + 5 : 10;
          var saveYL = window.innerHeight / 2;
          var saveTargetL = document.elementFromPoint(saveXL, saveYL) || document.body;
          saveTargetL.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:saveXL,clientY:saveYL})); await _delay(150);
          saveTargetL.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:saveXL,clientY:saveYL})); await _delay(900);
          _log.push('✓ Created: ' + title + ' → $' + unitCost);
        }

        async function createSiteItem(title, parentGroup, unitCost) {
          var ns2 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          var si = document.getElementById('rc_select_17') || document.getElementById('rc_select_1');
          if (!si) {
            var cands2 = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
            si = cands2.find(function(el){ var id=el.id||''; return id.startsWith('rc_select_') && id!=='rc_select_0'; });
          }
          if (si) {
            var cont2 = si.closest('.ant-select-selector') || si.parentElement;
            if (cont2) { cont2.click(); await _delay(200); }
            si.focus(); await _delay(100);
            ns2.call(si, 'Site Allowances');
            si.dispatchEvent(new Event('input',{bubbles:true}));
            si.dispatchEvent(new Event('change',{bubbles:true}));
            await _delay(900);
            var siResult = null;
            var liItems = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
            for (var li=0; li<liItems.length; li++) {
              if ((liItems[li].innerText||'').trim().toLowerCase() === 'site allowances') { siResult = liItems[li]; break; }
            }
            if (siResult) { siResult.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); siResult.click(); await _delay(700); }
          }
          var plusBtn = null;
          for (var siat=0; siat<20; siat++) {
            var siRows = document.querySelectorAll('.WorksheetGroupCellActions');
            for (var siri=0; siri<siRows.length; siri++) {
              var siTitleEl = siRows[siri].querySelector('.proposalFormatGroupCellTitle');
              if (siTitleEl && (siTitleEl.innerText||'').trim().toLowerCase() === 'site allowances') {
                var siCandidate = siRows[siri].querySelector('button.AddItemsDropdown') ||
                  (siRows[siri].parentElement && siRows[siri].parentElement.querySelector('button.AddItemsDropdown'));
                if (siCandidate) { plusBtn = siCandidate; break; }
              }
            }
            if (plusBtn) break;
            await _delay(150);
          }
          if (!plusBtn) { _log.push('✗ createSiteItem: + button not found for Site Allowances'); return; }
          plusBtn.scrollIntoView({ behavior:'instant', block:'center' });
          await _delay(300);
          var siExistingIds = new Set(Array.from(document.querySelectorAll('[data-testid*="itemTitle"]')).map(function(e){ return e.id; }));
          plusBtn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          plusBtn.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
          plusBtn.click();
          await _delay(400);
          var itemOpt = null;
          for (var iat=0; iat<15; iat++) {
            var opts = document.querySelectorAll('.ant-dropdown-menu-item, [class*="DropdownMenuItem"], li[role="menuitem"]');
            for (var oi=0; oi<opts.length; oi++) {
              if ((opts[oi].textContent||'').trim().toLowerCase() === 'item') { itemOpt = opts[oi]; break; }
            }
            if (itemOpt) break;
            await _delay(100);
          }
          if (!itemOpt) { _log.push('✗ createSiteItem: Item option not found'); return; }
          itemOpt.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          itemOpt.click();
          await _delay(600);
          if (si) { ns2.call(si, ''); si.dispatchEvent(new Event('input',{bubbles:true})); si.dispatchEvent(new Event('change',{bubbles:true})); await _delay(600); }
          var newTitleEl = null;
          for (var tat=0; tat<30; tat++) {
            var editRow = document.querySelector('tr.editing');
            if (editRow) { newTitleEl = editRow.querySelector('input[id*="itemTitle"], [data-testid*="itemTitle"]'); if (newTitleEl) break; }
            var allTitleInps = document.querySelectorAll('[data-testid*="itemTitle"], input[id*="itemTitle"]');
            for (var tt=0; tt<allTitleInps.length; tt++) { if (!siExistingIds.has(allTitleInps[tt].id)) { newTitleEl = allTitleInps[tt]; break; } }
            if (newTitleEl) break;
            await _delay(150);
          }
          if (!newTitleEl) { _log.push('✗ createSiteItem: title input not found'); return; }
          newTitleEl.scrollIntoView({ behavior:'instant', block:'center' });
          newTitleEl.focus(); await _delay(150);
          ns2.call(newTitleEl, title);
          newTitleEl.dispatchEvent(new Event('input',{bubbles:true}));
          newTitleEl.dispatchEvent(new Event('change',{bubbles:true}));
          await _delay(300);
          var keyBase = (newTitleEl.getAttribute('data-testid') || newTitleEl.id || '').replace(/\.itemTitle$/, '');
          var ccInput = document.querySelector('[id="' + keyBase + '.costCodeId"]');
          if (ccInput) {
            var ccWrap = ccInput.closest('.ant-select') || ccInput.parentElement;
            if (ccWrap) { ccWrap.click(); await _delay(400); }
            ccInput.focus(); await _delay(200);
            document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); await _delay(100);
            document.execCommand('insertText', false, parentGroup);
            await _delay(1200);
            var ccOpt = null;
            var allCcOpts = document.querySelectorAll('.ant-select-item-option-content');
            for (var co=0; co<allCcOpts.length; co++) { if ((allCcOpts[co].textContent||'').trim() === parentGroup) { ccOpt = allCcOpts[co]; break; } }
            if (!ccOpt) {
              document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); await _delay(100);
              document.execCommand('insertText', false, '09 - Lot Clearing');
              await _delay(1200);
              allCcOpts = document.querySelectorAll('.ant-select-item-option-content');
              for (var co2=0; co2<allCcOpts.length; co2++) { if ((allCcOpts[co2].textContent||'').trim() === '09 - Lot Clearing/Site Prep') { ccOpt = allCcOpts[co2]; break; } }
            }
            if (ccOpt) {
              var ccOptParent = ccOpt.closest('.ant-select-item-option') || ccOpt.parentElement;
              ccOptParent.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true})); await _delay(80);
              ccOptParent.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true}));
              ccOptParent.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
              await _delay(600); _log.push('✓ createSiteItem: cost code set');
            } else { _log.push('⚠ createSiteItem: cost code option not found — continuing'); }
          } else { _log.push('⚠ createSiteItem: cost code input not found'); }
          var pgInput = null;
          for (var pgwait=0; pgwait<20; pgwait++) { pgInput = document.getElementById('parentId'); if (pgInput) break; await _delay(200); }
          if (pgInput) {
            var pgWrap = pgInput.closest('.ant-select') || pgInput.parentElement;
            if (pgWrap) { pgWrap.click(); await _delay(400); }
            pgInput.focus(); await _delay(200);
            document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); await _delay(100);
            document.execCommand('insertText', false, parentGroup);
            await _delay(1000);
            var pgOpts = document.querySelectorAll('.ant-select-item-option-content');
            var pgOpt = null;
            for (var po=0; po<pgOpts.length; po++) { if ((pgOpts[po].textContent||'').trim() === parentGroup) { pgOpt = pgOpts[po]; break; } }
            if (pgOpt) {
              var pgOptParent = pgOpt.closest('.ant-select-item-option') || pgOpt.parentElement;
              pgOptParent.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true})); await _delay(80);
              pgOptParent.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true}));
              pgOptParent.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
              await _delay(500); _log.push('✓ createSiteItem: parent group set to ' + parentGroup);
            } else { _log.push('⚠ createSiteItem: parent group "' + parentGroup + '" not found — continuing'); }
          } else { _log.push('⚠ createSiteItem: parentId input not found'); }
          if (unitCost && parseFloat(unitCost) > 0) {
            var ucInput = document.querySelector('[data-testid="' + keyBase + '.unitCost"]') || document.querySelector('[id="' + keyBase + '.unitCost"]');
            if (ucInput) {
              ucInput.focus(); await _delay(150); ucInput.select();
              ns2.call(ucInput, ''); ucInput.dispatchEvent(new Event('input',{bubbles:true})); await _delay(50);
              ns2.call(ucInput, String(Math.round(parseFloat(unitCost) * 100) / 100));
              ucInput.dispatchEvent(new Event('input',{bubbles:true})); ucInput.dispatchEvent(new Event('change',{bubbles:true})); await _delay(200);
            } else { _log.push('⚠ createSiteItem: unit cost input not found'); }
          }
          var sideElSi = document.querySelector('.ant-layout-sider, aside');
          var saveXSi = sideElSi ? sideElSi.getBoundingClientRect().right + 5 : 10;
          var saveYSi = window.innerHeight / 2;
          var saveTargetSi = document.elementFromPoint(saveXSi, saveYSi) || document.body;
          saveTargetSi.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:saveXSi,clientY:saveYSi})); await _delay(150);
          saveTargetSi.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:saveXSi,clientY:saveYSi})); await _delay(900);
          _log.push('✓ Site item: ' + title + ' → ' + parentGroup + (unitCost ? ' → $' + unitCost : ''));
        }

        async function editExistingItem(searchName, newTitle, unitCost) {
          var nsE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          var siE = document.getElementById('rc_select_17') || document.getElementById('rc_select_1');
          if (!siE) {
            var candsE = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
            siE = candsE.find(function(el){ var id=el.id||''; return id.startsWith('rc_select_') && id!=='rc_select_0'; });
          }
          if (siE) {
            var contE = siE.closest('.ant-select-selector') || siE.parentElement;
            if (contE) { contE.click(); await _delay(200); }
            siE.focus(); await _delay(100);
            nsE.call(siE, searchName);
            siE.dispatchEvent(new Event('input',{bubbles:true}));
            siE.dispatchEvent(new Event('change',{bubbles:true}));
            await _delay(900);
            var eResult = null;
            var eItems = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
            for (var eli=0; eli<eItems.length; eli++) {
              if ((eItems[eli].innerText||'').trim().toLowerCase() === searchName.toLowerCase()) { eResult = eItems[eli]; break; }
            }
            if (eResult) { eResult.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); eResult.click(); await _delay(1000); }
            nsE.call(siE, ''); siE.dispatchEvent(new Event('input',{bubbles:true})); siE.dispatchEvent(new Event('change',{bubbles:true})); await _delay(400);
          }
          var targetRow = null;
          for (var tdi=0; tdi<20; tdi++) {
            var bTags = document.querySelectorAll('tr.proposalBaseLineItemContainerRow b');
            for (var tdi2=0; tdi2<bTags.length; tdi2++) {
              if ((bTags[tdi2].textContent||'').trim().toLowerCase() === searchName.toLowerCase()) {
                targetRow = bTags[tdi2].closest('tr.proposalBaseLineItemContainerRow'); break;
              }
            }
            if (targetRow) break;
            await _delay(150);
          }
          if (!targetRow) { _log.push('⚠ editExistingItem: row not found for ' + searchName); return; }
          targetRow.click(); await _delay(800);
          var titleDisplay = null;
          for (var tdd=0; tdd<15; tdd++) {
            var tDisplays = document.querySelectorAll('.ValueDisplay[data-testid$=".itemTitle"]');
            for (var tdi3=0; tdi3<tDisplays.length; tdi3++) {
              if ((tDisplays[tdi3].textContent||'').trim().toLowerCase() === searchName.toLowerCase()) { titleDisplay = tDisplays[tdi3]; break; }
            }
            if (titleDisplay) break;
            await _delay(100);
          }
          if (titleDisplay) { titleDisplay.click(); await _delay(400); }
          else { _log.push('⚠ editExistingItem: title ValueDisplay not found for ' + searchName); }
          var titleInp = null;
          for (var tii=0; tii<15; tii++) { titleInp = document.querySelector('input[data-testid="itemTitle"]'); if (titleInp) break; await _delay(100); }
          if (titleInp) {
            titleInp.focus();
            document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
            document.execCommand('insertText', false, newTitle);
            await _delay(300);
          } else { _log.push('⚠ editExistingItem: title input did not appear for ' + searchName); }
          var costCell = targetRow.querySelector('td[data-testid="cell-unitCost"] .ValueDisplay') ||
                         targetRow.querySelector('td[data-testid="cell-unitCost"]');
          if (costCell) {
            costCell.click(); await _delay(400);
            var costInp = null;
            for (var cii=0; cii<15; cii++) { costInp = document.querySelector('input[data-testid="unitCost"]'); if (costInp) break; await _delay(100); }
            if (costInp) {
              costInp.focus();
              document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
              document.execCommand('insertText', false, String(unitCost));
              await _delay(300);
            } else { _log.push('⚠ editExistingItem: cost input did not appear for ' + searchName); }
          } else { _log.push('⚠ editExistingItem: cost cell not found for ' + searchName); }
          var sideElE = document.querySelector('.ant-layout-sider, aside');
          var saveXE = sideElE ? sideElE.getBoundingClientRect().right + 5 : 10;
          var saveYE = window.innerHeight / 2;
          var saveTargetE = document.elementFromPoint(saveXE, saveYE) || document.body;
          saveTargetE.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:saveXE,clientY:saveYE})); await _delay(150);
          saveTargetE.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:saveXE,clientY:saveYE})); await _delay(900);
          var dirtySave = null;
          for (var ds=0; ds<15; ds++) { dirtySave = document.querySelector('[data-testid="dirtyTrackingSave"]'); if (dirtySave) break; await _delay(150); }
          if (dirtySave) { dirtySave.click(); await _delay(800); }
          _log.push('✓ editExistingItem: ' + searchName + ' → "' + newTitle + '" $' + unitCost);
        }

        var editableItems = {};
        if (siteOptionsList) {
          for (var ei = 0; ei < siteOptionsList.length; ei++) {
            if (siteOptionsList[ei].existingLine) {
              editableItems[siteOptionsList[ei].existingLine] = siteOptionsList[ei];
            }
          }
        }

        var writeStartTime = performance.now();
        for (var i = 0; i < itemsList.length; i++) {
          if (window.__dukeWriteStop) { _log.push('⏹ Stopped'); break; }
          var editOpt = editableItems[itemsList[i].name];
          if (editOpt) {
            await editExistingItem(itemsList[i].name, editOpt.name, editOpt.unitCost);
          } else {
            await setQty(itemsList[i].name, itemsList[i].qty, itemsList[i].isUnitCost);
          }
        }

        await _delay(1500);

        // Realtor Fees — grab the grand total from BTGridFooterCell--ellipsis (the center total column)
        var totalVal = 0;
        var footerSpan = document.querySelector('.BTGridFooterCell--ellipsis span[dir="ltr"]');
        if (footerSpan) {
          var footerTxt = (footerSpan.innerText || '').trim();
          var footerMatch = footerTxt.match(/^\$([\d,]+\.?\d*)$/);
          if (footerMatch) totalVal = parseFloat(footerMatch[1].replace(/,/g, ''));
        }
        if (totalVal > 0) {
          _log.push('Grand total: $' + totalVal + ' → Realtor Fees unit cost');
          await setQty('Realtor Fees', totalVal, true);
        } else {
          _log.push('⚠ Could not detect estimate total for Realtor Fees');
        }

        // Delete ALL existing placeholders (same search bar as setQty)
        _log.push('Clearing placeholders…');
        await (async function() {
          try {
            async function getDelSearchInput() {
              var si = null;
              for (var wi = 0; wi < 20; wi++) {
                si = document.getElementById('rc_select_17');
                if (!si) si = document.getElementById('rc_select_1');
                if (!si) {
                  var cb = Array.from(document.querySelectorAll('button')).find(function(b) { return b.textContent && b.textContent.includes('Collapse all'); });
                  if (cb) { var par = cb.closest('[class*="header"], [class*="control"], div'); if (par) si = par.querySelector('input[role="combobox"].ant-select-selection-search-input'); }
                }
                if (!si) {
                  si = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input')).filter(function(el) {
                    var id = el.id || ''; return id && id.startsWith('rc_select_') && id !== 'rc_select_0' && id !== 'savedFilterDropdown' && !id.match(/^\d+$/);
                  })[0];
                }
                if (si) break;
                await _delay(100);
              }
              return si || null;
            }

            var deletedCount = 0;
            var maxLoops = 1;

            for (var loop = 0; loop < maxLoops; loop++) {
              var si = await getDelSearchInput();
              if (!si) { _log.push('⚠ Search bar not found — stopping placeholder delete'); break; }

              var selEl = si.closest('.ant-select-selector') || si.parentElement;
              if (selEl) { selEl.click(); await _delay(200); }
              si.focus();
              await _delay(100);
              reactSet(si, '');
              await _delay(100);
              reactSet(si, 'place');
              await _delay(1200);

              var target = null;
              for (var ri = 0; ri < 30; ri++) {
                target = document.querySelector('.LineItemResult.LineItem');
                if (target) break;
                await _delay(100);
              }
              if (!target) { document.body.click(); await _delay(200); break; }

              target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              target.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
              target.click();
              await _delay(1000);

              // Pick the BTIconActions button closest to viewport center (BT scrolls the target row there)
              var vcY = window.innerHeight / 2;
              var actBtn = null;
              var actionIcons = Array.from(document.querySelectorAll('[data-icon-name="BTIconActions"]'));
              var closestDist = Infinity;
              for (var ai = 0; ai < actionIcons.length; ai++) {
                var rect = actionIcons[ai].getBoundingClientRect();
                var dist = Math.abs((rect.top + rect.height / 2) - vcY);
                if (dist < closestDist) { closestDist = dist; actBtn = actionIcons[ai].closest('button, [role="button"]') || actionIcons[ai].parentElement; }
              }
              if (!actBtn) { _log.push('⚠ Actions button not found on loop ' + (loop + 1) + ' — stopping'); break; }

              actBtn.click();
              await _delay(400);

              var delOption = Array.from(document.querySelectorAll('.ant-dropdown-menu-title-content')).find(function(el) { return el.textContent.trim() === 'Delete'; });
              if (!delOption) { document.body.click(); _log.push('⚠ Delete option not found on loop ' + (loop + 1) + ' — stopping'); break; }
              delOption.click();
              await _delay(500);

              var confirmBtn = Array.from(document.querySelectorAll('button span')).find(function(el) { return el.textContent.trim() === 'Delete'; });
              if (!confirmBtn) { _log.push('⚠ Confirm Delete not found on loop ' + (loop + 1) + ' — stopping'); break; }
              confirmBtn.closest('button').click();
              await _delay(3000);
              deletedCount++;
            }

            if (deletedCount > 0) _log.push('✓ Deleted ' + deletedCount + ' placeholder(s)');
            else _log.push('⚠ No placeholders found — continuing');
          } catch(e) { _log.push('⚠ Placeholder delete error: ' + e.message); }
        })();

        if (siteOptionsList && siteOptionsList.length) {
          _log.push('');
          _log.push('── Site Options ──');
          for (var si2 = 0; si2 < siteOptionsList.length; si2++) {
            if (siteOptionsList[si2].existingLine) continue;
            await createSiteItem(siteOptionsList[si2].name, siteOptionsList[si2].parentGroup, siteOptionsList[si2].unitCost);
          }
        }

        if (customItemsList && customItemsList.length) {
          _log.push('');
          _log.push('── Custom Selection Allowances ──');
          for (var cli = 0; cli < customItemsList.length; cli++) {
            await createLineItem(customItemsList[cli].name, customItemsList[cli].unitCost);
          }
        }

        var totalWriteTime = performance.now() - writeStartTime;
        var totalSeconds = totalWriteTime / 1000;
        var minutes = Math.floor(totalSeconds / 60);
        var seconds = (totalSeconds % 60).toFixed(1);
        var timeFormat = minutes > 0 ? minutes + 'm ' + seconds + 's' : seconds + 's';
        console.log('[TIMING] ═══════════════════════════════════════');
        console.log('[TIMING] TOTAL WRITE TO ESTIMATE TIME: ' + timeFormat);
        console.log('[TIMING] ═══════════════════════════════════════');
        _log.push('');
        _log.push('═══ TOTAL WRITE TO ESTIMATE TIME: ' + timeFormat + ' ═══');

        return { ok: _log.filter(function(l){ return l.startsWith('✓'); }).length,
                 fail: _log.filter(function(l){ return l.startsWith('✗'); }).length,
                 lines: _log };
      } catch(e) { return { ok: 0, fail: 1, lines: ['✗ Write script error: ' + e.message] }; } },
      args: [items, siteOptions, customItems]
    });

    var res = result && result[0] && result[0].result;
    if (res && res.lines) {
      res.lines.forEach(function(l) { log(l); });
      showStatus('✓ Wrote ' + res.ok + ' items' + (res.fail ? ' · ' + res.fail + ' failed (see log)' : ''), res.fail ? 'error' : 'success', 6000);
    } else if (result && result[0] && result[0].error) {
      log('⚠ Write script error: ' + result[0].error.message);
    } else {
      showStatus('Write complete', 'success');
    }

  } catch(e) {
    log('ERROR: ' + e.message);
    showStatus('Write to Estimate failed: ' + e.message, 'error', 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Write to Estimate';
    if (stopBtn) stopBtn.style.display = 'none';
    _writeTabId = null;
  }
}

// ── Proposal Group Selector ────────────────────────────────────────────────
let _proposalSelectResolve = null;

function showProposalSelector(groups) {
  return new Promise(function(resolve) {
    _proposalSelectResolve = resolve;
    var el = $('proposal-select');
    var list = $('proposal-select-list');
    if (!el || !list) { resolve(null); return; }
    list.innerHTML = '';
    groups.forEach(function(g) {
      var row = document.createElement('label');
      row.className = 'proposal-select-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.groupName = g.name;
      var nameSpan = document.createElement('span');
      nameSpan.className = 'proposal-select-name';
      nameSpan.textContent = g.name;
      var amtSpan = document.createElement('span');
      amtSpan.className = 'proposal-select-amount';
      amtSpan.textContent = g.amount || '';
      row.appendChild(cb); row.appendChild(nameSpan); row.appendChild(amtSpan);
      list.appendChild(row);
    });
    el.classList.remove('hidden');
    el.scrollIntoView({ behavior: 'smooth' });
  });
}

function resolveProposalSelector() {
  var list = $('proposal-select-list');
  var cbs = Array.from((list || document).querySelectorAll('input[type="checkbox"]'));
  var kept    = cbs.filter(function(c){ return  c.checked; }).map(function(c){ return c.dataset.groupName; });
  var removed = cbs.filter(function(c){ return !c.checked; }).map(function(c){ return c.dataset.groupName; });
  $('proposal-select')?.classList.add('hidden');
  if (_proposalSelectResolve) { var r = _proposalSelectResolve; _proposalSelectResolve = null; r({ kept, removed }); }
}

// ── Navigation: Proposal View → Estimate Page (for future use) ──────────────────
// This function navigates back from proposal/client preview to the estimate page
// and handles the "Unsaved changes" Save modal. Call this when returning from proposal view.
//
// Navigation Steps:
// 1. Click back link: [data-testid="jobProposalPresentationalHeader-back-link"]
// 2. Wait for "Unsaved changes" modal (.ant-modal-confirm-title)
// 3. Click Save button in modal
// 4. Wait 1500ms for modal to close
// 5. Wait 2500ms for estimate page to reload
//
// async function goBackAndSave(tabId, log) {
//   await chrome.scripting.executeScript({
//     target: { tabId }, world: 'MAIN',
//     func: async function() {
//       function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
//       function waitFor(fn, ms) {
//         return new Promise(function(res, rej) {
//           var end = Date.now() + (ms || 5000);
//           (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
//         });
//       }
//       var back = document.querySelector('[data-testid="jobProposalPresentationalHeader-back-link"]');
//       if (!back) { console.warn('[Duke] back link not found'); return; }
//       back.click();
//       var modal = await waitFor(function() {
//         var t = document.querySelector('.ant-modal-confirm-title');
//         return (t && t.textContent.trim() === 'Unsaved changes') ? t : null;
//       }, 4000).catch(function(){ return null; });
//       if (modal) {
//         var saveBtn = Array.from(document.querySelectorAll('.ant-modal-confirm button, .ant-modal-footer button, .BTConfirm button'))
//           .find(function(b){ return b.textContent.trim() === 'Save'; });
//         if (saveBtn) { saveBtn.click(); }
//         await delay(1500);
//       }
//     }
//   }).catch(function(e){ log('⚠ Back/save error: ' + e.message); });
//   await new Promise(function(r){ setTimeout(r, 2500); });
// }

async function runClientPreviewFlow(tabId, log, setLabel) {
  function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

  // Step 0: Read grand total from estimate footer (before navigating away)
  log('Reading estimate grand total…');
  var _totalRes = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: function() {
      var span = document.querySelector('.BTGridFooterCell--ellipsis span[dir="ltr"]');
      if (!span) return 0;
      var txt = (span.innerText || '').trim();
      var m = txt.match(/^\$([\d,]+\.?\d*)$/);
      return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
    }
  });
  var _grandTotal = (_totalRes && _totalRes[0] && _totalRes[0].result) || 0;
  if (_grandTotal > 0) log('Grand total: $' + _grandTotal.toLocaleString('en-US'));
  else log('Warning: grand total not found — budget range will be skipped');

  // Step 1: Click buildProposal button
  log('Opening proposal builder…');
  setLabel('Opening proposal…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      var btn = document.querySelector('[data-testid="buildProposal"]');
      if (btn) btn.click();
    }
  });
  await delay(2500);

  // Step 1.5: Fill editor1 (intro) and editor2 (closing) via CKEditor API
  if (_grandTotal > 0) {
    log('Filling proposal editors…');
    setLabel('Writing proposal text…');
    var _lowFmt  = '$' + Math.round(_grandTotal * 0.99).toLocaleString('en-US');
    var _highFmt = '$' + Math.round(_grandTotal * 1.10).toLocaleString('en-US');

    // Read sales notes from SALES NOTES sheet tab
    var _salesNotesText = '';
    try {
      var _snResp = await sendMsg('READ_CELLS_RANGE_TAB', { tab: 'SALES NOTES', range: 'A1' });
      _salesNotesText = ((_snResp.data && _snResp.data[0] && _snResp.data[0][0]) || '').trim();
    } catch(e) { log('⚠ Could not read sales notes: ' + e.message); }

    var _notesBlock = '';
    if (_salesNotesText) {
      var _noteLines = _salesNotesText.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
      var _notesBody = _noteLines.map(function(l){
        return l.startsWith('-') ? '<li>' + l.slice(1).trim() + '</li>' : '<p>' + l + '</p>';
      }).join('');
      if (_noteLines.some(function(l){ return l.startsWith('-'); })) _notesBody = '<ul>' + _notesBody + '</ul>';
      _notesBlock = '<p>&nbsp;</p><h2><span style="font-size:16px;"><strong>NOTES</strong></span></h2><hr />' + _notesBody;
    }

    // Build HTML here (outside executeScript) so the serialized function stays small
    var _introHtml = [
      '<p><em>This is a preliminary estimate for budgeting purposes only &mdash; not a contract or binding price.</em></p>',
      '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;',
      '<table align="center" border="1" cellpadding="1" cellspacing="1" style="width:500px;">',
      '<tbody><tr><td style="text-align: center;">',
      '<h3><span style="font-size:16px;"><strong>ESTIMATED BUDGET RANGE</strong></span></h3>',
      '<h1><span style="font-size:28px;"><strong>' + _lowFmt + ' &ndash; ' + _highFmt + '</strong></span></h1>',
      '</td></tr></tbody></table>',
      _notesBlock,
      '&nbsp;',
      '<p>&nbsp;</p>',
      '<h2><span style="font-size:16px;"><strong>WHAT&#39;S INCLUDED IN YOUR ESTIMATE&nbsp;</strong></span></h2>',
      '<p><hr /><strong>Design &amp; Pre-Construction</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Complete architectural plans, engineering, permits, surveys, and inspections</p>',
      '<p><hr /><strong>Foundation</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; &nbsp;Standard footings, walls, waterproofing, and backfill</p>',
      '<p><hr /><strong>Framing &amp; Structure</strong>&nbsp; &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Full framing package including lumber, trusses, engineered joists, and stairs</p>',
      '<p><hr /><strong>Exterior Envelope</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Siding exterior with architectural shingle roofing, gutters, and all exterior trim</p>',
      '<p><hr /><strong>Mechanical Systems</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; &nbsp;Complete HVAC, plumbing rough &amp; finish, and electrical rough &amp; finish</p>',
      '<p><hr /><strong>Insulation &amp; Drywall</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; &nbsp; Full insulation to code, drywall, and interior/exterior paint</p>',
      '<p><hr /><strong>Interior Finishes</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; Interior doors, trim, hardware, and custom carpentry allowance</p>',
      '<p><hr /><strong>Site Work</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Site clearing, grading, driveway, and all utilities including municipal tap fees</p>',
      '<p><hr /><strong>Decks / Porches</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Porches and decks finished per spec</p>'
    ].join('');
    var _closingHtml = [
      '<h2><span style="font-size:16px;"><span style="color:#000000;"><strong>BUDGET PRICING SUMMARY</strong></span></span></h2>',
      '<hr />',
      '<p>The pricing shown in this proposal represents the initial contract amount for Milestone 1 and is based on the information available at this stage of the project. Because detailed selections and final site confirmations have not yet been completed, this is not the final contract price.</p>',
      '<p>This budget is intended to establish feasibility, provide direction, and support loan preapproval. As plans are finalized, site conditions are verified, and selections are made, the contract pricing will be refined to reflect the specific scope and investment of your home.</p>',
      '<p>Any adjustments resulting from confirmed site conditions, completed selections, or requested upgrades will be clearly communicated as information becomes available.</p>',
      '<h2><span style="font-size:16px;"><span style="color:#000000;"><strong>ALLOWANCE STRUCTURE &amp; BUDGET ASSUMPTIONS</strong></span></span></h2>',
      '<hr /><h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Allowances</strong></span></span></h3>',
      '<p>This budget includes allowances for major finish categories. These are placeholder amounts intended to provide a realistic starting point and do not reflect specific brands, products, or final selections at this stage. Final costs will be determined once selections are completed.</p>',
      '<ul><li>If selections exceed the allowance, the difference will be added to the project cost.</li>',
      '<li>If selections come in under the allowance, a credit will be applied.</li></ul>',
      '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Budget Assumptions</strong></span></span></h3>',
      '<p>This budget is based on the following standard residential construction assumptions. If any of these conditions differ, adjustments to cost, design, or schedule may be required.</p>',
      '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Lot &amp; Approvals<em>&nbsp;</em></strong></span></span></h3>',
      '<ul><li><em>T</em>he lot is legally buildable and compliant with zoning, setbacks, easements, floodplain, and municipal requirements.</li>',
      '<li>No rezoning, variances, special use permits, or additional jurisdictional approvals are required.</li>',
      '<li>No unusual HOA or architectural review requirements beyond typical residential standards.</li></ul>',
      '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Site &amp; Soil Conditions</strong></span></span></h3>',
      '<ul><li>Standard soil conditions suitable for typical residential foundation construction.</li>',
      '<li>No rock excavation, blasting, or unsuitable soils requiring remediation.</li>',
      '<li>Standard foundation type as reflected in current plans.</li>',
      '<li>No unanticipated environmental conditions, including wetlands or protected areas.</li></ul>',
      '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Utilities &amp; Infrastructure&nbsp;</strong></span></span></h3>',
      '<ul><li>Standard utility access is available at the home site.</li>',
      '<li>No off-site utility extensions or upgrades are required.</li>',
      '<li>No extraordinary stormwater management requirements beyond typical residential construction.</li></ul>',
      '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Construction Conditions&nbsp;</strong></span></span></h3>',
      '<ul><li>No unusual site constraints affecting access, staging, or logistics.</li>',
      '<li>No material shortages or trade disruptions beyond normal market conditions.</li>',
      '<li>Plans provided are accurate and complete for this phase of pricing.</li></ul>',
      '<p>If any of these assumptions prove to be inaccurate, additional costs may be incurred.</p>',
      '<h2><span style="font-size:16px;"><strong>ITEMS NOT INCLUDED IN THIS BUDGET</strong></span></h2>',
      '<hr />Unless specifically noted elsewhere in the proposal, the following items are not included:',
      '<ul><li>Building permits and government fees beyond the municipality&#39;s building permit</li>',
      '<li>Utility provider fees and service connection charges</li>',
      '<li>Well and septic systems (refer to allowances, if applicable)</li>',
      '<li>Landscaping beyond minimum stabilization</li>',
      '<li>Off-site improvements or upgrades required by local authorities</li></ul>',
      '<p>Depending on the lot, jurisdiction, or lender requirements, these items may be required and are often paid directly by the homeowner or financed separately.</p>',
      '<h2><span style="font-size:16px;"><strong>WHAT COMES NEXT</strong></span></h2>',
      '<hr />Milestone 2 is where your home begins to take shape. During this phase, we align your site, structural decisions, and exterior selections to significantly reduce pricing uncertainty and move toward a refined price range.',
      '<h3><span style="font-size:14px;"><strong><span style="color:#133d59;">Milestone 2&nbsp;&mdash; Site, Design, and Structural Alignment</span></strong></span><br /><br />',
      '<span style="font-size: 13px;"><strong>Purpose: </strong>Lock in the size, structure, and exterior of your home to reduce uncertainty and bring greater clarity to pricing.</span></h3>',
      '<h3><br /><span style="font-size:14px;"><strong><span style="color:#133d59;">During This Phase &mdash; You Provide</span></strong></span></h3>',
      '<ul><li>Final approval of plan layout and square footage.</li>',
      '<li>Exterior selections including roof, windows, siding, doors, and related finishes</li>',
      '<li>Completed site design including house location, driveway layout, clearing, and utilities.</li></ul>',
      '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Keel Provides:</strong>&nbsp;</span></span></h3>',
      '<ul><li>&quot;Bid Set&quot; floor plans</li>',
      '<li>Defined structural system</li>',
      '<li>Exterior and site selections priced</li>',
      '<li>A refined price range.</li></ul>',
      '<p style="text-align: center;"><span style="color:#999999;"><strong>MAKE THIS HOME YOURS</strong></span></p>',
      '<p style="text-align: center;"><span style="color:#999999;">With the design aligned and pricing refined, we move confidently into the next milestone and continue turning your plans into reality.</span></p>',
      '<p style="text-align: center;"><em>Keel Custom Homes &bull; Preliminary Budget Estimate &bull; Confidential</em></p>'
    ].join('');
    var _editorResult = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: async function(introHtml, closingHtml) {
        function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
        // Fill proposal title
        var titleInput = document.querySelector('#title[data-testid="title"]');
        if (titleInput) {
          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(titleInput, 'Preliminary Budget Estimate');
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
          titleInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Wait for CKEditor instances to be ready
        var waited = 0;
        while (waited < 8000) {
          if (window.CKEDITOR && CKEDITOR.instances && Object.keys(CKEDITOR.instances).length >= 2) break;
          await delay(300);
          waited += 300;
        }
        if (!window.CKEDITOR) return;
        var editorKeys = Object.keys(CKEDITOR.instances);
        if (editorKeys.length < 2) return;
        var editorA = CKEDITOR.instances[editorKeys[0]];
        var editorB = CKEDITOR.instances[editorKeys[1]];

        // Show content visually in the editors
        editorA.setData(introHtml);
        editorB.setData(closingHtml);
        await delay(300);

        // Get jobId from already-loaded network resources
        var jobId = null;
        var resources = performance.getEntriesByType('resource');
        for (var ri = 0; ri < resources.length; ri++) {
          var rm = resources[ri].name.match(/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/);
          if (rm) { jobId = rm[1]; break; }
        }

        console.log('[Duke] jobId found:', jobId);
        if (jobId) {
          // GET current draft via XHR (bypasses BT's patched window.fetch)
          console.log('[Duke] GETting current draft via XHR...');
          var draft = await new Promise(function(resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', '/apix/v2/Proposals/draft?jobId=' + jobId, true);
            xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
            xhr.setRequestHeader('portaltype', '1');
            xhr.onload = function() {
              if (xhr.status === 200) {
                try { resolve(JSON.parse(xhr.responseText)); } catch(e) { resolve(null); }
              } else { resolve(null); }
            };
            xhr.onerror = function() { resolve(null); };
            xhr.send();
          });
          if (!draft) {
            console.log('[Duke] GET failed — falling back to Save button');
            var saveBtn = document.querySelector('[data-testid="save"]');
            if (saveBtn) { saveBtn.click(); await delay(3000); }
          } else {
            console.log('[Duke] GET ok');
            console.log('[Duke] GET top-level keys:', JSON.stringify(Object.keys(draft)));
            // Merge all sub-objects into one flat object (proposal + settings + jobInfo)
            var putBody = {};
            Object.keys(draft).forEach(function(k) {
              if (draft[k] && typeof draft[k] === 'object' && !Array.isArray(draft[k])) {
                Object.assign(putBody, draft[k]);
              }
            });
            // GET uses different field names than PUT — remap them
            if (!('categories' in putBody) && putBody.formatItems) {
              putBody.categories = putBody.formatItems;
            }
            if (!('formatOptions' in putBody)) {
              var dOpts = putBody.displayOptions || {};
              var pConf = putBody.proposalDisplayConfig || {};
              putBody.formatOptions = {
                body: dOpts.body,
                header: dOpts.header,
                printoutType: dOpts.printoutType,
                includeSpecs: dOpts.includeSpecs || false,
                showAddress: putBody.showAddress || false,
                showOwnerContactInfo: putBody.showOwnerContactInfo || false,
                showPrintoutInfo: putBody.showPrintoutInfo || false,
                proposalLayout: pConf.proposalLayout != null ? pConf.proposalLayout : 0,
                hasSingleSelectCostTypes: pConf.hasSingleSelectCostTypes || false
              };
            }
            // Rename items→lineItems inside each category (GET uses 'items', PUT expects 'lineItems')
            if (Array.isArray(putBody.categories)) {
              putBody.categories.forEach(function(cat) {
                if (cat.items && !cat.lineItems) {
                  cat.lineItems = cat.items;
                  delete cat.items;
                }
              });
            }
            // Don't change signature settings — always send as no-signatures-required
            putBody.requireSignatures = false;
            putBody.requiredSignatureUsers = [];
            // columnsToDisplay in GET is {type,value:[],options,validators}; PUT wants the array directly
            if (putBody.columnsToDisplay && Array.isArray(putBody.columnsToDisplay.value)) {
              putBody.columnsToDisplay = putBody.columnsToDisplay.value;
            }
            console.log('[Duke] requireSignatures:', putBody.requireSignatures, '| columnsToDisplay is array:', Array.isArray(putBody.columnsToDisplay));
            putBody.introductionText = introHtml;
            putBody.closingText = closingHtml;
            var bodyStr = JSON.stringify(putBody);
            console.log('[Duke] Sending via XHR, body size:', bodyStr.length);

            // Use XHR instead of fetch — BT patches window.fetch which truncates our body
            var xhrStatus = await new Promise(function(resolve) {
              var xhr = new XMLHttpRequest();
              xhr.open('PUT', '/apix/v2/Proposals/draft?jobId=' + jobId, true);
              xhr.setRequestHeader('content-type', 'application/merge-patch+json');
              xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
              xhr.setRequestHeader('portaltype', '1');
              xhr.onload = function() {
                console.log('[Duke] XHR status:', xhr.status, xhr.responseText);
                resolve(xhr.status);
              };
              xhr.onerror = function() { console.log('[Duke] XHR error'); resolve(0); };
              xhr.send(bodyStr);
            });
            await delay(1500);
            // Re-apply editor content after PUT — React may have reset editors during XHR
            editorA.setData(introHtml);
            editorB.setData(closingHtml);
            await delay(300);
          }
        } else {
          console.log('[Duke] jobId NOT found — falling back to Save button');
          var saveBtn = document.querySelector('[data-testid="save"]');
          if (saveBtn) { saveBtn.click(); await delay(3000); }
        }
      },
      args: [_introHtml, _closingHtml]
    });
    var _saveResult = _editorResult && _editorResult[0] && _editorResult[0].result;
    log('Proposal save result: ' + JSON.stringify(_saveResult));
    // Verify our content is still on server before navigating to Client Preview
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: async function() {
        var resources = performance.getEntriesByType('resource');
        var jobId = null;
        for (var ri = 0; ri < resources.length; ri++) {
          var rm = resources[ri].name.match(/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/);
          if (rm) { jobId = rm[1]; break; }
        }
        if (!jobId) return;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/apix/v2/Proposals/draft?jobId=' + jobId, false); // sync
        xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
        xhr.setRequestHeader('portaltype', '1');
        xhr.send();
        if (xhr.status === 200) {
          try {
            var d = JSON.parse(xhr.responseText);
            var intro = (d.proposal && d.proposal.introductionText) || '';
            console.log('[Duke] Verify GET introductionText starts with:', intro.slice(0, 80));
          } catch(e) {}
        }
      }
    });
    await delay(2000);
    // Uncheck "Collect signatures" if it is currently checked
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: function() {
        var cb = document.querySelector('[data-testid="requireSignatures"]');
        if (cb) {
          var wrapper = cb.closest('.ant-checkbox-wrapper');
          if (wrapper && wrapper.classList.contains('ant-checkbox-wrapper-checked')) {
            cb.click();
            console.log('[Duke] Unchecked requireSignatures');
          }
        }
      }
    });
  }

  // Step 2: Click Client Preview tab
  log('Navigating to client preview…');
  var previewResult = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      function waitFor(fn, ms) {
        return new Promise(function(res, rej) {
          var end = Date.now() + (ms || 6000);
          (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
        });
      }
      var tab = await waitFor(function() {
        var el = document.querySelector('[data-testid="jobProposalClientPreviewTab"]');
        return (el && el.offsetParent !== null) ? el : null;
      }, 6000).catch(function(){ return null; });
      if (!tab) return { ok: false, error: 'Client Preview tab not found' };
      tab.click();
      return { ok: true };
    }
  });
  var pr = previewResult && previewResult[0] && previewResult[0].result;
  if (pr && !pr.ok) throw new Error(pr.error || 'Could not open client preview');
  await delay(2000);

  // Step 3: Edit Display to client — remove Cost code, Parent group price, Unit price; add Item title, Description
  log('Configuring display settings…');
  setLabel('Setting display…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      function waitFor(fn, ms) {
        return new Promise(function(res, rej) {
          var end = Date.now() + (ms || 5000);
          (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
        });
      }

      function removeTag(label) {
        var norm = label.trim().toLowerCase();
        var items = Array.from(document.querySelectorAll('.ant-select-selection-item'));
        var item = items.find(function(el) {
          var c = el.querySelector('.ant-select-selection-item-content');
          return c && c.textContent.trim().toLowerCase() === norm;
        });
        if (item) {
          var btn = item.querySelector('.ant-select-selection-item-remove');
          if (btn) { btn.click(); return true; }
        }
        return false;
      }

      async function addOption(label) {
        var input = document.querySelector('#columnsToDisplay');
        if (!input) return;
        input.focus(); input.click();
        await delay(400);
        var node = await waitFor(function() {
          return Array.from(document.querySelectorAll('.ant-select-tree-node-content-wrapper')).find(function(n) {
            return (n.getAttribute('title') || n.textContent || '').trim().toLowerCase() === label.toLowerCase();
          });
        }, 4000).catch(function(){ return null; });
        if (node) { node.click(); await delay(300); }
        // Close dropdown
        document.body.click();
        await delay(200);
      }

      // Remove unwanted columns
      removeTag('Cost code');    await delay(200);
      removeTag('Parent group price'); await delay(200);
      removeTag('Unit price');   await delay(200);

      // Add missing columns (no-op if already present)
      var existing = Array.from(document.querySelectorAll('.ant-select-selection-item-content')).map(function(el){ return el.textContent.trim().toLowerCase(); });
      if (!existing.includes('item title'))   await addOption('Item title');
      if (!existing.includes('description'))  await addOption('Description');
    }
  });
  await delay(1000);

  // Step 4: Collapse all groups EXCEPT Selection Allowance & Site Allowance
  // (expand those two if they're collapsed)
  log('Configuring groups…');
  setLabel('Configuring groups…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      var KEEP_EXPANDED = ['selection allowances', 'site allowances'];

      // Step 1: Collapse all expanded groups EXCEPT the two we want to keep
      var expandedItems = Array.from(document.querySelectorAll('.ant-collapse-item.ProposalGroup.ant-collapse-item-active'));
      for (var i = 0; i < expandedItems.length; i++) {
        var nameEl = expandedItems[i].querySelector('h3.ant-typography');
        var name = nameEl ? nameEl.textContent.trim().toLowerCase() : '';
        // Exact match only (strip trailing "(1)" if present)
        var cleanName = name.replace(/\s*\(1\)\s*$/, '');
        var keep = KEEP_EXPANDED.some(function(k) { return cleanName === k; });
        if (!keep) {
          var header = expandedItems[i].querySelector('.ant-collapse-header');
          if (header) { header.click(); await delay(200); }
        }
      }

      // Step 2: Expand Selection Allowances & Site Allowances if they're collapsed
      var allItems = Array.from(document.querySelectorAll('.ant-collapse-item.ProposalGroup'));
      for (var j = 0; j < allItems.length; j++) {
        var nameEl2 = allItems[j].querySelector('h3.ant-typography');
        var name2 = nameEl2 ? nameEl2.textContent.trim().toLowerCase() : '';
        // Exact match only (strip trailing "(1)" if present)
        var cleanName2 = name2.replace(/\s*\(1\)\s*$/, '');
        var shouldExpand = KEEP_EXPANDED.some(function(k) { return cleanName2 === k; });
        if (shouldExpand) {
          // Check if currently collapsed (no ant-collapse-item-active class)
          var isCollapsed = !allItems[j].classList.contains('ant-collapse-item-active');
          if (isCollapsed) {
            var header2 = allItems[j].querySelector('.ant-collapse-header');
            if (header2) { header2.click(); await delay(200); }
          }
        }
      }
    }
  });
  await delay(800);

  log('✓ Client preview setup complete');
  setLabel('Done');
}

async function startClientPreview() {
  const btn = $('btn-client-preview');
  const logEl = $('estimate-log');
  btn.disabled = true; btn.textContent = 'Working…';
  logEl.textContent = ''; logEl.classList.remove('hidden');
  function log(msg) { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; }

  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(function(t){ return t.url && t.url.includes('buildertrend') && t.url.toLowerCase().includes('estimate'); })
             || tabs.find(function(t){ return t.url && t.url.includes('buildertrend'); });
    if (!tab) throw new Error('No BuilderTrend Estimate tab found.');
    await runClientPreviewFlow(tab.id, log, function(t){ btn.textContent = t; });
  } catch(e) {
    log('ERROR: ' + e.message);
    showStatus('Client Preview failed: ' + e.message, 'error', 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Start Prelim - Budget Client Preview';
  }
}

async function runM1ClientPreviewFlow(tabId, log, setLabel) {
  function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

  // Step 1: Click buildProposal button
  log('Opening proposal builder…');
  setLabel('Opening proposal…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      var btn = document.querySelector('[data-testid="buildProposal"]');
      if (btn) btn.click();
    }
  });
  await delay(2500);

  // Step 2: Click Client Preview tab
  log('Navigating to client preview…');
  var previewResult = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      function waitFor(fn, ms) {
        return new Promise(function(res, rej) {
          var end = Date.now() + (ms || 6000);
          (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
        });
      }
      var tab = await waitFor(function() {
        var el = document.querySelector('[data-testid="jobProposalClientPreviewTab"]');
        return (el && el.offsetParent !== null) ? el : null;
      }, 6000).catch(function(){ return null; });
      if (!tab) return { ok: false, error: 'Client Preview tab not found' };
      tab.click();
      return { ok: true };
    }
  });
  var pr = previewResult && previewResult[0] && previewResult[0].result;
  if (pr && !pr.ok) throw new Error(pr.error || 'Could not open client preview');
  await delay(2000);

  // Step 3: Edit Display to client — remove Cost code, Parent group price, Unit price; add Item title, Description
  log('Configuring display settings…');
  setLabel('Setting display…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      function waitFor(fn, ms) {
        return new Promise(function(res, rej) {
          var end = Date.now() + (ms || 5000);
          (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
        });
      }
      function removeTag(label) {
        var norm = label.trim().toLowerCase();
        var items = Array.from(document.querySelectorAll('.ant-select-selection-item'));
        var item = items.find(function(el) {
          var c = el.querySelector('.ant-select-selection-item-content');
          return c && c.textContent.trim().toLowerCase() === norm;
        });
        if (item) {
          var btn = item.querySelector('.ant-select-selection-item-remove');
          if (btn) { btn.click(); return true; }
        }
        return false;
      }
      async function addOption(label) {
        var input = document.querySelector('#columnsToDisplay');
        if (!input) return;
        input.focus(); input.click();
        await delay(400);
        var node = await waitFor(function() {
          return Array.from(document.querySelectorAll('.ant-select-tree-node-content-wrapper')).find(function(n) {
            return (n.getAttribute('title') || n.textContent || '').trim().toLowerCase() === label.toLowerCase();
          });
        }, 4000).catch(function(){ return null; });
        if (node) { node.click(); await delay(300); }
        document.body.click();
        await delay(200);
      }
      removeTag('Cost code');        await delay(200);
      removeTag('Parent group price'); await delay(200);
      removeTag('Unit price');       await delay(200);
      var existing = Array.from(document.querySelectorAll('.ant-select-selection-item-content')).map(function(el){ return el.textContent.trim().toLowerCase(); });
      if (!existing.includes('item title'))  await addOption('Item title');
      if (!existing.includes('description')) await addOption('Description');
    }
  });
  await delay(1000);

  // Step 4: Collapse all groups EXCEPT Selection Allowance & Site Allowance
  log('Configuring groups…');
  setLabel('Configuring groups…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      var KEEP_EXPANDED = ['selection allowances', 'site allowances'];
      var expandedItems = Array.from(document.querySelectorAll('.ant-collapse-item.ProposalGroup.ant-collapse-item-active'));
      for (var i = 0; i < expandedItems.length; i++) {
        var nameEl = expandedItems[i].querySelector('h3.ant-typography');
        var name = nameEl ? nameEl.textContent.trim().toLowerCase() : '';
        var cleanName = name.replace(/\s*\(1\)\s*$/, '');
        var keep = KEEP_EXPANDED.some(function(k) { return cleanName === k; });
        if (!keep) {
          var header = expandedItems[i].querySelector('.ant-collapse-header');
          if (header) { header.click(); await delay(200); }
        }
      }
      var allItems = Array.from(document.querySelectorAll('.ant-collapse-item.ProposalGroup'));
      for (var j = 0; j < allItems.length; j++) {
        var nameEl2 = allItems[j].querySelector('h3.ant-typography');
        var name2 = nameEl2 ? nameEl2.textContent.trim().toLowerCase() : '';
        var cleanName2 = name2.replace(/\s*\(1\)\s*$/, '');
        var shouldExpand = KEEP_EXPANDED.some(function(k) { return cleanName2 === k; });
        if (shouldExpand) {
          var isCollapsed = !allItems[j].classList.contains('ant-collapse-item-active');
          if (isCollapsed) {
            var header2 = allItems[j].querySelector('.ant-collapse-header');
            if (header2) { header2.click(); await delay(200); }
          }
        }
      }
    }
  });
  await delay(800);

  log('✓ Client preview setup complete');
  setLabel('Done');
}

async function startM1ClientPreview() {
  const btn = $('btn-m1-client-preview');
  const logEl = $('estimate-log');
  btn.disabled = true; btn.textContent = 'Working…';
  logEl.textContent = ''; logEl.classList.remove('hidden');
  function log(msg) { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; }
  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(function(t){ return t.url && t.url.includes('buildertrend') && t.url.toLowerCase().includes('estimate'); })
             || tabs.find(function(t){ return t.url && t.url.includes('buildertrend'); });
    if (!tab) throw new Error('No BuilderTrend Estimate tab found.');
    await runM1ClientPreviewFlow(tab.id, log, function(t){ btn.textContent = t; });
  } catch(e) {
    log('ERROR: ' + e.message);
    showStatus('M1 Client Preview failed: ' + e.message, 'error', 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Start M1 Client Preview';
  }
}

// ── Write helpers ─────────────────────────────────────────────────────────────

async function writeValues(values) {
  showStatus('Writing to Google Sheets…', 'info', 0);
  try {
    const res = await sendMsg('WRITE_VALUES', { values: values });
    showStatus('✓ Wrote ' + res.written + ' value(s) to sheet', 'success');
    setTimeout(function() { loadSheetTab(activeTab); }, 1000);
  } catch (e) {
    showStatus('Error: ' + e.message, 'error', 6000);
  }
}

// ── Sheet display ─────────────────────────────────────────────────────────────

let activeTab = 'fixed-costs';
const TAB_HEADERS = ['Cost Code', 'Item', 'Type', 'Quantity', 'Amount', 'Unit Cost'];
const TAB_ORDER   = ['fixed-costs', 'finished-unfinished', 'areas', 'allowances-permits'];

async function loadSheetTab(tab) {
  $('sheet-loading').classList.remove('hidden');
  $('sheet-content').classList.add('hidden');
  $('sheet-error').classList.add('hidden');
  try {
    const res = await sendMsg('GET_TAB_DATA', { tab: tab });
    renderTable(res.rows);
    $('sheet-loading').classList.add('hidden');
    $('sheet-content').classList.remove('hidden');
    applySheetZoom();
  } catch (e) {
    $('sheet-loading').classList.add('hidden');
    $('sheet-error').textContent = 'Error: ' + e.message;
    $('sheet-error').classList.remove('hidden');
  }
}

function renderTable(rows) {
  const thead = $('sheet-thead'), tbody = $('sheet-tbody');
  thead.innerHTML = '';
  const hr = document.createElement('tr');
  TAB_HEADERS.forEach(function(h) { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
  thead.appendChild(hr);
  tbody.innerHTML = '';
  if (!rows || !rows.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 6; td.textContent = 'No data'; td.style.cssText = 'text-align:center;padding:16px;color:#a0aec0';
    tr.appendChild(td); tbody.appendChild(tr); return;
  }
  rows.forEach(function(row) {
    if (row.every(function(c) { return !c || !c.toString().trim(); })) return;
    const tr = document.createElement('tr');
    const b2 = (row[1] || '').toString().trim();
    if (!row[0] && b2 === b2.toUpperCase() && b2.length > 3) tr.classList.add('row-total');
    for (let i = 0; i < 6; i++) {
      const td = document.createElement('td');
      let v = row[i] !== undefined ? row[i] : '';
      if ((i === 4 || i === 5) && v) {
        const n = parseFloat(v.toString().replace(/[$,]/g, ''));
        if (!isNaN(n) && n !== 0) v = '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      td.textContent = v;
      if (!v || v === '0') td.style.color = '#cbd5e0';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
}

// ── Sheet zoom ────────────────────────────────────────────────────────────────

const SHEET_ZOOM_STEPS = [60, 70, 80, 90, 100, 110, 120];
let sheetZoomIdx = 4;

function applySheetZoom() {
  const pct   = SHEET_ZOOM_STEPS[sheetZoomIdx];
  const table = $('sheet-table');
  if (table) table.style.fontSize = (pct / 100 * 11) + 'px';
  const szPct = $('sz-pct');
  if (szPct) szPct.textContent = pct + '%';
}

function switchToTab(tabKey) {
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === tabKey);
  });
  activeTab = tabKey;
  loadSheetTab(activeTab);
  updateArrows();
}

function updateArrows() {
  const idx  = TAB_ORDER.indexOf(activeTab);
  const prev = $('tab-prev'), next = $('tab-next');
  if (prev) prev.disabled = (idx === 0);
  if (next) next.disabled = (idx === TAB_ORDER.length - 1);
}

// ── Sequential Post-Takeoff Actions ───────────────────────────────────────────
// Manages workflow: Grab & Write → Write to Estimate → Start Client Preview

let seqState = { currentStep: null, isProcessing: false };

function showSeqActions() {
  const tkWriteBtn = $('btn-tk-write');
  const seqActionsEl = $('seq-actions');
  if (tkWriteBtn) tkWriteBtn.classList.add('hidden');
  if (seqActionsEl) seqActionsEl.classList.remove('hidden');
  seqState.currentStep = 'write-estimate';
  showSeqButton('write-estimate');
}

function showSeqButton(step) {
  const estimateBtn = $('btn-seq-write-estimate');
  const previewBtn = $('btn-seq-client-preview');
  const loadingEl = $('seq-loading');

  if (estimateBtn) estimateBtn.classList.add('hidden');
  if (previewBtn) previewBtn.classList.add('hidden');
  if (loadingEl) loadingEl.classList.add('hidden');

  seqState.currentStep = step;
  seqState.isProcessing = false;
  if (step === 'write-estimate' && estimateBtn) estimateBtn.classList.remove('hidden');
  if (step === 'client-preview' && previewBtn) previewBtn.classList.remove('hidden');
}

function showSeqLoading(text) {
  const estimateBtn = $('btn-seq-write-estimate');
  const previewBtn = $('btn-seq-client-preview');
  const loadingEl = $('seq-loading');
  const loadingText = $('seq-loading-text');

  if (estimateBtn) estimateBtn.classList.add('hidden');
  if (previewBtn) previewBtn.classList.add('hidden');
  if (loadingEl) {
    loadingEl.classList.remove('hidden');
    if (loadingText) loadingText.textContent = text || 'Processing…';
  }
  seqState.isProcessing = true;
}

function hideSeqActions() {
  const tkWriteBtn = $('btn-tk-write');
  const seqActionsEl = $('seq-actions');
  if (tkWriteBtn) tkWriteBtn.classList.remove('hidden');
  if (seqActionsEl) seqActionsEl.classList.add('hidden');
  seqState.currentStep = null;
  seqState.isProcessing = false;
}

function completeSeqActions() {
  const seqActionsEl = $('seq-actions');
  if (seqActionsEl) seqActionsEl.classList.add('hidden');
  seqState.currentStep = null;
  seqState.isProcessing = false;
}

async function seqWriteToEstimate() {
  showSeqLoading('Writing to Estimate…');
  try {
    await writeToEstimate();
    showSeqButton('client-preview');
  } catch (err) {
    console.error('Sequential write to estimate failed:', err);
    hideSeqActions();
  }
}

async function seqClientPreview() {
  showSeqLoading('Starting Client Preview…');
  try {
    await startClientPreview();
    completeSeqActions();
  } catch (err) {
    console.error('Sequential client preview failed:', err);
    hideSeqActions();
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Write to Estimate — click only; block Enter/Space so it can't be triggered via keyboard
  // (only the post-write-to-sheet sequential button responds to Enter)
  $('btn-write-estimate').addEventListener('click', writeToEstimate);
  $('btn-write-estimate').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); e.stopPropagation(); }
  });
  $('btn-stop-write').addEventListener('click', stopWrite);
  $('btn-proposal-done')?.addEventListener('click', resolveProposalSelector);
  $('btn-client-preview')?.addEventListener('click', startClientPreview);
  $('btn-m1-client-preview')?.addEventListener('click', startM1ClientPreview);

  // Stop writing if the extension popup is closed mid-run
  window.addEventListener('unload', stopWrite);

  // Manual entry
  $('btn-write-manual').addEventListener('click', function() {
    const values = {};
    document.querySelectorAll('.manual-row input').forEach(function(inp) {
      if (inp.value.trim()) values[inp.dataset.key] = parseFloat(inp.value);
    });
    if (!Object.keys(values).length) { showStatus('No values entered', 'error', 3000); return; }
    writeValues(values);
  });
  $('btn-clear-manual').addEventListener('click', function() {
    document.querySelectorAll('.manual-row input').forEach(function(i) { i.value = ''; });
  });

  // Sheet tabs & arrows
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchToTab(btn.dataset.tab); });
  });
  const prevBtn = $('tab-prev'), nextBtn = $('tab-next');
  if (prevBtn) prevBtn.addEventListener('click', function() {
    const idx = TAB_ORDER.indexOf(activeTab);
    if (idx > 0) switchToTab(TAB_ORDER[idx - 1]);
  });
  if (nextBtn) nextBtn.addEventListener('click', function() {
    const idx = TAB_ORDER.indexOf(activeTab);
    if (idx < TAB_ORDER.length - 1) switchToTab(TAB_ORDER[idx + 1]);
  });
  updateArrows();

  // Sheet zoom
  $('btn-sz-out') && $('btn-sz-out').addEventListener('click', function() {
    if (sheetZoomIdx > 0) { sheetZoomIdx--; applySheetZoom(); chrome.storage.local.set({ sheetZoomIdx: sheetZoomIdx }); }
  });
  $('btn-sz-in') && $('btn-sz-in').addEventListener('click', function() {
    if (sheetZoomIdx < SHEET_ZOOM_STEPS.length - 1) { sheetZoomIdx++; applySheetZoom(); chrome.storage.local.set({ sheetZoomIdx: sheetZoomIdx }); }
  });
  chrome.storage.local.get('sheetZoomIdx', function(s) {
    if (s.sheetZoomIdx !== undefined) { sheetZoomIdx = s.sheetZoomIdx; applySheetZoom(); }
  });

  // Settings & refresh
  $('btn-settings').addEventListener('click', function() { chrome.runtime.openOptionsPage(); });
  $('btn-refresh-sheet').addEventListener('click', function() { loadSheetTab(activeTab); });

  // Open Sheet button — opens the Google Sheet in a new tab
  var btnOpenSheet = $('btn-open-sheet');
  if (btnOpenSheet) {
    btnOpenSheet.addEventListener('click', function(e) {
      e.stopPropagation(); // don't toggle the <details>
      sendMsg('CHECK_AUTH').then(function(auth) {
        var sid = auth && auth.sheetId;
        if (sid) {
          chrome.tabs.create({ url: 'https://docs.google.com/spreadsheets/d/' + sid });
        } else {
          showStatus('No sheet configured — add Sheet ID in ⚙ Settings', 'error', 4000);
        }
      });
    });
  }

  // Load sheet only when the details panel is first opened
  var sheetDetails = $('sheet-details');
  var sheetLoaded = false;
  if (sheetDetails) {
    sheetDetails.addEventListener('toggle', function() {
      if (sheetDetails.open && !sheetLoaded) {
        sheetLoaded = true;
        $('sheet-loading').classList.remove('hidden');
        loadSheetTab(activeTab);
      }
    });
  }

  // Check auth (no auto-load sheet)
  try {
    const auth = await sendMsg('CHECK_AUTH');
    if (!auth.hasClientId || !auth.hasSheetId) {
      $('sheet-error').textContent = 'Configure Google Client ID in ⚙ Settings to see sheet data.';
      $('sheet-error').classList.remove('hidden');
    }
  } catch (e) {
    $('sheet-error').textContent = 'Setup error: ' + e.message;
    $('sheet-error').classList.remove('hidden');
  }

  // Sequential post-takeoff buttons
  $('btn-seq-write-estimate')?.addEventListener('click', seqWriteToEstimate);
  $('btn-seq-client-preview')?.addEventListener('click', seqClientPreview);

  // NOTE: Enter key handling for the workflow buttons (btn-tk-done, btn-tk-write-estimate)
  // is handled entirely inside takeoff-workflow.js to avoid race conditions.
  // The Grab & Write to Sheet button (btn-tk-write) must only be triggered by explicit mouse click.

  // Enter key: allow Grab & Write to Sheet ONLY when tk-complete is actually visible.
  // (btn-tk-write lives inside tk-complete, which is hidden during active takeoff steps.
  //  Checking the parent prevents a stray Enter from the last takeoff step triggering it.)
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return;
    const tkCompleteDiv = document.getElementById('tk-complete');
    const tkBtn = $('btn-tk-write');
    if (tkCompleteDiv && !tkCompleteDiv.classList.contains('hidden') &&
        tkBtn && !tkBtn.disabled) {
      tkBtn.click();
      e.preventDefault();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
