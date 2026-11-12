'use strict';

// Sincronización entre dispositivos con un Gist secreto de GitHub.
// Cada dispositivo guarda un token personal (permiso de Gists); los datos se
// fusionan con los del Gist (merge.js), así no se pierden cambios de ninguno.
const CloudSync = (() => {
  const API = 'https://api.github.com';
  const FILE = 'fichaje-datos.json';
  const CONFIG_KEY = 'fichaje.sync';
  const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

  let config = loadConfig(); // { token, gistId } o null
  // off | syncing | ok | offline | auth | error
  let status = config ? 'syncing' : 'off';
  let lastSync = null;
  let etag = null;
  let lastRemote = null;
  let running = false;
  let again = false;
  let timer = null;

  function loadConfig() {
    try {
      const c = JSON.parse(localStorage.getItem(CONFIG_KEY));
      return c && c.token && c.gistId ? c : null;
    } catch {
      return null;
    }
  }

  const connected = () => !!config;

  class ApiError extends Error {
    constructor(status) {
      super(`GitHub ${status}`);
      this.status = status;
    }
  }

  async function api(token, path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    if (!res.ok && res.status !== 304) throw new ApiError(res.status);
    return res;
  }

  async function readGistFile(gist) {
    const file = gist.files && gist.files[FILE];
    if (!file) return null;
    const text = file.truncated ? await (await fetch(file.raw_url, { cache: 'no-store' })).text() : file.content;
    try {
      return text && text.trim() ? parseSnapshot(JSON.parse(text)) : null;
    } catch {
      return null;
    }
  }

  const gistBody = (snap) => JSON.stringify({ files: { [FILE]: { content: JSON.stringify(snap, null, 2) } } });

  // Busca el Gist de datos de esta cuenta o crea uno secreto
  async function findOrCreateGist(token) {
    const list = await (await api(token, '/gists?per_page=100')).json();
    const found = list.find((g) => g.files && g.files[FILE]);
    if (found) return found.id;
    const created = await api(token, '/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: 'Fichaje — datos sincronizados',
        public: false,
        files: { [FILE]: { content: JSON.stringify(snapshot(), null, 2) } },
      }),
    });
    return (await created.json()).id;
  }

  async function connect(token) {
    token = token.trim();
    if (!token) return;
    setStatus('syncing');
    try {
      const gistId = await findOrCreateGist(token);
      config = { token, gistId };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      etag = null;
      lastRemote = null;
      await sync();
    } catch (err) {
      config = null;
      setStatus(errorStatus(err));
    }
    FileBackup.renderStatus();
  }

  function disconnect() {
    if (!confirm(t('sync.confirmDisconnect'))) return;
    config = null;
    localStorage.removeItem(CONFIG_KEY);
    clearTimeout(timer);
    setStatus('off');
    FileBackup.renderStatus();
  }

  function errorStatus(err) {
    if (err instanceof ApiError) return err.status === 401 || err.status === 403 ? 'auth' : 'error';
    return 'offline';
  }

  const editingTodo = () => !!document.activeElement && document.activeElement.classList.contains('todo-text');

  async function sync() {
    if (!config) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    setStatus('syncing');
    try {
      let remote = lastRemote;
      try {
        const res = await api(config.token, `/gists/${config.gistId}`, etag ? { headers: { 'If-None-Match': etag } } : {});
        if (res.status !== 304) {
          remote = await readGistFile(await res.json());
          etag = res.headers.get('ETag');
          lastRemote = remote;
        }
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
        // El Gist ya no existe: se crea otro con los datos de este dispositivo
        config.gistId = await findOrCreateGist(config.token);
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
        remote = null;
      }

      // Desde aquí hasta aplicar la fusión no hay esperas: no se pierde ningún cambio local
      const local = snapshot();
      const merged = remote ? mergeSnapshots(local, remote) : normalizeSnapshot(local);
      const updatedAt = Math.max(local.updatedAt, remote ? remote.updatedAt : 0);
      if (!sameData(merged, local)) {
        if (editingTodo()) {
          // No se redibuja la lista mientras se escribe una tarea: se reintenta enseguida
          schedule(5000);
          setStatus('ok');
          return;
        }
        applySnapshot({ ...merged, updatedAt });
        FileBackup.schedule();
      }
      if (!remote || !sameData(merged, remote)) {
        await api(config.token, `/gists/${config.gistId}`, {
          method: 'PATCH',
          body: gistBody({ version: 4, updatedAt, ...merged }),
        });
        etag = null;
        lastRemote = null;
      }
      lastSync = Date.now();
      setStatus('ok');
    } catch (err) {
      setStatus(errorStatus(err));
    } finally {
      running = false;
      if (again) {
        again = false;
        sync();
      }
    }
  }

  function schedule(delay = 2000) {
    if (!config) return;
    clearTimeout(timer);
    timer = setTimeout(sync, delay);
  }

  // ---- Interfaz ----
  function setStatus(s) {
    status = s;
    renderStatus();
  }

  function statusText() {
    if (status === 'ok') return t('sync.ok', { time: lastSync ? fmtTime(lastSync) : '—' });
    return t(`sync.${status}`);
  }

  function button(key, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost small';
    b.textContent = t(key);
    b.addEventListener('click', fn);
    return b;
  }

  function renderStatus() {
    // Línea de estado en la cabecera
    const line = document.getElementById('sync-status');
    if (line) {
      line.className = `sync-status sync-${status}` + (config ? '' : ' hidden');
      line.textContent = config ? statusText() : '';
    }

    // Sección de configuración
    const box = document.getElementById('sync-box');
    if (!box) return;
    const editing = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    if (editing && !config) {
      // No se redibuja mientras se escribe el token; solo se actualiza el mensaje
      const msg = box.querySelector('.sync-msg');
      if (msg) msg.textContent = status === 'off' ? '' : statusText();
      return;
    }
    box.innerHTML = '';
    if (config) {
      const text = document.createElement('span');
      text.className = `sync-msg sync-${status}`;
      text.textContent = statusText();
      const row = document.createElement('div');
      row.className = 'manual';
      row.append(button('sync.now', sync), button('sync.disconnect', disconnect));
      box.append(text, row);
      return;
    }
    const help = document.createElement('p');
    help.className = 'muted small';
    help.textContent = t('sync.help') + ' ';
    const link = document.createElement('a');
    link.href = TOKEN_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = t('sync.createToken');
    help.appendChild(link);

    const form = document.createElement('form');
    form.className = 'manual';
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder = t('sync.tokenPlaceholder');
    input.setAttribute('aria-label', t('sync.tokenPlaceholder'));
    input.className = 'sync-token';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-small';
    submit.textContent = t('sync.connect');
    form.append(input, submit);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      connect(input.value);
    });

    const msg = document.createElement('p');
    msg.className = `sync-msg small sync-${status}`;
    msg.textContent = status === 'off' ? '' : statusText();
    box.append(help, form, msg);
  }

  function init() {
    renderStatus();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) sync();
    });
    window.addEventListener('online', sync);
    setInterval(() => {
      if (!document.hidden) sync();
    }, 60000);
    sync();
  }

  return { init, sync, schedule, connected, renderStatus };
})();

CloudSync.init();
