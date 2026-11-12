'use strict';

// Copia automática en un fichero del ordenador (File System Access API).
// Cada cambio se escribe también en el fichero, así los datos sobreviven
// aunque el navegador borre su almacenamiento.
const FileBackup = (() => {
  const supported = 'showSaveFilePicker' in window && 'indexedDB' in window;
  const FILE_TYPES = [{ description: 'JSON', accept: { 'application/json': ['.json'] } }];

  let handle = null;
  // none | ok | paused (falta permiso) | error
  let status = 'none';
  let lastSaved = null;
  let notice = '';
  let timer = null;

  // ---- IndexedDB: guarda la referencia al fichero entre sesiones ----
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('fichaje', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function kv(mode, fn) {
    const conn = await db();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- Lectura / escritura ----
  async function readFile() {
    try {
      const text = await (await handle.getFile()).text();
      return text.trim() ? parseSnapshot(JSON.parse(text)) : null;
    } catch {
      return null;
    }
  }

  async function write() {
    if (!handle || status === 'paused') return;
    try {
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(snapshot(), null, 2));
      await writable.close();
      status = 'ok';
      lastSaved = Date.now();
    } catch (err) {
      status = err && err.name === 'NotAllowedError' ? 'paused' : 'error';
    }
    renderStatus();
  }

  // Se queda con la versión más reciente: la del fichero o la del navegador
  async function sync() {
    const file = await readFile();
    if (file && file.updatedAt > localUpdatedAt()) {
      applySnapshot(file);
      notice = t('backup.restored', { name: handle.name });
      status = 'ok';
      lastSaved = Date.now();
      renderStatus();
    } else {
      await write();
    }
  }

  function schedule() {
    if (!handle) return;
    clearTimeout(timer);
    timer = setTimeout(write, 300);
  }

  async function link(newHandle) {
    handle = newHandle;
    await kv('readwrite', (s) => s.put(handle, 'fileHandle'));
  }

  // ---- Acciones del usuario ----
  async function create() {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: 'fichaje-datos.json', types: FILE_TYPES });
      await link(h);
      status = 'ok';
      await write();
    } catch (err) {
      if (err.name !== 'AbortError') fail();
    }
  }

  async function open() {
    try {
      const [h] = await window.showOpenFilePicker({ types: FILE_TYPES });
      if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
      const previous = handle;
      handle = h;
      const file = await readFile();
      if (file && hasData() && !confirm(t('backup.confirmLoad', { n: file.events.length }))) {
        handle = previous;
        return;
      }
      await link(h);
      status = 'ok';
      if (file) {
        applySnapshot(file);
        notice = t('backup.restored', { name: h.name });
      }
      await write();
    } catch (err) {
      if (err.name !== 'AbortError') fail();
    }
  }

  async function resume() {
    try {
      if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
      status = 'ok';
      await sync();
    } catch {
      fail();
    }
  }

  async function unlink() {
    handle = null;
    status = 'none';
    notice = '';
    await kv('readwrite', (s) => s.delete('fileHandle'));
    renderStatus();
  }

  function fail() {
    status = handle ? 'error' : 'none';
    renderStatus();
  }

  // ---- Interfaz ----
  function renderStatus() {
    const box = document.getElementById('backup');
    if (!box) return;
    box.className = `backup backup-${supported ? status : 'unsupported'}`;
    box.innerHTML = '';
    const text = document.createElement('span');
    const button = (key, fn) => {
      const b = document.createElement('button');
      b.className = 'ghost small';
      b.textContent = t(key);
      b.addEventListener('click', fn);
      return b;
    };
    const buttons = [];

    if (!supported) {
      text.textContent = t('backup.unsupported');
    } else if (status === 'none') {
      text.textContent = t('backup.warn');
      // El selector de ficheros cerraría el panel de la extensión: se abre en pestaña
      const inPopup = document.body.classList.contains('popup') && location.protocol === 'chrome-extension:';
      const act = (fn) => (inPopup ? () => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }) : fn);
      buttons.push(button('backup.create', act(create)), button('backup.open', act(open)));
    } else if (status === 'paused') {
      text.textContent = t('backup.paused', { name: handle.name });
      buttons.push(button('backup.resume', resume));
    } else if (status === 'error') {
      text.textContent = t('backup.error', { name: handle.name });
      buttons.push(button('backup.retry', resume), button('backup.unlink', unlink));
    } else {
      text.textContent =
        (notice ? notice + ' ' : '') + t('backup.ok', { name: handle.name, time: lastSaved ? fmtTime(lastSaved) : '—' });
      buttons.push(button('backup.unlink', unlink));
    }
    box.append(text, ...buttons);
  }

  async function init() {
    // Pide al navegador que no borre los datos por falta de espacio
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if (supported) {
      try {
        handle = (await kv('readonly', (s) => s.get('fileHandle'))) || null;
        if (handle) {
          const permission = await handle.queryPermission({ mode: 'readwrite' });
          if (permission === 'granted') {
            status = 'ok';
            await sync();
          } else {
            status = 'paused';
          }
        }
      } catch {
        handle = null;
      }
    }
    renderStatus();
    // Asegura la escritura pendiente al ocultar o cerrar la pestaña
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && timer) {
        clearTimeout(timer);
        timer = null;
        write();
      }
    });
  }

  return { init, schedule, renderStatus };
})();

FileBackup.init();
