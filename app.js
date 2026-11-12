'use strict';

// Horas de jornada por día de la semana (0 = domingo ... 6 = sábado)
const TARGET_HOURS = { 0: 0, 1: 8.5, 2: 8.5, 3: 8.5, 4: 8.5, 5: 6, 6: 0 };
const STORAGE_KEY = 'fichaje.events.v1';
const DAYS_OFF_KEY = 'fichaje.daysoff.v1';
const TODOS_KEY = 'fichaje.todos.v1';
const UPDATED_KEY = 'fichaje.updated.v1';
const META_KEY = 'fichaje.meta.v1';
const CLOCK_KEY = 'fichaje.clock';
const HOUR = 3600000;

const EVENT_TYPES = ['in', 'pause', 'resume', 'out'];
const DAY_OFF_TYPES = ['holiday', 'vacation', 'other'];
const typeLabel = (type) => t(`type.${type}`);
const dayOffLabel = (type) => t(`dayoff.${type}`);

// ---------- Almacenamiento ----------

function loadEvents() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(data) ? data.filter(isValidEvent).sort((a, b) => a.ts - b.ts) : [];
  } catch {
    return [];
  }
}

function saveEvents() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  touch();
}

// Anota la hora del último cambio y lanza la copia en fichero y la sincronización
function touch() {
  localStorage.setItem(UPDATED_KEY, String(Date.now()));
  scheduleCopies();
}

function scheduleCopies() {
  if (typeof FileBackup !== 'undefined') FileBackup.schedule();
  if (typeof CloudSync !== 'undefined') CloudSync.schedule();
}

// Datos auxiliares para fusionar con otros dispositivos (ver merge.js):
// qué se ha borrado y cuándo se cambió la marca de cada día
function loadMeta() {
  try {
    return cleanMeta(JSON.parse(localStorage.getItem(META_KEY) || '{}'));
  } catch {
    return emptyMeta();
  }
}

function cleanMeta(data) {
  const out = emptyMeta();
  for (const field of ['deleted', 'daysOff']) {
    const src = data && data[field];
    if (!src || typeof src !== 'object') continue;
    for (const [k, ts] of Object.entries(src)) if (typeof ts === 'number') out[field][k] = ts;
  }
  return out;
}

function saveMeta() {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

function localUpdatedAt() {
  return Number(localStorage.getItem(UPDATED_KEY)) || 0;
}

function isValidEvent(e) {
  return e && typeof e.ts === 'number' && EVENT_TYPES.includes(e.type);
}

// Días sin jornada: { 'AAAA-MM-DD': 'holiday' | 'vacation' }
function loadDaysOff() {
  try {
    const data = JSON.parse(localStorage.getItem(DAYS_OFF_KEY) || '{}');
    return cleanDaysOff(data);
  } catch {
    return {};
  }
}

function cleanDaysOff(data) {
  const out = {};
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && DAY_OFF_TYPES.includes(v)) out[k] = v;
    }
  }
  return out;
}

function saveDaysOff() {
  localStorage.setItem(DAYS_OFF_KEY, JSON.stringify(daysOff));
  touch();
}

// Tareas por día: { 'AAAA-MM-DD': [{ id, text, done }] }
function loadTodos() {
  try {
    return cleanTodos(JSON.parse(localStorage.getItem(TODOS_KEY) || '{}'));
  } catch {
    return {};
  }
}

function cleanTodos(data) {
  const out = {};
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [k, list] of Object.entries(data)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !Array.isArray(list)) continue;
      const items = list
        .filter((x) => x && typeof x.text === 'string')
        .map((x) => ({ id: x.id || newId(), text: x.text, done: !!x.done, u: Number(x.u) || 0 }));
      if (items.length) out[k] = items;
    }
  }
  return out;
}

function saveTodos() {
  for (const k of Object.keys(todos)) if (!todos[k].length) delete todos[k];
  localStorage.setItem(TODOS_KEY, JSON.stringify(todos));
  touch();
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

let events = loadEvents();
let daysOff = loadDaysOff();
let todos = loadTodos();
let meta = loadMeta();

// ---------- Utilidades de fecha ----------

const pad = (n) => String(n).padStart(2, '0');

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function targetFor(key) {
  if (daysOff[key]) return 0;
  return (TARGET_HOURS[keyToDate(key).getDay()] || 0) * HOUR;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDur(ms) {
  const neg = ms < 0;
  const totalMin = Math.floor(Math.abs(ms) / 60000);
  return (neg ? '-' : '') + t('dur', { h: Math.floor(totalMin / 60), m: pad(totalMin % 60) });
}

function fmtClock(ms) {
  const s = Math.floor(Math.max(ms, 0) / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function fmtSigned(ms) {
  return (ms > 0 ? '+' : '') + fmtDur(ms);
}

// ---------- Cálculo ----------

function eventsOfDay(key) {
  return events.filter((e) => dayKey(e.ts) === key);
}

// Recorre los fichajes de un día y devuelve tiempos y estado final.
function computeDay(key, now = Date.now()) {
  const list = eventsOfDay(key);
  let state = 'off';
  let worked = 0;
  let paused = 0;
  let since = null;
  let firstIn = null;
  let lastOut = null;

  for (const e of list) {
    if (e.type === 'in' && state === 'off') {
      state = 'working';
      since = e.ts;
      if (firstIn === null) firstIn = e.ts;
    } else if (e.type === 'pause' && state === 'working') {
      worked += e.ts - since;
      state = 'paused';
      since = e.ts;
    } else if (e.type === 'resume' && state === 'paused') {
      paused += e.ts - since;
      state = 'working';
      since = e.ts;
    } else if (e.type === 'out' && state !== 'off') {
      if (state === 'working') worked += e.ts - since;
      else paused += e.ts - since;
      state = 'off';
      lastOut = e.ts;
    }
  }

  const isToday = key === dayKey(now);
  const open = state !== 'off';
  if (open && isToday) {
    if (state === 'working') worked += now - since;
    else paused += now - since;
  }

  return { key, list, state, worked, paused, firstIn, lastOut, open: open && !isToday, target: targetFor(key), dayOff: daysOff[key] };
}

function currentState() {
  return computeDay(dayKey(Date.now())).state;
}

function weekKeys(now = new Date()) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return dayKey(d.getTime());
  });
}

// ---------- Acciones ----------

const ALLOWED = {
  off: ['in'],
  working: ['pause', 'out'],
  paused: ['resume', 'out'],
};

function punch(type) {
  if (!ALLOWED[currentState()].includes(type)) return;
  addEvent(type, Date.now());
}

function addEvent(type, ts) {
  events.push({ id: newId(), type, ts });
  events.sort((a, b) => a.ts - b.ts);
  saveEvents();
  render();
}

// El selector del formulario muestra siempre la marca actual de la fecha elegida
function syncDayOffType() {
  $('dayoff-type').value = daysOff[$('dayoff-date').value] || '';
}

function setDayOff(key, type) {
  if (type) daysOff[key] = type;
  else delete daysOff[key];
  meta.daysOff[key] = Date.now();
  saveMeta();
  saveDaysOff();
  render();
}

function deleteEvent(id) {
  const e = events.find((x) => x.id === id);
  if (!e) return;
  if (!confirm(t('confirmDelete', { type: typeLabel(e.type), time: fmtTime(e.ts) }))) return;
  events = events.filter((x) => x.id !== id);
  meta.deleted[id] = Date.now();
  saveMeta();
  saveEvents();
  render();
}

// ---------- Render ----------

const $ = (id) => document.getElementById(id);
const expanded = new Set();

function render() {
  renderToday();
  renderTable();
  syncDayOffType();
}

// 'countdown' (tiempo que falta) o 'worked' (tiempo trabajado)
let clockMode = localStorage.getItem(CLOCK_KEY) === 'worked' ? 'worked' : 'countdown';

function renderToday() {
  const now = new Date();
  const today = computeDay(dayKey(now.getTime()), now.getTime());

  $('today-label').textContent = now.toLocaleDateString(locale(), {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const status = $('status');
  status.className = `status status-${today.state}`;
  status.textContent = t(`status.${today.state}`);

  const allowed = ALLOWED[today.state];
  $('btn-in').disabled = !allowed.includes('in');
  $('btn-pause').disabled = !allowed.includes('pause');
  $('btn-resume').disabled = !allowed.includes('resume');
  $('btn-out').disabled = !allowed.includes('out');


  // Barra de la jornada
  const target = today.target;
  const done = today.worked;
  const left = target - done;
  // Reloj principal: cuenta atrás hasta completar la jornada, o tiempo trabajado
  let clock = fmtClock(today.worked);
  let clockLabel = t('workedToday');
  if (clockMode === 'countdown' && target > 0) {
    const secs = Math.ceil(Math.abs(left) / 1000) * 1000;
    clock = left >= 0 ? fmtClock(secs) : `+${fmtClock(secs)}`;
    clockLabel = left >= 0 ? t('clock.left') : t('clock.extra');
  }
  $('worked-live').textContent = clock;
  $('worked-live').classList.toggle('overtime', target > 0 && left < 0);
  $('clock-label').textContent = clockLabel;

  $('day-target').textContent = today.dayOff
    ? dayOffLabel(today.dayOff)
    : target ? t('target', { d: fmtDur(target) }) : t('nonWorkingDay');
  $('day-done').textContent = fmtDur(done);

  let fillPct;
  let extraPct = 0;
  if (!target) {
    fillPct = done > 0 ? 100 : 0;
  } else if (left >= 0) {
    fillPct = (done / target) * 100;
  } else {
    // Horas extra: la barra se reparte entre jornada y exceso
    fillPct = (target / done) * 100;
    extraPct = 100 - fillPct;
  }
  $('day-fill').style.width = `${fillPct}%`;
  $('day-extra').style.width = `${extraPct}%`;
  $('day-bar').classList.toggle('done', target > 0 && left <= 0);
  $('day-bar').setAttribute('aria-valuenow', target ? Math.round(Math.min(done / target, 1) * 100) : 0);

  if (target && left < 0) {
    $('day-left').textContent = fmtDur(-left);
    $('day-left-label').textContent = t('extra');
  } else {
    $('day-left').textContent = fmtDur(Math.max(left, 0));
    $('day-left-label').textContent = t('remaining');
  }

  let eta = '';
  if (target && left > 0) {
    const pct = Math.round((done / target) * 100);
    if (today.state === 'working') eta = t('eta.working', { time: fmtTime(now.getTime() + left), pct });
    else if (today.state === 'paused') eta = t('eta.paused', { time: fmtTime(today.list.at(-1).ts), pct });
    else if (done > 0) eta = t('eta.pct', { pct });
  } else if (target && left <= 0 && done > 0) {
    eta = t('eta.done');
  }
  $('day-eta').textContent = eta;

  // Barra semanal
  const week = weekKeys(now).map((k) => computeDay(k, now.getTime()));
  const weekTarget = week.reduce((s, d) => s + d.target, 0);
  const weekDone = week.reduce((s, d) => s + d.worked, 0);
  $('week-target').textContent = t('target', { d: fmtDur(weekTarget) });
  $('week-done').textContent = fmtDur(weekDone);
  $('week-left').textContent = fmtDur(Math.max(weekTarget - weekDone, 0));
  $('week-fill').style.width = `${weekTarget ? Math.min(weekDone / weekTarget, 1) * 100 : 0}%`;

  document.title = today.state === 'off' ? t('appName') : `${clock} · ${t('appName')}`;
}

function renderTable() {
  const month = $('month').value;
  const now = Date.now();
  const todayKey = dayKey(now);
  const keys = monthKeys(month).reverse();
  const weekday = new Intl.DateTimeFormat(locale(), { weekday: 'short' });

  const body = $('records-body');
  body.innerHTML = '';
  let totalWorked = 0;
  let totalTarget = 0;

  for (const key of keys) {
    const d = computeDay(key, now);
    totalWorked += d.worked;
    totalTarget += d.target;
    const balance = d.worked - d.target;
    const date = keyToDate(key);

    const tr = document.createElement('tr');
    tr.className = 'day' + (key === todayKey ? ' today' : '');
    tr.innerHTML = `
      <td>${weekday.format(date)} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}${d.dayOff ? ` <span class="tag ${d.dayOff}">${dayOffLabel(d.dayOff)}<button class="tag-del">✕</button></span>` : ''}</td>
      <td>${d.firstIn ? fmtTime(d.firstIn) : '—'}</td>
      <td>${d.lastOut && d.state === 'off' ? fmtTime(d.lastOut) : d.open ? `<span class="warn">${t('noExit')}</span>` : '—'}</td>
      <td>${fmtDur(d.paused)}</td>
      <td>${fmtDur(d.worked)}</td>
      <td>${fmtDur(d.target)}</td>
      <td class="${balance >= 0 ? 'pos' : 'neg'}">${fmtSigned(balance)}</td>`;
    // La ✕ de la etiqueta quita la marca de festivo/vacaciones/ausencia
    const tagDel = tr.querySelector('.tag-del');
    if (tagDel) {
      tagDel.title = t('dayoff.remove');
      tagDel.setAttribute('aria-label', t('dayoff.remove'));
      tagDel.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setDayOff(key, null);
      });
    }
    tr.addEventListener('click', () => {
      expanded.has(key) ? expanded.delete(key) : expanded.add(key);
      renderTable();
    });
    body.appendChild(tr);

    if (expanded.has(key)) {
      const detail = document.createElement('tr');
      detail.className = 'detail';
      const td = document.createElement('td');
      td.colSpan = 7;
      const wrap = document.createElement('div');
      wrap.className = 'events';
      for (const e of d.list) {
        const chip = document.createElement('span');
        chip.className = `chip ${e.type}`;
        chip.textContent = `${typeLabel(e.type)} ${fmtTime(e.ts)}`;
        const del = document.createElement('button');
        del.textContent = '✕';
        del.title = t('deleteEntry');
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          deleteEvent(e.id);
        });
        chip.appendChild(del);
        wrap.appendChild(chip);
      }
      const offActions = document.createElement('div');
      offActions.className = 'day-off-actions';
      const options = d.dayOff
        ? [[null, t('dayoff.remove')]]
        : [['holiday', t('dayoff.markHoliday')], ['vacation', t('dayoff.markVacation')], ['other', t('dayoff.markOther')]];
      for (const [type, label] of options) {
        const btn = document.createElement('button');
        btn.className = 'ghost small';
        btn.textContent = label;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          setDayOff(key, type);
        });
        offActions.appendChild(btn);
      }
      td.appendChild(wrap);
      td.appendChild(offActions);
      detail.appendChild(td);
      body.appendChild(detail);
    }
  }

  const totalBalance = totalWorked - totalTarget;
  $('records-foot').innerHTML = keys.length
    ? `<tr><td>${t('total')}</td><td></td><td></td><td></td><td>${fmtDur(totalWorked)}</td><td>${fmtDur(totalTarget)}</td><td class="${totalBalance >= 0 ? 'pos' : 'neg'}">${fmtSigned(totalBalance)}</td></tr>`
    : '';
  $('records-empty').classList.toggle('hidden', keys.length > 0);
}

// ---------- Tareas ----------

// Desplazamiento en días respecto a hoy del día que se muestra en la lista de tareas
let todoOffset = 0;

function todoKey() {
  const d = new Date();
  d.setDate(d.getDate() + todoOffset);
  return dayKey(d.getTime());
}

function shortDate(key) {
  const date = keyToDate(key);
  const weekday = new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(date);
  return `${weekday} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}

// Último día anterior a `key` con tareas sin hacer
function previousPending(key) {
  const prev = Object.keys(todos).filter((k) => k < key).sort().reverse();
  for (const k of prev) {
    const pending = todos[k].filter((x) => !x.done);
    if (pending.length) return { key: k, pending };
  }
  return null;
}

function addTodo(text) {
  const key = todoKey();
  (todos[key] ||= []).push({ id: newId(), text, done: false, u: Date.now() });
  saveTodos();
  renderTodos();
}

function updateTodo(key, id, changes) {
  const item = (todos[key] || []).find((x) => x.id === id);
  if (!item) return;
  Object.assign(item, changes, { u: Date.now() });
  saveTodos();
}

function removeTodo(key, id) {
  todos[key] = (todos[key] || []).filter((x) => x.id !== id);
  meta.deleted[id] = Date.now();
  saveMeta();
  saveTodos();
  renderTodos();
}

// Mueve las tareas pendientes del último día con pendientes al día mostrado
function carryTodos() {
  const key = todoKey();
  const from = previousPending(key);
  if (!from) return;
  todos[from.key] = todos[from.key].filter((x) => x.done);
  const now = Date.now();
  (todos[key] ||= []).push(...from.pending.map((x) => ({ ...x, u: now })));
  saveTodos();
  renderTodos();
}

function renderTodos() {
  const key = todoKey();
  const list = todos[key] || [];
  $('todo-day').textContent = todoOffset === 0 ? `${t('todo.today')} · ${shortDate(key)}` : shortDate(key);

  const ul = $('todo-list');
  ul.innerHTML = '';
  for (const item of list) {
    const li = document.createElement('li');
    li.className = 'todo-item' + (item.done ? ' done' : '');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = item.done;
    check.addEventListener('change', () => {
      updateTodo(key, item.id, { done: check.checked });
      li.classList.toggle('done', check.checked);
      renderTodoFoot();
    });

    // El texto se edita en el sitio y se guarda mientras se escribe
    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'todo-text';
    text.value = item.text;
    text.maxLength = 200;
    text.addEventListener('input', () => updateTodo(key, item.id, { text: text.value }));
    text.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') text.blur();
    });
    text.addEventListener('blur', () => {
      if (!text.value.trim()) removeTodo(key, item.id);
    });

    const del = document.createElement('button');
    del.className = 'todo-del';
    del.textContent = '✕';
    del.title = t('todo.delete');
    del.setAttribute('aria-label', t('todo.delete'));
    del.addEventListener('click', () => removeTodo(key, item.id));

    li.append(check, text, del);
    ul.appendChild(li);
  }
  $('todo-empty').classList.toggle('hidden', list.length > 0);
  renderTodoFoot();
}

function renderTodoFoot() {
  const key = todoKey();
  const list = todos[key] || [];
  const done = list.filter((x) => x.done).length;
  $('todo-count').textContent = list.length ? t('todo.count', { done, total: list.length }) : '';

  const from = todoOffset >= 0 ? previousPending(key) : null;
  const carry = $('todo-carry');
  carry.classList.toggle('hidden', !from);
  if (from) carry.textContent = t('todo.carry', { n: from.pending.length, date: shortDate(from.key) });
}

// Días del mes con fichajes o marcados como festivo/vacaciones
function monthKeys(month) {
  return [...new Set([...events.map((e) => dayKey(e.ts)), ...Object.keys(daysOff)])]
    .filter((k) => k.startsWith(month))
    .sort();
}

// ---------- Exportar / importar ----------

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() {
  const month = $('month').value;
  const keys = monthKeys(month);
  const rows = [['date', 'type', 'in', 'out', 'pauses', 'worked', 'target', 'balance', 'events'].map((c) => t(`col.${c}`))];
  for (const key of keys) {
    const d = computeDay(key);
    rows.push([
      key,
      d.dayOff ? dayOffLabel(d.dayOff) : t('workday'),
      d.firstIn ? fmtTime(d.firstIn) : '',
      d.lastOut && d.state === 'off' ? fmtTime(d.lastOut) : '',
      fmtDur(d.paused),
      fmtDur(d.worked),
      fmtDur(d.target),
      fmtSigned(d.worked - d.target),
      d.list.map((e) => `${typeLabel(e.type)} ${fmtTime(e.ts)}`).join(' | '),
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  download(`fichajes-${month}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
}

function snapshot() {
  return { version: 4, updatedAt: localUpdatedAt(), events, daysOff, todos, meta };
}

function hasData() {
  return events.length > 0 || Object.keys(daysOff).length > 0 || Object.keys(todos).length > 0;
}

// Valida una copia. Acepta las antiguas (solo lista de fichajes) y las nuevas ({ events, daysOff, todos })
function parseSnapshot(data) {
  const list = Array.isArray(data) ? data : data && data.events;
  if (!Array.isArray(list)) throw new Error('formato');
  const full = Array.isArray(data) ? {} : data;
  return {
    updatedAt: Number(full.updatedAt) || 0,
    events: list
      .filter(isValidEvent)
      .map((e) => ({ id: e.id || newId(), type: e.type, ts: e.ts }))
      .sort((a, b) => a.ts - b.ts),
    daysOff: cleanDaysOff(full.daysOff),
    todos: cleanTodos(full.todos),
    meta: cleanMeta(full.meta),
  };
}

function applySnapshot(snap) {
  events = snap.events;
  daysOff = snap.daysOff;
  todos = snap.todos;
  meta = cleanMeta(snap.meta);
  saveMeta();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  localStorage.setItem(DAYS_OFF_KEY, JSON.stringify(daysOff));
  localStorage.setItem(TODOS_KEY, JSON.stringify(todos));
  localStorage.setItem(UPDATED_KEY, String(snap.updatedAt || Date.now()));
  render();
  renderTodos();
}

// Prepara una copia restaurada a mano para que gane también en los demás dispositivos:
// lo que había y no está en la copia queda borrado, y lo que estaba borrado vuelve con id nuevo
function asRestore(snap) {
  const now = Date.now();
  const deleted = { ...meta.deleted };
  const allIds = (s) => [...s.events.map((e) => e.id), ...Object.values(s.todos).flat().map((x) => x.id)];
  const kept = new Set(allIds(snap));
  for (const id of allIds({ events, todos })) if (!kept.has(id)) deleted[id] = now;
  const revive = (x) => (deleted[x.id] ? { ...x, id: newId() } : x);
  const dayMeta = {};
  for (const k of [...Object.keys(daysOff), ...Object.keys(snap.daysOff), ...Object.keys(meta.daysOff)]) dayMeta[k] = now;
  return {
    updatedAt: now,
    events: snap.events.map(revive),
    daysOff: snap.daysOff,
    todos: Object.fromEntries(Object.entries(snap.todos).map(([k, list]) => [k, list.map((x) => ({ ...revive(x), u: now }))])),
    meta: { deleted, daysOff: dayMeta },
  };
}

function exportJson() {
  download(`fichajes-backup-${dayKey(Date.now())}.json`, JSON.stringify(snapshot(), null, 2), 'application/json');
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const snap = parseSnapshot(JSON.parse(reader.result));
      if (!confirm(t('confirmImport', { n: snap.events.length, d: Object.keys(snap.daysOff).length }))) return;
      applySnapshot(asRestore(snap));
      scheduleCopies();
    } catch {
      alert(t('importError'));
    }
  };
  reader.readAsText(file);
}

// ---------- Inicio ----------

function init() {
  const langSelect = $('lang');
  for (const [code, info] of Object.entries(LANGS)) {
    langSelect.add(new Option(info.name, code, false, code === lang));
  }
  langSelect.addEventListener('change', () => {
    setLang(langSelect.value);
    render();
    renderTodos();
    FileBackup.renderStatus();
    CloudSync.renderStatus();
  });

  $('clock').addEventListener('click', () => {
    clockMode = clockMode === 'countdown' ? 'worked' : 'countdown';
    localStorage.setItem(CLOCK_KEY, clockMode);
    renderToday();
  });
  applyTranslations();

  const params = new URLSearchParams(location.search);
  const isExtension = location.protocol === 'chrome-extension:';
  if (params.has('popup')) document.body.classList.add('popup');
  if (isExtension && params.has('popup')) {
    $('open-tab').classList.remove('hidden');
    $('open-tab').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
      window.close();
    });
  }

  const now = new Date();
  $('month').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  $('manual-date').value = dayKey(now.getTime());
  $('manual-time').value = fmtTime(now.getTime());
  $('dayoff-date').value = dayKey(now.getTime());

  $('btn-in').addEventListener('click', () => punch('in'));
  $('btn-pause').addEventListener('click', () => punch('pause'));
  $('btn-resume').addEventListener('click', () => punch('resume'));
  $('btn-out').addEventListener('click', () => punch('out'));
  $('month').addEventListener('change', renderTable);

  $('manual-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const [y, m, d] = $('manual-date').value.split('-').map(Number);
    const [hh, mm] = $('manual-time').value.split(':').map(Number);
    const ts = new Date(y, m - 1, d, hh, mm).getTime();
    if (Number.isNaN(ts)) return;
    addEvent($('manual-type').value, ts);
  });

  // Festivos: el selector muestra la marca de la fecha elegida y se guarda al cambiarlo
  let savedTimer;
  $('dayoff-form').addEventListener('submit', (ev) => ev.preventDefault());
  $('dayoff-date').addEventListener('change', syncDayOffType);
  $('dayoff-type').addEventListener('change', () => {
    const key = $('dayoff-date').value;
    if (!key) return;
    setDayOff(key, $('dayoff-type').value || null);
    $('month').value = key.slice(0, 7);
    renderTable();
    $('dayoff-saved').classList.remove('hidden');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $('dayoff-saved').classList.add('hidden'), 2000);
  });
  syncDayOffType();

  $('todo-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('todo-input').value.trim();
    if (!text) return;
    addTodo(text);
    $('todo-input').value = '';
  });
  $('todo-prev').addEventListener('click', () => {
    todoOffset--;
    renderTodos();
  });
  $('todo-next').addEventListener('click', () => {
    todoOffset++;
    renderTodos();
  });
  $('todo-day').addEventListener('click', () => {
    todoOffset = 0;
    renderTodos();
  });
  $('todo-carry').addEventListener('click', carryTodos);

  $('export-csv').addEventListener('click', exportCsv);
  $('export-json').addEventListener('click', exportJson);
  $('import-json').addEventListener('change', (ev) => {
    if (ev.target.files[0]) importJson(ev.target.files[0]);
    ev.target.value = '';
  });

  // Sincroniza si se ficha desde otra pestaña
  window.addEventListener('storage', (ev) => {
    if (ev.key === LANG_KEY && STRINGS[ev.newValue]) {
      lang = ev.newValue;
      $('lang').value = lang;
      applyTranslations();
      render();
      renderTodos();
    } else if (ev.key === META_KEY) {
      meta = loadMeta();
    } else if (ev.key === STORAGE_KEY || ev.key === DAYS_OFF_KEY) {
      events = loadEvents();
      daysOff = loadDaysOff();
      render();
    } else if (ev.key === TODOS_KEY && !document.activeElement?.classList.contains('todo-text')) {
      todos = loadTodos();
      renderTodos();
    }
  });

  render();
  renderTodos();
  setInterval(renderToday, 1000);
  // Refresca cada minuto para que el día en curso (y el cambio de día) se actualicen
  let lastDay = dayKey(Date.now());
  setInterval(() => {
    renderTable();
    if (dayKey(Date.now()) !== lastDay) {
      lastDay = dayKey(Date.now());
      if (!document.activeElement?.classList.contains('todo-text')) renderTodos();
    }
  }, 60000);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
