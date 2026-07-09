// ═══════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════
var pendingItems = [];
var pendingCustomItems = [];
var pendingClientPreview = false;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  var data = await chrome.storage.session.get(['pendingEstimateItems','pendingCustomItems','pendingClientPreview']);
  pendingItems = data.pendingEstimateItems || [];
  pendingCustomItems = data.pendingCustomItems || [];
  pendingClientPreview = !!data.pendingClientPreview;

  if (pendingClientPreview) {
    document.querySelector('.hdr-title').textContent = 'Start Prelim - Budget Client Preview';
    document.getElementById('item-count').textContent = 'Select a BuilderTrend Estimate tab';
  } else {
    document.getElementById('item-count').textContent =
      pendingItems.length + ' item' + (pendingItems.length === 1 ? '' : 's') + ' ready to write';
  }
  document.getElementById('btn-refresh').addEventListener('click', loadTabs);
  document.getElementById('btn-back').addEventListener('click', showPicker);
  document.getElementById('btn-close').addEventListener('click', function () { window.close(); });
  await loadTabs();
}

function isBuilderTrendTab(t) {
  return !!(t.url && /buildertrend\.net|squaretakeoff\.com/i.test(t.url));
}

// ═══════════════════════════════════════════════════════════
// Tab list (the "share a tab" style picker)
// ═══════════════════════════════════════════════════════════
async function loadTabs() {
  var listEl = document.getElementById('tab-list');
  listEl.innerHTML = '<div class="loading">Loading open tabs…</div>';

  var tabs = await chrome.tabs.query({});
  var visible = tabs.filter(function (t) { return t.url && /^https?:\/\//.test(t.url); });

  visible.sort(function (a, b) {
    var ra = isBuilderTrendTab(a) ? 0 : 1;
    var rb = isBuilderTrendTab(b) ? 0 : 1;
    return ra - rb;
  });

  if (!visible.length) {
    listEl.innerHTML = '<div class="empty">No open tabs found. Open your BuilderTrend Estimate tab, then click Refresh.</div>';
    return;
  }

  listEl.innerHTML = '';
  visible.forEach(function (t) {
    var recommended = isBuilderTrendTab(t);
    var row = document.createElement('div');
    row.className = 'tab-row' + (recommended ? ' recommended' : '');

    var favicon = document.createElement('img');
    favicon.className = 'favicon';
    favicon.src = t.favIconUrl || 'icons/icon16.png';
    favicon.addEventListener('error', function () { favicon.src = 'icons/icon16.png'; });

    var info = document.createElement('div');
    info.className = 'tab-info';

    var title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = t.title || '(untitled tab)';

    var url = document.createElement('div');
    url.className = 'tab-url';
    try { url.textContent = new URL(t.url).hostname; } catch (e) { url.textContent = t.url; }

    info.appendChild(title);
    info.appendChild(url);
    row.appendChild(favicon);
    row.appendChild(info);

    if (recommended) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'BuilderTrend';
      row.appendChild(badge);
    }

    row.addEventListener('click', function () { selectTab(t); });
    listEl.appendChild(row);
  });
}

function showPicker() {
  document.getElementById('progress-view').classList.add('hidden');
  document.getElementById('picker-view').classList.remove('hidden');
  loadTabs();
}

// ═══════════════════════════════════════════════════════════
// Write-to-estimate — runs in the chosen tab
// ═══════════════════════════════════════════════════════════
async function selectTab(tab) {
  document.getElementById('picker-view').classList.add('hidden');
  document.getElementById('progress-view').classList.remove('hidden');

  var titleEl  = document.getElementById('progress-title');
  var statusEl = document.getElementById('progress-status');
  var logEl    = document.getElementById('log');

  titleEl.textContent = 'Writing to: ' + (tab.title || tab.url);
  statusEl.className = 'progress-status';
  statusEl.innerHTML = '<span class="spin"></span>Bringing tab into focus…';
  logEl.textContent = '';

  function log(msg) {
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  if (pendingClientPreview) {
    await selectTabForClientPreview(tab, titleEl, statusEl, logEl);
    return;
  }

  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise(function (r) { setTimeout(r, 400); });

    statusEl.innerHTML = '<span class="spin"></span>Writing items to the estimate…';

    var result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: writeEstimateInPage,
      args: [pendingItems, pendingCustomItems]
    });

    var res2 = result && result[0] && result[0].result;
    if (res2 && res2.lines) {
      res2.lines.forEach(function (l) { log(l); });
      if (res2.fail) {
        statusEl.className = 'progress-status error';
        statusEl.textContent = 'Wrote ' + res2.ok + ' item(s) · ' + res2.fail + ' failed — see log above.';
      } else {
        statusEl.className = 'progress-status success';
        statusEl.textContent = '✓ Wrote ' + res2.ok + ' item(s) to the estimate successfully.';
      }
    } else if (result && result[0] && result[0].error) {
      log('⚠ Script error: ' + result[0].error.message);
      statusEl.className = 'progress-status error';
      statusEl.textContent = 'Script error — see log above.';
    } else {
      statusEl.className = 'progress-status success';
      statusEl.textContent = 'Write to Estimate complete.';
    }
  } catch (e) {
    log('ERROR: ' + e.message);
    statusEl.className = 'progress-status error';
    statusEl.textContent = 'Failed: ' + e.message;
  }
}

// Injected into the target tab via chrome.scripting.executeScript.
async function writeEstimateInPage(itemsList, customItemsList) {
  try {
    var _log = [];
    var _delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    function reactSet(input, val) {
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(val));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function waitForModalClose(maxWaitMs) {
      maxWaitMs = maxWaitMs || 2000;
      return new Promise(function (resolve) {
        var startWait = performance.now();
        var checkInterval = setInterval(function () {
          var modal = document.querySelector('.ant-modal-wrap, .ant-modal-root, [class*="modal"][class*="show"]');
          var elapsed = performance.now() - startWait;
          if (!modal || elapsed >= maxWaitMs) { clearInterval(checkInterval); resolve(elapsed); }
        }, 50);
      });
    }

    async function setQty(name, qty, isUnitCost) {
      var needle = name.toLowerCase();
      var words = needle.split(/\s+/).filter(Boolean);
      var startTime = performance.now();

      var si = null;
      for (var wi = 0; wi < 20; wi++) {
        si = document.getElementById('rc_select_17');
        if (!si) si = document.getElementById('rc_select_1');
        if (!si) {
          var collapseBtn = Array.from(document.querySelectorAll('button')).find(function (btn) {
            return btn.textContent && btn.textContent.includes('Collapse all');
          });
          if (collapseBtn) {
            var parent = collapseBtn.closest('[class*="header"], [class*="control"], div');
            if (parent) si = parent.querySelector('input[role="combobox"].ant-select-selection-search-input');
          }
        }
        if (!si) {
          var candidates = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
          candidates = candidates.filter(function (el) {
            var id = el.id || '';
            return id && id.startsWith('rc_select_') && id !== 'rc_select_0' && id !== 'savedFilterDropdown' && !id.match(/^\d+$/);
          });
          si = candidates[0];
        }
        if (si) break;
        await _delay(100);
      }
      if (!si) { _log.push('✗ ' + name + ' — search bar not found'); return; }

      var container = si.closest('.ant-select-selector') || si.parentElement;
      if (container) { container.click(); await _delay(200); }
      si.focus();
      await _delay(100);

      var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(si, name);
      si.dispatchEvent(new Event('input', { bubbles: true }));
      si.dispatchEvent(new Event('change', { bubbles: true }));
      await _delay(500);

      var opts = document.querySelectorAll('.LineItemResult.LineItem');
      var clicked = false;
      for (var o = 0; o < opts.length; o++) {
        var optTxt = (opts[o].innerText || '').trim().toLowerCase();
        if (words.every(function (w) { return optTxt.includes(w); })) {
          opts[o].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          opts[o].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          opts[o].click();
          clicked = true;
          break;
        }
      }
      if (!clicked) { _log.push('○ ' + name + ' — not in dropdown'); return; }

      function isInGroupHeader(node) {
        var ownCls = node.className || '';
        if (ownCls.includes('proposalFormatGroupCellTitle') || ownCls.includes('proposalFormatGroupCellTitleReadonly')) return true;
        var n = node.parentElement;
        while (n && n !== document.body) {
          var cc = n.className || '';
          if (cc.includes('WorksheetGroupCellActions') || cc.includes('proposalFormatGroupCell')) return true;
          n = n.parentElement;
        }
        return false;
      }

      function findValueDisplay() {
        var vds = document.querySelectorAll('.ValueDisplay');
        for (var v = 0; v < vds.length; v++) {
          if (!vds[v].offsetHeight || isInGroupHeader(vds[v])) continue;
          if ((vds[v].innerText || '').trim().toLowerCase() === needle) return vds[v];
        }
        for (var v2 = 0; v2 < vds.length; v2++) {
          if (!vds[v2].offsetHeight || isInGroupHeader(vds[v2])) continue;
          var t = (vds[v2].innerText || '').trim().toLowerCase();
          if (words.every(function (w) { return t.includes(w); })) return vds[v2];
        }
        return null;
      }

      var el = null;
      for (var attempt = 0; attempt < 15; attempt++) {
        el = findValueDisplay();
        if (el) break;
        await _delay(100);
      }
      if (!el) { _log.push('○ ' + name + ' — ValueDisplay not found'); return; }

      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      await _delay(300);
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
      await _delay(400);

      var qtyInput = null;
      if (isUnitCost) qtyInput = document.querySelector('input[data-testid="unitCost"], input#unitCost');
      if (!qtyInput) {
        qtyInput = document.querySelector('input[role="spinbutton"].ant-input-number-input')
          || document.querySelector('input[role="spinbutton"]')
          || document.querySelector('input.ant-input-number-input');
      }
      if (!qtyInput) { _log.push('○ ' + name + ' — qty input not found'); return; }

      qtyInput.focus();
      await _delay(150);
      qtyInput.select();
      qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, ctrlKey: true, bubbles: true }));
      await _delay(50);
      qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', keyCode: 46, bubbles: true }));
      reactSet(qtyInput, '');
      qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
      await _delay(100);

      var roundedQty = Math.round(qty * 100) / 100;
      var valStr = String(roundedQty);
      var setter2 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (var ci = 0; ci < valStr.length; ci++) {
        var ch = valStr[ci];
        var code = ch.charCodeAt(0);
        qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: ch, keyCode: code, bubbles: true }));
        qtyInput.dispatchEvent(new KeyboardEvent('keypress', { key: ch, keyCode: code, bubbles: true }));
        setter2.call(qtyInput, valStr.slice(0, ci + 1));
        qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        qtyInput.dispatchEvent(new KeyboardEvent('keyup', { key: ch, keyCode: code, bubbles: true }));
        await _delay(20);
      }
      await _delay(200);

      var saveBtn = document.querySelector('[data-testid="saveButton"], #saveButton');
      if (!saveBtn) {
        for (var s = 0; s < 15; s++) {
          await _delay(100);
          saveBtn = document.querySelector('[data-testid="saveButton"], #saveButton');
          if (saveBtn) break;
        }
      }
      if (saveBtn) {
        saveBtn.click();
        await waitForModalClose(2000);
      } else {
        qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        await _delay(500);
      }

      var totalTime = performance.now() - startTime;
      _log.push('✓ ' + name + ' → ' + qty + (isUnitCost ? ' (unit cost)' : ' (qty)') + ' (' + totalTime.toFixed(0) + 'ms)');
    }

    async function createLineItem(title, unitCost) {
      var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

      // ── Step 1: Type in search bar, then click the <b>Custom Selection Allowances</b>
      // result — that's what scrolls the virtualized table to render the group row.
      var si = document.getElementById('rc_select_17') || document.getElementById('rc_select_1');
      if (!si) {
        var cands = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
        si = cands.find(function(el){ var id=el.id||''; return id.startsWith('rc_select_') && id!=='rc_select_0'; });
      }
      if (si) {
        var cont = si.closest('.ant-select-selector') || si.parentElement;
        if (cont) { cont.click(); await _delay(200); }
        si.focus(); await _delay(100);
        ns.call(si, 'Custom Selection Allowances');
        si.dispatchEvent(new Event('input',{bubbles:true}));
        si.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(900);
        // Click the dropdown result — it appears as a <b> tag or a .LineItemResult
        // containing "Custom Selection Allowances". Clicking it scrolls the table to the group.
        var result = null;
        var bTags = document.querySelectorAll('b');
        for (var bi=0; bi<bTags.length; bi++) {
          if ((bTags[bi].textContent||'').trim().toLowerCase() === 'custom selection allowances') {
            result = bTags[bi]; break;
          }
        }
        // fallback: any visible dropdown item containing the text
        if (!result) {
          var items = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
          for (var ii=0; ii<items.length; ii++) {
            if ((items[ii].innerText||'').toLowerCase().includes('custom selection allowances')) {
              result = items[ii]; break;
            }
          }
        }
        if (result) {
          var clickTarget = result.closest('.LineItemResult') || result.closest('[class*="Result"]') || result;
          clickTarget.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          clickTarget.click();
          await _delay(700);
        }
      }

      // ── Step 2: Find the + button — group is now rendered in the DOM ─────────
      var plusBtn = null;
      for (var wi=0; wi<20; wi++) {
        var rows = document.querySelectorAll('.WorksheetGroupCellActions');
        for (var ri=0; ri<rows.length; ri++) {
          var titleEl = rows[ri].querySelector('.proposalFormatGroupCellTitle');
          if (titleEl && (titleEl.innerText||'').trim().toLowerCase() === 'custom selection allowances') {
            var candidate = rows[ri].querySelector('button.AddItemsDropdown');
            if (candidate) { plusBtn = candidate; break; }
          }
        }
        if (plusBtn) break;
        await _delay(150);
      }
      if (!plusBtn) { _log.push('✗ createLineItem: + button not found'); return; }
      plusBtn.scrollIntoView({ behavior:'instant', block:'center' });
      await _delay(300);

      // ── Step 3: Click + → Item ────────────────────────────────────────────
      var existingIds = new Set(Array.from(document.querySelectorAll('[data-testid*="itemTitle"]')).map(function(e){ return e.id; }));
      plusBtn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      plusBtn.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      plusBtn.click();
      await _delay(600);

      // "Item" option in the dropdown that appears
      var itemOpt = null;
      for (var wi=0; wi<15; wi++) {
        var opts2 = document.querySelectorAll('.ant-dropdown-menu-title-content');
        for (var oi=0; oi<opts2.length; oi++) {
          if ((opts2[oi].textContent||'').trim() === 'Item') { itemOpt = opts2[oi]; break; }
        }
        if (itemOpt) break;
        await _delay(100);
      }
      if (!itemOpt) { _log.push('✗ createLineItem: Item option not found'); return; }
      itemOpt.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      itemOpt.click();
      await _delay(600);

      // Clear the search bar so the table fully re-renders and shows the new row
      if (si) {
        ns.call(si, '');
        si.dispatchEvent(new Event('input',{bubbles:true}));
        si.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(600);
      }

      // ── Step 4: Find the newly-added title input ──────────────────────────
      // The new row has class "editing" on the <tr> (confirmed from OuterHTML).
      // Find the title input inside any editing row, or fall back to any new itemTitle input.
      var newTitleEl = null;
      for (var a=0; a<30; a++) {
        // Primary: find input inside a tr.editing row
        var editingRow = document.querySelector('tr.editing');
        if (editingRow) {
          newTitleEl = editingRow.querySelector('input[id*="itemTitle"], [data-testid*="itemTitle"]');
          if (newTitleEl) break;
        }
        // Fallback: any itemTitle input not in our pre-existing set
        var allTitles = document.querySelectorAll('[data-testid*="itemTitle"], input[id*="itemTitle"]');
        for (var tt=0; tt<allTitles.length; tt++) {
          if (!existingIds.has(allTitles[tt].id)) { newTitleEl = allTitles[tt]; break; }
        }
        if (newTitleEl) break;
        await _delay(150);
      }
      if (!newTitleEl) { _log.push('✗ createLineItem: new title input not found'); return; }

      // Fill title
      newTitleEl.scrollIntoView({ behavior:'instant', block:'center' });
      newTitleEl.focus(); await _delay(150);
      newTitleEl.select();
      ns.call(newTitleEl, title);
      newTitleEl.dispatchEvent(new Event('input',{bubbles:true}));
      newTitleEl.dispatchEvent(new Event('change',{bubbles:true}));
      await _delay(300);

      // ── Step 5: Cost code — type & pick "Custom Selection Allowances" ─────
      // keyBase e.g. "formatItems[4].items[0]"
      var keyBase = (newTitleEl.getAttribute('data-testid') || newTitleEl.id || '').replace(/\.itemTitle$/, '');
      var ccInput = document.querySelector('[id="' + keyBase + '.costCodeId"]');
      if (ccInput) {
        // click the select container first so the ant-select opens
        var ccWrap = ccInput.closest('.ant-select') || ccInput.parentElement;
        if (ccWrap) { ccWrap.click(); await _delay(300); }
        ccInput.focus(); await _delay(100);
        ns.call(ccInput, 'Custom Selection Allowances');
        ccInput.dispatchEvent(new Event('input',{bubbles:true}));
        ccInput.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(800);
        // Pick the dropdown option — matches OuterHTML: <div class="ant-select-item-option-content">Custom Selection Allowances</div>
        var ccOpt = null;
        var allCcOpts = document.querySelectorAll('.ant-select-item-option-content');
        for (var co=0; co<allCcOpts.length; co++) {
          if ((allCcOpts[co].textContent||'').trim() === 'Custom Selection Allowances') { ccOpt = allCcOpts[co]; break; }
        }
        if (ccOpt) {
          ccOpt.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          ccOpt.click();
          await _delay(400);
        } else {
          _log.push('⚠ createLineItem: cost code option not found — continuing');
        }
      }

      // ── Step 6: Unit cost ─────────────────────────────────────────────────
      // OuterHTML shows type="text", id & data-testid = keyBase + ".unitCost", value="0.0000"
      var ucInput = document.querySelector('[data-testid="' + keyBase + '.unitCost"]')
                 || document.querySelector('[id="' + keyBase + '.unitCost"]');
      if (ucInput) {
        ucInput.focus(); await _delay(150);
        ucInput.select();
        // clear existing "0.0000" then type the real value
        ns.call(ucInput, '');
        ucInput.dispatchEvent(new Event('input',{bubbles:true}));
        await _delay(50);
        var valStr = String(Math.round(parseFloat(unitCost) * 100) / 100);
        ns.call(ucInput, valStr);
        ucInput.dispatchEvent(new Event('input',{bubbles:true}));
        ucInput.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(200);
      } else {
        _log.push('⚠ createLineItem: unit cost input not found — continuing');
      }

      // ── Step 7: Save by clicking to the left of the estimate ─────────────
      var sideEl = document.querySelector('.ant-layout-sider, aside');
      var saveX = sideEl ? sideEl.getBoundingClientRect().right + 5 : 10;
      var saveY = window.innerHeight / 2;
      var saveTarget = document.elementFromPoint(saveX, saveY) || document.body;
      saveTarget.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:saveX,clientY:saveY}));
      await _delay(150);
      saveTarget.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:saveX,clientY:saveY}));
      await _delay(900);

      _log.push('✓ Created: ' + title + ' → $' + unitCost);
    }

    var writeStartTime = performance.now();
    for (var i = 0; i < itemsList.length; i++) {
      await setQty(itemsList[i].name, itemsList[i].qty, itemsList[i].isUnitCost);
    }

    await _delay(1500);

    var totalVal = 0;
    var footerSpan = document.querySelector('.BTGridFooterCell--ellipsis span[dir="ltr"]');
    if (footerSpan) {
      var footerTxt = (footerSpan.innerText || '').trim();
      var footerMatch = footerTxt.match(/^\$([\d,]+\.?\d*)$/);
      if (footerMatch) totalVal = parseFloat(footerMatch[1].replace(/,/g, ''));
    }
    if (customItemsList && customItemsList.length) {
      _log.push('');
      _log.push('── Custom Selection Allowances ──');
      for (var ci = 0; ci < customItemsList.length; ci++) {
        await createLineItem(customItemsList[ci].name, customItemsList[ci].unitCost);
      }
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

          // Pick the BTIconActions button closest to viewport center
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

    var totalWriteTime = performance.now() - writeStartTime;
    var totalSeconds = totalWriteTime / 1000;
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = (totalSeconds % 60).toFixed(1);
    var timeFormat = minutes > 0 ? minutes + 'm ' + seconds + 's' : seconds + 's';
    _log.push('');
    _log.push('═══ TOTAL TIME: ' + timeFormat + ' ═══');

    return {
      ok: _log.filter(function (l) { return l.startsWith('✓'); }).length,
      fail: _log.filter(function (l) { return l.startsWith('✗'); }).length,
      lines: _log
    };
  } catch (e) {
    return { ok: 0, fail: 1, lines: ['✗ Script error: ' + e.message] };
  }
}

// ═══════════════════════════════════════════════════════════
// Client Preview flow — runs in the chosen tab via
// chrome.scripting.executeScript (same as popup.js)
// ═══════════════════════════════════════════════════════════
async function selectTabForClientPreview(tab, titleEl, statusEl, logEl) {
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  titleEl.textContent = 'Client Preview: ' + (tab.title || tab.url);
  statusEl.className = 'progress-status';
  statusEl.innerHTML = '<span class="spin"></span>Bringing tab into focus…';
  logEl.textContent = '';

  function log(msg) {
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setStatus(msg) {
    statusEl.innerHTML = '<span class="spin"></span>' + msg;
  }

  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await delay(400);

    // Step 0: Read grand total
    log('Reading estimate grand total…');
    var totalRes = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: function () {
        var span = document.querySelector('.BTGridFooterCell--ellipsis span[dir="ltr"]');
        if (!span) return 0;
        var txt = (span.innerText || '').trim();
        var m = txt.match(/^\$([\d,]+\.?\d*)$/);
        return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
      }
    });
    var grandTotal = (totalRes && totalRes[0] && totalRes[0].result) || 0;
    if (grandTotal > 0) log('Grand total: $' + grandTotal.toLocaleString('en-US'));
    else log('Warning: grand total not found — budget range will be skipped');

    // Step 1: Click buildProposal
    log('Opening proposal builder…');
    setStatus('Opening proposal…');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: function () {
        var btn = document.querySelector('[data-testid="buildProposal"]');
        if (btn) btn.click();
      }
    });
    await delay(2500);

    // Step 1.5: Fill editors if grand total available
    if (grandTotal > 0) {
      log('Filling proposal editors…');
      setStatus('Writing proposal text…');
      var lowFmt  = '$' + Math.round(grandTotal * 0.99).toLocaleString('en-US');
      var highFmt = '$' + Math.round(grandTotal * 1.10).toLocaleString('en-US');
      var introHtml = [
        '<p><em>This is a preliminary estimate for budgeting purposes only &mdash; not a contract or binding price.</em></p>',
        '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;',
        '<table align="center" border="1" cellpadding="1" cellspacing="1" style="width:500px;">',
        '<tbody><tr><td style="text-align: center;">',
        '<h3><span style="font-size:16px;"><strong>ESTIMATED BUDGET RANGE</strong></span></h3>',
        '<h1><span style="font-size:28px;"><strong>' + lowFmt + ' &ndash; ' + highFmt + '</strong></span></h1>',
        '</td></tr></tbody></table>',
        '&nbsp;',
        '<p>&nbsp;</p>',
        '<h2><span style="font-size:16px;"><strong>WHAT&#39;S INCLUDED IN YOUR ESTIMATE&nbsp;</strong></span></h2>',
        '<hr /><strong>Design &amp; Pre-Construction</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Complete architectural plans, engineering, permits, surveys, and inspections',
        '<hr /><strong>Foundation</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; &nbsp;Standard footings, walls, waterproofing, and backfill',
        '<hr /><strong>Framing &amp; Structure</strong>&nbsp; &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Full framing package including lumber, trusses, engineered joists, and stairs',
        '<hr /><strong>Exterior Envelope</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Siding exterior with architectural shingle roofing, gutters, and all exterior trim',
        '<hr /><strong>Mechanical Systems</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; &nbsp;Complete HVAC, plumbing rough &amp; finish, and electrical rough &amp; finish',
        '<hr /><strong>Insulation &amp; Drywall</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; &nbsp; Full insulation to code, drywall, and interior/exterior paint',
        '<hr /><strong>Interior Finishes</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; Interior doors, trim, hardware, and custom carpentry allowance',
        '<hr /><strong>Site Work &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp;S</strong>ite clearing, grading, driveway, and all utilities including municipal tap fees',
        '<hr /><strong>Decks / Porches &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;P</strong>orches and decks finished per spec'
      ].join('');
      var closingHtml = [
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

      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: async function (introHtml, closingHtml) {
          function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

          var titleInput = document.querySelector('#title[data-testid="title"]');
          if (titleInput) {
            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(titleInput, 'Preliminary Budget Estimate');
            titleInput.dispatchEvent(new Event('input', { bubbles: true }));
            titleInput.dispatchEvent(new Event('change', { bubbles: true }));
          }

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
          editorA.setData(introHtml);
          editorB.setData(closingHtml);
          await delay(300);

          var jobId = null;
          var resources = performance.getEntriesByType('resource');
          for (var ri = 0; ri < resources.length; ri++) {
            var rm = resources[ri].name.match(/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/);
            if (rm) { jobId = rm[1]; break; }
          }

          if (jobId) {
            var draft = await new Promise(function (resolve) {
              var xhr = new XMLHttpRequest();
              xhr.open('GET', '/apix/v2/Proposals/draft?jobId=' + jobId, true);
              xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
              xhr.setRequestHeader('portaltype', '1');
              xhr.onload = function () {
                if (xhr.status === 200) { try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(null); } }
                else { resolve(null); }
              };
              xhr.onerror = function () { resolve(null); };
              xhr.send();
            });
            if (!draft) {
              var saveBtn = document.querySelector('[data-testid="save"]');
              if (saveBtn) { saveBtn.click(); await delay(3000); }
            } else {
              var putBody = {};
              Object.keys(draft).forEach(function (k) {
                if (draft[k] && typeof draft[k] === 'object' && !Array.isArray(draft[k])) {
                  Object.assign(putBody, draft[k]);
                }
              });
              if (!('categories' in putBody) && putBody.formatItems) { putBody.categories = putBody.formatItems; }
              if (!('formatOptions' in putBody)) {
                var dOpts = putBody.displayOptions || {};
                var pConf = putBody.proposalDisplayConfig || {};
                putBody.formatOptions = {
                  body: dOpts.body, header: dOpts.header, printoutType: dOpts.printoutType,
                  includeSpecs: dOpts.includeSpecs || false, showAddress: putBody.showAddress || false,
                  showOwnerContactInfo: putBody.showOwnerContactInfo || false,
                  showPrintoutInfo: putBody.showPrintoutInfo || false,
                  proposalLayout: pConf.proposalLayout != null ? pConf.proposalLayout : 0,
                  hasSingleSelectCostTypes: pConf.hasSingleSelectCostTypes || false
                };
              }
              if (Array.isArray(putBody.categories)) {
                putBody.categories.forEach(function (cat) {
                  if (cat.items && !cat.lineItems) { cat.lineItems = cat.items; delete cat.items; }
                });
              }
              putBody.requireSignatures = false;
              putBody.requiredSignatureUsers = [];
              if (putBody.columnsToDisplay && Array.isArray(putBody.columnsToDisplay.value)) {
                putBody.columnsToDisplay = putBody.columnsToDisplay.value;
              }
              putBody.introductionText = introHtml;
              putBody.closingText = closingHtml;
              var bodyStr = JSON.stringify(putBody);
              await new Promise(function (resolve) {
                var xhr = new XMLHttpRequest();
                xhr.open('PUT', '/apix/v2/Proposals/draft?jobId=' + jobId, true);
                xhr.setRequestHeader('content-type', 'application/merge-patch+json');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('portaltype', '1');
                xhr.onload = function () { resolve(xhr.status); };
                xhr.onerror = function () { resolve(0); };
                xhr.send(bodyStr);
              });
              await delay(1500);
              editorA.setData(introHtml);
              editorB.setData(closingHtml);
              await delay(300);
            }
          } else {
            var saveBtn2 = document.querySelector('[data-testid="save"]');
            if (saveBtn2) { saveBtn2.click(); await delay(3000); }
          }
        },
        args: [introHtml, closingHtml]
      });

      log('Proposal editors filled.');
      await delay(2000);

      // Uncheck signatures
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: function () {
          var cb = document.querySelector('[data-testid="requireSignatures"]');
          if (cb) {
            var wrapper = cb.closest('.ant-checkbox-wrapper');
            if (wrapper && wrapper.classList.contains('ant-checkbox-wrapper-checked')) { cb.click(); }
          }
        }
      });
      await delay(500);

      // Click Save button to persist all changes before navigating away
      log('Saving proposal…');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: function () {
          var btn = document.querySelector('[data-testid="save"]');
          if (btn) btn.click();
        }
      });
      await delay(3000);
    }

    // Step 2: Click Client Preview tab
    log('Navigating to client preview…');
    setStatus('Navigating to client preview…');
    var previewResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: async function () {
        function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        function waitFor(fn, ms) {
          return new Promise(function (res, rej) {
            var end = Date.now() + (ms || 6000);
            (function tick() { var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
          });
        }
        var tabEl = await waitFor(function () {
          var el = document.querySelector('[data-testid="jobProposalClientPreviewTab"]');
          return (el && el.offsetParent !== null) ? el : null;
        }, 6000).catch(function () { return null; });
        if (!tabEl) return { ok: false, error: 'Client Preview tab not found' };
        tabEl.click();
        return { ok: true };
      }
    });
    var pr = previewResult && previewResult[0] && previewResult[0].result;
    if (pr && !pr.ok) throw new Error(pr.error || 'Could not open client preview');
    await delay(2000);

    // Step 3: Configure display settings
    log('Configuring display settings…');
    setStatus('Setting display…');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: async function () {
        function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        function waitFor(fn, ms) {
          return new Promise(function (res, rej) {
            var end = Date.now() + (ms || 5000);
            (function tick() { var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
          });
        }
        function removeTag(label) {
          var norm = label.trim().toLowerCase();
          var items = Array.from(document.querySelectorAll('.ant-select-selection-item'));
          var item = items.find(function (el) {
            var c = el.querySelector('.ant-select-selection-item-content');
            return c && c.textContent.trim().toLowerCase() === norm;
          });
          if (item) { var btn = item.querySelector('.ant-select-selection-item-remove'); if (btn) { btn.click(); return true; } }
          return false;
        }
        async function addOption(label) {
          var input = document.querySelector('#columnsToDisplay');
          if (!input) return;
          input.focus(); input.click();
          await delay(400);
          var node = await waitFor(function () {
            return Array.from(document.querySelectorAll('.ant-select-tree-node-content-wrapper')).find(function (n) {
              return (n.getAttribute('title') || n.textContent || '').trim().toLowerCase() === label.toLowerCase();
            });
          }, 4000).catch(function () { return null; });
          if (node) { node.click(); await delay(300); }
          document.body.click();
          await delay(200);
        }
        removeTag('Cost code');          await delay(200);
        removeTag('Parent group price'); await delay(200);
        removeTag('Unit price');         await delay(200);
        var existing = Array.from(document.querySelectorAll('.ant-select-selection-item-content')).map(function (el) { return el.textContent.trim().toLowerCase(); });
        if (!existing.includes('item title'))  await addOption('Item title');
        if (!existing.includes('description')) await addOption('Description');
      }
    });
    await delay(1000);

    // Step 4: Collapse all groups except Selection/Site Allowances
    log('Configuring groups…');
    setStatus('Configuring groups…');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: async function () {
        function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        var KEEP_EXPANDED = ['selection allowances', 'site allowances'];
        var expandedItems = Array.from(document.querySelectorAll('.ant-collapse-item.ProposalGroup.ant-collapse-item-active'));
        for (var i = 0; i < expandedItems.length; i++) {
          var nameEl = expandedItems[i].querySelector('h3.ant-typography');
          var name = nameEl ? nameEl.textContent.trim().toLowerCase() : '';
          var cleanName = name.replace(/\s*\(1\)\s*$/, '');
          var keep = KEEP_EXPANDED.some(function (k) { return cleanName === k; });
          if (!keep) { var header = expandedItems[i].querySelector('.ant-collapse-header'); if (header) { header.click(); await delay(200); } }
        }
        var allItems = Array.from(document.querySelectorAll('.ant-collapse-item.ProposalGroup'));
        for (var j = 0; j < allItems.length; j++) {
          var nameEl2 = allItems[j].querySelector('h3.ant-typography');
          var name2 = nameEl2 ? nameEl2.textContent.trim().toLowerCase() : '';
          var cleanName2 = name2.replace(/\s*\(1\)\s*$/, '');
          var shouldExpand = KEEP_EXPANDED.some(function (k) { return cleanName2 === k; });
          if (shouldExpand && !allItems[j].classList.contains('ant-collapse-item-active')) {
            var header2 = allItems[j].querySelector('.ant-collapse-header');
            if (header2) { header2.click(); await delay(200); }
          }
        }
      }
    });
    await delay(800);

    log('✓ Client preview setup complete');
    setStatus('Opening print dialog…');

    // ── Open print preview (suppress dialog via content.js flag) ────────────
    try {
      // Set flag so content.js overrides window.print on the new print tab,
      // leaving just the clean print preview visible without any dialog.
      await chrome.storage.session.set({ suppressNextPrint: true });

      log('Clicking "…" menu to open print options…');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: function () {
          var moreBtn = document.querySelector('[data-testid="JobProposalModalFooterRollup"]');
          if (moreBtn) moreBtn.click();
        }
      });
      await delay(600);

      log('Clicking Print — print preview tab will open…');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: function () {
          var printBtn = document.querySelector('[data-testid="printProposal"]');
          if (printBtn) printBtn.click();
        }
      });
      // Safety: clear flag after 10s in case no new tab was created
      setTimeout(function () {
        chrome.storage.session.remove('suppressNextPrint');
      }, 10000);

      statusEl.className = 'progress-status success';
      statusEl.textContent = '✓ Done — print preview tab opened. Use Ctrl+P / Save as PDF when ready.';
    } catch (pdfErr) {
      await chrome.storage.session.remove('suppressNextPrint');
      log('⚠ Print error: ' + pdfErr.message);
      statusEl.className = 'progress-status success';
      statusEl.textContent = '✓ Client preview ready. Use the "…" menu → Print to save as PDF.';
    }

    // ── dead code below kept for reference, never reached ───
    if (false) { var jobIdFromUrl = null;
      var proposalRes = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: function (urlJobId) {
          var jobId = urlJobId;
          if (!jobId) {
            var entries = performance.getEntriesByType('resource');
            for (var i = 0; i < entries.length; i++) {
              var m = entries[i].name.match(/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/);
              if (m) { jobId = m[1]; break; }
            }
          }
          if (!jobId) return { ok: false, error: 'jobId not found' };

          var xhr = new XMLHttpRequest();
          xhr.open('GET', '/apix/v2/Proposals/draft?jobId=' + jobId, false);
          xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
          xhr.setRequestHeader('portaltype', '1');
          try { xhr.send(); } catch(e) { return { ok: false, error: 'XHR send: ' + e.message }; }
          if (xhr.status !== 200) return { ok: false, error: 'GET ' + xhr.status };

          try {
            var draft = JSON.parse(xhr.responseText);
            var proposal = draft.proposal || draft || {};
            var ji = draft.jobInfo || {};

            var rawCats = proposal.formatItems || proposal.categories || draft.formatItems || [];
            var categories = rawCats.map(function (cat) {
              var rawItems = cat.items || cat.lineItems || [];
              return {
                name: cat.name || cat.groupName || '',
                description: cat.description || '',
                items: rawItems.map(function (it) {
                  return {
                    name: it.description || it.name || '',
                    qty: it.quantity != null ? it.quantity : (it.qty != null ? it.qty : ''),
                    unit: it.unitOfMeasure || it.unit || '',
                    price: it.totalOwnerPrice || it.totalOwnerCost || 0
                  };
                }),
                total: cat.totalOwnerPrice || cat.totalOwnerCost || 0
              };
            });

            // Job address — may be string or object
            var addr = ji.address || ji.jobAddress || ji.propertyAddress || '';
            if (addr && typeof addr === 'object') {
              addr = [addr.street || addr.streetAddress, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
            }

            return {
              ok: true,
              jobId: jobId,
              title: proposal.title || 'Preliminary Budget Estimate',
              jobName: ji.jobName || ji.name || '',
              jobAddress: addr,
              companyName: ji.companyName || 'Keel Custom Homes',
              categories: categories
            };
          } catch (e) {
            return { ok: false, error: 'parse: ' + e.message };
          }
        },
        args: [jobIdFromUrl]
      });

      var pd = proposalRes && proposalRes[0] && proposalRes[0].result;
      if (!pd || !pd.ok) {
        log('⚠ Proposal data fetch failed: ' + ((pd && pd.error) || 'unknown'));
        statusEl.className = 'progress-status success';
        statusEl.textContent = '✓ Client preview ready (PDF data fetch failed).';
      } else {
        log('Building PDF — ' + pd.categories.length + ' categories…');
        setStatus('Building PDF…');

        // 2. Build jsPDF text-based document
        var doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
        var pW = 612, pH = 792, mL = 50, mR = 50, mT = 55, mB = 55;
        var cW = pW - mL - mR;
        var y = mT;

        function newPage() { doc.addPage(); y = mT; }
        function chk(need) { if (y + need > pH - mB) newPage(); }
        function sp(n) { y += (n || 8); }
        function hr(g) {
          var c = (g != null ? g : 190);
          doc.setDrawColor(c, c, c);
          doc.setLineWidth(0.5);
          doc.line(mL, y, pW - mR, y);
          y += 5;
        }
        function txt(str, x, sz, style, rgb, maxW) {
          doc.setFontSize(sz || 10);
          doc.setFont('helvetica', style || 'normal');
          if (rgb) doc.setTextColor(rgb[0], rgb[1], rgb[2]);
          var lines = doc.splitTextToSize(String(str || ''), maxW || (pW - mR - (x || mL)));
          for (var i = 0; i < lines.length; i++) {
            chk((sz || 10) * 1.45);
            doc.text(lines[i], x || mL, y);
            y += (sz || 10) * 1.45;
          }
          if (rgb) doc.setTextColor(0, 0, 0);
        }
        function fmtMoney(n) {
          if (!n && n !== 0) return '';
          return '$' + parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        // ── Header ──────────────────────────────────────────
        // Gold box logo top-left
        doc.setFillColor(232, 184, 75);
        doc.rect(mL, mT - 4, 40, 40, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(26, 26, 46);
        doc.text('KEEL', mL + 20, mT + 12, { align: 'center' });
        doc.setFontSize(7);
        doc.setFont('helvetica', 'normal');
        doc.text('custom homes', mL + 20, mT + 22, { align: 'center' });
        doc.setTextColor(0, 0, 0);

        // Company info top-right
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(26, 26, 46);
        doc.text(pd.companyName || 'Keel Custom Homes', pW - mR, mT + 4, { align: 'right' });
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(90, 90, 90);
        doc.text('2128 Staples Mill Rd Suite 200', pW - mR, mT + 16, { align: 'right' });
        doc.text('Richmond, VA 23230', pW - mR, mT + 27, { align: 'right' });
        doc.text('804-206-9280', pW - mR, mT + 38, { align: 'right' });
        doc.setTextColor(0, 0, 0);

        y = mT + 52;
        hr(200);
        sp(6);

        // Job address
        if (pd.jobAddress || pd.jobName) {
          doc.setFontSize(8);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(100, 100, 100);
          doc.text('Job Address', mL, y); y += 11;
          doc.setTextColor(0, 0, 0);
          doc.setFontSize(10);
          doc.setFont('helvetica', 'bold');
          if (pd.jobName) { doc.text(pd.jobName, mL, y); y += 13; }
          doc.setFont('helvetica', 'normal');
          if (pd.jobAddress) { doc.text(pd.jobAddress, mL, y); y += 13; }
          sp(6);
        }

        // Title
        doc.setFontSize(17);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(26, 26, 46);
        chk(24);
        doc.text(pd.title || 'Preliminary Budget Estimate', mL, y); y += 24;
        doc.setTextColor(0, 0, 0);

        // Disclaimer
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(100, 100, 100);
        var discLines = doc.splitTextToSize('This is a preliminary estimate for budgeting purposes only — not a contract or binding price.', cW);
        discLines.forEach(function (l) { chk(12); doc.text(l, mL, y); y += 12; });
        doc.setTextColor(0, 0, 0);
        sp(14);

        // ── Budget Range Box ─────────────────────────────────
        if (grandTotal > 0) {
          var lowFmt2  = '$' + Math.round(grandTotal * 0.99).toLocaleString('en-US');
          var highFmt2 = '$' + Math.round(grandTotal * 1.10).toLocaleString('en-US');
          var bxW = 260, bxH = 58, bxX = mL + (cW - bxW) / 2;
          chk(bxH + 16);
          doc.setFillColor(248, 248, 248);
          doc.setDrawColor(200, 200, 200);
          doc.setLineWidth(0.75);
          doc.rect(bxX, y, bxW, bxH, 'FD');
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(7.5);
          doc.setTextColor(80, 80, 80);
          doc.text('ESTIMATED BUDGET RANGE', bxX + bxW / 2, y + 15, { align: 'center' });
          doc.setFontSize(19);
          doc.setTextColor(26, 26, 46);
          doc.text(lowFmt2 + ' – ' + highFmt2, bxX + bxW / 2, y + 44, { align: 'center' });
          doc.setTextColor(0, 0, 0);
          y += bxH + 16;
        }
        sp(8);

        // ── What's Included ──────────────────────────────────
        chk(40);
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(26, 26, 46);
        doc.text("WHAT'S INCLUDED IN YOUR ESTIMATE", mL, y); y += 15;
        doc.setTextColor(0, 0, 0);
        hr(210);

        var included = [
          ['Design & Pre-Construction', 'Complete architectural plans, engineering, permits, surveys, and inspections'],
          ['Foundation', 'Standard footings, walls, waterproofing, and backfill'],
          ['Framing & Structure', 'Full framing package including lumber, trusses, engineered joists, and stairs'],
          ['Exterior Envelope', 'Siding exterior with architectural shingle roofing, gutters, and all exterior trim'],
          ['Mechanical Systems', 'Complete HVAC, plumbing rough & finish, and electrical rough & finish'],
          ['Insulation & Drywall', 'Full insulation to code, drywall, and interior/exterior paint'],
          ['Interior Finishes', 'Interior doors, trim, hardware, and custom carpentry allowance'],
          ['Site Work', 'Site clearing, grading, driveway, and all utilities including municipal tap fees'],
          ['Decks / Porches', 'Porches and decks finished per spec']
        ];
        var colLabelW = 155;
        included.forEach(function (row) {
          chk(13);
          doc.setFontSize(8.5);
          doc.setFont('helvetica', 'bold');
          doc.text(row[0], mL, y);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(60, 60, 60);
          var dLines = doc.splitTextToSize(row[1], cW - colLabelW);
          dLines.forEach(function (dl, di) {
            chk(13);
            if (di > 0) y += 12;
            doc.text(dl, mL + colLabelW, y);
          });
          doc.setTextColor(0, 0, 0);
          y += 13;
          hr(225);
        });
        sp(14);

        // ── Category Tables ──────────────────────────────────
        var colW = [148, 196, 68, 100]; // Item | Description | Qty/Unit | Price  (sum=512)
        pd.categories.forEach(function (cat) {
          chk(36);
          // Category heading
          doc.setFontSize(11);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(26, 26, 46);
          doc.text(cat.name || '', mL, y); y += 15;
          doc.setTextColor(0, 0, 0);

          if (cat.description) {
            doc.setFontSize(8);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(90, 90, 90);
            var dL = doc.splitTextToSize(cat.description, cW);
            dL.forEach(function (l) { chk(11); doc.text(l, mL, y); y += 11; });
            doc.setTextColor(0, 0, 0);
            sp(3);
          }

          if (cat.items && cat.items.length > 0) {
            // Table header row
            chk(20);
            doc.setFillColor(230, 232, 237);
            doc.rect(mL, y - 10, cW, 16, 'F');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(7.5);
            doc.setTextColor(40, 40, 40);
            var hx = mL;
            ['Item', 'Description', 'Qty / Unit', 'Price'].forEach(function (h, hi) {
              if (hi === 3) {
                doc.text(h, hx + colW[hi] - 4, y, { align: 'right' });
              } else {
                doc.text(h, hx + 3, y);
              }
              hx += colW[hi];
            });
            y += 6;
            doc.setDrawColor(210, 212, 218);
            doc.setLineWidth(0.3);
            doc.line(mL, y, mL + cW, y);
            y += 4;

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            cat.items.forEach(function (item, ii) {
              var nameLines = doc.splitTextToSize(item.name || '', colW[0] - 6);
              var descLines = doc.splitTextToSize(item.description || '', colW[1] - 6);
              var maxL = Math.max(nameLines.length, descLines.length, 1);
              var rowH = Math.max(14, maxL * 11 + 4);
              chk(rowH);

              if (ii % 2 === 0) {
                doc.setFillColor(250, 251, 253);
                doc.rect(mL, y - 10, cW, rowH, 'F');
              }

              doc.setTextColor(30, 30, 30);
              var rx = mL;
              nameLines.forEach(function (l, li) { doc.text(l, rx + 3, y + li * 11); });
              rx += colW[0];
              descLines.forEach(function (l, li) { doc.text(l, rx + 3, y + li * 11); });
              rx += colW[1];
              var qtyStr = (item.qty !== '' && item.qty != null ? item.qty : '') + (item.unit ? ' ' + item.unit : '');
              doc.text(qtyStr.trim(), rx + 3, y);
              rx += colW[2];
              doc.text(fmtMoney(item.price), rx + colW[3] - 4, y, { align: 'right' });

              y += rowH;
              doc.setDrawColor(220, 222, 226);
              doc.line(mL, y - rowH + 2, mL + cW, y - rowH + 2);
            });

            // Category total row
            chk(18);
            doc.setFillColor(238, 240, 244);
            doc.rect(mL, y - 10, cW, 18, 'F');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8.5);
            doc.text('Category Total', mL + 3, y);
            if (cat.total) doc.text(fmtMoney(cat.total), mL + cW - 4, y, { align: 'right' });
            doc.setFont('helvetica', 'normal');
            y += 10;

          } else {
            // No items — just show total aligned right on same line as name
            if (cat.total) {
              doc.setFontSize(8.5);
              doc.setFont('helvetica', 'bold');
              doc.text(fmtMoney(cat.total), mL + cW, y - 12, { align: 'right' });
              doc.setFont('helvetica', 'normal');
            }
          }

          sp(12);
          hr(215);
          sp(10);
        });

        // ── Grand Total ──────────────────────────────────────
        if (grandTotal > 0) {
          chk(30);
          doc.setFontSize(12);
          doc.setFont('helvetica', 'bold');
          doc.text('Total price:', mL, y);
          doc.text(fmtMoney(grandTotal), pW - mR, y, { align: 'right' });
          y += 20;
          hr(180);
          sp(16);
        }

        // ── Budget Pricing Summary ───────────────────────────
        chk(36);
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(26, 26, 46);
        doc.text('BUDGET PRICING SUMMARY', mL, y); y += 16;
        doc.setTextColor(0, 0, 0);
        hr();
        sp(4);

        [
          'The pricing shown in this proposal represents the initial contract amount for Milestone 1 and is based on the information available at this stage of the project. Because detailed selections and final site confirmations have not yet been completed, this is not the final contract price.',
          'This budget is intended to establish feasibility, provide direction, and support loan preapproval. As plans are finalized, site conditions are verified, and selections are made, the contract pricing will be refined to reflect the specific scope and investment of your home.',
          'Any adjustments resulting from confirmed site conditions, completed selections, or requested upgrades will be clearly communicated as information becomes available.'
        ].forEach(function (p) {
          doc.setFontSize(9);
          doc.setFont('helvetica', 'normal');
          doc.splitTextToSize(p, cW).forEach(function (l) { chk(13); doc.text(l, mL, y); y += 13; });
          sp(7);
        });

        // ── Allowance Structure ──────────────────────────────
        chk(36);
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(26, 26, 46);
        doc.text('ALLOWANCE STRUCTURE & BUDGET ASSUMPTIONS', mL, y); y += 16;
        doc.setTextColor(0, 0, 0);
        hr();
        sp(4);

        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        chk(14); doc.text('Allowances', mL, y); y += 14;
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.splitTextToSize('This budget includes allowances for major finish categories. These are placeholder amounts intended to provide a realistic starting point and do not reflect specific brands, products, or final selections at this stage. Final costs will be determined once selections are completed.', cW).forEach(function (l) { chk(13); doc.text(l, mL, y); y += 13; });
        sp(5);
        ['If selections exceed the allowance, the difference will be added to the project cost.', 'If selections come in under the allowance, a credit will be applied.'].forEach(function (b) {
          chk(13); doc.text('•  ' + b, mL + 8, y); y += 13;
        });
        sp(10);

        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        chk(14); doc.text('Budget Assumptions', mL, y); y += 14;
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.splitTextToSize('This budget is based on the following standard residential construction assumptions. If any of these conditions differ, adjustments to cost, design, or schedule may be required.', cW).forEach(function (l) { chk(13); doc.text(l, mL, y); y += 13; });
        sp(8);

        var assumptions = [
          { title: 'Lot & Approvals', bullets: ['The lot is legally buildable and compliant with zoning, setbacks, easements, floodplain, and municipal requirements.', 'No rezoning, variances, special use permits, or additional jurisdictional approvals are required.', 'No unusual HOA or architectural review requirements beyond typical residential standards.'] },
          { title: 'Site & Soil Conditions', bullets: ['Standard soil conditions suitable for typical residential foundation construction.', 'No rock excavation, blasting, or unsuitable soils requiring remediation.', 'Standard foundation type as reflected in current plans.', 'No unanticipated environmental conditions, including wetlands or protected areas.'] },
          { title: 'Utilities & Infrastructure', bullets: ['Standard utility access is available at the home site.', 'No off-site utility extensions or upgrades are required.', 'No extraordinary stormwater management requirements beyond typical residential construction.'] },
          { title: 'Construction Conditions', bullets: ['No unusual site constraints affecting access, staging, or logistics.', 'No material shortages or trade disruptions beyond normal market conditions.', 'Plans provided are accurate and complete for this phase of pricing.'] }
        ];
        assumptions.forEach(function (sec) {
          chk(26);
          doc.setFontSize(9.5);
          doc.setFont('helvetica', 'bold');
          doc.text(sec.title, mL, y); y += 13;
          doc.setFontSize(9);
          doc.setFont('helvetica', 'normal');
          sec.bullets.forEach(function (b) {
            var bLines = doc.splitTextToSize('•  ' + b, cW - 10);
            bLines.forEach(function (bl, bi) {
              chk(13);
              doc.text(bi === 0 ? bl : '    ' + bl.trimLeft(), mL + 8, y);
              y += 13;
            });
          });
          sp(5);
        });
        doc.setFontSize(9);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(90, 90, 90);
        chk(13);
        doc.text('If any of these assumptions prove to be inaccurate, additional costs may be incurred.', mL, y); y += 14;
        doc.setTextColor(0, 0, 0);
        doc.setFont('helvetica', 'normal');
        sp(10);

        // ── Items Not Included ───────────────────────────────
        chk(36);
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(26, 26, 46);
        doc.text('ITEMS NOT INCLUDED IN THIS BUDGET', mL, y); y += 16;
        doc.setTextColor(0, 0, 0);
        hr();
        sp(4);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.text('Unless specifically noted elsewhere in the proposal, the following items are not included:', mL, y); y += 14;
        [
          "Building permits and government fees beyond the municipality's building permit",
          'Utility provider fees and service connection charges',
          'Well and septic systems (refer to allowances, if applicable)',
          'Landscaping beyond minimum stabilization',
          'Off-site improvements or upgrades required by local authorities'
        ].forEach(function (b) { chk(13); doc.text('•  ' + b, mL + 8, y); y += 13; });
        sp(5);
        doc.splitTextToSize('Depending on the lot, jurisdiction, or lender requirements, these items may be required and are often paid directly by the homeowner or financed separately.', cW).forEach(function (l) { chk(13); doc.text(l, mL, y); y += 13; });
        sp(14);

        // ── What Comes Next ──────────────────────────────────
        chk(36);
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(26, 26, 46);
        doc.text('WHAT COMES NEXT', mL, y); y += 16;
        doc.setTextColor(0, 0, 0);
        hr();
        sp(4);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.splitTextToSize('Milestone 2 is where your home begins to take shape. During this phase, we align your site, structural decisions, and exterior selections to significantly reduce pricing uncertainty and move toward a refined price range.', cW).forEach(function (l) { chk(13); doc.text(l, mL, y); y += 13; });
        sp(8);

        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(19, 61, 89);
        chk(14); doc.text('Milestone 2 — Site, Design, and Structural Alignment', mL, y); y += 14;
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        chk(13); doc.text('Purpose: Lock in the size, structure, and exterior of your home to reduce uncertainty and bring greater clarity to pricing.', mL, y); y += 14;
        sp(6);

        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(19, 61, 89);
        chk(14); doc.text('During This Phase — You Provide', mL, y); y += 14;
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        ['Final approval of plan layout and square footage.', 'Exterior selections including roof, windows, siding, doors, and related finishes.', 'Completed site design including house location, driveway layout, clearing, and utilities.'].forEach(function (b) { chk(13); doc.text('•  ' + b, mL + 8, y); y += 13; });
        sp(6);

        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(19, 61, 89);
        chk(14); doc.text('Keel Provides:', mL, y); y += 14;
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        ['"Bid Set" floor plans.', 'Defined structural system.', 'Exterior and site selections priced.', 'A refined price range.'].forEach(function (b) { chk(13); doc.text('•  ' + b, mL + 8, y); y += 13; });
        sp(20);

        // ── Footer rule ──────────────────────────────────────
        chk(24);
        hr(200);
        sp(6);
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(130, 130, 130);
        doc.text('Keel Custom Homes  •  Preliminary Budget Estimate  •  Confidential', pW / 2, y, { align: 'center' });
        doc.setTextColor(0, 0, 0);

        var pdfDataUri = doc.output('datauristring');
        await chrome.storage.session.set({ pendingProposalPdf: pdfDataUri });
        chrome.runtime.sendMessage({ action: 'NOTIFY_PDF_READY' });
        log('✓ PDF ready (' + doc.getNumberOfPages() + ' pages) — click "Open Proposal as PDF" on the webpage');
        statusEl.className = 'progress-status success';
        statusEl.textContent = '✓ Done — click "Open Proposal as PDF" on the webpage.';
      }
    } // end if(false) dead block

  } catch (e) {
    log('ERROR: ' + e.message);
    statusEl.className = 'progress-status error';
    statusEl.textContent = 'Failed: ' + e.message;
  }
}
