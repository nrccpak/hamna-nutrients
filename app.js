'use strict';
/* Hamna's Nutrient Tracker - Phase 3 PWA. Numbers come only from the Google Sheet via the Apps Script API. */
var DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbxTX0PWCCAwk1NRTnhXqTewbFGAsvKEe23oWuhm5VEkgrpbA4iF7Z8BnFgNMOKjHY2V/exec';
var ALERT = ['protein', 'fiber', 'iron', 'calcium', 'vitD', 'b12', 'folate'];
var NINE = ['protein', 'carbs', 'fat', 'fiber', 'iron', 'calcium', 'vitD', 'b12', 'folate'];

function store(k, v) {
  try { if (v === undefined) { return localStorage.getItem(k); } if (v === null) { localStorage.removeItem(k); } else { localStorage.setItem(k, v); } } catch (e) { return null; }
  return null;
}
var S = { screen: 'today', cfg: null, day: null, meal: null, cart: [], q: '', preview: null, busy: false, err: '', text: '', unmatched: [], parsing: false, rec: null };

/* ---------- tiny DOM helper (text only, no innerHTML) ---------- */
function h(tag, attrs) {
  var e = document.createElement(tag);
  for (var k in (attrs || {})) {
    var v = attrs[k];
    if (k === 'class') { e.className = v; } else if (k === 'style') { e.setAttribute('style', v); }
    else if (k.slice(0, 2) === 'on') { e.addEventListener(k.slice(2), v); }
    else if (v !== false && v != null) { e.setAttribute(k, v === true ? '' : v); }
  }
  for (var i = 2; i < arguments.length; i++) { add(e, arguments[i]); }
  return e;
}
function add(e, c) {
  if (c == null || c === false) { return; }
  if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
  e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
}
function toast(msg) {
  var t = document.getElementById('toast'); t.textContent = msg; t.className = 'show';
  clearTimeout(toast.t); toast.t = setTimeout(function () { t.className = ''; }, 2600);
}

/* ---------- API ---------- */
function creds() { return { url: store('hna_url') || DEFAULT_URL, key: store('hna_key') || '' }; }
function api(action, body) {
  var c = creds();
  if (!c.key) { return Promise.reject(new Error('Not connected yet. Open Profile and enter the access key.')); }
  var payload = Object.assign({ key: c.key, action: action }, body || {});
  return fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) })
    .then(function (r) { return r.text(); })
    .then(function (t) {
      var j; try { j = JSON.parse(t); } catch (e) { throw new Error('Could not reach the server. Check your internet.'); }
      if (!j.ok) { throw new Error(j.error === 'unauthorized' ? 'Wrong access key. Check Profile.' : (j.error || 'Server error')); }
      return j.data;
    }, function () { throw new Error('No internet connection.'); });
}

/* ---------- formatting ---------- */
function fmt(k, v) {
  var u = (S.cfg && S.cfg.units && S.cfg.units[k]) || '';
  var n = (k === 'iron' || k === 'b12' || k === 'fiber' || k === 'protein' || k === 'carbs' || k === 'fat') ? Math.round(v * 10) / 10 : Math.round(v);
  return n + (k === 'kcal' ? ' kcal' : ' ' + u);
}
function ql(qty, measure) {
  if (measure === 'g') { return qty + ' g'; }
  var m = /^(\d+(?:\.\d+)?)[\s-]+(.*)$/.exec(measure);
  if (m) { var n = Math.round(qty * parseFloat(m[1]) * 100) / 100; return n + ' ' + m[2] + (n === 1 ? '' : (/s$|\)$/.test(m[2]) ? '' : 's')); }
  return qty + ' × ' + measure;
}
function pct(k, total) { var t = S.cfg.targets[k]; return t ? Math.round(total / t * 100) : 0; }
function label(k) { return (S.cfg.labels && S.cfg.labels[k]) || k; }
function niceDate(iso) {
  var p = iso.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function defaultMeal() { var hr = new Date().getHours(); return hr < 11 ? 'Breakfast' : hr < 16 ? 'Lunch' : hr < 19 ? 'Snack' : 'Dinner'; }
function bar(p, cls, before) {
  var w = Math.min(p, 100);
  return h('div', { class: 'track' },
    h('div', { class: 'fill ' + (cls || ''), style: 'width:' + w + '%' }),
    before != null ? h('div', { class: 'fill before', style: 'width:' + Math.min(before, 100) + '%' }) : null);
}

/* ---------- suggestions: 1-2 foods that fit the calories left and fill today's biggest gaps ---------- */
function lowKeys(d) { return d.low.map(function (l) { return l.key; }); }
function portion(f, m, qty) {
  var g = m.grams * qty, n = {};
  Object.keys(f.per100).forEach(function (k) { n[k] = f.per100[k] * g / 100; });
  return { food: f, m: m, qty: qty, grams: g, n: n };
}
function ideas(day, limit) {
  var lows = lowKeys(day);
  if (!lows.length) { return []; }
  var T = S.cfg.targets, left = Math.max(day.kcal_left, 0), budget = Math.max(Math.min(left, 650), 150);
  var need = {}; lows.forEach(function (k) { need[k] = Math.max(0, 100 - day.pct[k]); });
  var singles = [];
  S.cfg.foods.forEach(function (f) {
    var m = f.measures[0]; if (!m || f.category === 'Raw ingredient') { return; }
    [1, 2].forEach(function (q) {
      var p = portion(f, m, q);
      if (p.n.kcal > budget || (q === 2 && p.n.kcal / 2 > 160)) { return; }
      singles.push(p);
    });
  });
  function score(parts) {
    var gain = {}, s = 0, kc = 0, tot = {};
    parts.forEach(function (p) { Object.keys(p.n).forEach(function (k) { tot[k] = (tot[k] || 0) + p.n[k]; }); kc += p.n.kcal; });
    lows.forEach(function (k) { var g = (tot[k] || 0) / T[k] * 100; if (g >= 5) { gain[k] = Math.round(Math.min(g, need[k])); s += Math.min(g, need[k]); } });
    ['fat', 'carbs'].forEach(function (k) { var over = (day.totals[k] + (tot[k] || 0)) / T[k] * 100 - 105; if (over > 0) { s -= over * 0.5; } });
    if (kc > left) { s -= (kc - left) * 0.1; }
    s -= kc * 0.02;
    ALERT.forEach(function (k) { if ((day.totals[k] + (tot[k] || 0)) / T[k] * 100 > 250) { s -= 15; } });
    if (parts.some(function (p) { return p.food.confidence === 'L'; })) { s -= 2; }
    return { s: s, gain: gain, kcal: Math.round(kc), tot: tot };
  }
  var cands = singles.map(function (p) { var r = score([p]); return { parts: [p], sc: r }; })
    .filter(function (c) { return Object.keys(c.sc.gain).length; })
    .sort(function (a, b) { return b.sc.s - a.sc.s; });
  var top = cands.slice(0, 14), out = top.slice();
  for (var i = 0; i < top.length; i++) {
    for (var j = i + 1; j < top.length; j++) {
      var A = top[i].parts[0], B = top[j].parts[0];
      if (A.food.id === B.food.id || A.food.category === B.food.category || A.qty > 1 || B.qty > 1) { continue; }
      var r = score([A, B]);
      if (r.kcal <= budget && r.s > Math.max(top[i].sc.s, top[j].sc.s) + 8) { out.push({ parts: [A, B], sc: r }); }
    }
  }
  out.sort(function (a, b) { return b.sc.s - a.sc.s; });
  var used = {}, res = [];
  out.forEach(function (c) {
    if (res.length >= limit) { return; }
    if (c.parts.some(function (p) { return used[p.food.id]; })) { return; }
    c.parts.forEach(function (p) { used[p.food.id] = 1; });
    res.push(c);
  });
  return res;
}
function shortName(f) { return f.name.replace(/\s*\(.*\)/, ''); }
function partTitle(p) {
  var nm = shortName(p.food), first = nm.split(/[\s,]/)[0].toLowerCase();
  if (p.m.measure.toLowerCase().indexOf(first) >= 0) { return p.qty === 1 ? nm : p.qty + ' × ' + nm; }
  return ql(p.qty, p.m.measure) + ' ' + nm;
}
function ideaTitle(c) { return c.parts.map(partTitle).join(' + '); }
function ideaGain(c, max) { return Object.keys(c.sc.gain).sort(function (x, y) { return c.sc.gain[y] - c.sc.gain[x]; }).slice(0, max || 9).map(function (k) { return '+' + c.sc.gain[k] + '% ' + label(k).toLowerCase(); }).join(', '); }
function showIdea(c) {
  var d = S.day, sheet = h('div', { class: 'sheet', onclick: function (e) { if (e.target === sheet) { sheet.remove(); } } });
  var box = h('div', null, h('h2', null, ideaTitle(c)), h('div', { class: 'sub' }, 'About ' + c.sc.kcal + ' kcal. Here is how your day would end if you eat this.'));
  ['kcal'].concat(NINE).forEach(function (k) {
    var before = d.pct[k], after = pct(k, d.totals[k] + (c.sc.tot[k] || 0));
    box.appendChild(h('div', { style: 'display:flex;flex-direction:column;gap:4px' },
      h('div', { class: 'row' }, h('span', { class: 'n' }, k === 'kcal' ? 'Calories' : label(k)), h('span', { class: 'v' }, before + '% → ' + after + '%')),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + Math.min(after, 100) + '%' }), h('div', { class: 'fill before', style: 'width:' + Math.min(before, 100) + '%' }))));
  });
  box.appendChild(h('button', { class: 'btn', type: 'button', onclick: function () {
    c.parts.forEach(function (p) { S.cart.push({ food_id: p.food.id, name: p.food.name, qty: p.qty, measure: p.m.measure }); });
    S.meal = defaultMeal(); sheet.remove(); toast('Added to your ' + S.meal.toLowerCase() + '. Review, then save.'); go('log');
  } }, 'Add to my ' + defaultMeal().toLowerCase()));
  box.appendChild(h('button', { class: 'btn alt', type: 'button', onclick: function () { sheet.remove(); } }, 'Close'));
  sheet.appendChild(box); document.body.appendChild(sheet);
}

/* ---------- data loading ---------- */
function loadAll() {
  S.busy = true; S.err = ''; render();
  return api('config').then(function (cfg) {
    S.cfg = cfg; store('hna_cfg', JSON.stringify(cfg));
    return api('day', { date: cfg.today });
  }).then(function (d) { S.day = d; S.busy = false; render(); })
    .catch(function (e) {
      S.busy = false; S.err = e.message;
      try { S.cfg = S.cfg || JSON.parse(store('hna_cfg')); } catch (x) { /* ignore */ }
      render();
    });
}
function reloadDay() {
  return api('day', { date: S.cfg.today }).then(function (d) { S.day = d; });
}

/* ---------- screens ---------- */
function errBox() { return S.err ? h('div', { class: 'err' }, S.err, ' ', h('button', { class: 'chip', type: 'button', onclick: loadAll }, 'Retry')) : null; }

function screenToday() {
  var d = S.day, c = S.cfg;
  var out = [h('div', { class: 'row', style: 'align-items:flex-end' },
    h('div', null, h('div', { class: 'sub' }, c ? niceDate(c.today) : ''), h('h1', null, 'Hi Hamna'))), errBox()];
  if (S.busy && !d) { out.push(h('div', { class: 'spin' }, 'Loading your day…')); return out; }
  if (!d) { return out; }
  var p = pct('kcal', d.totals.kcal);
  out.push(h('div', { class: 'hero' }, h('span', { class: 'sub', style: 'color:#fff;opacity:.9' }, 'Calories today'),
    h('div', { class: 'big' }, Math.round(d.totals.kcal).toLocaleString(), ' ', h('small', null, '/ ' + c.targets.kcal.toLocaleString() + ' kcal')),
    bar(p), h('span', { style: 'font-size:13px' }, d.kcal_left >= 0 ? d.kcal_left + ' kcal left for the day' : Math.abs(d.kcal_left) + ' kcal over today')));
  if (d.entries.length && d.low.length) {
    var s = ideas(d, 2);
    out.push(h('div', { class: 'warn' }, h('b', { class: 't' }, 'Low so far'),
      h('span', null, d.low.slice(0, 3).map(function (l) { return l.label + ' ' + l.pct + '%'; }).join(', ') + " of today's target."),
      s.length ? h('span', null, h('b', null, 'Try: '), s.map(function (c) { return ideaTitle(c) + ' (' + ideaGain(c, 3) + ')'; }).join('  or  ')) : null));
  } else if (!d.entries.length) {
    out.push(h('div', { class: 'card' }, h('span', null, 'Nothing logged yet today.'), h('button', { class: 'btn', type: 'button', onclick: function () { go('log'); } }, 'Log your first meal')));
  }
  var nut = h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', null, 'Nutrients'), h('span', { class: 'sub' }, '% of daily target')));
  NINE.forEach(function (k) {
    var pp = d.pct[k], lowish = ALERT.indexOf(k) >= 0 && pp < d.threshold * 100;
    nut.appendChild(h('div', { style: 'display:flex;flex-direction:column;gap:4px' },
      h('div', { class: 'row' }, h('span', { class: 'n' }, label(k)), h('span', { class: 'v' }, Math.round(d.totals[k] * 10) / 10 + ' / ' + c.targets[k] + ' ' + (c.units[k] || '') + ' · ' + pp + '%')),
      bar(pp, lowish ? 'low' : '')));
  });
  out.push(nut);
  var meals = h('div', { class: 'card' }, h('h2', null, 'Meals'));
  var any = false;
  c.meals.forEach(function (m) {
    var es = d.entries.filter(function (e) { return e.meal === m; });
    if (!es.length) { return; }
    any = true;
    var kc = es.reduce(function (s, e) { return s + e.nutrients.kcal; }, 0);
    meals.appendChild(h('div', { class: 'meal' }, h('span', null, h('b', null, m), ' · ' + es.map(function (e) { return ql(e.qty, e.measure) + ' ' + e.food_name.replace(/\s*\(.*\)/, ''); }).join(', ')), h('span', { class: 'k' }, Math.round(kc))));
    es.forEach(function (e) {
      meals.appendChild(h('div', { class: 'row', style: 'padding-left:6px' }, h('span', { class: 'sub' }, ql(e.qty, e.measure) + ' · ' + e.food_name), h('button', { class: 'x', type: 'button', 'aria-label': 'Remove ' + e.food_name, onclick: function () { removeEntry(e); } }, '✕')));
    });
  });
  if (any) { out.push(meals); }
  return out;
}
function removeEntry(e) {
  if (!confirm('Remove ' + e.food_name + ' from today?')) { return; }
  S.busy = true; api('delete', { log_id: e.log_id }).then(function (d) { S.day = d; S.busy = false; toast('Removed'); render(); })
    .catch(function (x) { S.busy = false; toast(x.message); });
}

function filteredFoods() {
  var q = S.q.trim().toLowerCase(), fs = S.cfg.foods;
  if (q) { fs = fs.filter(function (f) { return (f.name + ' ' + f.category).toLowerCase().indexOf(q) >= 0; }); }
  return fs.slice(0, 60);
}
function screenLog() {
  var out = [h('h1', null, 'Log food'), errBox()];
  if (!S.cfg) { out.push(h('div', { class: 'spin' }, S.busy ? 'Loading…' : 'Connect in Profile first.')); return out; }
  out.push(h('div', { class: 'chips' }, S.cfg.meals.map(function (m) { return h('button', { class: 'chip' + (S.meal === m ? ' on' : ''), type: 'button', onclick: function () { S.meal = m; render(); } }, m); })));
  var ta = h('textarea', { id: 'mealtext', rows: '2', maxlength: '400', placeholder: 'e.g. 2 roti aur 1 katori daal, 1 glass doodh', 'aria-label': 'Type what you ate', oninput: function (e) { S.text = e.target.value; } }, S.text);
  out.push(h('div', { class: 'card' }, h('b', null, 'Type what you ate'), ta,
    h('button', { class: 'btn', type: 'button', disabled: S.parsing, onclick: doParse }, S.parsing ? 'Reading…' : 'Read my meal'),
    h('div', { class: 'note' }, 'English, Urdu or Roman Urdu is fine. You can fix everything before saving.')));
  if (S.unmatched.length) {
    out.push(h('div', { class: 'warn' }, h('b', { class: 't' }, "Couldn't find these in the food list"), h('span', null, S.unmatched.join(', ')), h('span', { class: 'note' }, 'Search below and add them by hand.')));
  }
  if (S.cart.length) {
    var cart = h('div', { class: 'card' }, h('h2', null, 'This ' + S.meal.toLowerCase()));
    S.cart.forEach(function (it, i) {
      cart.appendChild(h('div', { class: 'row' }, h('span', null, ql(it.qty, it.measure) + ' · ' + it.name), h('button', { class: 'x', type: 'button', 'aria-label': 'Remove ' + it.name, onclick: function () { S.cart.splice(i, 1); render(); } }, '✕')));
    });
    cart.appendChild(h('button', { class: 'btn', type: 'button', disabled: S.busy, onclick: doPreview }, S.busy ? 'Checking…' : 'Review ' + S.cart.length + ' item' + (S.cart.length > 1 ? 's' : '')));
    out.push(cart);
  }
  out.push(recipesCard());
  var inp = h('input', { type: 'search', placeholder: 'Search foods: roti, daal, milk…', 'aria-label': 'Search foods', value: S.q, oninput: function (e) { S.q = e.target.value; renderList(); } });
  var list = h('div', { class: 'card', id: 'foodlist', style: 'padding:4px 16px' });
  out.push(inp, list);
  setTimeout(renderList, 0);
  return out;
}
function renderList() {
  var l = document.getElementById('foodlist'); if (!l) { return; }
  l.textContent = '';
  var fs = filteredFoods();
  if (!fs.length) { l.appendChild(h('div', { class: 'spin' }, 'No match. Try another word.')); return; }
  fs.forEach(function (f) {
    var m = f.measures[0];
    l.appendChild(h('button', { class: 'food', type: 'button', onclick: function () { pickFood(f, S.screen === 'recipe' ? function (it) { S.rec.ing.push({ food_id: it.food_id, name: it.name, grams: Math.round(it.totalGrams * 10) / 10 }); } : null); } },
      h('div', null, h('div', { style: 'font-size:15px;font-weight:600' }, f.name), h('div', { class: 's' }, f.category + (m ? ' · ' + m.measure + ' ≈ ' + Math.round(f.per100.kcal * m.grams / 100) + ' kcal' : ''))),
      h('span', { style: 'color:var(--g);font-weight:700' }, '+')));
  });
}
function pickFood(f, cb) {
  var sheet = h('div', { class: 'sheet', onclick: function (e) { if (e.target === sheet) { sheet.remove(); } } });
  var opts = f.measures.map(function (m) { return h('option', { value: m.measure }, m.measure + ' (' + m.grams + ' g)'); });
  opts.push(h('option', { value: '__g' }, 'Grams (exact)'));
  var sel = h('select', { 'aria-label': 'Measure' }, opts);
  var qty = h('input', { type: 'number', inputmode: 'decimal', min: '0.25', step: '0.25', value: '1', 'aria-label': 'How many' });
  var lab = h('div', { class: 'sub' }, 'How many?');
  sel.onchange = function () { var g = sel.value === '__g'; lab.textContent = g ? 'How many grams?' : 'How many?'; qty.step = g ? '5' : '0.25'; qty.value = g ? '100' : '1'; };
  var ok = h('button', { class: 'btn', type: 'button', onclick: function () {
    var n = parseFloat(qty.value); if (!(n > 0)) { toast('Enter an amount'); return; }
    var it = { food_id: f.id, name: f.name };
    if (sel.value === '__g') { it.grams = n; it.qty = n; it.measure = 'g'; it.totalGrams = n; }
    else { it.qty = n; it.measure = sel.value; var mm = f.measures.filter(function (x) { return x.measure === sel.value; })[0]; it.totalGrams = mm ? mm.grams * n : 0; }
    S.q = ''; sheet.remove(); toast('Added ' + f.name);
    if (cb) { cb(it); } else { S.cart.push(it); }
    render();
  } }, 'Add');
  sheet.appendChild(h('div', null, h('h2', null, f.name), h('div', { class: 'sub' }, 'Measure'), sel, lab, qty, ok, h('button', { class: 'btn alt', type: 'button', onclick: function () { sheet.remove(); } }, 'Cancel')));
  document.body.appendChild(sheet);
}
function doParse() {
  var t = S.text.trim();
  if (!t) { toast('Type what you ate first'); return; }
  S.parsing = true; S.unmatched = []; render();
  api('parse', { text: t }).then(function (r) {
    r.items.forEach(function (it) { S.cart.push({ food_id: it.food_id, name: it.name, qty: it.qty, measure: it.measure, grams: it.grams }); });
    S.unmatched = r.unmatched || []; S.parsing = false;
    if (r.items.length) { S.text = ''; toast('Added ' + r.items.length + ' item' + (r.items.length > 1 ? 's' : '') + '. Check them below.'); }
    else { toast('Nothing matched. Try the search below.'); }
    render();
  }).catch(function (e) { S.parsing = false; toast(e.message); render(); });
}
function cartToApi(it) {
  var o = { food_id: it.food_id };
  if (it.grams) { o.grams = it.grams; } else { o.qty = it.qty; o.measure = it.measure; }
  if (it.text) { o.text = it.text; }
  return o;
}
function doPreview() {
  S.busy = true; render();
  var items = S.cart.map(cartToApi);
  api('preview', { date: S.cfg.today, meal: S.meal, items: items }).then(function (p) { S.preview = p; S.busy = false; S.screen = 'confirm'; render(); })
    .catch(function (e) { S.busy = false; toast(e.message); render(); });
}
function screenConfirm() {
  var p = S.preview, out = [h('div', { class: 'row', style: 'justify-content:flex-start' },
    h('button', { class: 'x', type: 'button', 'aria-label': 'Back', onclick: function () { go('log'); } }, '←'), h('h1', null, 'Check your ' + S.meal.toLowerCase()))];
  out.push(h('div', { class: 'sub' }, 'Make sure each item looks right.'));
  var items = h('div', { class: 'card', style: 'padding:4px 16px' });
  p.added.forEach(function (a) {
    items.appendChild(h('div', { class: 'meal' }, h('span', null, h('b', null, a.food_name), h('div', { class: 'sub' }, ql(a.qty, a.measure) + ' · about ' + Math.round(a.grams) + ' g')), h('span', { class: 'k' }, Math.round(a.nutrients.kcal) + ' kcal')));
  });
  out.push(items);
  var card = h('div', { class: 'card' }, h('h2', null, 'If you save this'), h('div', { class: 'sub' }, 'Light bar = today so far. Dark bar = after this meal.'));
  ['kcal', 'protein', 'fiber', 'iron', 'calcium', 'vitD', 'b12', 'folate'].forEach(function (k) {
    var b = pct(k, p.before[k]), a = pct(k, p.after[k]);
    card.appendChild(h('div', { style: 'display:flex;flex-direction:column;gap:4px' }, h('div', { class: 'row' }, h('span', { class: 'n' }, k === 'kcal' ? 'Calories' : label(k)), h('span', { class: 'v' }, b + '% → ' + a + '%')),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + Math.min(a, 100) + '%' }), h('div', { class: 'fill before', style: 'width:' + Math.min(b, 100) + '%' }))));
  });
  out.push(card);
  var still = ALERT.filter(function (k) { return pct(k, p.after[k]) < S.cfg.threshold * 100; });
  if (still.length) { out.push(h('div', { class: 'warn' }, h('b', { class: 't' }, 'Still low after this'), h('span', null, still.map(label).join(', ') + '.'))); }
  out.push(h('div', { class: 'bar' }, h('button', { class: 'btn alt', type: 'button', onclick: function () { go('log'); } }, 'Edit'),
    h('button', { class: 'btn', type: 'button', disabled: S.busy, onclick: doSave }, S.busy ? 'Saving…' : 'Save ' + S.meal.toLowerCase())));
  return out;
}
function doSave() {
  if (S.busy) { return; }
  S.busy = true; render();
  var items = S.cart.map(cartToApi);
  api('add', { date: S.cfg.today, meal: S.meal, items: items }).then(function () { S.cart = []; S.unmatched = []; S.preview = null; return reloadDay(); })
    .then(function () { S.busy = false; toast('Saved'); go('today'); })
    .catch(function (e) { S.busy = false; toast(e.message); render(); });
}

function screenSummary() {
  var out = [h('div', null, h('div', { class: 'sub' }, 'Your day so far'), h('h1', null, 'Summary')), errBox()];
  var d = S.day; if (!d) { out.push(h('div', { class: 'spin' }, S.busy ? 'Loading…' : 'No data yet.')); return out; }
  var on = NINE.filter(function (k) { return d.pct[k] >= d.threshold * 100; }).length;
  out.push(h('div', { class: 'card', style: 'display:grid;grid-template-columns:repeat(3,1fr);text-align:center;gap:8px' },
    stat(Math.round(d.totals.kcal).toLocaleString(), 'kcal eaten'), stat(Math.max(d.kcal_left, 0).toLocaleString(), 'kcal left'), stat(on + ' of 9', 'on track')));
  if (d.low.length) {
    var g = h('div', { class: 'warn' }, h('b', { style: 'font-size:16px;color:var(--warnink)' }, 'Still missing today'));
    d.low.forEach(function (l) { g.appendChild(h('div', { class: 'row', style: 'font-size:14px' }, h('b', null, l.label), h('span', { style: 'color:var(--warnink)' }, l.pct + '% · need ' + (Math.round(l.need * 10) / 10) + ' ' + l.unit + ' more'))); });
    out.push(g);
    var s = ideas(d, 4);
    var card = h('div', { class: 'card' }, h('h2', null, 'Ideas for your ' + defaultMeal().toLowerCase()),
      h('div', { class: 'sub' }, d.kcal_left < 150 ? 'You are close to your calorie limit, so these are light options.' : 'Fits your ' + d.kcal_left + ' kcal left. Tap one to see how your day would end.'));
    if (!s.length) { card.appendChild(h('div', { class: 'note' }, 'Nothing small enough fits your remaining calories. A glass of water or a light walk is fine today.')); }
    s.forEach(function (c) {
      card.appendChild(h('button', { class: 'food', type: 'button', onclick: function () { showIdea(c); } },
        h('div', null, h('div', { style: 'font-size:15px;font-weight:600' }, ideaTitle(c)), h('div', { class: 's', style: 'color:var(--g)' }, ideaGain(c))),
        h('span', { class: 'sub' }, c.sc.kcal + ' kcal')));
    });
    out.push(card);
  } else if (d.entries.length) { out.push(h('div', { class: 'card' }, h('b', null, 'Nothing is low right now. Nice balance.'))); }
  else { out.push(h('div', { class: 'card' }, 'Log a meal to see your summary.')); }
  out.push(h('div', { class: 'note' }, 'Food values are approximate estimates.'));
  return out;
}
function stat(a, b) { return h('div', { style: 'display:flex;flex-direction:column;gap:2px' }, h('span', { style: 'font-size:22px;font-weight:700' }, a), h('span', { class: 'sub' }, b)); }

function screenProfile() {
  var c = creds(), out = [h('h1', null, 'Profile'), errBox()];
  if (S.cfg) {
    var t = S.cfg.targets, card = h('div', { class: 'card' }, h('h2', null, 'Hamna'), h('div', { class: 'sub' }, 'Daily targets (set in the Google Sheet)'));
    ['kcal'].concat(NINE).forEach(function (k) { card.appendChild(h('div', { class: 'row' }, h('span', { class: 'n' }, k === 'kcal' ? 'Calories' : label(k)), h('span', { class: 'v' }, k === 'kcal' ? t[k] + ' kcal' : t[k] + ' ' + S.cfg.units[k]))); });
    card.appendChild(h('div', { class: 'row' }, h('span', { class: 'n' }, 'Low alert below'), h('span', { class: 'v' }, Math.round(S.cfg.threshold * 100) + '% of target')));
    out.push(card);
  }
  var key = h('input', { type: 'password', placeholder: 'Access key', value: c.key, autocomplete: 'off', 'aria-label': 'Access key' });
  var url = h('input', { type: 'url', value: c.url, 'aria-label': 'Server address' });
  out.push(h('div', { class: 'card' }, h('h2', null, 'Connection'), h('div', { class: 'sub' }, 'Access key'), key, h('div', { class: 'sub' }, 'Server address'), url,
    h('button', { class: 'btn', type: 'button', onclick: function () { store('hna_key', key.value.trim()); store('hna_url', url.value.trim()); toast('Saved. Connecting…'); S.cfg = null; S.day = null; go('today'); loadAll(); } }, 'Save and connect'),
    h('div', { class: 'note' }, 'The key is kept only on this phone.')));
  return out;
}

/* ---------- home recipes ---------- */
function recipeNut(ings, servings) {
  var tot = {}, map = {};
  S.cfg.foods.forEach(function (f) { map[f.id] = f; });
  ings.forEach(function (i) { var f = map[i.food_id]; if (!f) { return; } Object.keys(f.per100).forEach(function (k) { tot[k] = (tot[k] || 0) + f.per100[k] * i.grams / 100 / (servings || 1); }); });
  return tot;
}
function recipesCard() {
  var rs = (S.cfg && S.cfg.recipes) || [];
  var card = h('div', { class: 'card' }, h('h2', null, 'My recipes'));
  if (!rs.length) { card.appendChild(h('div', { class: 'note' }, 'Save a dish you cook often (like karahi) once, then add it to a meal in one tap.')); }
  rs.forEach(function (r) {
    var n = recipeNut(r.ingredients, r.servings);
    card.appendChild(h('button', { class: 'food', type: 'button', onclick: function () { recipeSheet(r); } },
      h('div', null, h('div', { style: 'font-size:15px;font-weight:600' }, r.name), h('div', { class: 's' }, 'Per serving ≈ ' + Math.round(n.kcal || 0) + ' kcal · makes ' + r.servings)),
      h('span', { style: 'color:var(--g);font-weight:700' }, '+')));
  });
  card.appendChild(h('button', { class: 'btn alt', type: 'button', onclick: function () { S.rec = { id: null, name: '', servings: 4, ing: [] }; S.q = ''; go('recipe'); } }, 'New recipe'));
  return card;
}
function recipeSheet(r) {
  var sheet = h('div', { class: 'sheet', onclick: function (e) { if (e.target === sheet) { sheet.remove(); } } });
  var qty = h('input', { type: 'number', inputmode: 'decimal', min: '0.25', step: '0.25', value: '1', 'aria-label': 'Servings you ate' });
  sheet.appendChild(h('div', null, h('h2', null, r.name), h('div', { class: 'sub' }, 'How many servings did you eat? (This recipe makes ' + r.servings + ')'), qty,
    h('button', { class: 'btn', type: 'button', onclick: function () {
      var e = parseFloat(qty.value); if (!(e > 0 && e <= 20)) { toast('Enter servings, like 1 or 0.5'); return; }
      r.ingredients.forEach(function (i) {
        var g = Math.round(i.grams / r.servings * e * 10) / 10; if (g <= 0) { return; }
        S.cart.push({ food_id: i.food_id, name: i.name, qty: g, measure: 'g', grams: g, text: 'Recipe: ' + r.name });
      });
      sheet.remove(); toast('Added ' + r.name); render();
    } }, 'Add to this ' + (S.meal || defaultMeal()).toLowerCase()),
    h('div', { class: 'grid2' },
      h('button', { class: 'btn alt', type: 'button', onclick: function () { sheet.remove(); S.rec = { id: r.id, name: r.name, servings: r.servings, ing: r.ingredients.map(function (i) { return { food_id: i.food_id, name: i.name, grams: i.grams }; }) }; S.q = ''; go('recipe'); } }, 'Edit'),
      h('button', { class: 'btn alt', type: 'button', style: 'color:var(--warn);border-color:var(--warn)', onclick: function () {
        if (!confirm('Delete the recipe "' + r.name + '"?')) { return; }
        sheet.remove(); S.busy = true; render();
        api('deleteRecipe', { recipe_id: r.id }).then(function (d) { S.cfg.recipes = d.recipes; store('hna_cfg', JSON.stringify(S.cfg)); S.busy = false; toast('Recipe deleted'); render(); })
          .catch(function (x) { S.busy = false; toast(x.message); render(); });
      } }, 'Delete')),
    h('button', { class: 'btn alt', type: 'button', onclick: function () { sheet.remove(); } }, 'Cancel')));
  document.body.appendChild(sheet);
}
function screenRecipe() {
  var R = S.rec, out = [h('div', { class: 'row', style: 'justify-content:flex-start' },
    h('button', { class: 'x', type: 'button', 'aria-label': 'Back', onclick: function () { go('log'); } }, '←'), h('h1', null, R.id ? 'Edit recipe' : 'New recipe'))];
  out.push(h('div', { class: 'card' },
    h('div', { class: 'sub' }, 'Recipe name'), h('input', { type: 'text', maxlength: '60', placeholder: 'e.g. Chicken karahi', value: R.name, 'aria-label': 'Recipe name', oninput: function (e) { R.name = e.target.value; } }),
    h('div', { class: 'sub' }, 'How many servings does the whole pot make?'), h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '50', value: String(R.servings), 'aria-label': 'Servings', oninput: function (e) { R.servings = parseFloat(e.target.value) || 1; updTotals(); } })));
  var ing = h('div', { class: 'card' }, h('h2', null, 'Ingredients (whole pot)'));
  if (!R.ing.length) { ing.appendChild(h('div', { class: 'note' }, 'Add each ingredient below with the amount for the whole pot.')); }
  R.ing.forEach(function (i, idx) { ing.appendChild(h('div', { class: 'row' }, h('span', null, i.name + ' · ' + i.grams + ' g'), h('button', { class: 'x', type: 'button', 'aria-label': 'Remove ' + i.name, onclick: function () { R.ing.splice(idx, 1); render(); } }, '✕'))); });
  var tot = h('div', { class: 'note', id: 'rectot' });
  ing.appendChild(tot); out.push(ing);
  function updTotals() {
    var n = recipeNut(R.ing, R.servings);
    tot.textContent = R.ing.length ? 'Per serving ≈ ' + Math.round(n.kcal || 0) + ' kcal, ' + Math.round((n.protein || 0) * 10) / 10 + ' g protein, ' + Math.round((n.iron || 0) * 10) / 10 + ' mg iron, ' + Math.round(n.calcium || 0) + ' mg calcium' : '';
  }
  updTotals();
  out.push(h('input', { type: 'search', placeholder: 'Search an ingredient: chicken, onion, oil…', 'aria-label': 'Search ingredient', value: S.q, oninput: function (e) { S.q = e.target.value; renderList(); } }));
  out.push(h('div', { class: 'card', id: 'foodlist', style: 'padding:4px 16px' }));
  setTimeout(renderList, 0);
  out.push(h('div', { class: 'bar', style: 'grid-template-columns:1fr' }, h('button', { class: 'btn', type: 'button', disabled: S.busy, onclick: saveRec }, S.busy ? 'Saving…' : 'Save recipe')));
  return out;
}
function saveRec() {
  var R = S.rec;
  if (!R.name.trim()) { toast('Give the recipe a name'); return; }
  if (!R.ing.length) { toast('Add at least one ingredient'); return; }
  S.busy = true; render();
  api('saveRecipe', { recipe_id: R.id || undefined, name: R.name.trim(), servings: R.servings, ingredients: R.ing.map(function (i) { return { food_id: i.food_id, grams: i.grams }; }) })
    .then(function (d) { S.cfg.recipes = d.recipes; store('hna_cfg', JSON.stringify(S.cfg)); S.rec = null; S.busy = false; toast('Recipe saved'); go('log'); })
    .catch(function (e) { S.busy = false; toast(e.message); render(); });
}

/* ---------- router ---------- */
function go(s) { S.screen = s; if (s === 'log' && !S.meal) { S.meal = defaultMeal(); } render(); var sc = document.getElementById('screen'); if (sc) { sc.scrollTop = 0; } }
function render() {
  var sc = document.getElementById('screen');
  if (S.screen === 'today' && !creds().key) { S.screen = 'profile'; }
  if (!S.meal) { S.meal = defaultMeal(); }
  var f = { today: screenToday, log: screenLog, confirm: screenConfirm, recipe: screenRecipe, summary: screenSummary, profile: screenProfile }[S.screen];
  var keep = (S.screen === 'log' || S.screen === 'recipe') && document.activeElement && document.activeElement.type === 'search';
  sc.textContent = '';
  add(sc, f());
  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) { b.className = (b.dataset.go === S.screen || ((S.screen === 'confirm' || S.screen === 'recipe') && b.dataset.go === 'log')) ? 'on' : ''; });
  if (keep) { var i = sc.querySelector('input[type=search]'); if (i) { i.focus(); } }
}
Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) { b.addEventListener('click', function () { go(b.dataset.go); if (b.dataset.go !== 'profile' && !S.day && creds().key && !S.busy) { loadAll(); } }); });

/* one-time setup from a link like  .../#k=ACCESSKEY  (the part after # never goes to any server) */
function applyHashKey() {
  var m = /[#&]k=([A-Za-z0-9]+)/.exec(location.hash);
  if (!m) { return false; }
  store('hna_key', m[1]); history.replaceState(null, '', location.pathname + location.search); return true;
}
applyHashKey();
window.addEventListener('hashchange', function () { if (applyHashKey()) { S.cfg = null; S.day = null; S.screen = 'today'; loadAll(); } });
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ }); }
if (creds().key) { try { S.cfg = JSON.parse(store('hna_cfg')); } catch (e) { S.cfg = null; } render(); loadAll(); } else { S.screen = 'profile'; render(); }
