// panel-controls.js — zoom + pin controls for the floating panel
// Must be an external file — Manifest V3 blocks all inline scripts

(function () {
  // ── Zoom ───────────────────────────────────────────────────────────────────
  const ZOOM_STEPS = [60, 70, 80, 90, 100, 110, 125];
  let zoomIdx = 4;
  const zoomLabel = document.getElementById('zoom-label');

  function applyZoom() {
    const pct = ZOOM_STEPS[zoomIdx];
    document.body.style.zoom = pct + '%';
    if (zoomLabel) zoomLabel.textContent = pct + '%';
    chrome.storage.local.set({ panelZoom: zoomIdx });
  }

  const btnZoomOut = document.getElementById('btn-zoom-out');
  const btnZoomIn  = document.getElementById('btn-zoom-in');
  if (btnZoomOut) btnZoomOut.addEventListener('click', () => { if (zoomIdx > 0) { zoomIdx--; applyZoom(); } });
  if (btnZoomIn)  btnZoomIn.addEventListener('click',  () => { if (zoomIdx < ZOOM_STEPS.length - 1) { zoomIdx++; applyZoom(); } });

  // ── Pin / Always-on-Top ────────────────────────────────────────────────────
  let pinned = false;
  const pinBtn    = document.getElementById('btn-pin');
  const headerSub = document.getElementById('header-sub');

  function doPin() {
    pinned = !pinned;
    if (pinBtn)    pinBtn.classList.toggle('active', pinned);
    if (pinBtn)    pinBtn.title = pinned ? 'Pinned — click to unpin' : 'Pin: keep on top';
    if (headerSub) headerSub.textContent = pinned
      ? '📌 Pinned on top  •  Corner to resize'
      : 'Drag to move  •  Corner to resize';
    chrome.storage.local.set({ panelPinned: pinned });
    chrome.runtime.sendMessage({ action: 'SET_ALWAYS_ON_TOP', alwaysOnTop: pinned });
  }

  if (pinBtn) pinBtn.addEventListener('click', doPin);

  // ── Restore saved state ────────────────────────────────────────────────────
  chrome.storage.local.get(['panelZoom', 'panelPinned'], ({ panelZoom, panelPinned }) => {
    if (panelZoom !== undefined) { zoomIdx = panelZoom; applyZoom(); }
    if (panelPinned) { pinned = false; doPin(); }
  });

  // ── Static Write-to-Estimate: Calculator ──────────────────────────────────
  (function() {
    var CALC_STORAGE_KEY = 'tkCalcHistory';
    var EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
    var calcHistory = [];

    var calcInput  = document.getElementById('ext-calc-input');
    var calcResult = document.getElementById('ext-calc-result');
    var histBtn    = document.getElementById('ext-calc-history-btn');
    var histDrop   = document.getElementById('ext-calc-history-drop');
    if (!calcInput) return;

    function parseMath(str) {
      var s = str.replace(/^\s*=\s*/, '').trim();
      var pos = 0;
      function ws()  { while (pos < s.length && s[pos] === ' ') pos++; }
      function parseExpr()   { return parseAddSub(); }
      function parseAddSub() {
        var v = parseMulDiv(); ws();
        while (pos < s.length && (s[pos] === '+' || s[pos] === '-')) {
          var op = s[pos++]; v = op === '+' ? v + parseMulDiv() : v - parseMulDiv(); ws();
        }
        return v;
      }
      function parseMulDiv() {
        var v = parsePow(); ws();
        while (pos < s.length && (s[pos] === '*' || s[pos] === '/' || s[pos] === '%')) {
          var op = s[pos++]; var r = parsePow();
          v = op === '*' ? v * r : op === '/' ? v / r : v % r; ws();
        }
        return v;
      }
      function parsePow() {
        var v = parseUnary(); ws();
        if (pos < s.length && s[pos] === '^') { pos++; v = Math.pow(v, parseUnary()); }
        return v;
      }
      function parseUnary() {
        ws();
        if (pos < s.length && s[pos] === '-') { pos++; return -parseAtom(); }
        if (pos < s.length && s[pos] === '+') { pos++; return parseAtom(); }
        return parseAtom();
      }
      function parseAtom() {
        ws();
        if (pos < s.length && s[pos] === '(') {
          pos++; var v = parseExpr(); ws();
          if (pos < s.length && s[pos] === ')') pos++;
          return v;
        }
        var fnMatch = s.slice(pos).match(/^([A-Za-z_]\w*)\s*\(/);
        if (fnMatch) {
          var fname = fnMatch[1].toUpperCase(); pos += fnMatch[0].length;
          var args = []; ws();
          if (pos < s.length && s[pos] !== ')') {
            args.push(parseExpr()); ws();
            while (pos < s.length && (s[pos] === ',' || s[pos] === ';')) { pos++; args.push(parseExpr()); ws(); }
          }
          if (pos < s.length && s[pos] === ')') pos++;
          switch (fname) {
            case 'SQRT': return Math.sqrt(args[0]);
            case 'ABS':  return Math.abs(args[0]);
            case 'ROUND': return Math.round((args[0]||0) * Math.pow(10, args[1]||0)) / Math.pow(10, args[1]||0);
            case 'INT':  return Math.trunc(args[0]);
            case 'MAX':  return Math.max.apply(null, args);
            case 'MIN':  return Math.min.apply(null, args);
            case 'SUM':  return args.reduce(function(a,b){return a+b;}, 0);
            case 'PI':   return Math.PI;
            default: throw new Error('Unknown function: ' + fname);
          }
        }
        var numRe = s.slice(pos).match(/^[0-9]*\.?[0-9]+/);
        if (numRe) { pos += numRe[0].length; return parseFloat(numRe[0]); }
        throw new Error('Unexpected: ' + (s[pos] || 'end'));
      }
      var result = parseExpr(); ws();
      if (pos < s.length) throw new Error('Unexpected: ' + s[pos]);
      if (!isFinite(result)) throw new Error('Result is not finite');
      return result;
    }

    function tryEval(expr) {
      if (!expr || !expr.trim()) return null;
      try { return parseMath(expr); } catch(e) { return null; }
    }

    function saveHistory() { chrome.storage.local.set({ tkCalcHistory: calcHistory }); }

    function loadHistory(cb) {
      chrome.storage.local.get(CALC_STORAGE_KEY, function(res) {
        var now = Date.now();
        var stored = res[CALC_STORAGE_KEY] || [];
        calcHistory = stored.filter(function(h) { return (now - (h.ts || 0)) < EIGHT_HOURS_MS; });
        if (cb) cb();
      });
    }

    function commitCalc() {
      var expr = (calcInput.value || '').trim().replace(/^\s*=\s*/, '');
      if (!expr) return;
      var val = tryEval(expr);
      if (val === null) return;
      var rounded = Math.round(val * 10000) / 10000;
      if (calcHistory.length && calcHistory[0].expr === expr && calcHistory[0].val === rounded) return;
      calcHistory.unshift({ expr: expr, val: rounded, ts: Date.now() });
      if (calcHistory.length > 10) calcHistory.pop();
      saveHistory();
      renderHistory();
    }

    function updateLiveResult() {
      var expr = (calcInput.value || '').trim();
      if (!expr) { calcResult.textContent = ''; return; }
      var val = tryEval(expr);
      if (val !== null) {
        calcResult.textContent = '= ' + (Math.round(val * 10000) / 10000);
        calcResult.style.color = '#0f172a';
        calcResult.style.fontWeight = '700';
      } else {
        calcResult.textContent = '';
      }
    }

    function renderHistory() {
      if (!histDrop) return;
      histDrop.innerHTML = '';
      if (!calcHistory.length) {
        histDrop.innerHTML = '<div style="padding:6px 12px;font-size:11px;color:#94a3b8;">No history in the last 8 hours</div>';
        return;
      }
      calcHistory.forEach(function(h) {
        var item = document.createElement('div');
        item.style.cssText = 'padding:5px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        item.innerHTML = h.expr + ' = <b>' + h.val + '</b>';
        item.addEventListener('mouseenter', function(){ item.style.background = '#f0f9ff'; });
        item.addEventListener('mouseleave', function(){ item.style.background = ''; });
        item.addEventListener('click', function() {
          calcInput.value = String(h.val);
          updateLiveResult();
          histDrop.style.display = 'none';
        });
        histDrop.appendChild(item);
      });
    }

    loadHistory(function() {});

    calcInput.addEventListener('input', updateLiveResult);
    calcInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); commitCalc(); }
    });
    calcInput.addEventListener('blur', commitCalc);

    if (histBtn) histBtn.addEventListener('click', function() {
      renderHistory();
      histDrop.style.display = histDrop.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', function(e) {
      if (histDrop && !histDrop.contains(e.target) && e.target !== histBtn) {
        histDrop.style.display = 'none';
      }
    }, { capture: true });
  })();

  // ── Static Write-to-Estimate: Add custom row button ───────────────────────
  const addCustomRowBtn = document.getElementById('ext-add-custom-row');
  if (addCustomRowBtn) {
    addCustomRowBtn.addEventListener('click', function() {
      const rowsEl = document.getElementById('ext-custom-rows');
      if (!rowsEl) return;
      const row = document.createElement('div');
      row.className = 'ext-custom-row';
      row.style.cssText = 'display:flex;gap:5px;margin-bottom:4px;';
      row.innerHTML = '<input class="ext-custom-name" type="text" placeholder="Item name…" style="flex:2;font-size:12px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;outline:none;">' +
        '<span style="line-height:28px;color:#64748b;font-size:12px;">$</span>' +
        '<input class="ext-custom-price" type="number" placeholder="0.00" min="0" step="0.01" style="flex:1;font-size:12px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;outline:none;">';
      rowsEl.appendChild(row);
    });
  }
})();
