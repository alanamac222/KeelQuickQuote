// Duke Estimating - Background Service Worker
// Handles Google Sheets API auth, data read/write, and GPT-4o plan analysis

const SHEETS_API    = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES        = 'https://www.googleapis.com/auth/spreadsheets';
const OPENAI_API    = 'https://api.openai.com/v1/chat/completions';

const DEFAULT_SHEET_ID   = '1iO37IiTagtu4OGEZSHA5C62tPRc5HOKMpq0UcsUI9ig';
const DEFAULT_SHEET_NAME = '2026 CUSTOM PLAN';

// ─── Floating Panel Window ───────────────────────────────────────────────────
// Clicking the toolbar icon opens a draggable/resizable floating window

let panelWindowId = null;

chrome.action.onClicked.addListener(async () => {
  // If panel is already open, focus it instead of opening another
  if (panelWindowId !== null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch (_) {
      panelWindowId = null; // window was closed, fall through to create
    }
  }

  const panelUrl = chrome.runtime.getURL('panel.html');

  // Get current window position to place panel beside it
  let left = 100, top = 80;
  try {
    const currentWin = await chrome.windows.getCurrent();
    left = (currentWin.left || 0) + (currentWin.width || 1200) - 520;
    top  = currentWin.top || 80;
    if (left < 0) left = 0;
  } catch (_) {}

  const win = await chrome.windows.create({
    url: panelUrl,
    type: 'popup',
    width: 500,
    height: 700,
    top: top,
    left: left,
    focused: true
  });
  panelWindowId = win.id;
});

// Clear stored ID when the panel window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === panelWindowId) panelWindowId = null;
});

// ─── Config ──────────────────────────────────────────────────────────────────

async function getConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      ['clientId','sheetId','sheetName','accessToken','tokenExpiry','openaiKey'],
      (cfg) => {
        cfg.sheetId   = cfg.sheetId   || DEFAULT_SHEET_ID;
        cfg.sheetName = cfg.sheetName || DEFAULT_SHEET_NAME;
        resolve(cfg);
      }
    );
  });
}

// ─── Google OAuth2 ────────────────────────────────────────────────────────────

async function getValidToken() {
  const cfg = await getConfig();
  if (!cfg.clientId) throw new Error('NO_CLIENT_ID');

  if (cfg.accessToken && cfg.tokenExpiry && Date.now() < cfg.tokenExpiry - 300000) {
    return cfg.accessToken;
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = `${GOOGLE_AUTH_URL}?client_id=${encodeURIComponent(cfg.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(SCOPES)}&prompt=consent`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        reject(new Error(chrome.runtime.lastError?.message || 'Auth cancelled'));
        return;
      }
      const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
      const token = params.get('access_token');
      const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
      if (!token) { reject(new Error('No access token')); return; }
      chrome.storage.local.set({ accessToken: token, tokenExpiry: Date.now() + expiresIn * 1000 });
      resolve(token);
    });
  });
}

// ─── Sheets API ───────────────────────────────────────────────────────────────

async function sheetsGet(range) {
  const { sheetId, sheetName } = await getConfig();
  const token = await getValidToken();
  const sheet = sheetName || DEFAULT_SHEET_NAME;
  const encoded = encodeURIComponent(`'${sheet}'!${range}`);
  const res = await fetch(`${SHEETS_API}/${sheetId}/values/${encoded}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Sheets read error: ${await res.text()}`);
  return (await res.json()).values || [];
}

async function sheetsWrite(updates) {
  const { sheetId, sheetName } = await getConfig();
  const token = await getValidToken();
  const sheet = sheetName || DEFAULT_SHEET_NAME;
  const data = updates.map(u => ({
    range: `'${sheet}'!${u.range}`,
    values: [[u.value]]
  }));
  const res = await fetch(`${SHEETS_API}/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
  });
  if (!res.ok) throw new Error(`Sheets write error: ${await res.text()}`);
  return await res.json();
}

// ─── Offscreen Document (PDF rendering) ──────────────────────────────────────

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.() ?? false;
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['DOM_SCRAPING'],
      justification: 'Render PDF floor plan pages using PDF.js for GPT-4o analysis'
    });
  }
}

async function renderPDFToImages(pdfBase64) {
  await ensureOffscreen();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'RENDER_PDF_PAGES', target: 'offscreen', pdfBase64, scale: 2.5 },
      (res) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!res?.ok) { reject(new Error(res?.error || 'PDF render failed')); return; }
        resolve(res.images); // array of base64 PNG per page
      }
    );
  });
}

// ─── Auto-crop whitespace (background / service worker version) ──────────────

async function cropWhitespace(base64) {
  try {
    const blob  = await (await fetch('data:image/png;base64,' + base64)).blob();
    const bmp   = await createImageBitmap(blob);
    const W = bmp.width, H = bmp.height;

    const oc  = new OffscreenCanvas(W, H);
    const ctx = oc.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(bmp, 0, 0);

    const data = ctx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = 0, maxY = 0;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (data[i] < 238 || data[i+1] < 238 || data[i+2] < 238) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX <= minX || maxY <= minY) return base64;

    const pad = 40;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(W, maxX + pad);
    maxY = Math.min(H, maxY + pad);

    const cW = maxX - minX, cH = maxY - minY;
    const out = new OffscreenCanvas(cW, cH);
    out.getContext('2d').drawImage(oc, minX, minY, cW, cH, 0, 0, cW, cH);

    const outBlob = await out.convertToBlob({ type: 'image/png' });
    const buf = await outBlob.arrayBuffer();
    let binary = '';
    new Uint8Array(buf).forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
  } catch (e) {
    console.warn('[Duke] cropWhitespace failed:', e.message);
    return base64; // return original if crop fails
  }
}

// ─── Fetch PDF from URL ───────────────────────────────────────────────────────

async function fetchPDFAsBase64(pdfUrl) {
  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ─── Offscreen Document ───────────────────────────────────────────────────────

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['DOM_PARSER'],
      justification: 'OCR spec pages with Tesseract.js',
    });
  }
}

// ─── Flooring Specs (Included Features page) ──────────────────────────────────

// Fetch a rasterized page image (Azure-blob GIF) and return raw bytes as base64.
async function fetchGifAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  let binary = '';
  new Uint8Array(buf).forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

const FLOORING_SPEC_PROMPT =
  'You are reading an architectural "Included Features" / specifications sheet (provided as an image).\n' +
  'Extract VERBATIM any notes that mention flooring materials.\n\n' +
  'Return ONLY a JSON object with exactly these keys, each an array of verbatim note strings ' +
  '(copy the wording exactly as written on the sheet, including room/location names if present). ' +
  'If a category has no notes, use an empty array.\n\n' +
  '{\n' +
  '  "flooring": [ notes mentioning flooring in general ],\n' +
  '  "tile":     [ notes mentioning tile ],\n' +
  '  "carpet":   [ notes mentioning carpet ],\n' +
  '  "hardwood": [ notes mentioning hardwood OR any of these wood species: oak, maple, walnut, cherry, birch, hickory, pine, ash, douglas fir, bamboo, poplar ]\n' +
  '}\n\n' +
  'Rules:\n' +
  '- Copy each note exactly as written (verbatim).\n' +
  '- A note may appear in more than one category if it mentions multiple materials.\n' +
  '- Only include notes actually about flooring/tile/carpet/hardwood; ignore unrelated spec lines.\n' +
  '- Return only the JSON object, with no extra text.';

async function extractFlooringSpecs(ocrText) {
  const prompt = FLOORING_SPEC_PROMPT + '\n\nDocument text:\n"""\n' + ocrText + '\n"""';
  const payload = {
    model: 'gpt-4o-mini',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  };
  return callGPT4o(payload);
}

// ─── GPT-4o Plan Analysis ─────────────────────────────────────────────────────

const ANALYSIS_SYSTEM_PROMPT = `You are an experienced residential construction estimator who specializes in reading floor plans — both professional CAD drawings and hand-drawn sketches.

Your job is to carefully count and locate specific elements in the floor plan images provided. You must return your answer as a single valid JSON object matching the schema below. Do not include any text outside the JSON.

How to count doors:
- A single door is shown as one arc (quarter-circle swing) at a wall opening — like a pie slice or fan shape. Count it as 1.
- A double door (French doors, double entry) has two arcs at the same opening facing each other. Count each leaf separately — two arcs = 2 doors.
- Hand-drawn arcs are still doors even if rough or imperfect. If there is an arc or curved line at a wall gap, count it as a door.
- Two hand-drawn half-semicircles at one opening = 2 doors.
- Pocket doors (dashes inside the wall) = 1 per panel.
- Sliding glass doors = 1 per panel.

Exterior doors: doors in the outer perimeter walls of the building. Includes front entry, rear/side doors, mudroom-to-outside, porch doors. Does not include garage overhead doors.
Interior doors: doors connecting interior rooms. Includes bedroom, bathroom, closet, utility, and hallway doors.
Garage overhead doors: large rolling doors shown as parallel horizontal lines across a garage bay opening. Count each bay separately.

How to count staircases:
Count every distinct stair location: interior stairs (with UP/DN arrows and step lines), garage entry steps, and porch/exterior steps. Each location = 1 staircase.

Other elements:
- Windows: rectangular openings cut into exterior walls, usually with parallel lines inside the gap.
- Baths: rooms with a toilet and sink. Include half baths and powder rooms.
- Porch columns: small square or circular symbols at porch corners or edges indicating structural columns.

For each element found, record its position as x and y percentages of the image dimensions (0 to 100). Top-left = 0,0. Bottom-right = 100,100.

Return this exact JSON structure with no extra text:
{
  "exterior_doors":  { "count": 0, "locations": [{ "x": 0, "y": 0, "note": "brief description" }] },
  "windows":         { "count": 0, "locations": [{ "x": 0, "y": 0, "note": "brief description" }] },
  "baths":           { "count": 0, "locations": [{ "x": 0, "y": 0, "note": "brief description" }] },
  "staircases":      { "count": 0, "locations": [{ "x": 0, "y": 0, "note": "brief description" }] },
  "porch_columns":   { "count": 0, "locations": [{ "x": 0, "y": 0, "note": "brief description" }] },
  "garage_doors":    { "count": 0, "locations": [{ "x": 0, "y": 0, "note": "brief description" }] },
  "interior_doors":  { "count": 0, "locations": [{ "x": 0, "y": 0, "note": "brief description" }] }
}`;

// Analyze one OR multiple page images (for multi-page PDFs)
function buildOpenAIRequest(imagesBase64Array, mimeType) {
  // Images go in the user message; system prompt is in its own role
  const userContent = [];

  userContent.push({ type: 'text', text: 'Please analyze the floor plan image(s) below and return the JSON.' });

  imagesBase64Array.forEach((b64, i) => {
    if (imagesBase64Array.length > 1) {
      userContent.push({ type: 'text', text: `Page ${i + 1}:` });
    }
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${b64}`, detail: 'high' }
    });
  });

  return {
    model: 'gpt-4o',
    max_tokens: 4096,
    response_format: { type: 'json_object' },   // forces valid JSON output
    messages: [
      { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
      { role: 'user',   content: userContent }
    ]
  };
}

async function callGPT4o(payload) {
  const cfg = await getConfig();
  if (!cfg.openaiKey) throw new Error('NO_OPENAI_KEY');

  // Remove response_format — it conflicts with vision in some cases
  delete payload.response_format;

  const res = await fetch(OPENAI_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errText}`);
  }

  const data    = await res.json();
  const content = (data.choices?.[0]?.message?.content || '').trim();

  // Log full response to service worker console for debugging
  console.log('[Duke Estimating] GPT-4o raw response:', content);

  if (!content) throw new Error('GPT-4o returned an empty response. The image may not have loaded correctly.');

  // Strip markdown fences if present
  const clean = content.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  // Find the JSON object in the response (in case GPT added surrounding text)
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`GPT-4o did not return JSON. Full response: ${content}`);

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Could not parse GPT-4o response as JSON. Response was: ${content}`);
  }
}

async function analyzeWithGPT4oPages(imagesBase64Array, mimeType = 'image/png') {
  return callGPT4o(buildOpenAIRequest(imagesBase64Array, mimeType));
}

async function analyzeWithGPT4o(imageBase64, mimeType = 'image/png') {
  return callGPT4o(buildOpenAIRequest([imageBase64], mimeType));
}

// ─── Cell Mapping ─────────────────────────────────────────────────────────────

const CELL_MAP = {
  'basement':                  'I3',
  '1st floor':                 'I4',
  'first floor':               'I4',
  '2nd floor':                 'I5',
  'second floor':              'I5',
  '3rd floor':                 'I6',
  'third floor':               'I6',
  'attic with storage':        'I7',
  'habitable attic':           'I8',
  'front porch':               'I9',
  'rear porch':                'I10',
  'rear deck':                 'I11',
  'garage':                    'I12',
  '# of exterior doors':       'I18',
  'exterior doors':            'I18',
  'exterior door':             'I18',
  '# of windows':              'I19',
  'windows':                   'I19',
  '# of baths':                'I20',
  'baths':                     'I20',
  'bathrooms':                 'I20',
  'cabinets lf':               'I21',
  'cabinets':                  'I21',
  'countertops lf':            'I22',
  'countertops':               'I22',
  'countertop':                'I22',
  '# of staircases':           'I23',
  'staircases':                'I23',
  '# of front porch columns':  'I24',
  'front porch columns':       'I24',
  'porch columns':             'I24',
  '# of garage doors':         'I25',
  'garage doors':              'I25',
  '# of interior doors':       'I26',
  'interior doors':            'I26',
  'sf of carpet':              'I27',
  'carpet':                    'I27',
  'sf of hardwood':            'I28',
  'hardwood':                  'I28',
  'sf of tile':                'I29',
  'tile':                      'I29',
};

function buildUpdates(values) {
  const updates = [];
  for (const [key, val] of Object.entries(values)) {
    const cell = CELL_MAP[key.toLowerCase().trim()];
    if (cell && val !== '' && val !== null && val !== undefined) {
      const num = parseFloat(String(val).replace(/,/g, ''));
      if (!isNaN(num)) updates.push({ range: cell, value: num });
    }
  }
  return updates;
}

// Map GPT-4o result keys to our cell map keys
function gptResultToValues(result) {
  return {
    '# of exterior doors':      result.exterior_doors?.count  ?? null,
    '# of windows':             result.windows?.count         ?? null,
    '# of baths':               result.baths?.count           ?? null,
    '# of staircases':          result.staircases?.count      ?? null,
    '# of front porch columns': result.porch_columns?.count   ?? null,
    '# of garage doors':        result.garage_doors?.count    ?? null,
    '# of interior doors':      result.interior_doors?.count  ?? null,
  };
}

// ─── Tab Data ─────────────────────────────────────────────────────────────────

async function fetchTabData(tab) {
  const ranges = {
    'fixed-costs':         'A1:F25',
    'finished-unfinished': 'A27:F47',
    'areas':               'A49:F78',
    'allowances-permits':  'A80:F101'
  };
  const range = ranges[tab];
  if (!range) throw new Error(`Unknown tab: ${tab}`);
  return await sheetsGet(range);
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {

        case 'GET_TAB_DATA': {
          const rows = await fetchTabData(msg.tab);
          sendResponse({ ok: true, rows });
          break;
        }

        case 'GET_INPUT_DATA': {
          const rows = await sheetsGet('H1:I28');
          sendResponse({ ok: true, rows });
          break;
        }

        case 'READ_CELLS_BATCH': {
          const { sheetId: sid, sheetName: sname } = await getConfig();
          const token = await getValidToken();
          const sheet = sname || DEFAULT_SHEET_NAME;
          const qp = msg.ranges.map(r => 'ranges=' + encodeURIComponent("'" + sheet + "'!" + r)).join('&');
          const batchRes = await fetch(`${SHEETS_API}/${sid}/values:batchGet?${qp}&valueRenderOption=UNFORMATTED_VALUE`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (!batchRes.ok) throw new Error('Batch read error: ' + await batchRes.text());
          const batchJson = await batchRes.json();
          const out = {};
          msg.ranges.forEach((r, i) => {
            out[r] = batchJson.valueRanges?.[i]?.values?.[0]?.[0] ?? null;
          });
          sendResponse({ ok: true, data: out });
          break;
        }

        case 'READ_CELLS_RANGE_TAB': {
          const { sheetId: sid2 } = await getConfig();
          const token2 = await getValidToken();
          const tabName = msg.tab || 'SITE OPTIONS';
          const rangeStr = encodeURIComponent("'" + tabName + "'!" + msg.range);
          const rangeRes = await fetch(`${SHEETS_API}/${sid2}/values/${rangeStr}?valueRenderOption=UNFORMATTED_VALUE`, {
            headers: { Authorization: `Bearer ${token2}` }
          });
          if (!rangeRes.ok) throw new Error('Range read error: ' + await rangeRes.text());
          const rangeJson = await rangeRes.json();
          sendResponse({ ok: true, data: rangeJson.values || [] });
          break;
        }

        case 'WRITE_VALUES': {
          const updates = buildUpdates(msg.values);
          if (updates.length === 0) { sendResponse({ ok: true, written: 0 }); break; }
          // Zero-fill target cells before writing real values
          const zeroRanges = [
            'I3','I4','I5','I6','I7','I8','I9','I10','I11','I12',
            'I18','I19','I20','I21','I22','I23','I24','I25','I26','I27','I28'
          ];
          await sheetsWrite(zeroRanges.map(r => ({ range: r, value: 0 })));
          await sheetsWrite(updates);
          sendResponse({ ok: true, written: updates.length });
          break;
        }

        case 'ANALYZE_PDF': {
          // Full PDF flow: find URL → fetch PDF → render pages → analyze all pages
          const allTabs = await chrome.tabs.query({});
          const btTab = allTabs.find(t => t.url && (
            t.url.includes('squaretakeoff.com') || t.url.includes('buildertrend.net')
          ));
          if (!btTab) throw new Error('BuilderTrend takeoff tab not found. Make sure it is open.');

          // Inject content script then get PDF URL
          try {
            await chrome.scripting.executeScript({ target: { tabId: btTab.id }, files: ['content.js'] });
          } catch (_) {}

          const urlRes = await chrome.tabs.sendMessage(btTab.id, { action: 'GET_PDF_URL' });
          let pdfUrl = urlRes?.url;

          // Fallback: scan the page source for any .pdf URL
          if (!pdfUrl) {
            const [scanResult] = await chrome.scripting.executeScript({
              target: { tabId: btTab.id },
              func: () => {
                // Search page HTML for PDF URLs
                const html = document.documentElement.innerHTML;
                const matches = html.match(/https?:\/\/[^\s"'<>]+\.pdf[^\s"'<>]*/gi);
                if (matches?.length) return matches[0];

                // Check XHR performance entries
                const entries = performance.getEntriesByType('resource');
                const pdfEntry = entries.find(e => /\.pdf/i.test(e.name));
                if (pdfEntry) return pdfEntry.name;

                return null;
              }
            });
            pdfUrl = scanResult?.result;
          }

          if (!pdfUrl) throw new Error('Could not find the PDF on this page. Please refresh the BuilderTrend takeoff tab, wait for the plan to fully load, then try again.');

          // Fetch the full PDF
          const pdfBase64 = await fetchPDFAsBase64(pdfUrl);

          // Render all pages to high-res PNG via offscreen document
          const images = await renderPDFToImages(pdfBase64);

          // Validate images
          if (!images?.length) throw new Error('PDF rendered 0 pages. The PDF may be blank or failed to render.');
          const validImages = images.filter(b64 => b64 && b64.length > 1000);
          if (!validImages.length) throw new Error('PDF pages rendered as blank images. Try refreshing the BuilderTrend tab.');

          // Auto-crop each page using OffscreenCanvas to remove whitespace
          const croppedImages = await Promise.all(validImages.map(b64 => cropWhitespace(b64)));
          console.log(`[Duke Estimating] Sending ${croppedImages.length} page(s) to GPT-4o, sizes: ${croppedImages.map(b=>b.length).join(', ')} chars`);

          // Send cropped pages to GPT-4o
          const result = await analyzeWithGPT4oPages(croppedImages, 'image/png');
          sendResponse({ ok: true, result, pages: images.length });
          break;
        }

        case 'RENDER_UPLOADED_PDF': {
          const images = await renderPDFToImages(msg.pdfBase64);
          sendResponse({ ok: true, images });
          break;
        }

        case 'ANALYZE_PLAN': {
          // Support single image or multiple pages
          const pages = [msg.imageBase64, ...(msg.extraImages || [])].filter(Boolean);
          const result = pages.length > 1
            ? await analyzeWithGPT4oPages(pages, msg.mimeType || 'image/png')
            : await analyzeWithGPT4o(msg.imageBase64, msg.mimeType || 'image/png');
          sendResponse({ ok: true, result });
          break;
        }

        case 'ANALYZE_AND_WRITE': {
          // Analyze the plan image then immediately write counts to sheet
          const result = await analyzeWithGPT4o(msg.imageBase64, msg.mimeType || 'image/png');
          const values = gptResultToValues(result);
          const updates = buildUpdates(values);
          if (updates.length > 0) await sheetsWrite(updates);
          sendResponse({ ok: true, result, written: updates.length });
          break;
        }

        case 'CAPTURE_TAB_SCREENSHOT': {
          try {
            // Step 1: find the BuilderTrend / SquareTakeoff tab
            const allTabs = await chrome.tabs.query({});
            const btTab = allTabs.find(t =>
              t.url && (
                t.url.includes('squaretakeoff.com') ||
                t.url.includes('buildertrend.net')
              )
            );
            const targetTab = btTab || allTabs.find(t => t.active && !t.url?.startsWith('chrome-extension://'));
            if (!targetTab) throw new Error('No BuilderTrend tab found. Make sure the takeoff page is open.');

            // Step 2: get the plan canvas bounds from the content script
            let cropRect = null;
            try {
              const [result] = await chrome.scripting.executeScript({
                target: { tabId: targetTab.id },
                func: () => {
                  // Find the largest canvas (the plan viewer)
                  const canvases = Array.from(document.querySelectorAll('canvas'))
                    .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
                  if (canvases.length > 0 && canvases[0].offsetWidth > 100) {
                    const r = canvases[0].getBoundingClientRect();
                    return { x: r.left, y: r.top, w: r.width, h: r.height };
                  }
                  // Fallback: look for the plan viewer container
                  const viewer = document.querySelector(
                    '.plan-viewer, .takeoff-viewer, [class*="planViewer"], [class*="canvasContainer"], #canvas-container'
                  );
                  if (viewer) {
                    const r = viewer.getBoundingClientRect();
                    return { x: r.left, y: r.top, w: r.width, h: r.height };
                  }
                  return null;
                }
              });
              cropRect = result?.result;
            } catch (_) {}

            // Step 3: capture the tab
            const dataUrl = await new Promise((res, rej) => {
              chrome.tabs.captureVisibleTab(targetTab.windowId, { format: 'png' }, (url) => {
                if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
                else res(url);
              });
            });

            // Step 4: crop to canvas area if we got bounds
            let finalBase64;
            if (cropRect && cropRect.w > 100 && cropRect.h > 100) {
              const dpr = 2; // Chrome captures at 2x on most displays
              const img = await createImageBitmap(
                await (await fetch(dataUrl)).blob()
              );
              const offscreen = new OffscreenCanvas(
                Math.round(cropRect.w * dpr),
                Math.round(cropRect.h * dpr)
              );
              const ctx = offscreen.getContext('2d');
              ctx.drawImage(img,
                Math.round(cropRect.x * dpr), Math.round(cropRect.y * dpr),
                Math.round(cropRect.w * dpr), Math.round(cropRect.h * dpr),
                0, 0,
                Math.round(cropRect.w * dpr), Math.round(cropRect.h * dpr)
              );
              const blob = await offscreen.convertToBlob({ type: 'image/png' });
              const buf  = await blob.arrayBuffer();
              finalBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
            } else {
              finalBase64 = dataUrl.split(',')[1];
            }

            sendResponse({ ok: true, base64: finalBase64, mimeType: 'image/png', source: 'tab-screenshot' });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }

        case 'CHECK_AUTH': {
          const cfg = await getConfig();
          sendResponse({
            ok: true,
            hasClientId:  !!cfg.clientId,
            hasSheetId:   !!cfg.sheetId,
            hasOpenaiKey: !!cfg.openaiKey,
            sheetId:      cfg.sheetId || ''
          });
          break;
        }

        case 'SET_ALWAYS_ON_TOP': {
          if (panelWindowId !== null) {
            await chrome.windows.update(panelWindowId, { alwaysOnTop: msg.alwaysOnTop });
          }
          sendResponse({ ok: true });
          break;
        }

        case 'EXTRACT_FLOORING_SPECS': {
          // 1. Fetch GIF bytes in service worker (bypasses CORS)
          // 2. Send to panel-ocr for Tesseract OCR → plain text
          // 3. Send text to GPT-4o for flooring JSON extraction (no image = no content filter)
          try {
            const cfg = await getConfig();
            if (!cfg.openaiKey) { sendResponse({ ok: false, error: 'NO_OPENAI_KEY' }); break; }

            const _tFetch0 = performance.now();
            const gifB64 = await fetchGifAsBase64(msg.imageUrl);
            const _tFetch1 = performance.now();
            console.log('[Duke Timing] GIF fetch: ' + (_tFetch1 - _tFetch0).toFixed(0) + 'ms  size: ' + gifB64.length + ' chars b64');

            const _tOcr0 = performance.now();
            const ocrRes = await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage(
                { target: 'panel-ocr', action: 'OCR_IMAGE', gifBase64: gifB64 },
                (res) => {
                  if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                  if (!res || !res.ok) { reject(new Error((res && res.error) || 'OCR failed')); return; }
                  resolve(res.text);
                }
              );
            });
            const _tOcr1 = performance.now();
            console.log('[Duke Timing] Tesseract OCR: ' + (_tOcr1 - _tOcr0).toFixed(0) + 'ms  text length: ' + ocrRes.length + ' chars');
            console.log('[Duke Estimating] OCR preview:', ocrRes.slice(0, 200));

            const _tGpt0 = performance.now();
            const result = await extractFlooringSpecs(ocrRes);
            const _tGpt1 = performance.now();
            console.log('[Duke Timing] GPT-4o text analysis: ' + (_tGpt1 - _tGpt0).toFixed(0) + 'ms');

            sendResponse({ ok: true, result });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }

        case 'FOCUS_PANEL': {
          // Bring the Duke panel window to the front (e.g. when the Area Setup questionnaire appears)
          if (panelWindowId !== null) {
            try { await chrome.windows.update(panelWindowId, { focused: true, drawAttention: true }); }
            catch (_) {}
          }
          sendResponse({ ok: true });
          break;
        }

        case 'OPEN_ESTIMATE_TAB_PICKER': {
          // Called from webpage-bridge.js on behalf of the public Keel Quick
          // Quote webpage. Stash the items and open the tab-picker window —
          // it reads them back out of session storage once it loads.
          await chrome.storage.session.set({ pendingEstimateItems: msg.items || [], pendingCustomItems: msg.customItems || [], pendingSiteOptions: msg.siteOptions || [], pendingClientPreview: false });
          const pickerUrl = chrome.runtime.getURL('tabpicker.html');
          await chrome.windows.create({
            url: pickerUrl,
            type: 'popup',
            width: 480,
            height: 680,
            focused: true
          });
          sendResponse({ ok: true });
          break;
        }

        case 'RUN_CLIENT_PREVIEW': {
          await chrome.storage.session.set({ pendingClientPreview: true, pendingEstimateItems: [], pendingCustomItems: [] });
          const cpPickerUrl = chrome.runtime.getURL('tabpicker.html');
          await chrome.windows.create({
            url: cpPickerUrl,
            type: 'popup',
            width: 480,
            height: 680,
            focused: true
          });
          sendResponse({ ok: true });
          break;
        }

        case 'NOTIFY_PDF_READY': {
          // Find the KeelQuickQuote tab and tell its content script the PDF is ready
          const allTabs = await chrome.tabs.query({ url: 'https://alanamac222.github.io/*' });
          for (const t of allTabs) {
            try { await chrome.tabs.sendMessage(t.id, { action: 'PROPOSAL_PDF_READY' }); } catch (_) {}
          }
          sendResponse({ ok: true });
          break;
        }

        case 'GET_PROPOSAL_PDF': {
          var pdfStored = await chrome.storage.session.get(['pendingProposalPdf']);
          if (pdfStored.pendingProposalPdf) {
            sendResponse({ ok: true, data: pdfStored.pendingProposalPdf });
          } else {
            sendResponse({ ok: false, error: 'No PDF available — run Client Preview first' });
          }
          break;
        }

        case 'SIGN_OUT': {
          chrome.storage.local.remove(['accessToken', 'tokenExpiry']);
          sendResponse({ ok: true });
          break;
        }

        case 'DELETE_LAST_SVG_DOT': {
          // Step 1: get last dot info + remove from svgedit DOM (MAIN world of svgedit frame)
          const allFrames = await chrome.webNavigation.getAllFrames({ tabId: _sender.tab.id });
          const svgFrame  = allFrames && allFrames.find(f => f.url && f.url.includes('svg-editor'));
          if (!svgFrame) { sendResponse({ ok: false, error: 'svgedit frame not found' }); break; }

          const [svgRes] = await chrome.scripting.executeScript({
            target: { tabId: _sender.tab.id, frameIds: [svgFrame.frameId] },
            world: 'MAIN',
            func: function () {
              if (!window.svgCanvas) return { ok: false, error: 'no svgCanvas' };
              var layer  = svgCanvas.getCurrentDrawing().getCurrentLayer();
              var shapes = Array.from(layer.childNodes).filter(function (n) {
                return n.nodeType === 1 &&
                       n.tagName.toLowerCase() !== 'title' &&
                       n.tagName.toLowerCase() !== 'defs' &&
                       n.id !== 'selectorParentGroup' &&
                       !n.id.startsWith('selector');
              });
              if (!shapes.length) return { ok: false, error: 'no shapes' };
              var last    = shapes[shapes.length - 1];
              var dotId   = last.id;
              var dotHtml = last.outerHTML;
              svgCanvas.selectOnly([last], true);
              svgCanvas.deleteSelectedElements();
              return { ok: true, dotId: dotId, dotHtml: dotHtml };
            }
          });

          if (!svgRes || !svgRes.result || !svgRes.result.ok) {
            sendResponse(svgRes && svgRes.result ? svgRes.result : { ok: false, error: 'svgedit delete failed' });
            break;
          }

          const dotInfo = svgRes.result;

          // Step 2: POST DocumentPagesLayoutUpdateSquarefeet directly from the main
          // frame MAIN world so session cookies are included and the server count updates.
          const [mainRes] = await chrome.scripting.executeScript({
            target: { tabId: _sender.tab.id, frameIds: [0] },
            world: 'MAIN',
            func: function (dotId, dotHtml) {
              // Find the DocumentPageLayoutId from the active count row
              var layoutId = null;
              document.querySelectorAll('tr[aria-selected="true"], tr.k-selected').forEach(function (row) {
                if (layoutId) return;
                row.querySelectorAll('[id^="ccl"]').forEach(function (div) {
                  if (layoutId) return;
                  var m = div.id.match(/^ccl(\d+)$/);
                  if (m && /^\d+\s*EA$/i.test(div.textContent.trim())) layoutId = m[1];
                });
              });
              if (!layoutId) return { ok: false, error: 'no layoutId' };

              var fd = new FormData();
              fd.append('_DocumetPageLayoutId', layoutId);
              fd.append('_squarefeet', '1');
              fd.append('svgpathid', dotId);
              fd.append('_flag', 'D');
              fd.append('SvgElement', dotHtml);
              fetch('/Joist/DocumentPagesLayoutUpdateSquarefeet/', { method: 'POST', body: fd })
                .catch(function (e) { console.log('[Duke] count POST error:', e); });

              return { ok: true, dotId: dotId, layoutId: layoutId };
            },
            args: [dotInfo.dotId, dotInfo.dotHtml]
          });

          sendResponse(mainRes && mainRes.result ? mainRes.result : { ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown action' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
