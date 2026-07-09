// Duke Estimating - Content Script
// Runs on BuilderTrend + SquareTakeoff (app.squaretakeoff.com)

(function () {
  'use strict';

  // ── Suppress print dialog if flagged by the extension ──────────────────────
  // tabpicker.js sets suppressNextPrint:true before clicking BT's Print button.
  // We inject into MAIN world via a <script> tag so the override is in place
  // before any page script runs — the print dialog never appears.
  chrome.storage.session.get(['suppressNextPrint'], function (data) {
    if (!data.suppressNextPrint) return;
    chrome.storage.session.remove('suppressNextPrint');
    var s = document.createElement('script');
    s.textContent = 'window.print = function(){};';
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  });
  // ───────────────────────────────────────────────────────────────────────────

  var isMainFrame = (window === window.top);

  // Only run in the main frame
  if (!isMainFrame) return;

  // ─── ALL CATEGORIES with zero-fill defaults ───────────────────────────────
  // Every key here will be written to the sheet — missing ones get 0
  const ALL_CATEGORIES = {
    'basement':                  0,
    '1st floor':                 0,
    '2nd floor':                 0,
    '3rd floor':                 0,
    'attic with storage':        0,
    'habitable attic':           0,
    'front porch':               0,
    'rear porch':                0,
    'rear deck':                 0,
    'garage':                    0,
    'cabinets lf':               0,
    'countertops lf':            0,
    '# of exterior doors':       0,
    '# of windows':              0,
    '# of baths':                0,
    '# of staircases':           0,
    '# of front porch columns':  0,
    '# of garage doors':         0,
    '# of interior doors':       0,
    'sf of carpet':              0,
    'sf of hardwood':            0,
    'sf of tile':                0,
  };

  // ─── Label matching ───────────────────────────────────────────────────────
  // ORDER MATTERS: longer/more-specific patterns must come before any that are substrings of them.
  // Within each entry, longer patterns are listed first so the regex matches the full word.
  const LABEL_MAP = [
    { patterns: ['basement'],                                              key: 'basement' },
    { patterns: ['1st floor', 'first floor'],                              key: '1st floor' },
    { patterns: ['2nd floor', 'second floor'],                             key: '2nd floor' },
    { patterns: ['3rd floor', 'third floor'],                              key: '3rd floor' },
    { patterns: ['attic with storage'],                                    key: 'attic with storage' },
    { patterns: ['habitable attic'],                                       key: 'habitable attic' },
    // porch columns BEFORE front porch
    { patterns: ['porch columns', 'front porch columns', 'porch column'], key: '# of front porch columns' },
    { patterns: ['front porch'],                                           key: 'front porch' },
    { patterns: ['rear porch'],                                            key: 'rear porch' },
    { patterns: ['rear deck'],                                             key: 'rear deck' },
    // garage doors BEFORE garage
    { patterns: ['garage doors', 'garage door'],                           key: '# of garage doors' },
    { patterns: ['garage'],                                                key: 'garage' },
    { patterns: ['cabinets', 'cabinet'],                                   key: 'cabinets lf' },
    { patterns: ['countertops', 'countertop'],                             key: 'countertops lf' },
    { patterns: ['exterior doors', 'exterior door'],                       key: '# of exterior doors' },
    { patterns: ['interior doors', 'interior door'],                       key: '# of interior doors' },
    { patterns: ['windows', 'window'],                                     key: '# of windows' },
    { patterns: ['baths', 'bathroom', 'bath'],                             key: '# of baths' },
    { patterns: ['staircases', 'staircase', 'stair'],                      key: '# of staircases' },
    { patterns: ['carpet'],                                                key: 'sf of carpet' },
    { patterns: ['hardwood'],                                              key: 'sf of hardwood' },
    { patterns: ['tile'],                                                  key: 'sf of tile' },
  ];

  function normalizeLabel(t) {
    return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  }
  function matchLabel(t) {
    const n = normalizeLabel(t);
    for (const e of LABEL_MAP) {
      if (e.patterns.some(p => n.includes(p))) return e.key;
    }
    return null;
  }
  function parseNumber(t) {
    if (!t) return null;
    const n = parseFloat(String(t).replace(/[^0-9.]/g, ''));
    return isNaN(n) ? null : n;
  }

  // ─── Merge scraped values into zeroed defaults ────────────────────────────
  function mergeWithDefaults(scraped) {
    const result = { ...ALL_CATEGORIES };
    for (const [key, val] of Object.entries(scraped)) {
      if (key in result && val !== null) result[key] = val;
    }
    return result;
  }

  // ─── SquareTakeoff Scraper (app.squaretakeoff.com) ───────────────────────
  // Reads the left-panel list of takeoff items with their quantities

  // Read takeoff data from the sheet cells already in the DOM — no navigation needed.
  // SquareTakeoff renders each floor's sheet text in TWO identical cells (a Kendo rendering artifact).
  // We identify which floor each cell belongs to from its text content, then use a (floor, key) seen-set
  // to ensure each floor's value is counted exactly once before summing across floors.
  async function scrapeSquareTakeoff() {
    var scraped = {};
    var seenIds = new Set();

    // Each expanded page's takeoff items live in:
    // td.k-detail-cell > [inner grid] > tbody > tr.k-master-row
    // Each item row has a name TD and a DIV[id^="ccl"] with the value ("4 EA", "1936.01 SQFT", etc.)
    // Kendo renders two value divs per row (cl + ccl with the same ID suffix) — deduplicate by ID.
    var itemRows = Array.from(document.querySelectorAll('td.k-detail-cell tr.k-master-row'));
    console.log('[Duke] scrapeSquareTakeoff: ' + itemRows.length + ' item rows in DOM');

    itemRows.forEach(function (row) {
      // Prefer ccl (the combined label) to avoid double-counting cl+ccl siblings
      var valDiv = row.querySelector('[id^="ccl"]') || row.querySelector('[id^="cl"]');
      if (!valDiv || seenIds.has(valDiv.id)) return;
      seenIds.add(valDiv.id);

      var valText = valDiv.textContent.trim();
      var m = valText.match(/^([\d,]+\.?\d*)\s*(EA|SQFT|LF)$/i);
      if (!m) return;
      var val = parseFloat(m[1].replace(/,/g, ''));
      if (!val || val <= 0) return;

      // Get row name from the first TD that has non-empty text (first two TDs are empty color/type columns)
      var nameTd = Array.from(row.querySelectorAll('td')).find(function(td) {
        return td.textContent.trim().length > 0;
      });
      if (!nameTd) return;
      var name = nameTd.textContent.trim().toLowerCase();
      if (!name) return;

      // Match name exactly against LABEL_MAP patterns (exact match avoids false positives)
      var matched = false;
      for (var ei = 0; ei < LABEL_MAP.length && !matched; ei++) {
        var entry = LABEL_MAP[ei];
        for (var pi = 0; pi < entry.patterns.length; pi++) {
          if (name === entry.patterns[pi]) {
            scraped[entry.key] = (scraped[entry.key] || 0) + val;
            console.log('[Duke] scrape "' + name + '" → ' + entry.key + ' += ' + val);
            matched = true;
            break;
          }
        }
      }
    });

    console.log('[Duke] scrapeSquareTakeoff result:', scraped);
    return scraped;
  }

  // ─── Generic BuilderTrend Scraper ────────────────────────────────────────

  function scrapeGenericBT() {
    const scraped = {};

    // Tables
    document.querySelectorAll('table tr').forEach(row => {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const key = matchLabel(cells[0].textContent.trim());
        if (key) {
          const n = parseNumber(cells[cells.length - 1].textContent);
          if (n !== null) scraped[key] = n;
        }
      }
    });

    // Label-value pairs
    document.querySelectorAll(
      '.group-name,.item-name,.takeoff-name,.measurement-label,' +
      '[class*="groupName"],[class*="itemName"],[class*="measurementName"]'
    ).forEach(el => {
      const key = matchLabel(el.textContent);
      if (!key) return;
      const valEl = el.parentElement?.querySelector(
        '.total,.value,.quantity,.area,.length,[class*="total"],[class*="value"],[class*="quantity"]'
      );
      if (valEl) {
        const n = parseNumber(valEl.textContent);
        if (n !== null) scraped[key] = n;
      }
    });

    // Input fields
    document.querySelectorAll('input[type="number"],input[type="text"]').forEach(input => {
      const label = input.closest('label')?.textContent ||
                    input.previousElementSibling?.textContent ||
                    input.closest('tr')?.querySelector('td:first-child')?.textContent || '';
      const key = matchLabel(label);
      if (key && input.value) {
        const n = parseNumber(input.value);
        if (n !== null) scraped[key] = n;
      }
    });

    return scraped;
  }

  // ─── PDF URL Interception ────────────────────────────────────────────────
  // Hooks into fetch + XHR early to capture the PDF URL when ST loads it

  let capturedPDFUrl = null;

  // Hook fetch
  const _origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
    if (url && /\.pdf(\?|#|$)/i.test(url)) capturedPDFUrl = url;
    return _origFetch(input, init);
  };

  // Hook XHR
  const _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (url && /\.pdf(\?|#|$)/i.test(String(url))) capturedPDFUrl = String(url);
    return _origOpen.apply(this, arguments);
  };

  function findPDFUrl() {
    if (capturedPDFUrl) return capturedPDFUrl;

    // Check iframes / embeds
    for (const el of document.querySelectorAll('iframe[src], embed[src], object[data]')) {
      const src = el.getAttribute('src') || el.getAttribute('data') || '';
      if (/\.pdf/i.test(src)) return src;
    }

    // Check PDF.js viewer application object (standard PDF.js)
    try {
      if (window.PDFViewerApplication?.url) return window.PDFViewerApplication.url;
    } catch (_) {}

    // Check SquareTakeoff-specific globals
    const candidates = [
      window.currentPdfUrl, window.pdfUrl, window.planUrl,
      window.takeoffPdfUrl, window.__pdfUrl
    ].filter(Boolean);
    if (candidates.length) return candidates[0];

    return null;
  }

  // ─── Plan Image Capture ───────────────────────────────────────────────────

  // Try common keyboard shortcuts to zoom-to-fit the current page
  function fitPageToView() {
    var target = document.activeElement || document.body;
    // Ctrl+Shift+H  /  Ctrl+0  /  Ctrl+Shift+F — common fit-page shortcuts
    [
      { key: 'h', ctrlKey: true, shiftKey: true },
      { key: '0', ctrlKey: true },
      { key: 'f', ctrlKey: true, shiftKey: true },
    ].forEach(function (opts) {
      var ev = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, opts));
      target.dispatchEvent(ev);
    });
    // Also look for a "Fit" or "Zoom to Fit" button and click it
    var fitBtn = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .find(function (el) { return /fit|zoom\s*to\s*fit/i.test(el.title || el.textContent); });
    if (fitBtn) fitBtn.click();
  }

  // Returns { full, titleBlock } — both base64 PNGs.
  // titleBlock is the bottom-right 40% of the canvas, where the title block lives.
  function capturePlanImage() {
    const canvases = Array.from(document.querySelectorAll('canvas'))
      .sort((a, b) => (b.width * b.height) - (a.width * a.height));

    var sourceCanvas = (canvases.length > 0 && canvases[0].width > 200) ? canvases[0] : null;

    if (!sourceCanvas) {
      // Fall back to largest img drawn onto a canvas
      const imgs = Array.from(document.querySelectorAll('img[src]'))
        .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
      const planImg = imgs.find(img => img.naturalWidth > 400);
      if (planImg) {
        try {
          const c = document.createElement('canvas');
          c.width = planImg.naturalWidth; c.height = planImg.naturalHeight;
          c.getContext('2d').drawImage(planImg, 0, 0);
          sourceCanvas = c;
        } catch (_) {}
      }
    }

    if (!sourceCanvas) return null;

    try {
      var full = sourceCanvas.toDataURL('image/png').split(',')[1];

      // RIGHT STRIP — full height, rightmost 28% of sheet.
      // Title block runs the entire right side in these plans (DATE / SCALE / SHEET stacked vertically).
      var rw = Math.floor(sourceCanvas.width * 0.28);
      var rcrop = document.createElement('canvas');
      rcrop.width = rw; rcrop.height = sourceCanvas.height;
      rcrop.getContext('2d').drawImage(sourceCanvas, sourceCanvas.width - rw, 0, rw, sourceCanvas.height, 0, 0, rw, sourceCanvas.height);
      var rightStrip = rcrop.toDataURL('image/png').split(',')[1];

      // SCALE ZONE — bottom 40% of the right strip, which is where DATE/SCALE/SHEET labels sit
      var sz_x = sourceCanvas.width - rw;
      var sz_y = Math.floor(sourceCanvas.height * 0.60);
      var sz_w = rw;
      var sz_h = sourceCanvas.height - sz_y;
      var szcrop = document.createElement('canvas');
      szcrop.width = sz_w; szcrop.height = sz_h;
      szcrop.getContext('2d').drawImage(sourceCanvas, sz_x, sz_y, sz_w, sz_h, 0, 0, sz_w, sz_h);
      var scaleZone = szcrop.toDataURL('image/png').split(',')[1];

      // Bottom-center strip (fallback for plans with centered title blocks)
      var bw = Math.floor(sourceCanvas.width  * 0.50);
      var bh = Math.floor(sourceCanvas.height * 0.25);
      var bx = Math.floor((sourceCanvas.width - bw) / 2);
      var by = sourceCanvas.height - bh;
      var bcrop = document.createElement('canvas');
      bcrop.width = bw; bcrop.height = bh;
      bcrop.getContext('2d').drawImage(sourceCanvas, bx, by, bw, bh, 0, 0, bw, bh);
      var bottomCenter = bcrop.toDataURL('image/png').split(',')[1];

      // titleBlock kept for backward compat (same as rightStrip)
      return { base64: full, titleBlock: rightStrip, rightStrip, scaleZone, bottomCenter, mimeType: 'image/png', source: 'canvas' };
    } catch (_) { return null; }
  }

  // ─── BuilderTrend Guided Takeoff Automation ───────────────────────────────
  // Selectors confirmed from DevTools inspection of buildertrend.net takeoff UI

  var ST_AUTO = (function () {
    function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    async function waitFor(fn, timeout) {
      var end = Date.now() + (timeout || 5000);
      while (Date.now() < end) {
        var el = fn();
        if (el) return el;
        await delay(50);  // was 150 — faster poll = faster element detection
      }
      return null;
    }

    async function clickEl(el) {
      if (!el) throw new Error('Element not found');
      el.scrollIntoView({ block: 'center' });
      await delay(80);
      el.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown',  { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup',    { bubbles: true }));
      el.click();
      await delay(80);  // was 220 — DOM reacts well within 80ms
    }

    async function fillInput(el, value) {
      if (!el) throw new Error('Input not found');
      el.focus();
      await delay(60);
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Set a Kendo UI DropDownList by ID to a text value
    async function setKendoDropdown(id, value) {
      var input = document.getElementById(id);
      if (!input) throw new Error('Kendo dropdown not found: #' + id);

      // Extract fraction portion for fuzzy matching (e.g. "1/4" from '1/4" = 1\'-0"')
      var fractionMatch = value.match(/^(\d+(?:\/\d+)?)/);
      var fraction = fractionMatch ? fractionMatch[1] : null;

      // Try Kendo widget API first
      var jq = window.jQuery || window.$;
      if (jq) {
        try {
          var widget = jq(input).data('kendoDropDownList') || jq(input).data('kendoComboBox');
          if (widget) {
            // 1. Try exact value match
            widget.value(value);
            widget.trigger('change');
            await delay(150);
            if (widget.value()) { console.log('[Duke] setKendoDropdown exact match: ' + widget.value()); return; }

            // 2. Fuzzy match by fraction — normalize curly quotes, works regardless of dash/no-dash
            if (fraction) {
              function normQK(s) { return s.replace(/[''ʼ]/g, "'").replace(/[""]/g, '"'); }
              widget.select(function (item) {
                var txt = normQK(String(item.text || item.Text || item[widget.options.dataTextField] || ''));
                return txt.indexOf(fraction + '"') === 0 || txt.indexOf(fraction + ' ') === 0;
              });
              widget.trigger('change');
              await delay(150);
              if (widget.value()) { console.log('[Duke] setKendoDropdown fuzzy match: ' + widget.value()); return; }
            }
          }
        } catch (e) { console.warn('[Duke] Kendo API error for #' + id + ':', e.message); }
      }

      // Fallback: open dropdown UI and click matching list item
      var wrapper = input.closest('.k-dropdownlist') || input.closest('[data-role]') || input.parentElement;
      var dropBtn = wrapper && (wrapper.querySelector('.k-input-button') || wrapper.querySelector('[role="button"]'));
      if (!dropBtn) throw new Error('Cannot open Kendo dropdown: #' + id);
      await clickEl(dropBtn);
      await delay(300);

      var listId  = id + '_listbox';
      var listbox = await waitFor(function () { return document.getElementById(listId); }, 2000);
      if (!listbox) throw new Error('Kendo listbox not found: #' + listId);

      // Normalize curly/smart quotes to straight for comparison
      function normQ(s) { return s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"'); }
      var items = Array.from(listbox.querySelectorAll('li'));
      var lower = normQ(value.toLowerCase());
      var option = items.find(function (li) { return normQ(li.textContent.trim().toLowerCase()) === lower; })
                || (fraction && items.find(function (li) { return normQ(li.textContent.trim()).startsWith(fraction + '"'); }))
                || items.find(function (li) { return normQ(li.textContent.trim().toLowerCase()).includes(lower); });
      if (!option) throw new Error('Option "' + value + '" not found in #' + listId);
      await clickEl(option);
    }

    // Click the primary/save button inside a modal's footer — prefers "Save & Close"
    async function clickModalSave(modal) {
      var footer = modal.querySelector('.modal-footer');
      if (!footer) throw new Error('Modal footer not found');
      var btns = Array.from(footer.querySelectorAll('button'));
      // Prefer "Save & Close" over plain "Save"
      var saveBtn = btns.find(function (b) { return /save\s*&\s*close/i.test(b.textContent); })
                || btns.find(function (b) { return /save|submit|ok\b|confirm|done|start/i.test(b.textContent); })
                || btns.find(function (b) { return !/cancel|close|dismiss/i.test(b.textContent); });
      if (!saveBtn) throw new Error('Save button not found in modal');
      await clickEl(saveBtn);
    }

    // ── Nav bar helpers ───────────────────────────────────────────────────────
    // All nav links use onclick="onbtn<name>Click()" pattern — confirmed from DevTools.
    // Nav markup: <a href="#" class="nav-link btnDefaultwidthsize" onclick="onbtnareaClick()">
    //             <span class="nav-text fadeable text-darkExtn pt-1 pl-2">Area</span>
    var NAV_ONCLICK = {
      'count':  'onbtncountClick',
      'area':   'onbtnareaClick',
      'linear': 'onbtnLinearClick',
      'scale':  'onbtnscaleClick',
      'start':  'onbtnstartClick',
      'tools':  'onbtntoolsClick',
    };

    async function clickNavItem(name) {
      var fn = NAV_ONCLICK[name.toLowerCase()];
      var link = fn ? document.querySelector('[onclick*="' + fn + '"]') : null;
      // Fallback: search all clickable elements by visible text
      if (!link) {
        var lowerName = name.toLowerCase();
        link = Array.from(document.querySelectorAll('a, button, [role="button"], li, span[onclick]')).find(function (el) {
          return el.offsetParent !== null && (el.textContent || '').trim().toLowerCase().includes(lowerName);
        });
      }
      if (!link) throw new Error('"' + name + '" nav link not found');
      await clickEl(link);
      await delay(500);
    }

    // ── Ensure the sheet/pages panel is open so td.tooltipPageName cells are visible ──
    async function ensureSheetPanelOpen() {
      // If cells are already present in the DOM, nothing to do
      if (document.querySelectorAll('td.tooltipPageName').length) return;

      // Try clicking the "Sheets and Views" / pages panel toggle button
      var triggers = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="tab"], [class*="panel"]'));
      var panelBtn = triggers.find(function (el) {
        var t = (el.textContent || el.title || el.getAttribute('aria-label') || '').trim();
        return /sheets?\s*(and|&)?\s*views?|pages?\s*panel|page\s*list/i.test(t);
      });
      if (panelBtn) {
        await clickEl(panelBtn);
        await delay(600);
        return;
      }

      // Fallback: the sheet grid might be inside a collapsed splitter pane — try expanding it
      var splitter = document.querySelector('.k-splitbar, [class*="splitter"] [class*="collapse"], [class*="pane-toggle"]');
      if (splitter) { await clickEl(splitter); await delay(500); }
    }

    // ── Sheet list (Kendo grid — confirmed selector: td.tooltipPageName) ────

    // Returns all sheet row cells from the grid — accepts any content including generic names
    function getSheetCells() {
      var TRIES = [
        'td.tooltipPageName',
        '[class*="tooltipPageName"]',
        'td.k-table-td[role="gridcell"]',
      ];
      // Count-sidebar master rows have data-testid on their <tr>; clicking them
      // only expands count detail rows — they do NOT navigate the canvas page.
      function navOnly(cells) {
        return cells.filter(function(el) { var r = el.closest('tr'); return !r || !r.hasAttribute('data-testid'); });
      }
      for (var i = 0; i < TRIES.length; i++) {
        var cells = navOnly(Array.from(document.querySelectorAll(TRIES[i])));
        console.log('[Duke] getSheetCells selector="' + TRIES[i] + '" nav=' + cells.length);
        if (cells.length) return cells;
      }
      console.log('[Duke] getSheetCells: no match for any selector');
      return [];
    }

    function getSheetCount() {
      return getSheetCells().length;
    }

    function getSheetNames() {
      return getSheetCells().map(function (el, i) {
        var t = (el.getAttribute('title') || el.textContent || '').trim().split('\n')[0].trim();
        return t || ('Sheet ' + (i + 1));
      });
    }

    // Click sheet by zero-based index
    async function clickSheetByIndex(idx) {
      // Clicking a count-sidebar master row (tr.k-master-row[data-testid]) navigates
      // the canvas to that page AND selects the row. This is the correct navigation mechanism.
      var masterRows = Array.from(document.querySelectorAll('tr.k-master-row[data-testid]'));
      if (idx < masterRows.length) {
        await clickEl(masterRows[idx]);
        await delay(900);
        return;
      }
      // Fallback: sheet cells
      var cells = getSheetCells();
      if (idx >= cells.length) throw new Error('Sheet index ' + idx + ' out of range (' + cells.length + ' sheets)');
      await clickEl(cells[idx]);
      await delay(900);
    }

    // Find the cell for a given sheet name (used when names are meaningful)
    function findSheetCell(name) {
      var lower = name.toLowerCase();
      return getSheetCells().find(function (el) {
        var n = (el.getAttribute('title') || el.textContent || '').trim().split('\n')[0].trim().toLowerCase();
        return n === lower || n.includes(lower);
      }) || null;
    }

    // Get the action buttons visible on a sheet row.
    // From DevTools screenshot: 8 icons appear per row:
    //   [0] +add  [1] delete/trash  [2] list  [3] pencil/rename  [4] sync  [5] star  [6] print  [7] eraser
    function getSheetRowButtons(cell) {
      var row = cell.closest('tr') || cell.parentElement;
      if (!row) return [];
      return Array.from(row.querySelectorAll('button, a[href="javascript:void(0)"], [role="button"], span[onclick]'));
    }

    async function clickSheet(name) {
      var cell = findSheetCell(name);
      if (!cell) throw new Error('Sheet not found: ' + name);
      await clickEl(cell);
      await delay(700);
    }

    // Batch-delete sheets by zero-based indices using the Page Management dialog.
    // Flow: open dialog → check rows → Delete → type YES → OK → Save
    async function deleteSheetsAtIndices(indices) {
      if (!indices || !indices.length) return;

      // 1. Open Page Management via the nav list button
      var openBtn = document.getElementById('btnReorderfromtakeoff');
      if (!openBtn) throw new Error('#btnReorderfromtakeoff not found');
      await clickEl(openBtn);

      // 2. Wait for the modal that contains the Delete button
      var modal = await waitFor(function () {
        var m = document.querySelector('.modal.show');
        return (m && m.querySelector('#btnDeleteReorderPages')) ? m : null;
      }, 4000);
      if (!modal) throw new Error('Page Management dialog did not open');
      await delay(400);

      // 3. Check the row checkboxes for each index to delete
      //    Row checkboxes have class k-checkbox but NOT kheaderallchk (header)
      var rowCbs = Array.from(modal.querySelectorAll('input[type="checkbox"].k-checkbox'))
        .filter(function (cb) { return !cb.classList.contains('kheaderallchk'); });

      for (var i = 0; i < indices.length; i++) {
        var idx = indices[i];
        if (idx < rowCbs.length) {
          if (!rowCbs[idx].checked) await clickEl(rowCbs[idx]);
          await delay(80);
        }
      }

      // 4. Click the Delete button
      var delBtn = document.getElementById('btnDeleteReorderPages');
      if (!delBtn) throw new Error('#btnDeleteReorderPages not found');
      await clickEl(delBtn);
      await delay(600);

      // 5. Type YES in the confirmation input
      var yesInput = await waitFor(function () { return document.getElementById('bootboxYes'); }, 3000);
      if (!yesInput) throw new Error('#bootboxYes not found');
      await fillInput(yesInput, 'YES');
      await delay(200);

      // 6. Click OK (bootbox confirm)
      var okBtn = await waitFor(function () {
        return document.querySelector('button.bootboxbutton.btn-primary, button.bootboxbutton[class*="primary"]');
      }, 2000);
      if (!okBtn) throw new Error('Bootbox OK button not found');
      await clickEl(okBtn);
      await delay(800);

      // 7. Click Save to commit
      var saveBtn = document.getElementById('btnReorderPages');
      if (!saveBtn) throw new Error('#btnReorderPages not found');
      await clickEl(saveBtn);
      await delay(1000);
    }

    // Keep single-index wrapper for compatibility
    async function deleteSheetByIndex(idx) {
      return deleteSheetsAtIndices([idx]);
    }

    async function renameSheetByIndex(idx, newName) {
      var cells = getSheetCells();
      if (idx >= cells.length) throw new Error('Sheet index out of range');
      var cell = cells[idx];
      cell.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      cell.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true }));
      await delay(200);
      var btns = Array.from((cell.closest('tr') || cell.parentElement).querySelectorAll(
        'button, a[href="javascript:void(0)"], [role="button"]'
      ));
      if (btns.length < 4) throw new Error('Rename button not found for sheet at index ' + idx);
      await clickEl(btns[3]);
      await delay(500);
      var modal = await waitFor(function () {
        var m = document.getElementById('myTakeoffPageModal');
        return (m && m.classList.contains('show')) ? m : null;
      }, 3000);
      if (!modal) throw new Error('Rename modal did not open');
      var input = document.getElementById('txtPageName');
      if (!input) throw new Error('#txtPageName not found');
      await fillInput(input, newName);
      await delay(150);
      await clickModalSave(modal);
      await delay(700);
    }

    async function deleteSheet(name) {
      var cell = findSheetCell(name);
      if (!cell) throw new Error('Sheet not found: ' + name);

      // Hover to surface action buttons
      cell.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      cell.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true }));
      await delay(200);

      var btns = getSheetRowButtons(cell);
      // Index 1 = trash/delete (2nd button in row)
      if (btns.length < 2) throw new Error('Delete button not found in row for: ' + name);
      await clickEl(btns[1]);
      await delay(400);

      // Confirm dialog if it appears
      var confirmBtn = await waitFor(function () {
        return Array.from(document.querySelectorAll('button')).find(function (b) {
          return /^(delete|yes|confirm|ok)$/i.test(b.textContent.trim()) && b.offsetParent;
        });
      }, 2000);
      if (confirmBtn) { await clickEl(confirmBtn); await delay(400); }
    }

    async function renameSheet(oldName, newName) {
      var cell = findSheetCell(oldName);
      if (!cell) throw new Error('Sheet not found: ' + oldName);

      // Hover to surface action buttons
      cell.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      cell.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true }));
      await delay(200);

      var btns = getSheetRowButtons(cell);
      // Index 3 = pencil-on-square / rename (4th button in row)
      if (btns.length < 4) throw new Error('Rename button not found in row for: ' + oldName);
      await clickEl(btns[3]);
      await delay(500);

      // Wait for the page-rename modal (confirmed ID: myTakeoffPageModal)
      var modal = await waitFor(function () {
        var m = document.getElementById('myTakeoffPageModal');
        return (m && m.classList.contains('show')) ? m : null;
      }, 3000);
      if (!modal) throw new Error('Rename modal (#myTakeoffPageModal) did not open');

      // Confirmed input ID: txtPageName
      var input = document.getElementById('txtPageName');
      if (!input) throw new Error('#txtPageName not found');
      await fillInput(input, newName);
      await delay(150);
      await clickModalSave(modal);
      await delay(600);
    }

    // ── Page Management: Use AI Name ─────────────────────────────────────────
    // Flow: open Page Management → select all → toggle "Use AI Name" → popup select all → accept → save

    var aiPageNamesCancelled = false;

    function closePageMgmtModal() {
      var closeBtn = document.getElementById('ReorderPageMgmtTakeoffmodalButtonX');
      if (closeBtn && closeBtn.offsetParent !== null) { closeBtn.click(); return; }
      var anyClose = document.querySelector('[class*="modal"].show [data-dismiss="modal"], [class*="modal"].show .btn-close');
      if (anyClose) anyClose.click();
    }

    async function useAIPageNames() {
      aiPageNamesCancelled = false;

      // 1. Open Page Management
      var openBtn = document.getElementById('btnReorderfromtakeoff');
      if (!openBtn) throw new Error('#btnReorderfromtakeoff not found');
      await clickEl(openBtn);
      if (aiPageNamesCancelled) { closePageMgmtModal(); throw new Error('cancelled'); }

      var pgModal = await waitFor(function () {
        return Array.from(document.querySelectorAll('.modal')).find(function (m) {
          return m.classList.contains('show') && m.querySelector('#header-chb');
        }) || null;
      }, 5000);
      if (!pgModal) throw new Error('Page Management modal did not open');
      if (aiPageNamesCancelled) { closePageMgmtModal(); throw new Error('cancelled'); }
      await delay(600);

      // 2. Dismiss any "ok got it" info overlay that appears on first open
      var okGotIt = document.getElementById('overlaypopupclose');
      if (okGotIt && okGotIt.offsetParent !== null) {
        console.log('[Duke] Dismissing "ok got it" overlay');
        await clickEl(okGotIt);
        await delay(400);
      }
      if (aiPageNamesCancelled) { closePageMgmtModal(); throw new Error('cancelled'); }

      // 3. Select all pages — confirmed ID: header-chb
      var allCb = document.getElementById('header-chb');
      if (allCb && !allCb.checked) {
        await clickEl(allCb);
        await delay(400);
      }
      if (aiPageNamesCancelled) { closePageMgmtModal(); throw new Error('cancelled'); }

      // 4. Toggle "Use AI Name" — confirmed ID: toggleMultiPageAIExtraction
      // It's a Kendo switcher checkbox — click its label so the UI responds correctly
      var aiToggle = document.getElementById('toggleMultiPageAIExtraction');
      if (!aiToggle) throw new Error('#toggleMultiPageAIExtraction not found');
      var aiLabel = document.querySelector('label[for="toggleMultiPageAIExtraction"]');
      await clickEl(aiLabel || aiToggle);
      if (aiPageNamesCancelled) { closePageMgmtModal(); throw new Error('cancelled'); }
      await delay(2500); // allow extra time for the AI popup to load
      if (aiPageNamesCancelled) { closePageMgmtModal(); throw new Error('cancelled'); }

      // 5. Wait for the AI naming popup (#divAIPageNames)
      console.log('[Duke] useAIPageNames: waiting for #divAIPageNames…');
      var aiPopup = await waitFor(function () {
        var d = document.getElementById('divAIPageNames');
        if (!d) return null;
        var cs = window.getComputedStyle(d);
        var visible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
        console.log('[Duke] #divAIPageNames found, display=' + cs.display + ' visibility=' + cs.visibility + ' visible=' + visible);
        return visible ? d : null;
      }, 15000);
      if (!aiPopup) throw new Error('#divAIPageNames popup did not appear after 15s');
      if (aiPageNamesCancelled) { closePageMgmtModal(); throw new Error('cancelled'); }
      console.log('[Duke] useAIPageNames: AI popup visible — waiting for grid to fully load…');
      await delay(2500);

      // 6. Select all rows
      var selectAllCb = document.querySelector('input.k-select-checkbox[data-role="checkbox"]')
                     || document.querySelector('input[aria-label="Select all rows"]')
                     || document.querySelector('input[aria-label="Deselect all rows"]')
                     || document.querySelector('#AIPageNamesGrid input[data-role="checkbox"]');
      console.log('[Duke] useAIPageNames: select-all checkbox found=' + !!selectAllCb + (selectAllCb ? ' aria-checked=' + selectAllCb.getAttribute('aria-checked') : ''));
      if (selectAllCb) {
        // Click the parent <th> cell — Kendo intercepts at that level
        var selectAllTh = selectAllCb.closest('th') || selectAllCb.parentElement;
        function fireClick(el) {
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true, cancelable: true }));
          el.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true, cancelable: true }));
          el.click();
        }
        fireClick(selectAllTh || selectAllCb);
        await delay(500);
        // If still unchecked, try clicking the input directly
        if (selectAllCb.getAttribute('aria-checked') !== 'true') {
          fireClick(selectAllCb);
          selectAllCb.checked = true;
          selectAllCb.dispatchEvent(new Event('change', { bubbles: true }));
          await delay(400);
        }
        console.log('[Duke] useAIPageNames: select-all aria-checked=' + selectAllCb.getAttribute('aria-checked'));
      } else {
        console.log('[Duke] Warning: select-all checkbox not found in document');
      }

      // 7. Click Accept — use PointerEvent + MouseEvent + jQuery + native click for Kendo compatibility
      var acceptBtn = document.getElementById('btnAcceptAiPageName');
      console.log('[Duke] useAIPageNames: Accept button found=' + !!acceptBtn);
      if (!acceptBtn) throw new Error('#btnAcceptAiPageName not found');
      acceptBtn.focus();
      await delay(100);
      acceptBtn.dispatchEvent(new PointerEvent('pointerover',  { bubbles: true, cancelable: true }));
      acceptBtn.dispatchEvent(new PointerEvent('pointerdown',  { bubbles: true, cancelable: true }));
      acceptBtn.dispatchEvent(new MouseEvent('mousedown',      { bubbles: true, cancelable: true }));
      acceptBtn.dispatchEvent(new PointerEvent('pointerup',    { bubbles: true, cancelable: true }));
      acceptBtn.dispatchEvent(new MouseEvent('mouseup',        { bubbles: true, cancelable: true }));
      acceptBtn.click();
      var btnSpan = acceptBtn.querySelector('.k-button-text');
      if (btnSpan) btnSpan.click();
      var jq = window.jQuery || window.$;
      if (jq) { try { jq(acceptBtn).trigger('click'); } catch(_) {} }
      console.log('[Duke] useAIPageNames: Accept clicked — waiting 3s for AI processing…');
      await delay(3000);
      console.log('[Duke] useAIPageNames: proceeding to Save…');

      // 8. Save Page Management
      var saveBtn = document.getElementById('btnReorderPages');
      console.log('[Duke] useAIPageNames: Save button found=' + !!saveBtn);
      if (!saveBtn) throw new Error('#btnReorderPages not found');
      saveBtn.focus();
      await delay(100);
      saveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      saveBtn.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true, cancelable: true }));
      saveBtn.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
      saveBtn.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true, cancelable: true }));
      saveBtn.click();
      if (jq) { try { jq(saveBtn).trigger('click'); } catch(_) {} }
      await delay(1500);

      // 9. Close Page Management modal — try ID first, then data-dismiss, then aria-label="Close"
      var closeX = document.getElementById('ReorderPageMgmtTakeoffmodalButtonX');
      if (!closeX || closeX.offsetParent === null) {
        // fallback: any visible modal close button (skip the AI popup X which is gone by now)
        var allClose = Array.from(document.querySelectorAll('button[data-dismiss="modal"], button[aria-label="Close"]'));
        closeX = allClose.find(function(b) { return b.offsetParent !== null; }) || null;
      }
      console.log('[Duke] useAIPageNames: Page Mgmt close X found=' + !!closeX);
      if (closeX && closeX.offsetParent !== null) {
        closeX.focus();
        await delay(80);
        closeX.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        closeX.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true, cancelable: true }));
        closeX.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
        closeX.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true, cancelable: true }));
        closeX.click();
        if (jq) { try { jq(closeX).trigger('click'); } catch(_) {} }
        await delay(800);
      }
      await delay(1500); // allow pages to reload with new names
    }

    // ── Scale ────────────────────────────────────────────────────────────────
    // Scale dialog triggered by clicking "Scale" in the top nav bar (confirmed from screenshot)
    // Modal ID: myTakeoffScaleModal
    // Unit dropdown: #comboUnitofMeasure   (Kendo DropDownList)
    // Page scale dropdown: #combostaticPageScale (Kendo DropDownList)

    function getPageScaleFromDOM() {
      // Any straight or curly quote variant for " and '
      var AQ = '[\\u0022\\u201C\\u201D]'; // double-quote variants
      var SQ = '[\\u0027\\u2018\\u2019]'; // single-quote variants
      // Matches: 1/4" = 1'-0"  |  1/4" = 1'0"  |  1/4" = 12"  (any quote char)
      var scaleRe = new RegExp('(\\d+(?:\\/\\d+)?)' + AQ + '\\s*=\\s*(?:1' + SQ + '[-\\s]?0' + AQ + '|12' + AQ + ')', 'i');

      // Direct check — SquareTakeoff puts scale in #svgPageScale
      var svgScale = document.getElementById('svgPageScale');
      if (svgScale) {
        var svgTxt = (svgScale.textContent || '').trim();
        // "Not yet set" means no scale — return null immediately, don't fall through to broad scan
        if (/not yet set/i.test(svgTxt)) return null;
        var svgM = svgTxt.match(scaleRe);
        if (svgM) return svgM[0].trim();
        // Fallback: just find a fraction in the element (e.g. "Scale set at: 1/4...")
        var fracM = svgTxt.match(/(\d+\/\d+)/);
        if (fracM) return fracM[1];
      }
      // Broader scan of likely scale-containing elements
      var candidates = Array.from(document.querySelectorAll(
        '[class*="scale"], [class*="Scale"], [id*="scale"], [id*="Scale"], ' +
        '.page-info, .toolbar, .header, .navbar, .nav-bar, .status-bar, ' +
        '[class*="pageInfo"], [class*="PageInfo"], [class*="pageScale"], [class*="PageScale"]'
      ));
      for (var i = 0; i < candidates.length; i++) {
        var txt = candidates[i].textContent || '';
        var m = txt.match(scaleRe);
        if (m) return m[0].trim();
      }
      // Broader fallback: scan all visible short text nodes
      var allEls = Array.from(document.querySelectorAll('span, div, p, td, li'));
      for (var j = 0; j < allEls.length; j++) {
        var el = allEls[j];
        if (el.children.length > 3) continue; // skip containers
        var t = (el.textContent || '').trim();
        if (t.length > 40) continue;
        var m2 = t.match(scalePattern);
        if (m2) return m2[0].trim();
      }
      return null;
    }

    async function setScale(scale, applyAll) {
      // Open scale dialog — try bscaleEx first (same button as openScaleForManual),
      // then onclick attr, then walk up from the Scale span to its clickable ancestor
      var scaleOpened = false;
      var scaleBtn = document.getElementById('bscaleEx');
      if (scaleBtn) { await clickEl(scaleBtn); scaleOpened = true; }
      if (!scaleOpened) {
        try { await clickNavItem('Scale'); scaleOpened = true; } catch (_) {}
      }
      if (!scaleOpened) {
        // Find the Scale span and click its nearest clickable ancestor
        var scaleSpan = Array.from(document.querySelectorAll('span')).find(function (s) {
          return s.offsetParent !== null && s.textContent.trim() === 'Scale';
        });
        if (scaleSpan) {
          var clickTarget = scaleSpan;
          var p = scaleSpan.parentElement;
          while (p && p !== document.body) {
            if (p.onclick || p.getAttribute('onclick') || p.tagName === 'A' || p.tagName === 'BUTTON' || p.getAttribute('role') === 'button') {
              clickTarget = p; break;
            }
            p = p.parentElement;
          }
          await clickEl(clickTarget);
        }
      }

      var modal = await waitFor(function () {
        var m = document.getElementById('myTakeoffScaleModal');
        return (m && m.classList.contains('show')) ? m : null;
      }, 4000);
      if (!modal) throw new Error('Scale dialog (#myTakeoffScaleModal) did not open');
      await delay(300);

      // Set unit to Imperial
      try { await setKendoDropdown('comboUnitofMeasure', 'Imperial'); }
      catch (e) { console.warn('[Duke] Unit dropdown:', e.message); }
      await delay(200);

      // Set scale profile to "Set Via Page Scale"
      try { await setKendoDropdown('comboScaleSettingsProfile', 'Set Via Page Scale'); }
      catch (e) { console.warn('[Duke] Scale profile dropdown:', e.message); }
      await delay(200);

      // Ensure the "Page Scale" setting row is active (chkscaleSetting1)
      var scaleSettingRow = document.getElementById('chkscaleSetting1');
      if (scaleSettingRow) {
        var radio = scaleSettingRow.querySelector('input[type="radio"], input[type="checkbox"]');
        if (radio && !radio.checked) { await clickEl(radio); await delay(200); }
      }

      // Set the page scale dropdown to the desired scale
      if (scale) {
        try { await setKendoDropdown('combostaticPageScale', scale); }
        catch (e) { console.warn('[Duke] Scale dropdown:', e.message); }
      }
      await delay(200);

      // "Apply to all pages" — look for any checkbox in the modal
      if (applyAll) {
        var allCb = Array.from(modal.querySelectorAll('input[type="checkbox"]')).find(function (cb) {
          var lbl = cb.closest('label') || cb.parentElement;
          return lbl && /all\s*page|apply/i.test(lbl.textContent);
        });
        if (allCb && !allCb.checked) { await clickEl(allCb); await delay(150); }
      }

      // Check the disclaimer checkbox before saving
      var disclaimer = document.getElementById('chkAgreeDisclaimer');
      if (disclaimer && !disclaimer.checked) { await clickEl(disclaimer); await delay(150); }

      await clickModalSave(modal);
      await delay(600);
    }

    // Opens the scale dialog and auto-selects Imperial; does NOT click Start.
    // Used when AI couldn't read the scale — user fills in the rest.
    async function openScaleForManual() {
      var scaleBtn = document.getElementById('bscaleEx');
      if (scaleBtn) { await clickEl(scaleBtn); }
      else {
        try { await clickNavItem('Scale'); }
        catch (_) {
          var sb = Array.from(document.querySelectorAll('button,a,[role="button"]'))
            .find(function (el) { return /scale/i.test(el.textContent) && el.offsetParent; });
          if (sb) await clickEl(sb);
        }
      }
      var modal = await waitFor(function () {
        var m = document.getElementById('myTakeoffScaleModal');
        return (m && m.classList.contains('show')) ? m : null;
      }, 4000);
      if (!modal) throw new Error('Scale dialog (#myTakeoffScaleModal) did not open');
      await delay(300);
      try { await setKendoDropdown('comboUnitofMeasure', 'Imperial'); }
      catch (e) { console.warn('[Duke] Unit dropdown:', e.message); }
      await delay(200);
      try { await setKendoDropdown('comboScaleSettingsProfile', 'Set Via Page Scale'); }
      catch (e) { console.warn('[Duke] Scale profile dropdown:', e.message); }
      await delay(200);
    }

    // Resolves when the scale modal closes (user clicked Start or dismissed it).
    function waitForScaleModalClose() {
      return new Promise(function (res) {
        var att = 0;
        function check() {
          var modal = document.getElementById('myTakeoffScaleModal');
          if (!modal || !modal.classList.contains('show') || ++att >= 120) return res();
          setTimeout(check, 500);
        }
        check();
      });
    }

    // ── Count ────────────────────────────────────────────────────────────────
    // Nav: "Count" opens count dialog
    // Modal ID: myTakeoffCountModal    Name input: #txtCountName

    var colorIdx = 0;

    // Colors excluded from both count and area dropdowns (too light/white to see on plans)
    var EXCLUDED_COLORS = new Set([
      'azure','floralwhite','ghostwhite','white','whitesmoke','snow','seashell',
      'papayawhip','nocolor','oldlace','mintcream','linen','lightyellow',
      'lightgoldenrodyellow','lightcyan','lemonchiffon','lavenderblush','lavenderbluesh','ivory',
      'honeydew','cornsilk','blanchedalmond','bisque','antiquewhite','beige'
    ]);

    async function autoSelectDropdowns(modal) {
      // Find all Kendo DropDownList inputs inside the modal that have no value set.
      var allKendo = Array.from(modal.querySelectorAll('input[data-role="dropdownlist"]'));
      var empty = allKendo.filter(function (inp) {
        return !inp.value || inp.value === '';
      });

      console.log('[Duke] autoSelectDropdowns: ' + allKendo.length + ' kendo total, ' + empty.length + ' unset');

      for (var i = 0; i < empty.length; i++) {
        var inp = empty[i];
        try {
          // Open the dropdown
          var wrapper = inp.closest('.k-dropdownlist, .k-picker') || inp.parentElement;
          var arrow = wrapper && (wrapper.querySelector('.k-input-button, .k-select, [role="button"]'));
          if (arrow) { await clickEl(arrow); } else { await clickEl(inp); }
          await delay(150);  // was 350 — Kendo listbox renders well within 150ms

          // Find the open listbox
          var listboxId = inp.id + '_listbox';
          var listbox = document.getElementById(listboxId);
          if (!listbox) {
            listbox = document.querySelector('.k-popup .k-list-ul, .k-animation-container .k-list-ul');
          }
          if (!listbox) { console.log('[Duke] listbox not found for #' + inp.id); continue; }

          var items = Array.from(listbox.querySelectorAll('li[role="option"]'));
          var real = items.filter(function (li) {
            var txt = (li.textContent || '').trim();
            return txt && !/^select$/i.test(txt);
          });
          if (!real.length) { console.log('[Duke] no real items found for #' + inp.id); continue; }

          // If this dropdown contains "Standard Area" → it's the Type dropdown, always pick that
          var standardAreaItem = real.find(function (li) {
            return /standard\s*area/i.test((li.textContent || '').trim());
          });

          var pick;
          if (standardAreaItem) {
            pick = standardAreaItem;
            console.log('[Duke] #' + inp.id + ' → type dropdown, picking "Standard Area"');
          } else {
            // Treat as color dropdown — filter out excluded light/white colors
            var validColors = real.filter(function (li) {
              var name = (li.textContent || '').trim().toLowerCase().replace(/\s+/g, '');
              return !EXCLUDED_COLORS.has(name);
            });
            var colorPool = validColors.length > 0 ? validColors : real;
            pick = colorPool[colorIdx % colorPool.length];
            console.log('[Duke] #' + inp.id + ' → color dropdown, picking "' + (pick.textContent || '').trim() + '"');
          }

          await clickEl(pick);
          await delay(80);  // was 250 — settle after item selection
        } catch (e) { console.log('[Duke] autoSelectDropdowns error on #' + inp.id + ':', e.message); }
      }
      colorIdx++;
    }

    // Find sidebar rows matching `name` scoped to the currently selected floor.
    // Uses data-testid prefix (e.g. "row-65-") to reliably distinguish floors —
    // all floors' rows are always present in the DOM simultaneously.
    // Finds sidebar rows matching name scoped to the correct floor.
    // Uses the k-detail-row sibling of the target master row — reliable because
    // each floor's items live inside that floor's detail row in the Kendo grid.
    // explicitPageName: preferred lookup; falls back to k-selected then #svgPageName.
    function findCountRowsByName(name, floorLabel, explicitPageName) {
      var norm = name.trim().toLowerCase();
      var rows = [];
      var seen = new Set();

      // Resolve the target master row
      var masterRow = null;
      var lookupName = (explicitPageName || '').trim().toUpperCase();
      if (lookupName) {
        var allMasters = Array.from(document.querySelectorAll('tr.k-master-row[data-testid]'));
        masterRow = allMasters.find(function (mr) {
          var cell = mr.querySelector('td.tooltipPageName, [class*="tooltipPageName"]');
          return cell && cell.textContent.trim().toUpperCase() === lookupName;
        }) || null;
      }
      if (!masterRow) {
        masterRow = document.querySelector('tr.k-master-row.k-selected, tr.k-master-row[aria-selected="true"]');
      }
      if (!masterRow) {
        var curPage = ((document.getElementById('svgPageName') || {}).textContent || '').trim().toUpperCase();
        if (curPage) {
          var allM = Array.from(document.querySelectorAll('tr.k-master-row[data-testid]'));
          masterRow = allM.find(function (mr) {
            var cell = mr.querySelector('td.tooltipPageName, [class*="tooltipPageName"]');
            return cell && cell.textContent.trim().toUpperCase() === curPage;
          }) || null;
        }
      }

      // Search inside the detail row immediately following the master row
      var searchRoot = document;
      if (masterRow) {
        var detailRow = masterRow.nextElementSibling;
        if (detailRow && detailRow.classList.contains('k-detail-row')) {
          searchRoot = detailRow;
        }
      }

      searchRoot.querySelectorAll('td[role="gridcell"]').forEach(function (td) {
        var txt = (td.textContent || '').trim().toLowerCase();
        if (txt !== norm) return;
        var tr = td.closest('tr');
        if (!tr || seen.has(tr)) return;
        seen.add(tr);
        rows.push(tr);
      });

      console.log('[Duke] findCountRowsByName("' + name + '"' +
        (floorLabel ? ', floor="' + floorLabel + '"' : '') +
        ') scope=' + (masterRow ? (masterRow.getAttribute('data-testid') || 'master') : 'global') +
        ' found=' + rows.length);
      return rows;
    }

    // Parse the numeric value out of a sidebar row — handles "N EA", "N.N SQFT", "N.N LF"
    function getCountFromRow(tr) {
      var div = tr.querySelector('[id^="ccl"], [id^="cl"]');
      if (!div) return 0;
      var text = (div.textContent || '').trim();
      var m = text.match(/^([\d,]+\.?\d*)\s*(EA|SQFT|LF)$/i);
      if (!m) return 0;
      return parseFloat(m[1].replace(/,/g, ''));
    }

    // Delete a sidebar count row: select it → trash → type YES → confirm delete
    async function deleteCountRow(tr) {
      await clickEl(tr);
      await delay(400);

      var trashBtn = document.getElementById('btnLayerDelete');
      if (!trashBtn) throw new Error('#btnLayerDelete not found');
      await clickEl(trashBtn);

      // Wait for the YES confirmation input to appear
      var yesInput = await waitFor(function () {
        var el = document.getElementById('inputValidationTextYes');
        return (el && el.offsetParent !== null) ? el : null;
      }, 5000);
      if (!yesInput) throw new Error('#inputValidationTextYes did not appear');

      // Fill "YES" and fire all common validation events (SquareTakeoff may listen to keyup)
      await fillInput(yesInput, 'YES');
      yesInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'S', keyCode: 83 }));
      yesInput.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'S', keyCode: 83 }));
      yesInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'S', keyCode: 83 }));
      await delay(400);

      var deleteBtn = document.getElementById('btnUpdateDeleteFlag');
      if (!deleteBtn) throw new Error('#btnUpdateDeleteFlag not found');

      // Force-enable the button if validation events didn't unlock it
      if (deleteBtn.disabled || deleteBtn.getAttribute('aria-disabled') === 'true') {
        deleteBtn.removeAttribute('disabled');
        deleteBtn.setAttribute('aria-disabled', 'false');
        deleteBtn.classList.remove('k-disabled', 'k-button-disabled');
      }

      await clickEl(deleteBtn);
      await delay(1000);
    }

    async function openCount(name, floorLabel, totalFloors, floorIndex, pageName) {
      // Wait for any lingering modal to close before clicking nav
      await waitFor(function () {
        return document.querySelectorAll('.modal.show').length === 0 ? true : null;
      }, 2000).catch(function () {});
      await delay(300);

      var existingRows = findCountRowsByName(name, floorLabel, pageName || null);
      console.log('[Duke] openCount "' + name + '" existing=' + existingRows.length);

      // Dedup: this page should have at most 1 row — keep the highest count, delete others
      while (existingRows.length > 1) {
        existingRows.sort(function (a, b) { return getCountFromRow(a) - getCountFromRow(b); });
        await deleteCountRow(existingRows[0]);
        await delay(600);
        existingRows = findCountRowsByName(name, floorLabel);
      }

      if (existingRows.length === 0) {
        // This page doesn't have a row yet — create a new one
        await clickNavItem('Count');

        var modal = await waitFor(function () {
          var m = document.getElementById('myTakeoffCountModal');
          return (m && m.classList.contains('show')) ? m : null;
        }, 5000);
        if (!modal) throw new Error('Count dialog (#myTakeoffCountModal) did not open');
        await delay(200);

        var nameInput = document.getElementById('txtCountName');
        if (!nameInput) throw new Error('#txtCountName not found');
        await fillInput(nameInput, name);
        await delay(150);

        await autoSelectDropdowns(modal);
        await clickModalSave(modal);
        await delay(500);

      } else {
        // Row already exists on this page — select it and start
        await clickEl(existingRows[0]);
        await delay(600);
        await clickStartCountBtn();
      }
    }

    // Click the Start button that activates count/dot placement mode.
    // Waits up to 3 s for it to appear after a row is selected.
    async function clickStartCountBtn() {
      var btn = await waitFor(function () {
        var el = document.getElementById('btnStartSvgtoPage');
        if (!el) return null;
        var cs = window.getComputedStyle(el);
        return (cs.display !== 'none' && cs.visibility !== 'hidden') ? el : null;
      }, 800).catch(function () { return null; });  // was 3000 — linears never show this btn; 800ms is enough for counts
      if (btn) {
        console.log('[Duke] Clicking btnStartSvgtoPage');
        await clickEl(btn);
        await delay(300);
      } else {
        console.log('[Duke] btnStartSvgtoPage not found/visible — skipping start click');
      }
    }

    // Area-specific dropdown selector — processes ALL dropdowns (not just empty ones)
    // so "Standard Area" is always set even if the type dropdown has a pre-existing value.
    async function selectAreaDropdowns(modal) {
      var allKendo = Array.from(modal.querySelectorAll('input[data-role="dropdownlist"]'));
      console.log('[Duke] selectAreaDropdowns: ' + allKendo.length + ' kendo dropdowns');

      for (var i = 0; i < allKendo.length; i++) {
        var inp = allKendo[i];
        try {
          var wrapper = inp.closest('.k-dropdownlist, .k-picker') || inp.parentElement;
          var arrow = wrapper && wrapper.querySelector('.k-input-button, .k-select, [role="button"]');
          if (arrow) { await clickEl(arrow); } else { await clickEl(inp); }
          await delay(150);  // was 350 — Kendo listbox renders well within 150ms

          var listboxId = inp.id + '_listbox';
          var listbox = document.getElementById(listboxId);
          if (!listbox) {
            listbox = document.querySelector('.k-popup .k-list-ul, .k-animation-container .k-list-ul');
          }
          if (!listbox) { console.log('[Duke] selectAreaDropdowns: no listbox for #' + inp.id); continue; }

          var items = Array.from(listbox.querySelectorAll('li[role="option"]'));
          // Only exclude true placeholder items (empty text or "Select") — do NOT filter by
          // data-offset-index because Kendo uses index=0 for the first real item too.
          var real = items.filter(function (li) {
            var txt = (li.textContent || '').trim();
            return txt && !/^select$/i.test(txt);
          });
          if (!real.length) { console.log('[Duke] selectAreaDropdowns: no items for #' + inp.id); continue; }

          // Identify dropdown purpose by its items
          var standardAreaItem = real.find(function (li) {
            return /standard\s*area/i.test((li.textContent || '').trim());
          });

          // Detect color dropdown: at least one item matches a known color name
          var isColorDropdown = real.some(function (li) {
            var n = (li.textContent || '').trim().toLowerCase().replace(/\s+/g, '');
            return EXCLUDED_COLORS.has(n) ||
                   /^(red|blue|green|yellow|orange|purple|pink|brown|black|gray|grey|cyan|magenta|lime|navy|teal|maroon|olive|silver|gold)/i.test(n);
          });

          if (standardAreaItem) {
            // Type dropdown → always pick Standard Area
            console.log('[Duke] selectAreaDropdowns #' + inp.id + ' → type, picking "Standard Area"');
            await clickEl(standardAreaItem);
            await delay(80);  // was 250
          } else if (isColorDropdown) {
            // Color dropdown → pick non-excluded color
            var validColors = real.filter(function (li) {
              var n = (li.textContent || '').trim().toLowerCase().replace(/\s+/g, '');
              return !EXCLUDED_COLORS.has(n);
            });
            var colorPool = validColors.length > 0 ? validColors : real;
            var pick = colorPool[colorIdx % colorPool.length];
            console.log('[Duke] selectAreaDropdowns #' + inp.id + ' → color, picking "' + (pick.textContent || '').trim() + '"');
            await clickEl(pick);
            await delay(80);  // was 250
          } else {
            // Not type or color — leave it alone
            console.log('[Duke] selectAreaDropdowns #' + inp.id + ' → unrecognised, skipping');
          }
        } catch (e) { console.log('[Duke] selectAreaDropdowns error #' + inp.id + ':', e.message); }
      }
      colorIdx++;
    }

    // ── Area ─────────────────────────────────────────────────────────────────
    // Nav onclick: onbtnareaClick()   Modal: #myAreaTakeoffModal
    // Name input: #inputAreaname   Type dropdown: select "Standard Area"   Color: random non-light

    async function openArea(name, floorLabel, totalFloors, floorIndex) {
      await waitFor(function () {
        return document.querySelectorAll('.modal.show').length === 0 ? true : null;
      }, 2000).catch(function () {});
      await delay(300);

      var existingRows = findCountRowsByName(name, floorLabel);
      var maxAllowed = totalFloors || 1;
      var fi = floorIndex || 0;
      console.log('[Duke] openArea "' + name + '" floorIdx=' + fi + '/' + maxAllowed + ' existing=' + existingRows.length);

      // Delete genuine duplicates first (more rows than total floors)
      while (existingRows.length > maxAllowed) {
        existingRows.sort(function (a, b) { return getCountFromRow(a) - getCountFromRow(b); });
        await deleteCountRow(existingRows[0]);
        await delay(600);
        existingRows = findCountRowsByName(name, floorLabel);
      }

      if (existingRows.length <= fi) {
        // This floor doesn't have a row yet — create a new one
        await clickNavItem('area');

        var modal = await waitFor(function () {
          var m = document.getElementById('myAreaTakeoffModal');
          return (m && m.classList.contains('show')) ? m : null;
        }, 5000);
        if (!modal) throw new Error('Area dialog (#myAreaTakeoffModal) did not open');
        await delay(200);

        var nameInput = document.getElementById('inputAreaname');
        if (!nameInput) throw new Error('#inputAreaname not found');
        await fillInput(nameInput, name);
        await delay(150);

        await selectAreaDropdowns(modal);
        await clickModalSave(modal);
        await delay(500);

      } else {
        // Row for this floor exists at index fi
        await clickEl(existingRows[fi]);
        await delay(600);
        await clickStartCountBtn();
      }
    }

    // ── Ensure count exists (create with 0 if missing — for verification step) ──
    async function ensureCount(name, floorLabel) {
      var existing = findCountRowsByName(name, floorLabel);
      if (existing.length > 0) {
        console.log('[Duke] ensureCount: "' + name + '" already exists');
        return;
      }
      console.log('[Duke] ensureCount: creating "' + name + '" with 0 count');

      await clickNavItem('Count');
      var modal = await waitFor(function () {
        var m = document.getElementById('myTakeoffCountModal');
        return (m && m.classList.contains('show')) ? m : null;
      }, 5000);
      if (!modal) throw new Error('Count dialog did not open for ensureCount');
      await delay(200);

      var nameInput = document.getElementById('txtCountName');
      if (!nameInput) throw new Error('#txtCountName not found');
      await fillInput(nameInput, name);
      await delay(150);
      await autoSelectDropdowns(modal);
      await clickModalSave(modal);
      await delay(500);

      // Immediately stop any auto-started session → creates 0-count record on server
      var stopBtn = document.getElementById('btnSaveSvgtoPage');
      if (stopBtn) {
        var cs = window.getComputedStyle(stopBtn);
        if (cs.display !== 'none' && cs.visibility !== 'hidden') {
          await clickEl(stopBtn);
          await delay(500);
        }
      }
    }

    // Delete ALL rows matching name on the current floor (cleanup for upper-floor-only counts)
    async function deleteAllCountRows(name, floorLabel) {
      var rows = findCountRowsByName(name, floorLabel);
      console.log('[Duke] deleteAllCountRows "' + name + '" floor="' + (floorLabel || '?') + '" found=' + rows.length);
      while (rows.length > 0) {
        rows.sort(function (a, b) { return getCountFromRow(a) - getCountFromRow(b); });
        await deleteCountRow(rows[0]);
        await delay(600);
        rows = findCountRowsByName(name, floorLabel);
      }
    }

    // ── Linear ───────────────────────────────────────────────────────────────
    // Nav onclick: onbtnlinearClick()   Modal: #myTakeoffLinearModal (or #myTakeoffLinearModal1)
    // Name input: #txtLinearName   Type: comboLinearType → "Standard Linear" + None radio
    // Width: #txtLinearWidth → 1   Color: LinearColor dropdown (excluded colors blocked)

    // Reopen an existing linear row (Ctrl+Enter restart) — click the row then Start, no new row.
    async function reopenLinear(name, floorLabel) {
      var existing = findCountRowsByName(name, floorLabel);
      if (!existing.length) throw new Error('No existing linear row found for: ' + name);
      await clickEl(existing[0]);
      await delay(600);
      await clickStartCountBtn();
    }

    async function openLinear(name) {
      await clickNavItem('linear');

      var modal = await waitFor(function () {
        var m = document.getElementById('myTakeoffLinearModal') || document.getElementById('myTakeoffLinearModal1');
        return (m && m.classList.contains('show')) ? m : null;
      }, 4000);
      if (!modal) throw new Error('Linear dialog (#myTakeoffLinearModal) did not open');
      await delay(200);

      // Name
      var nameInput = document.getElementById('txtLinearName')
                   || modal.querySelector('input[type="text"]:not([readonly]):not([disabled])');
      if (!nameInput) throw new Error('Linear name input not found');
      await fillInput(nameInput, name);
      await delay(150);

      // Helper: open a Kendo dropdown by input id, pick item matching predicate, close
      async function pickKendoItem(inputId, predicate) {
        var inp = document.getElementById(inputId);
        if (!inp) return false;
        var wrapper = inp.closest('.k-dropdownlist, .k-picker') || inp.parentElement;
        var arrow = wrapper && wrapper.querySelector('.k-input-button, .k-select, [role="button"]');
        if (arrow) { await clickEl(arrow); } else { await clickEl(inp); }
        await delay(150);  // was 350 — Kendo listbox renders well within 150ms
        var listbox = document.getElementById(inputId + '_listbox')
                   || document.querySelector('.k-popup .k-list-ul, .k-animation-container .k-list-ul');
        if (!listbox) return false;
        var items = Array.from(listbox.querySelectorAll('li[role="option"]'));
        var real = items.filter(function (li) { return (li.textContent || '').trim() && !/^select$/i.test((li.textContent || '').trim()); });
        var pick = real.find(predicate);
        if (!pick) { // close without picking
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return false;
        }
        await clickEl(pick);
        await delay(80);  // was 250
        return true;
      }

      // Linear Type → "Standard Linear"
      try {
        var typePicked = await pickKendoItem('comboLinearType', function (li) {
          return /standard\s*linear/i.test((li.textContent || '').trim());
        });
        if (!typePicked) console.warn('[Duke] LinearType: Standard Linear not found, leaving as-is');
      } catch (e) { console.warn('[Duke] LinearType:', e.message); }

      // Sub-type radio → None
      var noneRadio = document.getElementById('StandardLinearTypeNone')
                   || modal.querySelector('input[type="radio"][id*="None"], input[type="radio"][value="0"]');
      if (noneRadio) {
        noneRadio.checked = true;
        noneRadio.dispatchEvent(new Event('change', { bubbles: true }));
        noneRadio.click();
        await delay(150);
      }

      // Width → 1
      var widthInput = document.getElementById('txtLinearWidth');
      if (widthInput) { await fillInput(widthInput, '1'); await delay(150); }

      // Linear Color → pick non-excluded color
      try {
        await pickKendoItem('LinearColor', function (li) {
          var n = (li.textContent || '').trim().toLowerCase().replace(/\s+/g, '');
          return !EXCLUDED_COLORS.has(n);
        });
      } catch (e) { console.warn('[Duke] LinearColor:', e.message); }
      colorIdx++;

      await clickModalSave(modal);
      await delay(500);

      // Start the linear drawing session (SquareTakeoff may not auto-start after modal save)
      await clickStartCountBtn();
    }

    // ── Ctrl+Z → stop count, delete last dot, resume ─────────────────────────
    var ctrlZBusy = false;
    async function doCtrlZ() {
      if (ctrlZBusy) return;
      ctrlZBusy = true;
      try {
        // Only active when the Stop button is visible (we're in an active count session)
        var stopBtn = document.getElementById('btnSaveSvgtoPage');
        if (!stopBtn || stopBtn.style.display === 'none') {
          console.log('[Duke] Ctrl+Z: not in an active count session');
          return;
        }

        // 1. Stop first so SquareTakeoff saves the current SVG state.
        //    Deleting AFTER stop prevents stop from overwriting the deletion.
        stopBtn.click();
        await delay(500);

        // 2. Delete the last dot via background executeScript (MAIN world).
        //    The Delete keydown fires SquareTakeoff's own handler →
        //    DocumentPagesLayoutUpdateSquarefeet XHR decrements the server count.
        try {
          var deleteResult = await new Promise(function (resolve) {
            chrome.runtime.sendMessage({ action: 'DELETE_LAST_SVG_DOT' }, resolve);
          });
          console.log('[Duke] Ctrl+Z delete result:', deleteResult);
          if (deleteResult && deleteResult.ok) {
            // Wait for the XHR to complete before resuming
            await delay(600);
            // Decrement the sidebar count display immediately (optimistic update)
            document.querySelectorAll('tr[aria-selected="true"], tr.k-selected').forEach(function (row) {
              row.querySelectorAll('[id^="cl"], [id^="ccl"]').forEach(function (div) {
                var m = div.textContent.match(/^(\d+)\s*EA$/i);
                if (m) {
                  var newCount = Math.max(0, parseInt(m[1], 10) - 1);
                  div.textContent = newCount + ' EA';
                  console.log('[Duke] Ctrl+Z: decremented #' + div.id + ' → ' + newCount + ' EA');
                }
              });
            });
          }
        } catch (msgErr) {
          console.log('[Duke] Ctrl+Z message error:', msgErr.message);
        }

        // 3. Resume counting
        var resumeBtn = document.getElementById('btnStartSvgtoPage');
        if (resumeBtn && resumeBtn.offsetParent !== null) {
          resumeBtn.click();
          console.log('[Duke] Ctrl+Z: resumed via btnStartSvgtoPage');
        } else {
          var toggleBtn = document.getElementById('btnSaveSvgtoPage');
          if (toggleBtn && toggleBtn.offsetParent !== null) toggleBtn.click();
        }
      } catch (err) {
        console.log('[Duke] Ctrl+Z error:', err.message);
      } finally {
        ctrlZBusy = false;
      }
    }

    function ctrlZKeyHandler(e) {
      if (!e.ctrlKey || (e.key !== 'z' && e.key !== 'Z')) return;
      e.preventDefault();
      e.stopPropagation();
      doCtrlZ();
    }

    // Listen on the main frame (catches Ctrl+Z when focus is outside the iframe)
    document.addEventListener('keydown', ctrlZKeyHandler, true);

    // Also attach to the svgedit iframe document so Ctrl+Z works when clicking dots
    function attachCtrlZToIframe(iframe) {
      try {
        var iDoc = iframe.contentDocument;
        if (!iDoc) return;
        // Remove any previous listener before re-adding (in case of reload)
        iDoc.removeEventListener('keydown', ctrlZKeyHandler, true);
        iDoc.addEventListener('keydown', ctrlZKeyHandler, true);
        console.log('[Duke] Ctrl+Z listener attached to svgedit iframe');
      } catch (e) {
        console.log('[Duke] Could not attach Ctrl+Z to iframe:', e.message);
      }
    }

    // Watch for the svgedit iframe to appear in the DOM, then attach
    var svgEditObserver = new MutationObserver(function () {
      var iframe = document.getElementById('svgedit');
      if (!iframe) return;
      svgEditObserver.disconnect();
      // Attach now and again on every load (in case the iframe src changes)
      attachCtrlZToIframe(iframe);
      iframe.addEventListener('load', function () {
        attachCtrlZToIframe(iframe);
      });
    });
    svgEditObserver.observe(document.documentElement, { childList: true, subtree: true });

    // ── Enter listener ────────────────────────────────────────────────────────
    var enterListening = false;
    function listenForEnter() {
      if (enterListening) return;
      enterListening = true;
      document.addEventListener('keydown', function handler(e) {
        if (e.key === 'Enter' && enterListening) {
          enterListening = false;
          document.removeEventListener('keydown', handler);
          var action = e.ctrlKey ? 'TAKEOFF_CTRL_ENTER_PRESSED' : 'TAKEOFF_ENTER_PRESSED';
          chrome.runtime.sendMessage({ action: action });
        }
      });
    }

    function cancelAIPageNames() {
      aiPageNamesCancelled = true;
      closePageMgmtModal();
    }

    async function navigateToPage(pageName) {
      var targetName = (pageName || '').trim().toUpperCase();
      var target = null;

      // 1. Preferred: k-master-row with matching tooltipPageName (floor plan sheets)
      var masterRows = Array.from(document.querySelectorAll('tr.k-master-row[data-testid]'));
      for (var i = 0; i < masterRows.length; i++) {
        var cell = masterRows[i].querySelector('td.tooltipPageName, [class*="tooltipPageName"]');
        var cellName = (cell ? cell.textContent : '').trim().toUpperCase();
        if (cellName === targetName) { target = masterRows[i]; break; }
      }

      // 2. Fallback: click the tooltipPageName cell directly (PDF-upload pages not in master rows)
      if (!target) {
        var nameCells = Array.from(document.querySelectorAll('td.tooltipPageName, [class*="tooltipPageName"]'));
        for (var j = 0; j < nameCells.length; j++) {
          if (nameCells[j].textContent.trim().toUpperCase() === targetName) {
            target = nameCells[j];
            break;
          }
        }
      }

      if (!target) throw new Error('No master row found for page: ' + targetName);
      var alreadyOn = ((document.getElementById('svgPageName') || {}).textContent || '').trim().toUpperCase() === targetName;
      var alreadySelected = target.classList.contains('k-selected') || target.getAttribute('aria-selected') === 'true';
      if (!alreadyOn || !alreadySelected) {
        await clickEl(target);
        await new Promise(function (res) {
          var att = 0;
          function waitForNav() {
            var cur = ((document.getElementById('svgPageName') || {}).textContent || '').trim().toUpperCase();
            var sel = target.classList.contains('k-selected') || target.getAttribute('aria-selected') === 'true';
            if ((cur === targetName && sel) || ++att >= 25) return res();
            setTimeout(waitForNav, 150);
          }
          waitForNav();
        });
      }
      // Ensure the detail row is expanded (Kendo removes it from DOM when collapsed)
      var detailSib = target.nextElementSibling;
      if (!detailSib || !detailSib.classList.contains('k-detail-row')) {
        // Use Kendo API so we don't re-trigger the row's navigation click handler
        var gridEl = target.closest('[data-role="grid"]');
        var jq = window.jQuery || window.$;
        var kendoGrid = gridEl && jq && jq(gridEl).data('kendoGrid');
        if (kendoGrid) {
          kendoGrid.expandRow(jq(target));
        } else {
          // Fallback: click the expand icon without bubbling to avoid re-navigation
          var expandCell = target.querySelector('td.k-hierarchy-cell');
          if (expandCell) {
            expandCell.dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true }));
          }
        }
        await new Promise(function (res) {
          var att2 = 0;
          function waitForDetail() {
            var sib = target.nextElementSibling;
            if ((sib && sib.classList.contains('k-detail-row')) || ++att2 >= 20) return res();
            setTimeout(waitForDetail, 150);
          }
          waitForDetail();
        });
      }
    }

    return { getSheetNames, getSheetCount, ensureSheetPanelOpen, clickSheet, clickSheetByIndex, navigateToPage, deleteSheet, deleteSheetByIndex, deleteSheetsAtIndices, renameSheet, renameSheetByIndex, setScale, openScaleForManual, waitForScaleModalClose, getPageScaleFromDOM, useAIPageNames, cancelAIPageNames, openCount, ensureCount, deleteAllCountRows, findCountRowsByName, getCountFromRow, openArea, openLinear, reopenLinear, listenForEnter };
  })();

  // ─── Message Listener ────────────────────────────────────────────────────
  // Guard: if content.js is injected again into an already-running tab, skip re-registering
  // the listener so messages are only handled once (not doubled).
  if (window.__dukeListenerRegistered) return;
  window.__dukeListenerRegistered = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    // GRAB_TAKEOFF — full scrape + zero-fill all missing categories
    if (msg.action === 'GRAB_TAKEOFF') {
      (async function () {
        try {
          const isSquareTakeoff = location.hostname.includes('squaretakeoff');
          const raw = isSquareTakeoff ? await scrapeSquareTakeoff() : scrapeGenericBT();
          const full = mergeWithDefaults(raw);
          const found = Object.values(raw).filter(v => v > 0).length;
          sendResponse({ ok: true, data: full, found, raw });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    // Legacy scrape (no zero-fill)
    if (msg.action === 'SCRAPE_TAKEOFF') {
      (async function () {
        try {
          const isSquareTakeoff = location.hostname.includes('squaretakeoff');
          const raw = isSquareTakeoff ? await scrapeSquareTakeoff() : scrapeGenericBT();
          sendResponse({ ok: true, data: raw });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    if (msg.action === 'GET_PDF_URL') {
      const url = findPDFUrl();
      sendResponse({ ok: !!url, url });
    }

    if (msg.action === 'TAKEOFF_FIT_PAGE') {
      fitPageToView();
      sendResponse({ ok: true });
    }

    if (msg.action === 'CAPTURE_PLAN') {
      try {
        const img = capturePlanImage();
        if (img) sendResponse({ ok: true, ...img });
        else sendResponse({ ok: false, error: 'No plan image found on page' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    }

    // ── Takeoff automation messages ─────────────────────────────────────────

    if (msg.action === 'TAKEOFF_GET_SHEETS') {
      ST_AUTO.ensureSheetPanelOpen()
        .catch(function () {})
        .then(function () {
          try {
            var sheets = ST_AUTO.getSheetNames();
            var count  = sheets.length;
            console.log('[Duke] TAKEOFF_GET_SHEETS — count=' + count + ' sheets=' + JSON.stringify(sheets.slice(0, 5)));
            sendResponse({ ok: true, sheets: sheets, count: count });
          } catch (e) { sendResponse({ ok: false, error: e.message }); }
        });
      return true;
    }

    if (msg.action === 'TAKEOFF_CLICK_SHEET_INDEX') {
      ST_AUTO.navigateToPage(msg.pageName)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_CLICK_SHEET_BY_INDEX') {
      ST_AUTO.clickSheetByIndex(msg.index)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_RENAME_SHEET_INDEX') {
      ST_AUTO.renameSheetByIndex(msg.index, msg.newName)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_DELETE_SHEET_INDEX') {
      ST_AUTO.deleteSheetByIndex(msg.index)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_DELETE_SHEETS_BATCH') {
      ST_AUTO.deleteSheetsAtIndices(msg.indices)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_CLICK_SHEET') {
      ST_AUTO.clickSheet(msg.name)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_DELETE_SHEET') {
      ST_AUTO.deleteSheet(msg.name)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_RENAME_SHEET') {
      ST_AUTO.renameSheet(msg.oldName, msg.newName)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_GET_PAGE_SCALE') {
      try { sendResponse({ ok: true, scale: ST_AUTO.getPageScaleFromDOM() }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
      return false;
    }

    if (msg.action === 'TAKEOFF_GET_PAGE_IMAGE_URL') {
      try {
        var url = null;

        // 1. Try svgedit SVG <image> elements (standard floor plan pages)
        var svgIframe = document.getElementById('svgedit');
        if (svgIframe && svgIframe.contentDocument) {
          var svgImages = Array.from(svgIframe.contentDocument.querySelectorAll('image'));
          for (var ii = 0; ii < svgImages.length; ii++) {
            var href = svgImages[ii].getAttribute('href') || svgImages[ii].getAttribute('xlink:href') || '';
            if (href && href.trim()) { url = href.trim(); break; }
          }
        }

        // 2. Fallback: any <img> in the main document pointing to Azure blob (spec/PDF pages)
        if (!url) {
          var pageImgs = Array.from(document.querySelectorAll('img[src*="blob.core.windows.net"], img[src*="squaretakeoff"]'));
          if (pageImgs.length) url = pageImgs[0].src;
        }

        // 3. Fallback: any <img> inside any iframe pointing to Azure blob
        if (!url) {
          var iframes = Array.from(document.querySelectorAll('iframe'));
          for (var fi = 0; fi < iframes.length && !url; fi++) {
            try {
              var iDoc = iframes[fi].contentDocument;
              if (!iDoc) continue;
              var iImgs = Array.from(iDoc.querySelectorAll('img[src*="blob.core.windows.net"], img[src*="squaretakeoff"]'));
              if (iImgs.length) url = iImgs[0].src;
              if (!url) {
                var iSvgImgs = Array.from(iDoc.querySelectorAll('image'));
                for (var si = 0; si < iSvgImgs.length; si++) {
                  var sh = iSvgImgs[si].getAttribute('href') || iSvgImgs[si].getAttribute('xlink:href') || '';
                  if (sh && sh.trim()) { url = sh.trim(); break; }
                }
              }
            } catch (_) {}
          }
        }

        if (url) sendResponse({ ok: true, url: url });
        else sendResponse({ ok: false, error: 'No image href found in svgedit' });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
      return false;
    }

    if (msg.action === 'TAKEOFF_CONVERT_GIF_TO_PNG') {
      // Receive raw GIF bytes (base64) from service worker, convert to PNG via real DOM canvas
      try {
        var bin = atob(msg.gifBase64);
        var bytes = new Uint8Array(bin.length);
        for (var gi = 0; gi < bin.length; gi++) bytes[gi] = bin.charCodeAt(gi);
        var blob = new Blob([bytes], { type: 'image/gif' });
        createImageBitmap(blob)
          .then(function (bmp) {
            var canvas = document.createElement('canvas');
            canvas.width  = bmp.width;
            canvas.height = bmp.height;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, bmp.width, bmp.height);
            ctx.drawImage(bmp, 0, 0);
            sendResponse({ ok: true, base64: canvas.toDataURL('image/png').split(',')[1] });
          })
          .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
      return true; // async
    }

    if (msg.action === 'TAKEOFF_USE_AI_PAGE_NAMES') {
      ST_AUTO.useAIPageNames()
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'CANCEL_AI_PAGE_NAMES') {
      ST_AUTO.cancelAIPageNames();
      sendResponse({ ok: true });
      return false;
    }

    if (msg.action === 'TAKEOFF_SET_SCALE') {
      ST_AUTO.setScale(msg.scale, msg.applyAll)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_OPEN_SCALE_MANUAL') {
      ST_AUTO.openScaleForManual()
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_WAIT_FOR_SCALE_START') {
      ST_AUTO.waitForScaleModalClose()
        .then(function () { sendResponse({ ok: true }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_OPEN_COUNT') {
      ST_AUTO.openCount(msg.name, msg.floorLabel, msg.totalFloors, msg.floorIndex, msg.pageName)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_OPEN_AREA') {
      ST_AUTO.openArea(msg.name, msg.floorLabel, msg.totalFloors, msg.floorIndex)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_STOP_AREA_SESSION') {
      (async function () {
        var stopBtn = document.getElementById('btnSaveSvgtoPage');
        if (stopBtn && getComputedStyle(stopBtn).display !== 'none') {
          console.log('[Duke] Clicking btnSaveSvgtoPage to commit area SQFT');
          stopBtn.click();
          await new Promise(function (r) { setTimeout(r, 800); });
        }
        sendResponse({ ok: true });
      })().catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_CHECK_ROW_EXISTS') {
      var rows = ST_AUTO.findCountRowsByName(msg.name, msg.floorLabel, msg.pageName);
      var count = rows.length > 0 ? ST_AUTO.getCountFromRow(rows[0]) : 0;
      sendResponse({ ok: true, exists: rows.length > 0, count: count });
      return true;
    }

    if (msg.action === 'TAKEOFF_GET_ROW_VALUE') {
      var grRows = ST_AUTO.findCountRowsByName(msg.name, msg.floorLabel || '', msg.pageName || null);
      var grValue = grRows.length > 0 ? ST_AUTO.getCountFromRow(grRows[0]) : 0;
      sendResponse({ ok: true, value: grValue });
      return true;
    }

    if (msg.action === 'TAKEOFF_ENSURE_COUNT') {
      ST_AUTO.ensureCount(msg.name, msg.floorLabel)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_DELETE_ALL_COUNT_ROWS') {
      ST_AUTO.deleteAllCountRows(msg.name, msg.floorLabel)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_OPEN_LINEAR') {
      ST_AUTO.openLinear(msg.name)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_REOPEN_LINEAR') {
      ST_AUTO.reopenLinear(msg.name, msg.floorLabel)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.action === 'TAKEOFF_LISTEN_ENTER') {
      ST_AUTO.listenForEnter();
      sendResponse({ ok: true });
    }

    return true;
  });

})();
