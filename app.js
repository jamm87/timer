'use strict';

// Horas de jornada por día de la semana (0 = domingo ... 6 = sábado)
const TARGET_HOURS = { 0: 0, 1: 8.5, 2: 8.5, 3: 8.5, 4: 8.5, 5: 6, 6: 0 };
const STORAGE_KEY = 'fichaje.events.v1';
const DAYS_OFF_KEY = 'fichaje.daysoff.v1';
const HOUR = 3600000;

const TYPE_LABEL = { in: 'Entrada', pause: 'Pausa', resume: 'Reanudar', out: 'Salida' };
const DAY_OFF_LABEL = { holiday: 'Festivo', vacation: 'Vacaciones' };
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

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
}

function isValidEvent(e) {
  return e && typeof e.ts === 'number' && TYPE_LABEL[e.type];
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
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && DAY_OFF_LABEL[v]) out[k] = v;
    }
  }
  return out;
}

function saveDaysOff() {
  localStorage.setItem(DAYS_OFF_KEY, JSON.stringify(daysOff));
}

let events = loadEvents();
let daysOff = loadDaysOff();

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
  return `${neg ? '-' : ''}${Math.floor(totalMin / 60)}h ${pad(totalMin % 60)}m`;
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
  events.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(ts) + Math.random(), type, ts });
  events.sort((a, b) => a.ts - b.ts);
  saveEvents();
  render();
}

function setDayOff(key, type) {
  if (type) daysOff[key] = type;
  else delete daysOff[key];
  saveDaysOff();
  render();
}

function deleteEvent(id) {
  const e = events.find((x) => x.id === id);
  if (!e) return;
  if (!confirm(`¿Borrar el fichaje "${TYPE_LABEL[e.type]}" de las ${fmtTime(e.ts)}?`)) return;
  events = events.filter((x) => x.id !== id);
  saveEvents();
  render();
}

// ---------- Render ----------

const $ = (id) => document.getElementById(id);
const expanded = new Set();

function render() {
  renderToday();
  renderTable();
}

function renderToday() {
  const now = new Date();
  const today = computeDay(dayKey(now.getTime()), now.getTime());

  $('today-label').textContent = now.toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const status = $('status');
  status.className = `status status-${today.state}`;
  status.textContent = { off: 'Fuera', working: 'Trabajando', paused: 'En pausa' }[today.state];

  const allowed = ALLOWED[today.state];
  $('btn-in').disabled = !allowed.includes('in');
  $('btn-pause').disabled = !allowed.includes('pause');
  $('btn-resume').disabled = !allowed.includes('resume');
  $('btn-out').disabled = !allowed.includes('out');

  $('worked-live').textContent = fmtClock(today.worked);

  // Barra de la jornada
  const target = today.target;
  const done = today.worked;
  const left = target - done;
  $('day-target').textContent = today.dayOff
    ? DAY_OFF_LABEL[today.dayOff].toLowerCase()
    : target ? `objetivo ${fmtDur(target)}` : 'día no laborable';
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
    $('day-left-label').textContent = 'extra';
  } else {
    $('day-left').textContent = fmtDur(Math.max(left, 0));
    $('day-left-label').textContent = 'restante';
  }

  let eta = '';
  if (target && left > 0) {
    if (today.state === 'working') eta = `Salida estimada a las ${fmtTime(now.getTime() + left)} (${Math.round((done / target) * 100)}%)`;
    else if (today.state === 'paused') eta = `En pausa desde las ${fmtTime(today.list.at(-1).ts)} · ${Math.round((done / target) * 100)}% completado`;
    else if (done > 0) eta = `${Math.round((done / target) * 100)}% completado`;
  } else if (target && left <= 0 && done > 0) {
    eta = '¡Jornada completada!';
  }
  $('day-eta').textContent = eta;

  // Barra semanal
  const week = weekKeys(now).map((k) => computeDay(k, now.getTime()));
  const weekTarget = week.reduce((s, d) => s + d.target, 0);
  const weekDone = week.reduce((s, d) => s + d.worked, 0);
  $('week-target').textContent = `objetivo ${fmtDur(weekTarget)}`;
  $('week-done').textContent = fmtDur(weekDone);
  $('week-left').textContent = fmtDur(Math.max(weekTarget - weekDone, 0));
  $('week-fill').style.width = `${weekTarget ? Math.min(weekDone / weekTarget, 1) * 100 : 0}%`;

  document.title = today.state === 'off' ? 'Fichaje' : `${fmtClock(today.worked)} · Fichaje`;
}

function renderTable() {
  const month = $('month').value;
  const now = Date.now();
  const todayKey = dayKey(now);
  const keys = monthKeys(month).reverse();

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
      <td>${WEEKDAYS[date.getDay()]} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}${d.dayOff ? ` <span class="tag ${d.dayOff}">${DAY_OFF_LABEL[d.dayOff]}</span>` : ''}</td>
      <td>${d.firstIn ? fmtTime(d.firstIn) : '—'}</td>
      <td>${d.lastOut && d.state === 'off' ? fmtTime(d.lastOut) : d.open ? '<span class="warn">sin salida</span>' : '—'}</td>
      <td>${fmtDur(d.paused)}</td>
      <td>${fmtDur(d.worked)}</td>
      <td>${fmtDur(d.target)}</td>
      <td class="${balance >= 0 ? 'pos' : 'neg'}">${fmtSigned(balance)}</td>`;
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
        chip.textContent = `${TYPE_LABEL[e.type]} ${fmtTime(e.ts)}`;
        const del = document.createElement('button');
        del.textContent = '✕';
        del.title = 'Borrar fichaje';
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          deleteEvent(e.id);
        });
        chip.appendChild(del);
        wrap.appendChild(chip);
      }
      const offActions = document.createElement('div');
      offActions.className = 'day-off-actions';
      const options = d.dayOff ? [[null, `Quitar ${DAY_OFF_LABEL[d.dayOff].toLowerCase()}`]] : Object.entries(DAY_OFF_LABEL).map(([t, l]) => [t, `Marcar ${l.toLowerCase()}`]);
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
    ? `<tr><td>Total</td><td></td><td></td><td></td><td>${fmtDur(totalWorked)}</td><td>${fmtDur(totalTarget)}</td><td class="${totalBalance >= 0 ? 'pos' : 'neg'}">${fmtSigned(totalBalance)}</td></tr>`
    : '';
  $('records-empty').classList.toggle('hidden', keys.length > 0);
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
  const rows = [['Fecha', 'Tipo', 'Entrada', 'Salida', 'Pausas', 'Trabajado', 'Jornada', 'Saldo', 'Fichajes']];
  for (const key of keys) {
    const d = computeDay(key);
    rows.push([
      key,
      d.dayOff ? DAY_OFF_LABEL[d.dayOff] : 'Laborable',
      d.firstIn ? fmtTime(d.firstIn) : '',
      d.lastOut && d.state === 'off' ? fmtTime(d.lastOut) : '',
      fmtDur(d.paused),
      fmtDur(d.worked),
      fmtDur(d.target),
      fmtSigned(d.worked - d.target),
      d.list.map((e) => `${TYPE_LABEL[e.type]} ${fmtTime(e.ts)}`).join(' | '),
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  download(`fichajes-${month}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
}

function exportJson() {
  download(`fichajes-backup-${dayKey(Date.now())}.json`, JSON.stringify({ version: 2, events, daysOff }, null, 2), 'application/json');
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      // Acepta copias antiguas (solo lista de fichajes) y nuevas ({ events, daysOff })
      const list = Array.isArray(data) ? data : data && data.events;
      if (!Array.isArray(list)) throw new Error('formato');
      const valid = list.filter(isValidEvent);
      const newDaysOff = cleanDaysOff(Array.isArray(data) ? {} : data.daysOff);
      if (!confirm(`Se restaurarán ${valid.length} fichajes y ${Object.keys(newDaysOff).length} días festivos/vacaciones, reemplazando los actuales. ¿Continuar?`)) return;
      events = valid.map((e) => ({ id: e.id || String(e.ts) + Math.random(), type: e.type, ts: e.ts })).sort((a, b) => a.ts - b.ts);
      daysOff = newDaysOff;
      saveEvents();
      saveDaysOff();
      render();
    } catch {
      alert('El fichero no es una copia válida.');
    }
  };
  reader.readAsText(file);
}

// ---------- Inicio ----------

function init() {
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

  $('dayoff-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const key = $('dayoff-date').value;
    if (!key) return;
    setDayOff(key, $('dayoff-type').value || null);
    $('month').value = key.slice(0, 7);
    renderTable();
  });

  $('export-csv').addEventListener('click', exportCsv);
  $('export-json').addEventListener('click', exportJson);
  $('import-json').addEventListener('change', (ev) => {
    if (ev.target.files[0]) importJson(ev.target.files[0]);
    ev.target.value = '';
  });

  // Sincroniza si se ficha desde otra pestaña
  window.addEventListener('storage', (ev) => {
    if (ev.key === STORAGE_KEY || ev.key === DAYS_OFF_KEY) {
      events = loadEvents();
      daysOff = loadDaysOff();
      render();
    }
  });

  render();
  setInterval(renderToday, 1000);
  // Refresca la tabla cada minuto para que el día en curso se actualice
  setInterval(renderTable, 60000);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
