'use strict';

// Fusión de dos copias de los datos (p. ej. la de este dispositivo y la de la nube).
// Funciones puras: no tocan el DOM ni el almacenamiento.
//
// Forma de una copia:
//   events:  [{ id, type, ts }]
//   daysOff: { 'AAAA-MM-DD': tipo }
//   todos:   { 'AAAA-MM-DD': [{ id, text, done, u }] }   u = última modificación
//   meta:    { deleted: { id: ts }, daysOff: { 'AAAA-MM-DD': ts } }
//            deleted = fichajes y tareas borrados; daysOff = última modificación de cada marca

const TOMBSTONE_MAX_AGE = 90 * 24 * 3600 * 1000;

function emptyMeta() {
  return { deleted: {}, daysOff: {} };
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

// Devuelve la copia con un orden estable, para poder compararla con otra
function normalizeSnapshot(snap) {
  const meta = snap.meta || emptyMeta();
  return {
    events: [...snap.events].sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id))),
    daysOff: sortKeys(snap.daysOff),
    todos: sortKeys(snap.todos),
    meta: { deleted: sortKeys(meta.deleted || {}), daysOff: sortKeys(meta.daysOff || {}) },
  };
}

function sameData(a, b) {
  return JSON.stringify(normalizeSnapshot(a)) === JSON.stringify(normalizeSnapshot(b));
}

// En caso de empate gana `a` (la copia local)
function mergeSnapshots(a, b, now = Date.now()) {
  const am = a.meta || emptyMeta();
  const bm = b.meta || emptyMeta();

  // Borrados: unión, con la fecha más reciente; los muy antiguos se olvidan
  const deleted = {};
  for (const src of [am.deleted || {}, bm.deleted || {}]) {
    for (const [id, ts] of Object.entries(src)) {
      if (now - ts < TOMBSTONE_MAX_AGE) deleted[id] = Math.max(deleted[id] || 0, ts);
    }
  }

  // Fichajes: unión por id, menos los borrados
  const byId = new Map();
  for (const e of [...a.events, ...b.events]) {
    if (!deleted[e.id] && !byId.has(e.id)) byId.set(e.id, e);
  }

  // Marcas de día: gana la modificación más reciente (también si fue quitar la marca)
  const daysOff = {};
  const daysOffMeta = {};
  const dayKeys = new Set([
    ...Object.keys(a.daysOff),
    ...Object.keys(b.daysOff),
    ...Object.keys(am.daysOff || {}),
    ...Object.keys(bm.daysOff || {}),
  ]);
  for (const k of dayKeys) {
    const ta = (am.daysOff || {})[k] || 0;
    const tb = (bm.daysOff || {})[k] || 0;
    let value;
    if (tb > ta) value = b.daysOff[k];
    else if (ta > tb) value = a.daysOff[k];
    else value = a.daysOff[k] || b.daysOff[k];
    if (value) daysOff[k] = value;
    if (ta || tb) daysOffMeta[k] = Math.max(ta, tb);
  }

  // Tareas: por id gana la versión más reciente, incluido el día al que pertenece
  const winners = new Map();
  for (const src of [a.todos, b.todos]) {
    for (const [key, list] of Object.entries(src)) {
      for (const item of list) {
        if (deleted[item.id]) continue;
        const cur = winners.get(item.id);
        if (!cur || (item.u || 0) > (cur.item.u || 0)) winners.set(item.id, { key, item });
      }
    }
  }
  // Orden dentro de cada día: primero el de `b` (la copia compartida) y después lo que
  // solo tiene `a`, para que todos los dispositivos acaben con el mismo orden
  const todos = {};
  const placed = new Set();
  for (const src of [b.todos, a.todos]) {
    for (const [key, list] of Object.entries(src)) {
      for (const { id } of list) {
        const w = winners.get(id);
        if (!w || w.key !== key || placed.has(id)) continue;
        placed.add(id);
        (todos[key] ||= []).push(w.item);
      }
    }
  }

  return normalizeSnapshot({
    events: [...byId.values()],
    daysOff,
    todos,
    meta: { deleted, daysOff: daysOffMeta },
  });
}

if (typeof module !== 'undefined') module.exports = { mergeSnapshots, normalizeSnapshot, sameData, emptyMeta };
