(() => {
'use strict';
/* ============ helpers ============ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
// Tagged template: every value is escaped unless it is already Raw (or an array of them).
const h = (strs, ...vals) => new Raw(strs.reduce((out, s, i) => {
  let v = vals[i];
  if (i >= vals.length) return out + s;
  if (Array.isArray(v)) v = v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
  else v = v instanceof Raw ? v.s : esc(v);
  return out + s + v;
}, ''));

const S = { me: null, csrf: null, cfg: { libraryName: 'Library', currency: '₹' }, tmp: {} };
const money = (n) => `${S.cfg.currency || '₹'}${Number(n || 0).toLocaleString()}`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtTime = (d) => d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const daysUntil = (d) => Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);

async function api(path, { method = 'GET', body, text } = {}) {
  const res = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(S.csrf ? { 'X-CSRF-Token': S.csrf } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = text ? await res.text() : await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && S.me && !path.startsWith('/auth/')) { S.me = null; S.csrf = null; render(); toast('Your session ended. Please sign in again.', 'err'); }
    throw new Error((data && data.error) || 'Something went wrong');
  }
  return data;
}
const OFFLINE_DB = 'dialibrary-opac';
const OFFLINE_SCHEMA = 2;
let offlineDbRequest;
let offlineSyncPromise;
let offlineCatalogueMemory;
function openOfflineDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('This browser does not support offline catalogue storage.'));
  if (!offlineDbRequest) {
    offlineDbRequest = new Promise((resolve, reject) => {
      const request = indexedDB.open(OFFLINE_DB, OFFLINE_SCHEMA);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        offlineDbRequest = null;
        reject(request.error || new Error('Could not open offline catalogue storage.'));
      };
    });
  }
  return offlineDbRequest;
}
async function getOfflineCatalogue() {
  if (offlineCatalogueMemory) return offlineCatalogueMemory;
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'meta'], 'readonly');
    const books = tx.objectStore('books').getAll();
    const meta = tx.objectStore('meta').get('catalogue');
    tx.oncomplete = () => {
      offlineCatalogueMemory = {
        books: books.result || [],
        syncedAt: meta.result ? meta.result.syncedAt : null,
        schemaVersion: meta.result ? meta.result.schemaVersion : null,
      };
      resolve(offlineCatalogueMemory);
    };
    tx.onerror = () => reject(tx.error || new Error('Could not read the offline catalogue.'));
    tx.onabort = () => reject(tx.error || new Error('Could not read the offline catalogue.'));
  });
}
async function getOfflineCatalogueMeta() {
  if (offlineCatalogueMemory) return {
    syncedAt: offlineCatalogueMemory.syncedAt,
    schemaVersion: offlineCatalogueMemory.schemaVersion,
  };
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const meta = tx.objectStore('meta').get('catalogue');
    tx.oncomplete = () => resolve({
      syncedAt: meta.result ? meta.result.syncedAt : null,
      schemaVersion: meta.result ? meta.result.schemaVersion : null,
    });
    tx.onerror = () => reject(tx.error || new Error('Could not read the offline catalogue status.'));
    tx.onabort = () => reject(tx.error || new Error('Could not read the offline catalogue status.'));
  });
}
async function saveOfflineCatalogue(results, syncedAt) {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'meta'], 'readwrite');
    const books = tx.objectStore('books');
    books.clear();
    for (const book of results) books.put(book);
    tx.objectStore('meta').put({ key: 'catalogue', syncedAt, schemaVersion: OFFLINE_SCHEMA });
    tx.oncomplete = () => {
      offlineCatalogueMemory = { books: results, syncedAt, schemaVersion: OFFLINE_SCHEMA };
      resolve();
    };
    tx.onerror = () => reject(tx.error || new Error('Could not save the offline catalogue.'));
    tx.onabort = () => reject(tx.error || new Error('Could not save the offline catalogue.'));
  });
}
async function syncOfflineCatalogue(force = false) {
  if (offlineSyncPromise) return offlineSyncPromise;
  offlineSyncPromise = (async () => {
    const meta = await getOfflineCatalogueMeta();
    const age = meta.syncedAt ? Date.now() - new Date(meta.syncedAt).getTime() : Infinity;
    if (!force && (!navigator.onLine || (meta.schemaVersion === OFFLINE_SCHEMA && meta.syncedAt && age < 6 * 60 * 60 * 1000))) return meta;
    if (!navigator.onLine) return meta;
    const data = await api('/opac/offline-catalogue');
    await saveOfflineCatalogue(data.results, data.generatedAt);
    return { syncedAt: data.generatedAt };
  })();
  try { return await offlineSyncPromise; }
  finally { offlineSyncPromise = null; }
}
const normalizedSearch = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase()
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي');
function searchOfflineCatalogue(catalogue) {
  const terms = normalizedSearch(Q.q).split(/\s+/).filter(Boolean);
  const fields = {
    title: (b) => [b.title, ...(b.searchAliases || [])],
    author: (b) => [b.author, ...(b.searchAliases || [])],
    subject: (b) => b.subjects || [],
    isbn: (b) => [b.isbn],
    callno: (b) => [b.callNumber],
    all: (b) => [b.title, b.author, ...(b.searchAliases || []), ...(b.subjects || []), b.isbn, b.callNumber, b.publisher, b.description],
  };
  const matched = catalogue.books.filter((book) => {
    if (Q.available && !book.available) return false;
    if (Q.language && book.language !== Q.language) return false;
    if (Q.subject && !(book.subjects || []).includes(Q.subject)) return false;
    const text = normalizedSearch(fields[Q.field](book).join(' '));
    return terms.every((term) => text.includes(term));
  });
  const subjects = {}, languages = {};
  for (const book of matched) {
    for (const subject of book.subjects || []) subjects[subject] = (subjects[subject] || 0) + 1;
    languages[book.language] = (languages[book.language] || 0) + 1;
  }
  const top = (values, limit) => Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([name, count]) => ({ name, count }));
  const sorted = matched.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const per = 12;
  return {
    total: sorted.length, page: Q.page, per,
    results: sorted.slice((Q.page - 1) * per, Q.page * per),
    facets: { subjects: top(subjects, 12), languages: top(languages, 6) },
  };
}
function toast(msg, kind = '') {
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
}
const setBusy = (btn, on, label) => { if (!btn) return; btn.disabled = on; if (label) { if (on) { btn.dataset.l = btn.textContent; btn.textContent = label; } else if (btn.dataset.l) btn.textContent = btn.dataset.l; } };
const view = (r) => { $('#view').innerHTML = r.s; };

/* ============ icons ============ */
const ICON = {
  search: '<path d="M10.5 4a6.500 6.500 0 1 0 0 13 6.500 6.500 0 0 0 0-13zm5 11.500 5 5"/>',
  book: '<path d="M4 5.500c2.700-.9 5.300-.7 8 .9v12c-2.700-1.600-5.300-1.800-8-.9zM20 5.500c-2.700-.9-5.300-.7-8 .9v12c2.700-1.600 5.300-1.800 8-.9z"/>',
  home: '<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  desk: '<path d="M3 8h18v4H3zM5 12v8m14-8v8M9 8V5h6v3"/>',
  users: '<path d="M9 11a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7zM2.500 20a6.500 6.500 0 0 1 13 0M16 4.500a3.500 3.500 0 0 1 0 6.500M18 14c2 .7 3.500 2.700 3.500 6"/>',
  clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7v5l3 2"/>',
  install: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M9 10l3 3 3-3M12 6v7"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  cog: '<circle cx="12" cy="12" r="3.200"/><path d="M12 3v2.500M12 18.500V21M3 12h2.500M18.500 12H21M5.600 5.600l1.800 1.800M16.600 16.600l1.800 1.800M5.600 18.400l1.800-1.800M16.600 7.400l1.800-1.800"/>',
  shield: '<path d="M12 3 5 6v5.500c0 4.300 2.800 7.600 7 9.500 4.200-1.900 7-5.200 7-9.500V6z"/><path d="m9 12 2.200 2.200L15.500 10"/>',
  log: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  out: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M16 8l4 4-4 4M20 12H9"/>',
  coin: '<circle cx="12" cy="12" r="8.500"/><path d="M9.500 9.500h4a1.800 1.800 0 0 1 0 3.600h-3a1.800 1.800 0 0 0 0 3.600h4.200M12 7.500v1.800m0 7.400v1.800"/>',
};
const ico = (n) => raw(`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`);
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor"/><path d="M7 9.500c3-1 6-.8 9 1v13c-3-1.800-6-2-9-1zM25 9.500c-3-1-6-.8-9 1v13c3-1.800 6-2 9-1z" fill="#fff"/></svg>';
const PALETTE = ['#d7263d', '#b3182d', '#ee5a6f', '#e0384e', '#9c1226', '#f06a7d', '#c4223a'];
const cover = (title, big) => { let s = 0; for (const c of title) s = (s * 31 + c.charCodeAt(0)) >>> 0; const c1 = PALETTE[s % PALETTE.length], c2 = PALETTE[(s >> 3) % PALETTE.length]; return h`<div class="cover${big ? ' big' : ''}" style="background:linear-gradient(150deg,${c1},${c2})"><span>${title}</span></div>`; };

/* ============ navigation ============ */
const NAV = {
  student: [['search', 'Catalogue', 'search'], ['account', 'My library', 'book'], ['security', 'Security', 'shield'], ['install', 'Install app', 'install']],
  librarian: [['dashboard', 'Overview', 'home'], ['desk', 'Desk', 'desk'], ['patrons', 'Students', 'users'], ['loans', 'Loans', 'clock'], ['holds', 'Holds', 'list'], ['search', 'Catalogue', 'search'], ['security', 'Security', 'shield'], ['install', 'Install app', 'install']],
  admin: [['dashboard', 'Overview', 'home'], ['desk', 'Desk', 'desk'], ['patrons', 'Students', 'users'], ['loans', 'Loans', 'clock'], ['holds', 'Holds', 'list'], ['search', 'Catalogue', 'search'], ['settings', 'Settings', 'cog'], ['inventory', 'Stock check', 'list'], ['users', 'Accounts', 'user'], ['audit', 'Activity', 'log'], ['security', 'Security', 'shield'], ['install', 'Install app', 'install']],
};
const home = () => ({ student: 'search', librarian: 'dashboard', admin: 'dashboard' }[S.me.role]);
const route = () => { const [name, ...rest] = (location.hash.slice(1) || '').split('/'); return { name, arg: rest.join('/') }; };

/* ============ rendering ============ */
function render() {
  if (!S.me) return renderPublic();
  if (S.me.mustChangePassword) return renderForcedPassword();
  const r = route();
  const allowed = NAV[S.me.role].map((n) => n[0]);
  const name = allowed.includes(r.name) || (r.name === 'patron' && S.me.role !== 'student') ? r.name : home();
  if (name !== r.name) { history.replaceState(null, '', '#' + name); }
  document.title = (S.cfg.libraryName || 'Library') + ' · ' + (NAV[S.me.role].find((n) => n[0] === name) || [0, 'Patron'])[1];
  const items = NAV[S.me.role];
  const groups = S.me.role === 'admin' ? { 6: 'Administration' } : {};
  $('#root').innerHTML = h`
  <div class="shell">
    <aside class="side">
      <a class="brand" href="/">${raw(LOGO)}<span>${S.cfg.libraryName}</span></a>
      <nav class="nav-list" aria-label="Main">
        ${items.map(([k, label, ic], i) => h`${groups[i] ? h`<div class="nav-sep">${groups[i]}</div>` : ''}<a href="#${k}" ${k === name || (k === 'patrons' && name === 'patron') ? raw('aria-current="page"') : ''}>${ico(ic)}<span>${label}</span></a>`)}
      </nav>
      <div class="side-foot">
        <div><b>${S.me.name}</b><span class="role">${S.me.role}</span></div>
        <button class="btn soft small" data-act="logout">${ico('out')} Sign out</button>
      </div>
    </aside>
    <main class="main">
      <div class="mobile-top"><a class="brand" href="/">${raw(LOGO)}<span>${S.cfg.libraryName}</span></a><button class="btn soft small" data-act="logout">Sign out</button></div>
      <div id="view" class="view"></div>
    </main>
  </div>`.s;
  (VIEWS[name] || VIEWS.search)(r.arg);
}

/* ============ sign in ============ */
let authRole = new URLSearchParams(location.search).get('role') || 'student';
if (!['student', 'librarian', 'admin'].includes(authRole)) authRole = 'student';
const ROLE_COPY = {
  student: ['Welcome back, reader.', 'Use your username and password, or the passkey on your phone or laptop.', 'Student ID or username'],
  librarian: ['Open the desk.', 'Sign in to check books in and out and look after every student.', 'Staff username'],
  admin: ['Control room.', 'Settings, uploads, accounts and the activity log live here.', 'Admin username'],
};
function renderPublic() {
  if (route().name === 'search') {
    document.title = (S.cfg.libraryName || 'Library') + ' · Catalogue';
    $('#root').innerHTML = h`<div class="main" style="margin:auto"><div class="row between" style="margin-bottom:1rem"><a class="brand" href="/" style="display:inline-flex;gap:.5rem;align-items:center;font-family:var(--display);font-weight:750;text-decoration:none;color:var(--red)">${raw(LOGO).s && raw(LOGO)}<span style="color:var(--ink)">${S.cfg.libraryName}</span></a><a class="btn small" href="/app">Sign in</a></div><div id="view" class="view"></div></div>`.s;
    $('.brand svg').style.width = '30px';
    return VIEWS.search();
  }
  const [title, sub, ph] = ROLE_COPY[authRole];
  document.title = 'Sign in · ' + (S.cfg.libraryName || 'Library');
  const canPasskey = window.SimpleWebAuthnBrowser && SimpleWebAuthnBrowser.browserSupportsWebAuthn();
  $('#root').innerHTML = h`
  <div class="auth">
    <section class="auth-art" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span>
      <a class="brand" href="/">${raw(LOGO)}${S.cfg.libraryName}</a>
      <div><h2>Every book has a reader waiting.</h2><p>Search, borrow, renew and keep track of what is due. Your fingerprint or face can be your key.</p></div>
      <small style="opacity:.8">Protected sign-in with passkeys</small>
    </section>
    <section class="auth-form-wrap">
      <form class="auth-card" id="login" autocomplete="on" novalidate>
        <a href="/" class="muted small" style="text-decoration:none">← Back to the front page</a>
        <h1>${title}</h1><p class="muted">${sub}</p>
        <div class="role-tabs" role="group" aria-label="Account type">
          ${['student', 'librarian', 'admin'].map((r) => h`<button type="button" data-act="role" data-role="${r}" aria-pressed="${r === authRole}">${r[0].toUpperCase() + r.slice(1)}</button>`)}
        </div>
        <div id="auth-err" class="error hidden" role="alert"></div>
        <label class="field">${ph}<input type="text" name="username" id="u" autocomplete="username webauthn" autocapitalize="none" spellcheck="false" required></label>
        <label class="field">Password<input type="password" name="password" id="p" autocomplete="current-password" required></label>
        <button class="btn" type="submit" id="go">Sign in</button>
        ${canPasskey ? h`<div class="divider">or</div><button class="btn ghost" type="button" data-act="passkey-login">${raw('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 11a5 5 0 0 1 10 0v3M12 11v5M9 14v2.500M15 14v4M5 14c0 3 1 5 2 6M19 14c0 3-.5 4.500-1.500 6"/></svg>')} Sign in with passkey</button><p class="hint">Fingerprint, face unlock or device PIN. Add a passkey after your first sign in.</p>` : h`<p class="hint">This browser cannot use passkeys. Your password works everywhere.</p>`}
        <a class="muted small" href="#search" style="text-align:center">Search the catalogue without signing in</a>
      </form>
    </section>
  </div>`.s;
}
function authError(msg) { const e = $('#auth-err'); if (!e) return toast(msg, 'err'); e.textContent = msg; e.classList.toggle('hidden', !msg); }
async function afterLogin(j) {
  S.me = j.user; S.csrf = j.csrf; S.cfg = { ...S.cfg, ...j.settings };
  const want = route().name;
  if (!want || want === 'search' && S.me.role !== 'student' && false) location.hash = '#' + home();
  if (!location.hash || location.hash === '#') history.replaceState(null, '', '#' + home());
  render();
}
async function passwordLogin(form) {
  const btn = $('#go'); authError(''); setBusy(btn, true, 'Signing in…');
  try { await afterLogin(await api('/auth/login', { method: 'POST', body: { username: form.username.value, password: form.password.value } })); }
  catch (e) { authError(e.message); setBusy(btn, false); }
}
async function passkeyLogin() {
  authError('');
  try {
    const username = ($('#u') || {}).value || '';
    const { options, challengeId } = await api('/auth/passkey/login/options', { method: 'POST', body: { username } });
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
    await afterLogin(await api('/auth/passkey/login/verify', { method: 'POST', body: { challengeId, response } }));
  } catch (e) {
    authError(e.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled or timed out.' : e.message);
  }
}

function renderForcedPassword() {
  $('#root').innerHTML = h`<div class="auth-form-wrap" style="min-height:100vh"><form class="auth-card" id="force"><h1>Choose your own password</h1><p class="muted">Your account was created with a temporary password. Set a new one to continue.</p><div id="auth-err" class="error hidden" role="alert"></div>
    <label class="field">Temporary password<input type="password" name="current" autocomplete="current-password" required></label>
    <label class="field">New password<input type="password" name="next" autocomplete="new-password" minlength="10" required><span class="hint">At least 10 characters with a letter and a number.</span></label>
    <button class="btn" type="submit">Save and continue</button><button class="btn ghost" type="button" data-act="logout">Sign out</button></form></div>`.s;
}

/* ============ shared UI bits ============ */
function openModal(content, { onClose } = {}) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = h`<div class="scrim" data-act="scrim"><div class="modal" role="dialog" aria-modal="true" tabindex="-1"><button class="modal-x" data-act="close-modal" aria-label="Close">×</button>${content}</div></div>`.s;
  S.tmp.prevFocus = document.activeElement; S.tmp.onClose = onClose;
  const m = $('.modal', root); m.focus();
}
function closeModal() {
  const root = $('#modal-root'); if (!root.firstChild) return;
  root.innerHTML = ''; if (S.tmp.prevFocus && S.tmp.prevFocus.focus) S.tmp.prevFocus.focus();
  if (S.tmp.onClose) { const f = S.tmp.onClose; S.tmp.onClose = null; f(); }
}
const emptyState = (msg) => h`<div class="empty"><svg viewBox="0 0 120 80"><rect x="14" y="52" width="92" height="6" rx="3" fill="#f3c4ca"/><rect x="24" y="22" width="14" height="30" rx="3" fill="#ffb3bb"/><rect x="42" y="14" width="14" height="38" rx="3" fill="#d7263d"/><rect x="60" y="26" width="14" height="26" rx="3" fill="#ffd0d5"/><rect x="78" y="18" width="14" height="34" rx="3" fill="#ff8e9a"/></svg><p>${msg}</p></div>`;
const dueBadge = (l) => {
  if (l.returnedAt) return h`<span class="pill ok">Returned ${fmtDate(l.returnedAt)}</span>`;
  if (l.overdue) return h`<span class="pill bad">${l.daysOverdue} ${l.daysOverdue === 1 ? 'day' : 'days'} overdue</span>`;
  const d = daysUntil(l.dueAt);
  return h`<span class="pill ${d <= 2 ? 'warn' : 'ok'}">${d <= 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : `${d} days left`}</span>`;
};
const availPill = (b) => b.available > 0 ? h`<span class="pill ok">${b.available} of ${b.copies} in</span>` : b.copies ? h`<span class="pill warn">All out${b.nextDue ? ' · back ' + fmtDate(b.nextDue) : ''}</span>` : h`<span class="pill">No copies</span>`;
const finesTable = (fines, staff) => fines.length ? h`<div class="table-wrap"><table><thead><tr><th>Book</th><th>Due</th><th>Returned</th><th class="r">Days late</th><th class="r">Billed</th><th class="r">Amount</th><th>Status</th>${staff ? raw('<th></th>') : ''}</tr></thead><tbody>
  ${fines.map((f) => h`<tr><td class="cell-title"><b>${f.title}</b><span>${f.kind === 'lost' ? 'Lost book charge' : 'Overdue fine'}</span></td><td>${fmtDate(f.dueAt)}</td><td>${f.returnedAt ? fmtDate(f.returnedAt) : '—'}</td><td class="r num">${f.daysOverdue}</td>
  <td class="r num small muted">${f.kind === 'lost' ? '—' : `${f.billableDays} × ${money(f.ratePerDay)}`}</td><td class="r num"><b>${money(f.amount)}</b></td>
  <td><span class="pill ${f.status === 'unpaid' ? 'bad' : 'ok'}">${f.status === 'unpaid' ? 'Unpaid' : f.status === 'waived' ? 'Waived' : 'Paid'}</span></td>
  ${staff ? h`<td class="r">${f.status === 'unpaid' ? h`<button class="btn small soft" data-act="pay-fine" data-id="${f.id || f._id}">Mark paid</button>${S.me.role === 'admin' ? h` <button class="btn small ghost" data-act="waive-fine" data-id="${f.id || f._id}">Waive</button>` : ''}` : ''}</td>` : ''}</tr>`)}</tbody></table></div>` : emptyState('No fines. Lovely.');

/* ============ views ============ */
const VIEWS = {};

/* ---------- catalogue (OPAC) ---------- */
const Q = { q: '', field: 'all', subject: '', language: '', available: false, page: 1 };
VIEWS.search = () => {
  view(h`
  <div class="page-head"><div><h1>Catalogue</h1><p>Search ${S.cfg.libraryName} by title, author, subject, ISBN or call number.</p></div></div>
  <form class="searchbar" id="searchform" role="search">
    <input type="search" id="q" placeholder="Search in any script or transliteration" value="${Q.q}" aria-label="Search the catalogue" autocomplete="off">
    <select id="field" aria-label="Search in">${[['all', 'Everything'], ['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'], ['isbn', 'ISBN'], ['callno', 'Call number']].map(([v, l]) => h`<option value="${v}" ${Q.field === v ? raw('selected') : ''}>${l}</option>`)}</select>
    <button class="btn" type="submit">${ico('search')} Search</button>
  </form>
  <div id="catalog-sync" class="hint" role="status" style="margin-top:.7rem"></div>
  <div class="filters" id="filters"></div>
  <div id="results"></div>`);
  runSearch();
};
async function runSearch() {
  const box = $('#results'); if (!box) return;
  const p = new URLSearchParams({ q: Q.q, field: Q.field, subject: Q.subject, language: Q.language, available: Q.available ? '1' : '0', page: Q.page });
  try {
    const showNew = !Q.q && !Q.subject && !Q.language && !Q.available;
    const [d, fresh] = await Promise.all([api('/opac/search?' + p), showNew && Q.page === 1 ? api('/opac/new') : null]);
    renderSearchResults(d, fresh, false);
    syncOfflineCatalogue().then((cached) => showCatalogueSync('online', cached.syncedAt)).catch((e) => {
      showCatalogueSync('sync-error', null, e.message);
    });
  } catch (e) {
    if (navigator.onLine !== false && !(e instanceof TypeError)) {
      box.innerHTML = h`<div class="error" style="margin-top:1rem">${e.message}</div>`.s;
      return;
    }
    try {
      const cached = await getOfflineCatalogue();
      if (!cached.books.length) throw new Error('No offline catalogue is saved on this device yet. Connect once and open the catalogue to sync it.');
      const d = searchOfflineCatalogue(cached);
      const showNew = !Q.q && !Q.subject && !Q.language && !Q.available && Q.page === 1;
      const fresh = showNew ? { results: [...cached.books].sort((a, b) => b.id - a.id).slice(0, 8) } : null;
      renderSearchResults(d, fresh, true);
      showCatalogueSync('offline', cached.syncedAt);
    } catch (offlineError) {
      box.innerHTML = h`<div class="error" style="margin-top:1rem">${offlineError.message}</div>`.s;
      showCatalogueSync('offline-error');
    }
  }
}
function showCatalogueSync(mode, syncedAt, error) {
  const status = $('#catalog-sync');
  if (!status) return;
  const when = syncedAt ? new Date(syncedAt).toLocaleString() : '';
  if (mode === 'offline') status.textContent = `Offline catalogue · Last synced ${when || 'unknown'}. Availability may have changed.`;
  else if (mode === 'offline-error') status.textContent = 'Offline catalogue could not be opened on this device.';
  else if (mode === 'syncing') status.textContent = 'Updating the catalogue saved on this device…';
  else if (mode === 'sync-error') status.textContent = `Online search works, but the offline catalogue could not update: ${error}`;
  else status.innerHTML = h`Offline search is ready · Last synced ${when || 'just now'} <button class="btn ghost small" data-act="sync-catalogue">Update now</button>`.s;
}
function renderSearchResults(d, fresh, offline) {
  const box = $('#results'); if (!box) return;
  const f = $('#filters');
  f.innerHTML = h`<button class="chip" data-act="avail" aria-pressed="${Q.available}">In now</button>
    ${d.facets.languages.length > 1 ? d.facets.languages.map((l) => h`<button class="chip" data-act="lang" data-v="${l.name}" aria-pressed="${Q.language === l.name}">${l.name} <small>${l.count}</small></button>`) : ''}
    ${d.facets.subjects.map((s) => h`<button class="chip" data-act="subject" data-v="${s.name}" aria-pressed="${Q.subject === s.name}">${s.name} <small>${s.count}</small></button>`)}
    ${Q.q || Q.subject || Q.language || Q.available ? h`<button class="chip" data-act="clear-filters">Clear all</button>` : ''}`.s;
  const grid = (list) => h`<div class="books">${list.map((b, i) => h`<button class="book" data-act="open-book" data-id="${b.id}" style="--i:${i}">${cover(b.title)}<div class="book-info"><h3>${b.title}</h3><span class="by">${b.author}${b.year ? ' · ' + b.year : ''}</span><span class="muted small">${b.callNumber}</span><div>${availPill(b)}</div></div></button>`)}</div>`;
  const pages = Math.ceil(d.total / d.per);
  box.innerHTML = h`
    ${fresh ? h`<h2 style="margin:1.6rem 0 0;font-size:1.3rem">New arrivals</h2>${grid(fresh.results)}<h2 style="margin:2rem 0 0;font-size:1.3rem">All books</h2>` : h`<p class="muted" style="margin-top:1.2rem"><b>${d.total}</b> ${d.total === 1 ? 'result' : 'results'}${offline ? ' · saved catalogue' : ''}</p>`}
    ${d.results.length ? grid(d.results) : emptyState('Nothing matched. Try fewer words or clear the filters.')}
    ${pages > 1 ? h`<div class="pager"><button class="btn ghost small" data-act="page" data-v="${Q.page - 1}" ${Q.page <= 1 ? raw('disabled') : ''}>Previous</button><span class="muted">Page ${d.page} of ${pages}</span><button class="btn ghost small" data-act="page" data-v="${Q.page + 1}" ${Q.page >= pages ? raw('disabled') : ''}>Next</button></div>` : ''}`.s;
}
async function openBook(id) {
  try {
    let b, offline = false;
    try { b = await api('/opac/biblio/' + id); }
    catch (e) {
      if (navigator.onLine !== false && !(e instanceof TypeError)) throw e;
      const cached = await getOfflineCatalogue();
      b = cached.books.find((book) => String(book.id) === String(id));
      if (!b) throw new Error('This book is not in the saved offline catalogue.');
      offline = true;
      b = { ...b, items: b.items || [], searchAliases: b.searchAliases || [], holds: 0 };
    }
    const staff = S.me && S.me.role !== 'student', stu = S.me && S.me.role === 'student';
    openModal(h`
      <h2>${b.title}</h2><p class="muted">${b.author}</p>
      ${offline ? h`<p class="hint">Saved catalogue record. Availability may have changed; reservations need an internet connection.</p>` : ''}
      <div class="detail-top">${cover(b.title, true)}
        <div class="grow stack" style="gap:.8rem">
          <div class="row">${availPill(b)} ${b.holds ? h`<span class="pill">${b.holds} waiting</span>` : ''}</div>
          <dl class="kv"><dt>Call number</dt><dd>${b.callNumber || '—'}</dd><dt>Published</dt><dd>${[b.publisher, b.year].filter(Boolean).join(', ') || '—'}</dd><dt>Language</dt><dd>${b.language}</dd><dt>ISBN</dt><dd>${b.isbn || '—'}</dd><dt>Subjects</dt><dd>${b.subjects.join(', ') || '—'}</dd><dt>Also searched as</dt><dd>${b.searchAliases.join(', ') || '—'}</dd></dl>
        </div></div>
      ${b.description ? h`<p>${b.description}</p>` : ''}
      <h3 style="margin-top:1.2rem;font-size:1.05rem">Copies and shelf numbers</h3>
      <div class="copies">${b.items.map((i) => h`<div class="copy"><span><b>Shelf number: ${i.shelfNumber || 'Not recorded'}</b><span class="muted small"> · ${i.location || 'Library'}</span>${staff && !offline ? h` <span class="muted small">· ${i.barcode}</span><label class="field small" style="max-width:180px;margin-top:.4rem">Edit shelf number<input type="text" data-shelf-item="${i.barcode}" value="${i.shelfNumber || ''}" maxlength="40"></label>` : ''}</span>
        <span class="row" style="gap:.4rem">${i.status === 'available' ? h`<span class="pill ok">On the shelf</span>` : i.status === 'checked_out' ? h`<span class="pill warn">Out${i.dueAt ? ' · due ' + fmtDate(i.dueAt) : ''}</span>` : i.status === 'on_hold' ? h`<span class="pill">On hold shelf</span>` : h`<span class="pill bad">${i.status.replace('_', ' ')}</span>`}
        ${staff && !offline && i.status !== 'checked_out' ? h`<select data-item="${i.barcode}" style="width:auto;padding:.3rem .6rem;border-radius:10px" aria-label="Change status">${['available', 'repair', 'lost', 'withdrawn'].map((s) => h`<option value="${s}" ${i.status === s ? raw('selected') : ''}>${s}</option>`)}</select>` : ''}</span></div>`)}</div>
      <div class="row" style="margin-top:1.4rem">
        ${stu && !offline ? (b.myHold ? h`<button class="btn soft" data-act="cancel-hold" data-id="${b.myHold._id}" data-bib="${b.id}">${b.myHold.status === 'waiting' ? 'Cancel pickup' : 'Cancel reservation'}</button>${b.myHold.status === 'waiting' ? h`<span class="pill ok">Ready at the desk until ${fmtDate(b.myHold.expiresAt)}</span>` : h`<span class="pill">In the queue</span>`}` : h`<button class="btn" data-act="reserve" data-id="${b.id}">${b.available > 0 ? 'Reserve for pickup' : 'Join the queue'}</button>`) : ''}
        ${stu && !offline ? h`<button class="btn ghost" data-act="shelf" data-id="${b.id}">${b.saved ? '★ In my list' : '☆ Save to my list'}</button>` : ''}
        ${staff && !offline ? h`<button class="btn soft" data-act="add-copy" data-id="${b.id}">${ico('plus')} Add a copy</button>` : ''}
        ${!S.me && !offline ? h`<a class="btn" href="/app">Sign in to reserve</a>` : ''}
      </div>`);
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- student: my library ---------- */
VIEWS.account = async () => {
  view(h`<div class="page-head"><div><h1>My library</h1><p>Hello, ${S.me.name.split(' ')[0]}. Here is everything you have borrowed.</p></div>${!isStandalone() ? h`<div class="row"><button class="btn soft" data-act="install-app">${ico('install')} Install as app</button></div>` : ''}</div><div id="acct"><div class="empty">Loading…</div></div>`);
  try {
    const d = await api('/me/summary'); S.tmp.acct = d;
    const tab = S.tmp.acctTab || 'loans';
    const overdue = d.loans.filter((l) => l.overdue).length;
    $('#acct').innerHTML = h`
    <div class="grid cols-3">
      <div class="stat"><b>${d.loans.length}<small style="font-size:1rem;color:var(--muted)"> / ${d.limits.maxLoans}</small></b><span>Books borrowed</span></div>
      <div class="stat ${overdue ? 'alert' : 'good'}"><b>${overdue}</b><span>Overdue</span></div>
      <div class="stat ${d.unpaid ? 'alert' : ''}"><b>${money(d.unpaid)}</b><span>Unpaid fines${d.accruing ? ` · ${money(d.accruing)} building up` : ''}</span></div>
    </div>
    ${d.unpaid >= d.limits.blockAt ? h`<div class="error" style="margin-top:1rem">Your unpaid fines are ${money(d.limits.blockAt)} or more, so new loans are paused. Please pay at the desk.</div>` : ''}
    <div class="tabs" role="tablist" style="margin:1.4rem 0 1rem">${[['loans', 'Borrowed'], ['holds', `Reserved (${d.holds.length})`], ['fines', 'Fines'], ['history', 'History'], ['shelf', 'Reading list']].map(([k, l]) => h`<button role="tab" data-act="acct-tab" data-v="${k}" aria-selected="${tab === k}">${l}</button>`)}</div>
    <div id="tabbody" class="card"></div>`.s;
    await acctTab(tab);
  } catch (e) { $('#acct').innerHTML = h`<div class="error">${e.message}</div>`.s; }
};
async function acctTab(tab) {
  S.tmp.acctTab = tab; const d = S.tmp.acct, box = $('#tabbody'); if (!box) return;
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.v === tab));
  if (tab === 'loans') box.innerHTML = (d.loans.length ? h`<div class="table-wrap"><table><thead><tr><th>Book</th><th>Borrowed</th><th>Due</th><th>Status</th><th class="r"></th></tr></thead><tbody>${d.loans.map((l) => h`<tr><td class="cell-title"><b>${l.title}</b><span>${l.author}</span></td><td>${fmtDate(l.outAt)}</td><td>${fmtDate(l.dueAt)}</td><td>${dueBadge(l)}${l.overdue && l.accruedFine ? h` <span class="small muted">${money(l.accruedFine)} so far</span>` : ''}</td>
    <td class="r">${l.canRenew ? h`<button class="btn small soft" data-act="renew" data-id="${l.id}">Renew (${l.renewalsLeft} left)</button>` : h`<span class="muted small">${l.overdue ? 'Return first' : l.renewalsLeft === 0 ? 'No renewals left' : 'Reserved by others'}</span>`}</td></tr>`)}</tbody></table></div>` : emptyState('You have nothing borrowed. Find something good in the catalogue.')).s;
  if (tab === 'holds') box.innerHTML = (d.holds.length ? h`<div class="table-wrap"><table><thead><tr><th>Book</th><th>Reserved</th><th>Status</th><th></th></tr></thead><tbody>${d.holds.map((x) => h`<tr><td class="cell-title"><b>${x.title}</b><span>${x.author}</span></td><td>${fmtDate(x.createdAt)}</td><td>${x.status === 'waiting' ? h`<span class="pill ok">Ready · collect by ${fmtDate(x.expiresAt)}</span>` : h`<span class="pill">In the queue</span>`}</td><td class="r"><button class="btn small ghost" data-act="cancel-hold" data-id="${x.id}">Cancel</button></td></tr>`)}</tbody></table></div>` : emptyState('No reservations.')).s;
  if (tab === 'fines') box.innerHTML = h`${d.accruing ? h`<div class="fine-box" style="margin-bottom:1rem"><div><span class="muted">Building up on overdue books</span><br><b>${money(d.accruing)}</b></div><p class="small muted" style="max-width:26rem">Charged when you return the books. Return or renew on time to stop it growing.</p></div>` : ''}${finesTable(d.fines, false)}`.s;
  if (tab === 'history') { box.innerHTML = '<div class="empty">Loading…</div>'; const x = await api('/me/history'); box.innerHTML = (x.loans.length ? h`<div class="table-wrap"><table><thead><tr><th>Book</th><th>Borrowed</th><th>Returned</th></tr></thead><tbody>${x.loans.map((l) => h`<tr><td class="cell-title"><b>${l.title}</b><span>${l.author}</span></td><td>${fmtDate(l.outAt)}</td><td>${fmtDate(l.returnedAt)}</td></tr>`)}</tbody></table></div>` : emptyState('Your reading history will appear here.')).s; }
  if (tab === 'shelf') { box.innerHTML = '<div class="empty">Loading…</div>'; const x = await api('/me/shelf'); box.innerHTML = (x.results.length ? h`<div class="books" style="margin:0">${x.results.map((b) => h`<button class="book" data-act="open-book" data-id="${b.id}">${cover(b.title)}<div class="book-info"><h3>${b.title}</h3><span class="by">${b.author}</span><div>${availPill(b)}</div></div></button>`)}</div>` : emptyState('Save books from the catalogue to build your reading list.')).s; }
}

/* ---------- staff: dashboard ---------- */
VIEWS.dashboard = async () => {
  view(h`<div class="page-head"><div><h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${S.me.name.split(' ')[0]}</h1><p>Here is how the library looks right now.</p></div><div class="row">${!isStandalone() ? h`<button class="btn soft" data-act="install-app">${ico('install')} Install as app</button>` : ''}<a class="btn" href="#desk">${ico('desk')} Open the desk</a></div></div><div id="dash"><div class="empty">Loading…</div></div>`);
  try {
    const [s, o] = await Promise.all([api('/staff/stats'), api('/staff/loans?mode=overdue')]);
    const days = []; for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); const k = d.toISOString().slice(0, 10); days.push({ k, l: d.toLocaleDateString(undefined, { weekday: 'short' }), c: (s.loansPerDay.find((x) => x.d === k) || {}).c || 0 }); }
    const mx = Math.max(1, ...days.map((d) => d.c));
    $('#dash').innerHTML = h`
    <div class="grid cols-3">
      <div class="stat"><b>${s.openLoans}</b><span>Books out</span></div>
      <div class="stat ${s.overdue ? 'alert' : 'good'}"><b>${s.overdue}</b><span>Overdue</span></div>
      <div class="stat"><b>${s.dueToday}</b><span>Due today</span></div>
      <div class="stat"><b>${s.holdsWaiting}</b><span>On the hold shelf${s.holdsPending ? ` · ${s.holdsPending} queued` : ''}</span></div>
      <div class="stat ${s.unpaidFines ? 'alert' : ''}"><b>${money(s.unpaidFines)}</b><span>Unpaid fines · ${s.unpaidCount} ${s.unpaidCount === 1 ? 'bill' : 'bills'}</span></div>
      <div class="stat"><b>${s.students}</b><span>Students · ${s.titles} titles · ${s.items} copies</span></div>
    </div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card"><h2>Loans this week</h2><div class="bars">${days.map((d, i) => h`<div class="bar"><b>${d.c}</b><i style="height:${Math.max(4, (d.c / mx) * 100)}%;animation-delay:${i * 60}ms"></i><small>${d.l}</small></div>`)}</div></div>
      <div class="card"><h2>Most overdue</h2>${o.loans.length ? h`<div class="stack" style="gap:.6rem">${o.loans.slice().sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, 5).map((l) => h`<div class="row between"><div class="cell-title"><b>${l.title}</b><span>${l.patronName} · ${l.cardNumber}</span></div>${dueBadge(l)}</div>`)}</div><p style="margin-top:1rem"><a href="#loans">See all loans →</a></p>` : emptyState('Nothing is overdue.')}</div>
    </div>`.s;
  } catch (e) { $('#dash').innerHTML = h`<div class="error">${e.message}</div>`.s; }
};

/* ---------- staff: desk ---------- */
VIEWS.desk = () => {
  const log = S.tmp.deskLog || [];
  view(h`<div class="page-head"><div><h1>Circulation desk</h1><p>Scan or type. Press Enter to submit.</p></div></div>
  <div class="grid cols-2">
    <form class="card stack" id="checkout"><h2>Check out</h2>
      <label class="field">Student card number<input type="text" name="card" id="card" placeholder="S20260001" autocomplete="off" autocapitalize="characters" required></label>
      <label class="field">Book barcode<input type="text" name="barcode" placeholder="B000001" autocomplete="off" autocapitalize="characters" required></label>
      <label class="check"><input type="checkbox" name="override"> Override blocks (fines, queue)</label>
      <button class="btn" type="submit">Check out</button><div id="out-result"></div></form>
    <form class="card stack" id="checkin"><h2>Check in</h2>
      <label class="field">Book barcode<input type="text" name="barcode" id="inbc" placeholder="B000001" autocomplete="off" autocapitalize="characters" required></label>
      <p class="hint">Late returns create a fine automatically. If a student is waiting, you will be told which shelf to use.</p>
      <button class="btn" type="submit">Check in</button><div id="in-result"></div></form>
  </div>
  <div class="card" style="margin-top:1rem"><h2>This session</h2><div id="deskLog">${deskLogHtml(log)}</div></div>`);
  $('#card').focus();
};
const deskLogHtml = (log) => log.length ? h`<div class="stack" style="gap:.5rem">${log.map((x) => h`<div class="row between"><span>${x.text}</span><span class="muted small">${x.at}</span></div>`)}</div>` : h`<p class="muted">Nothing yet.</p>`;
const deskLog = (text) => { S.tmp.deskLog = [{ text, at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...(S.tmp.deskLog || [])].slice(0, 12); const d = $('#deskLog'); if (d) d.innerHTML = deskLogHtml(S.tmp.deskLog).s; };

/* ---------- staff: patrons ---------- */
VIEWS.patrons = async () => {
  view(h`<div class="page-head"><div><h1>Students</h1><p>Open a profile to see loans, fines and history.</p></div><button class="btn" data-act="new-patron">${ico('plus')} Add student</button></div>
  <form class="searchbar" id="patronsearch" role="search"><input type="search" id="pq" placeholder="Name, card number, class or department" aria-label="Search students" value="${S.tmp.pq || ''}" autocomplete="off"><button class="btn" type="submit">${ico('search')} Find</button></form><div id="plist" class="card" style="margin-top:1.2rem"></div>`);
  loadPatrons();
};
async function loadPatrons() {
  const box = $('#plist'); if (!box) return;
  try {
    const { patrons } = await api('/staff/patrons?q=' + encodeURIComponent(S.tmp.pq || ''));
    box.innerHTML = (patrons.length ? h`<div class="table-wrap"><table><thead><tr><th>Student</th><th>Card</th><th>Course</th><th class="r">Out</th><th class="r">Overdue</th><th class="r">Owes</th></tr></thead><tbody>${patrons.map((p) => h`<tr style="cursor:pointer" data-act="open-patron" data-id="${p.id}"><td><div class="row" style="flex-wrap:nowrap"><span class="avatar" style="width:38px;height:38px;font-size:1rem">${p.name[0]}</span><div class="cell-title"><b><a href="#patron/${p.id}">${p.name}</a></b><span>${p.username}${p.active ? '' : ' · deactivated'}</span></div></div></td><td class="num">${p.cardNumber}</td><td>${[p.department, p.className].filter(Boolean).join(' · ') || '—'}</td><td class="r num">${p.loans}</td><td class="r">${p.overdue ? h`<span class="pill bad">${p.overdue}</span>` : '—'}</td><td class="r num">${p.owed ? h`<b style="color:var(--bad)">${money(p.owed)}</b>` : '—'}</td></tr>`)}</tbody></table></div>` : emptyState('No students found.')).s;
  } catch (e) { box.innerHTML = h`<div class="error">${e.message}</div>`.s; }
}
VIEWS.patron = async (id) => {
  view(h`<div class="empty">Loading…</div>`);
  try {
    const d = await api('/staff/patrons/' + encodeURIComponent(id)); const p = d.patron;
    view(h`<p><a href="#patrons">← All students</a></p>
    <div class="page-head" style="margin-top:.6rem"><div class="row" style="flex-wrap:nowrap"><span class="avatar">${p.name[0]}</span><div><h1 style="font-size:2rem">${p.name}</h1><p>${p.cardNumber} · ${[p.department, p.className].filter(Boolean).join(' · ') || 'No course set'}${p.active ? '' : ' · deactivated'}</p></div></div>
      <div class="row"><a class="btn" href="#desk" data-act="desk-for" data-card="${p.cardNumber}">Check out a book</a></div></div>
    <div class="grid cols-3"><div class="stat"><b>${d.loans.length}</b><span>Borrowed now</span></div><div class="stat ${d.loans.some((l) => l.overdue) ? 'alert' : 'good'}"><b>${d.loans.filter((l) => l.overdue).length}</b><span>Overdue</span></div><div class="stat ${d.owed ? 'alert' : ''}"><b>${money(d.owed)}</b><span>Unpaid${d.accruing ? ` · ${money(d.accruing)} building up` : ''}</span></div></div>
    <div class="card" style="margin-top:1rem"><h2>Borrowed now</h2>${d.loans.length ? h`<div class="table-wrap"><table><thead><tr><th>Book</th><th>Barcode</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>${d.loans.map((l) => h`<tr><td class="cell-title"><b>${l.title}</b><span>${l.author}</span></td><td class="num">${l.barcode}</td><td>${fmtDate(l.dueAt)}</td><td>${dueBadge(l)}${l.accruedFine ? h` <span class="small muted">${money(l.accruedFine)} so far</span>` : ''}</td><td class="r">${l.canRenew ? h`<button class="btn small soft" data-act="staff-renew" data-id="${l.id}">Renew</button>` : ''}</td></tr>`)}</tbody></table></div>` : emptyState('Nothing borrowed.')}</div>
    <div class="card" style="margin-top:1rem"><h2>Fines</h2>${finesTable(d.fines, true)}</div>
    <div class="grid cols-2" style="margin-top:1rem"><div class="card"><h2>Reservations</h2>${d.holds.length ? h`<div class="stack" style="gap:.5rem">${d.holds.map((x) => h`<div class="row between"><span>Title #${x.biblioId}</span><span class="pill ${x.status === 'waiting' ? 'ok' : ''}">${x.status === 'waiting' ? 'Ready ' + (x.barcode || '') : 'Queued'}</span></div>`)}</div>` : h`<p class="muted">None.</p>`}</div>
    <div class="card"><h2>Recent returns</h2>${d.history.length ? h`<div class="stack" style="gap:.5rem">${d.history.slice(0, 8).map((l) => h`<div class="row between"><span>${l.title}</span><span class="muted small">${fmtDate(l.returnedAt)}</span></div>`)}</div>` : h`<p class="muted">No history yet.</p>`}</div></div>
    <p class="muted small" style="margin-top:1rem">Joined ${fmtDate(p.joined)} · Last sign-in ${p.lastLogin ? fmtTime(p.lastLogin) : 'never'} · ${p.passkeys} passkey${p.passkeys === 1 ? '' : 's'}</p>`);
  } catch (e) { view(h`<div class="error">${e.message}</div>`); }
};

/* ---------- staff: loans + holds ---------- */
VIEWS.loans = async () => {
  const mode = S.tmp.loanMode || 'out';
  view(h`<div class="page-head"><div><h1>Loans</h1><p>Everything currently out of the library.</p></div><div class="tabs">${[['out', 'All out'], ['overdue', 'Overdue']].map(([k, l]) => h`<button data-act="loan-mode" data-v="${k}" aria-selected="${mode === k}">${l}</button>`)}</div></div><div class="card" id="loanbox">Loading…</div>`);
  try {
    const { loans } = await api('/staff/loans?mode=' + mode);
    $('#loanbox').innerHTML = (loans.length ? h`<div class="table-wrap"><table><thead><tr><th>Book</th><th>Student</th><th>Due</th><th>Status</th><th class="r">Fine so far</th></tr></thead><tbody>${loans.map((l) => h`<tr><td class="cell-title"><b>${l.title}</b><span>${l.barcode}</span></td><td class="cell-title"><b><a href="#patron/${l.patronId}">${l.patronName}</a></b><span>${l.cardNumber}</span></td><td>${fmtDate(l.dueAt)}</td><td>${dueBadge(l)}${l.presumedLost ? h` <span class="pill bad">Likely lost</span>` : ''}</td><td class="r num">${l.accruedFine ? money(l.accruedFine) : '—'}</td></tr>`)}</tbody></table></div>` : emptyState(mode === 'overdue' ? 'No overdue books.' : 'No books are out.')).s;
  } catch (e) { $('#loanbox').innerHTML = h`<div class="error">${e.message}</div>`.s; }
};
VIEWS.holds = async () => {
  view(h`<div class="page-head"><div><h1>Holds</h1><p>Reserved books and the hold shelf.</p></div></div><div class="card" id="holdbox">Loading…</div>`);
  try {
    const { holds } = await api('/staff/holds');
    $('#holdbox').innerHTML = (holds.length ? h`<div class="table-wrap"><table><thead><tr><th>Book</th><th>Student</th><th>Reserved</th><th>Status</th></tr></thead><tbody>${holds.map((x) => h`<tr><td class="cell-title"><b>${x.title}</b></td><td>${x.patronName}</td><td>${fmtDate(x.createdAt)}</td><td>${x.status === 'waiting' ? h`<span class="pill ok">On hold shelf · ${x.barcode} · until ${fmtDate(x.expiresAt)}</span>` : h`<span class="pill">Queued</span>`}</td></tr>`)}</tbody></table></div>` : emptyState('No holds right now.')).s;
  } catch (e) { $('#holdbox').innerHTML = h`<div class="error">${e.message}</div>`.s; }
};

/* ---------- admin: settings, uploads ---------- */
const SET_FIELDS = {
  Library: [['libraryName', 'Library name', 'text'], ['tagline', 'Tagline', 'text'], ['currency', 'Currency symbol', 'text']],
  Loans: [['loanDays', 'Loan period (days)', 'number'], ['maxRenewals', 'Renewals allowed', 'number'], ['maxLoans', 'Books per student', 'number'], ['maxHolds', 'Reservations per student', 'number'], ['holdWaitDays', 'Hold shelf wait (days)', 'number']],
  Fines: [['graceDays', 'Grace period (days)', 'number'], ['finePerDay', 'Fine per day', 'number'], ['maxFine', 'Maximum fine per book', 'number'], ['blockCheckoutAtFines', 'Pause new loans at unpaid total', 'number'], ['lostAfterDays', 'Treat as lost after (days late)', 'number'], ['lostCharge', 'Lost book charge', 'number']],
};
VIEWS.inventory = async () => {
  const q = S.tmp.inventoryQ || '';
  view(h`<div class="page-head"><div><h1>Stock check</h1><p>Mark each physical copy found or missing. This is separate from its loan status.</p></div></div>
    <form class="searchbar" id="inventorysearch" role="search"><input type="search" name="q" value="${q}" placeholder="Search title, author or barcode" aria-label="Search stock"><button class="btn" type="submit">${ico('search')} Find</button></form>
    <div id="inventory-counts" class="filters" style="margin-top:1rem"></div><div class="card" id="inventory-list" style="margin-top:1rem">Loading…</div>`);
  loadInventory();
};
async function loadInventory() {
  const box = $('#inventory-list');
  if (!box) return;
  const status = S.tmp.inventoryStatus || 'all';
  const p = new URLSearchParams({ q: S.tmp.inventoryQ || '', status, page: S.tmp.inventoryPage || 1 });
  try {
    const d = await api('/admin/inventory?' + p);
    $('#inventory-counts').innerHTML = h`${[['all', 'All copies', d.counts.total], ['unchecked', 'Not checked', d.counts.unchecked], ['available', 'Available', d.counts.available], ['missing', 'Missing', d.counts.missing]].map(([key, label, count]) => h`<button class="chip" data-act="inventory-filter" data-v="${key}" aria-pressed="${status === key}">${label} <small>${count}</small></button>`)}`.s;
    const pages = Math.ceil(d.total / d.per);
    box.innerHTML = d.items.length ? h`<div class="table-wrap"><table><thead><tr><th>Title / author</th><th>Barcode / location</th><th>Loan status</th><th>Physical check</th></tr></thead><tbody>${d.items.map((item) => h`<tr>
      <td class="cell-title"><b>${item.title}</b><span>${item.author || 'Author not recorded'}</span></td>
      <td class="cell-title"><b>${item.barcode}</b><span>${item.shelf_number || 'Shelf number not recorded'} · ${item.location}</span></td>
      <td>${String(item.item_status).replace('_', ' ')}</td>
      <td><div class="row" style="gap:.8rem">
        <label class="check"><input type="checkbox" data-inventory-id="${item.id}" data-inventory-status="available" ${item.inventory_status === 'available' ? raw('checked') : ''}> Available</label>
        <label class="check"><input type="checkbox" data-inventory-id="${item.id}" data-inventory-status="missing" ${item.inventory_status === 'missing' ? raw('checked') : ''}> Missing</label>
      </div></td></tr>`)}</tbody></table></div>${pages > 1 ? h`<div class="pager"><button class="btn ghost small" data-act="inventory-page" data-v="${Number(d.page) - 1}" ${d.page <= 1 ? raw('disabled') : ''}>Previous</button><span class="muted">Page ${d.page} of ${pages} · ${d.total} copies</span><button class="btn ghost small" data-act="inventory-page" data-v="${Number(d.page) + 1}" ${d.page >= pages ? raw('disabled') : ''}>Next</button></div>` : ''}`.s
      : emptyState(status === 'missing' ? 'No copies marked missing.' : status === 'unchecked' ? 'All copies in this view have been checked.' : 'No copies matched.');
  } catch (e) { box.innerHTML = h`<div class="error">${e.message}</div>`.s; }
}
VIEWS.settings = async () => {
  view(h`<div class="page-head"><div><h1>Settings</h1><p>Loan rules, fines and data uploads.</p></div></div><div id="setbox" class="stack"><div class="empty">Loading…</div></div>`);
  try {
    const { settings: s } = await api('/admin/settings'); S.tmp.settings = s;
    $('#setbox').innerHTML = h`
    <form id="settingsform" class="stack">
      ${Object.entries(SET_FIELDS).map(([group, fields]) => h`<div class="card"><h2>${group}</h2><div class="form-grid">${fields.map(([k, label, type]) => h`<label class="field">${label}<input type="${type}" name="${k}" value="${s[k]}" ${type === 'number' ? raw('min="0" step="1" inputmode="numeric"') : raw('maxlength="120"')} required></label>`)}</div>
        ${group === 'Fines' ? h`<div class="fine-box" style="margin-top:1.2rem"><div><span class="muted">Preview</span><br><span id="finepreview"></span></div><label class="field" style="width:150px">Days late<input type="number" id="previewdays" value="10" min="0" max="365"></label></div>` : ''}</div>`)}
      <div class="card"><h2>Access</h2><label class="check"><input type="checkbox" name="publicSearch" ${s.publicSearch ? raw('checked') : ''}> Let anyone search the catalogue without signing in</label></div>
      <div class="row"><button class="btn" type="submit">Save settings</button></div>
    </form>
    <div class="card"><h2>Upload data</h2><p class="muted" style="margin-bottom:1rem">Import many records at once from a CSV file. Existing titles are matched by ISBN or title and author, then extra copies are added.</p>
      <div class="grid cols-2">
        <div class="dropzone" data-drop="catalog"><b>Books and copies</b><p class="hint" style="margin:.4rem 0 1rem">Columns: title, author, search_aliases (alternate scripts / transliterations separated by |), isbn, publisher, year, language, subjects, call_number, copies, location, shelf_number, description</p><input type="file" id="f-catalog" accept=".csv,text/csv" class="sr-only"><label for="f-catalog" class="btn soft small" style="cursor:pointer">${ico('plus')} Choose CSV</label> <button type="button" class="btn ghost small" data-act="template" data-v="catalog">Download template</button></div>
        <div class="dropzone" data-drop="patrons"><b>Students</b><p class="hint" style="margin:.4rem 0 1rem">Columns: name, card_number, username, email, department, class</p><input type="file" id="f-patrons" accept=".csv,text/csv" class="sr-only"><label for="f-patrons" class="btn soft small" style="cursor:pointer">${ico('plus')} Choose CSV</label> <button type="button" class="btn ghost small" data-act="template" data-v="patrons">Download template</button></div>
      </div><div id="importresult" style="margin-top:1rem"></div></div>
    <div class="card"><h2>Export and backup</h2><div class="row"><a class="btn soft" href="/api/admin/export/catalog.csv" download>Catalogue (CSV)</a><a class="btn soft" href="/api/admin/export/backup.json" download>Full backup (JSON)</a></div><p class="hint" style="margin-top:.7rem">Backups leave out passwords and passkeys.</p></div>
    <div class="card"><h2>Desktop application</h2><p class="muted" style="margin-bottom:1rem">Run the library portal as a standalone desktop app with its own window, taskbar icon, and offline catalogue shell.</p>
      <div class="row">${isStandalone() ? h`<span class="pill ok">✓ Installed as application</span>` : h`<button class="btn" type="button" data-act="install-app">${ico('install')} Install as desktop app</button>`}<a class="btn soft" href="#install">Installation guide</a></div>
    </div>`.s;
    updateFinePreview();
  } catch (e) { $('#setbox').innerHTML = h`<div class="error">${e.message}</div>`.s; }
};
function updateFinePreview() {
  const f = $('#settingsform'); if (!f || !$('#finepreview')) return;
  const n = (k) => Number(f[k].value) || 0, days = Number($('#previewdays').value) || 0, cur = f.currency.value;
  const bill = Math.max(0, days - n('graceDays')), amt = Math.min(bill * n('finePerDay'), n('maxFine'));
  $('#finepreview').innerHTML = h`A book returned <b>${days}</b> days late costs <b style="color:var(--red)">${cur}${amt}</b> <span class="muted">(${bill} billable days × ${cur}${n('finePerDay')}, max ${cur}${n('maxFine')})</span>`.s;
}
const TEMPLATES = {
  catalog: 'title,author,search_aliases,isbn,publisher,year,language,subjects,call_number,copies,location,shelf_number,description\r\n"Example Book","A. Writer","Example alternate title|Example transliteration",9780000000002,"Example Press",2024,English,"Fiction|Classics","823 WRI",2,"Main Shelves","823 WRI 001","A short summary."\r\n',
  patrons: 'name,card_number,username,email,department,class\r\n"Example Student",S20260101,example.student,example@example.org,"BSc Physics","Year 1"\r\n',
};
async function runImport(kind, file) {
  const out = $('#importresult');
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return toast('Please choose a file under 5 MB', 'err');
  out.innerHTML = '<p class="muted">Uploading…</p>';
  try {
    const csv = await file.text();
    const r = await api('/admin/import/' + kind, { method: 'POST', body: { csv } });
    S.tmp.creds = r.credentials || null;
    out.innerHTML = h`<div class="desk-result"><b>${kind === 'catalog' ? `${r.titlesCreated} new titles, ${r.itemsCreated} copies added` : `${r.created} students created`}</b>${r.skipped ? h`<span>${r.skipped} rows skipped</span>` : ''}
      ${r.errors && r.errors.length ? h`<ul style="margin:.4rem 0 0;padding-left:1.2rem">${r.errors.map((x) => h`<li>${x}</li>`)}</ul>` : ''}
      ${r.credentials && r.credentials.length ? h`<div style="margin-top:.6rem"><button class="btn small" data-act="download-creds">Download sign-in details (CSV)</button><p class="hint">Temporary passwords are shown only now. Students must change them at first sign-in.</p></div>` : ''}</div>`.s;
    toast('Upload finished', 'ok');
  } catch (e) { out.innerHTML = h`<div class="error">${e.message}</div>`.s; }
}
function downloadBlob(name, text, type = 'text/csv') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }

/* ---------- admin: accounts + audit ---------- */
VIEWS.users = async () => {
  const role = S.tmp.userRole || 'staff';
  view(h`<div class="page-head"><div><h1>Accounts</h1><p>Create staff, reset passwords and switch accounts off.</p></div><div class="row">${!isStandalone() ? h`<button class="btn soft" data-act="install-app">${ico('install')} Install app</button>` : ''}<div class="tabs">${[['staff', 'Staff'], ['student', 'Students']].map(([k, l]) => h`<button data-act="user-role" data-v="${k}" aria-selected="${role === k}">${l}</button>`)}</div><button class="btn" data-act="new-staff">${ico('plus')} Add staff</button></div></div><div class="card" id="userbox">Loading…</div>`);
  try {
    const { users } = await api('/admin/users' + (role === 'student' ? '?role=student' : ''));
    $('#userbox').innerHTML = (users.length ? h`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Passkeys</th><th>Last sign-in</th><th></th></tr></thead><tbody>${users.map((u) => h`<tr><td class="cell-title"><b>${u.name}</b><span>${u.email || ''}</span></td><td>${u.username}</td><td><span class="pill">${u.role}</span> ${u.active ? '' : h`<span class="pill bad">off</span>`}</td><td class="num">${u.passkeys}</td><td class="small muted">${u.lastLogin ? fmtTime(u.lastLogin) : 'never'}</td>
      <td class="r"><div class="row" style="justify-content:flex-end;gap:.3rem">${u.id === S.me.id ? h`<span class="muted small">You</span>` : h`<button class="btn small soft" data-act="reset-pw" data-id="${u.id}">Reset password</button>${u.passkeys ? h`<button class="btn small ghost" data-act="clear-keys" data-id="${u.id}">Clear passkeys</button>` : ''}<button class="btn small ghost" data-act="toggle-user" data-id="${u.id}" data-on="${u.active}">${u.active ? 'Deactivate' : 'Activate'}</button>`}</div></td></tr>`)}</tbody></table></div>` : emptyState('No accounts.')).s;
  } catch (e) { $('#userbox').innerHTML = h`<div class="error">${e.message}</div>`.s; }
};
VIEWS.audit = async () => {
  view(h`<div class="page-head"><div><h1>Activity</h1><p>Who did what, and when. Newest first.</p></div></div><form class="searchbar" id="auditsearch"><input type="search" id="aq" placeholder="Filter by action or person, e.g. checkout" aria-label="Filter activity" value="${S.tmp.aq || ''}"><button class="btn" type="submit">Filter</button></form><div class="card" id="auditbox" style="margin-top:1.2rem">Loading…</div>`);
  try {
    const { events } = await api('/admin/audit?q=' + encodeURIComponent(S.tmp.aq || ''));
    $('#auditbox').innerHTML = (events.length ? h`<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th><th>IP</th></tr></thead><tbody>${events.map((e) => h`<tr><td class="small num">${fmtTime(e.at)}</td><td>${e.actorName}${e.role ? h` <span class="pill">${e.role}</span>` : ''}</td><td><span class="pill ${/fail/.test(e.action) ? 'bad' : ''}">${e.action}</span></td><td class="small muted">${Object.entries(e.detail || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</td><td class="small muted">${e.ip || ''}</td></tr>`)}</tbody></table></div>` : emptyState('No matching activity.')).s;
  } catch (e) { $('#auditbox').innerHTML = h`<div class="error">${e.message}</div>`.s; }
};

/* ---------- security (all roles) ---------- */
VIEWS.security = async () => {
  view(h`<div class="page-head"><div><h1>Security</h1><p>Passkeys and your password.</p></div></div><div class="grid cols-2"><div class="card" id="pkcard">Loading…</div>
  <form class="card stack" id="pwform"><h2>Change password</h2><div id="pw-err" class="error hidden" role="alert"></div>
    <label class="field">Current password<input type="password" name="current" autocomplete="current-password" required></label>
    <label class="field">New password<input type="password" name="next" autocomplete="new-password" minlength="10" required><span class="hint">At least 10 characters with a letter and a number.</span></label>
    <button class="btn" type="submit">Update password</button></form></div>`);
  loadPasskeys();
};

/* ---------- install app (all roles) ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
window.addEventListener('appinstalled', () => { deferredPrompt = null; toast('App installed. Open it from your home screen or desktop.', 'ok'); if (location.hash === '#install') render(); });

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function installHelp() {
  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = isIOS || (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/i.test(ua));
  if (isIOS) {
    return h`<p class="muted">On iPhone or iPad, tap the <b>Share</b> button in Safari, then choose <b>Add to Home Screen</b>.</p>`;
  }
  if (isSafari) {
    return h`<p class="muted">In Safari on Mac, choose <b>File → Add to Dock</b> to install the library as an app.</p>`;
  }
  if (/Android/i.test(ua)) {
    return h`<p class="muted">In Chrome on Android, tap the <b>⋮</b> menu and choose <b>Install app</b> or <b>Add to Home screen</b>.</p>`;
  }
  return h`<p class="muted">In Chrome or Edge on desktop, click the <b>install</b> icon in the address bar, or open the <b>⋮</b> menu and choose <b>Cast, save, and share → Install page as app</b>. You can also use the button above.</p>`;
}

VIEWS.install = async () => {
  const installed = isStandalone();
  view(h`
  <div class="page-head"><div><h1>Install the library</h1><p>Add the library to your device for quick access, like a native app.</p></div></div>
  <div class="card stack" style="max-width:42rem">
    ${installed ? h`<div class="desk-result"><b>Already installed</b><span>The library is running as an installed app on this device. Updates arrive automatically.</span></div>` : h`
      <p class="muted">Installing gives the library its own window and icon. Your sign-in, books and settings stay in sync because it is the same secure portal — no extra download.</p>
      ${deferredPrompt ? h`<div class="row"><button class="btn" data-act="install-app">${ico('install')} Install library</button></div>` : h`<div class="row"><button class="btn" data-act="install-help">${ico('install')} How to install</button></div>`}
      <div class="card" style="background:var(--surface-2,#fff)"><h2 style="margin:0 0 .6rem">Install on your device</h2>${installHelp()}</div>
      <ul class="muted small" style="margin:.4rem 0 0;padding-left:1.2rem">
        <li>Opens in its own window with an icon on your home screen or desktop.</li>
        <li>Loads the catalogue and your library page faster after the first visit.</li>
        <li>Sign-in and passkeys keep working exactly as in the browser.</li>
      </ul>`}
    <p class="hint">The install option appears only where your browser supports it. On unsupported browsers, the steps above still let you add a shortcut.</p>
  </div>`);
};
async function installApp() {
  if (isStandalone()) {
    toast('The library is already running as an installed application.', 'ok');
    return;
  }
  if (deferredPrompt) {
    try {
      const e = deferredPrompt;
      deferredPrompt = null;
      e.prompt();
      const choice = await e.userChoice;
      if (choice && choice.outcome === 'accepted') {
        toast('Installing library application…', 'ok');
        return;
      }
    } catch {
      // Fall through to guide
    }
  }
  location.hash = '#install';
}
function installHelpNav() { location.hash = '#install'; }
async function loadPasskeys() {
  const box = $('#pkcard'); if (!box) return;
  const ok = window.SimpleWebAuthnBrowser && SimpleWebAuthnBrowser.browserSupportsWebAuthn();
  try {
    const { passkeys } = await api('/auth/passkeys');
    box.innerHTML = h`<h2>Passkeys</h2><p class="muted" style="margin-bottom:1rem">Sign in with your fingerprint, face or device PIN. No password to remember.</p>
      ${passkeys.length ? h`<div class="stack" style="gap:.5rem">${passkeys.map((p) => h`<div class="copy"><span><b>${p.name}</b><br><span class="muted small">Added ${fmtDate(p.createdAt)}${p.lastUsed ? ' · used ' + fmtDate(p.lastUsed) : ''}${p.backedUp ? ' · synced' : ''}</span></span><button class="btn small ghost" data-act="del-key" data-id="${p.id}">Remove</button></div>`)}</div>` : h`<p class="muted">No passkeys yet.</p>`}
      <div style="margin-top:1rem">${ok ? h`<label class="field">Device name<input type="text" id="pkname" maxlength="40" placeholder="My phone" value=""></label><button class="btn" style="margin-top:.8rem" data-act="add-key">Add a passkey</button>` : h`<p class="hint">This browser does not support passkeys.</p>`}</div>`.s;
  } catch (e) { box.innerHTML = h`<div class="error">${e.message}</div>`.s; }
}
async function addPasskey() {
  try {
    const { options, challengeId } = await api('/auth/passkey/register/options', { method: 'POST', body: {} });
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
    await api('/auth/passkey/register/verify', { method: 'POST', body: { challengeId, response, name: ($('#pkname') || {}).value || '' } });
    toast('Passkey added. You can now sign in with it.', 'ok'); loadPasskeys();
  } catch (e) { toast(e.name === 'NotAllowedError' ? 'Passkey setup was cancelled.' : e.name === 'InvalidStateError' ? 'This device already has a passkey for your account.' : e.message, 'err'); }
}

/* ============ forms: modals ============ */
function patronForm() {
  openModal(h`<h2>Add a student</h2><form class="stack" id="newpatron" style="margin-top:1rem"><div class="form-grid">
    <label class="field">Full name<input type="text" name="name" required maxlength="80"></label>
    <label class="field">Card number<input type="text" name="cardNumber" placeholder="Leave blank to generate" maxlength="20"></label>
    <label class="field">Department<input type="text" name="department" maxlength="60"></label><label class="field">Class<input type="text" name="className" maxlength="40"></label>
    <label class="field">Email<input type="email" name="email" maxlength="120"></label><label class="field">Username<input type="text" name="username" placeholder="Defaults to card number" maxlength="40"></label></div>
    <div id="m-err" class="error hidden"></div><button class="btn" type="submit">Create student</button></form>`);
}
function staffForm() {
  openModal(h`<h2>Add staff</h2><form class="stack" id="newstaff" style="margin-top:1rem"><div class="form-grid">
    <label class="field">Full name<input type="text" name="name" required maxlength="80"></label><label class="field">Username<input type="text" name="username" required maxlength="40"></label>
    <label class="field">Email<input type="email" name="email" maxlength="120"></label>
    <label class="field">Role<select name="role"><option value="librarian">Librarian</option><option value="admin">Admin</option></select></label></div>
    <div id="m-err" class="error hidden"></div><button class="btn" type="submit">Create account</button></form>`);
}
function secretModal(title, line, pw) {
  openModal(h`<h2>${title}</h2><p style="margin:1rem 0">${line}</p><p><span class="secret">${pw}</span></p><p class="hint" style="margin-top:1rem">Share this once. It is not shown again, and they must choose a new password at first sign-in.</p><div class="row" style="margin-top:1rem"><button class="btn" data-act="close-modal">Done</button></div>`);
}
function copyForm(id) {
  openModal(h`<h2>Add a copy</h2><form class="stack" id="newcopy" data-id="${id}" style="margin-top:1rem"><label class="field">Barcode<input type="text" name="barcode" placeholder="Leave blank to generate" maxlength="40"></label><label class="field">Location<input type="text" name="location" value="Main Shelves" maxlength="60"></label><label class="field">Shelf number<input type="text" name="shelfNumber" maxlength="40"></label><div id="m-err" class="error hidden"></div><button class="btn" type="submit">Add copy</button></form>`);
}
function titleForm() {
  openModal(h`<h2>Add a book</h2><form class="stack" id="newtitle" style="margin-top:1rem"><div class="form-grid">
    <label class="field">Title<input type="text" name="title" required maxlength="200"></label><label class="field">Author<input type="text" name="author" maxlength="150"></label>
    <label class="field">ISBN<input type="text" name="isbn" maxlength="20"></label><label class="field">Publisher<input type="text" name="publisher" maxlength="100"></label>
    <label class="field">Year<input type="number" name="year" min="1000" max="2100"></label><label class="field">Language<input type="text" name="language" value="English" maxlength="40"></label>
    <label class="field">Call number<input type="text" name="callNumber" maxlength="40"></label><label class="field">Shelf number<input type="text" name="shelfNumber" maxlength="40"></label><label class="field">Location<input type="text" name="location" value="Main Shelves" maxlength="60"></label><label class="field">Copies<input type="number" name="copies" value="1" min="1" max="20"></label></div>
    <label class="field">Alternate names and transliterations<input type="text" name="searchAliases" placeholder="Separate variants with | (Arabic, Malayalam, Urdu, romanized names…)" maxlength="1000"></label>
    <label class="field">Subjects<input type="text" name="subjects" placeholder="Physics, Cosmology" maxlength="200"></label>
    <label class="field">Description<textarea name="description" maxlength="1500"></textarea></label>
    <div id="m-err" class="error hidden"></div><button class="btn" type="submit">Add to catalogue</button></form>`);
}
const mErr = (m) => { const e = $('#m-err'); if (e) { e.textContent = m; e.classList.remove('hidden'); } };
const formData = (f) => Object.fromEntries(new FormData(f).entries());

/* ============ events ============ */
const ACTIONS = {
  'install-app': installApp,
  'install-help': installHelpNav,
  logout: async () => { try { await api('/auth/logout', { method: 'POST', body: {} }); } catch {} S.me = null; S.csrf = null; history.replaceState(null, '', '/app'); render(); },
  role: (el) => { authRole = el.dataset.role; const u = $('#u') && $('#u').value; renderPublic(); if (u) $('#u').value = u; },
  'passkey-login': passkeyLogin,
  'close-modal': closeModal,
  scrim: (el, e) => { if (e.target === el) closeModal(); },
  'open-book': (el) => openBook(el.dataset.id),
  avail: () => { Q.available = !Q.available; Q.page = 1; runSearch(); },
  lang: (el) => { Q.language = Q.language === el.dataset.v ? '' : el.dataset.v; Q.page = 1; runSearch(); },
  subject: (el) => { Q.subject = Q.subject === el.dataset.v ? '' : el.dataset.v; Q.page = 1; runSearch(); },
  'clear-filters': () => { Object.assign(Q, { q: '', field: 'all', subject: '', language: '', available: false, page: 1 }); VIEWS.search(); },
  'sync-catalogue': async () => {
    showCatalogueSync('syncing');
    try { const cached = await syncOfflineCatalogue(true); showCatalogueSync('online', cached.syncedAt); toast('Offline catalogue updated', 'ok'); }
    catch (e) { showCatalogueSync('sync-error', null, e.message); toast(e.message, 'err'); }
  },
  'inventory-filter': (el) => { S.tmp.inventoryStatus = el.dataset.v; S.tmp.inventoryPage = 1; loadInventory(); },
  'inventory-page': (el) => { S.tmp.inventoryPage = Number(el.dataset.v); loadInventory(); },
  page: (el) => { Q.page = Number(el.dataset.v); runSearch(); scrollTo({ top: 0, behavior: 'smooth' }); },
  reserve: async (el) => { try { await api('/me/holds', { method: 'POST', body: { biblioId: Number(el.dataset.id) } }); toast('Reserved. We will tell you at the desk when it is ready.', 'ok'); openBook(el.dataset.id); } catch (e) { toast(e.message, 'err'); } },
  'cancel-hold': async (el) => { try { await api('/me/holds/' + el.dataset.id, { method: 'DELETE' }); toast('Reservation cancelled', 'ok'); if (el.dataset.bib) openBook(el.dataset.bib); else VIEWS.account(); } catch (e) { toast(e.message, 'err'); } },
  shelf: async (el) => { try { const r = await api('/me/shelf/' + el.dataset.id, { method: 'POST', body: {} }); toast(r.saved ? 'Saved to your list' : 'Removed from your list', 'ok'); openBook(el.dataset.id); } catch (e) { toast(e.message, 'err'); } },
  'acct-tab': (el) => acctTab(el.dataset.v),
  renew: async (el) => { try { const r = await api('/me/renew/' + el.dataset.id, { method: 'POST', body: {} }); toast(`Renewed. Now due ${fmtDate(r.dueAt)}`, 'ok'); VIEWS.account(); } catch (e) { toast(e.message, 'err'); } },
  'staff-renew': async (el) => { try { const r = await api('/staff/renew/' + el.dataset.id, { method: 'POST', body: {} }); toast(`Renewed until ${fmtDate(r.dueAt)}`, 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  'open-patron': (el, e) => { if (e.target.closest('a')) return; location.hash = '#patron/' + el.dataset.id; },
  'new-patron': patronForm, 'new-staff': staffForm,
  'add-copy': (el) => copyForm(el.dataset.id),
  'new-title': titleForm,
  'pay-fine': async (el) => { try { await api(`/staff/fines/${el.dataset.id}/pay`, { method: 'POST', body: {} }); toast('Marked as paid', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  'waive-fine': (el) => openModal(h`<h2>Waive this fine</h2><form class="stack" id="waive" data-id="${el.dataset.id}" style="margin-top:1rem"><label class="field">Reason<input type="text" name="note" required minlength="3" maxlength="120" placeholder="e.g. medical leave"></label><div id="m-err" class="error hidden"></div><button class="btn" type="submit">Waive fine</button></form>`),
  'loan-mode': (el) => { S.tmp.loanMode = el.dataset.v; VIEWS.loans(); },
  'user-role': (el) => { S.tmp.userRole = el.dataset.v; VIEWS.users(); },
  'desk-for': (el) => { S.tmp.prefillCard = el.dataset.card; },
  'reset-pw': async (el) => { try { const r = await api('/admin/users/' + el.dataset.id, { method: 'PATCH', body: { resetPassword: true } }); secretModal('New temporary password', 'Give this to the account owner:', r.tempPassword); } catch (e) { toast(e.message, 'err'); } },
  'clear-keys': async (el) => { try { await api('/admin/users/' + el.dataset.id, { method: 'PATCH', body: { clearPasskeys: true } }); toast('Passkeys cleared', 'ok'); VIEWS.users(); } catch (e) { toast(e.message, 'err'); } },
  'toggle-user': async (el) => { try { await api('/admin/users/' + el.dataset.id, { method: 'PATCH', body: { active: el.dataset.on !== 'true' } }); toast('Account updated', 'ok'); VIEWS.users(); } catch (e) { toast(e.message, 'err'); } },
  'del-key': async (el) => { try { await api('/auth/passkeys/' + encodeURIComponent(el.dataset.id), { method: 'DELETE' }); toast('Passkey removed', 'ok'); loadPasskeys(); } catch (e) { toast(e.message, 'err'); } },
  'add-key': addPasskey,
  template: (el) => downloadBlob(el.dataset.v + '-template.csv', TEMPLATES[el.dataset.v]),
  'download-creds': async () => { try { const t = await api('/admin/csv-credentials', { method: 'POST', body: { rows: S.tmp.creds || [] }, text: true }); downloadBlob('student-sign-in-details.csv', t); } catch (e) { toast(e.message, 'err'); } },
};
document.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (!el) return; const fn = ACTIONS[el.dataset.act]; if (!fn) return; if (el.tagName === 'BUTTON' || el.dataset.act === 'scrim') e.preventDefault(); fn(el, e); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.item) { try { await api('/staff/items/' + encodeURIComponent(t.dataset.item), { method: 'PATCH', body: { status: t.value } }); toast('Copy updated', 'ok'); } catch (err) { toast(err.message, 'err'); } }
  if (t.dataset && t.dataset.shelfItem) {
    try { await api('/staff/items/' + encodeURIComponent(t.dataset.shelfItem), { method: 'PATCH', body: { shelfNumber: t.value.trim() } }); toast('Shelf number saved', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  }
  if (t.dataset && t.dataset.inventoryId) {
    const inventoryStatus = t.checked ? t.dataset.inventoryStatus : 'unchecked';
    try {
      await api('/admin/inventory/' + t.dataset.inventoryId, { method: 'PATCH', body: { inventoryStatus } });
      await loadInventory();
    } catch (err) { toast(err.message, 'err'); await loadInventory(); }
  }
  if (t.id === 'f-catalog') runImport('catalog', t.files[0]);
  if (t.id === 'f-patrons') runImport('patrons', t.files[0]);
});
document.addEventListener('input', (e) => { if (e.target.closest('#settingsform') || e.target.id === 'previewdays') updateFinePreview(); });
['dragover', 'dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  const z = e.target.closest && e.target.closest('[data-drop]'); if (!z) return; e.preventDefault();
  z.classList.toggle('over', ev === 'dragover'); if (ev === 'drop' && e.dataTransfer.files[0]) runImport(z.dataset.drop, e.dataTransfer.files[0]);
}));

document.addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target, btn = $('button[type=submit]', f), id = f.id;
  try {
    if (id === 'login') return passwordLogin(f);
    if (id === 'force') { setBusy(btn, true); try { await api('/auth/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } }); S.me.mustChangePassword = false; toast('Password updated', 'ok'); render(); } catch (err) { authError(err.message); setBusy(btn, false); } return; }
    if (id === 'searchform') { Q.q = $('#q').value.trim(); Q.field = $('#field').value; Q.page = 1; return runSearch(); }
    if (id === 'inventorysearch') { S.tmp.inventoryQ = new FormData(f).get('q').trim(); S.tmp.inventoryPage = 1; return loadInventory(); }
    if (id === 'patronsearch') { S.tmp.pq = $('#pq').value.trim(); return loadPatrons(); }
    if (id === 'auditsearch') { S.tmp.aq = $('#aq').value.trim(); return VIEWS.audit(); }
    if (id === 'checkout') {
      const d = formData(f), box = $('#out-result'); box.innerHTML = '';
      try {
        const r = await api('/staff/checkout', { method: 'POST', body: { cardNumber: d.card.trim(), barcode: d.barcode.trim(), override: !!d.override } });
        box.innerHTML = h`<div class="desk-result ${r.warnings.length ? 'warn' : ''}"><b>${r.title}</b><span>Lent to ${r.patron}. Due ${fmtDate(r.dueAt)}.</span>${r.warnings.map((w) => h`<span>⚠ ${w}</span>`)}</div>`.s;
        deskLog(`Out: ${r.title} → ${r.patron}`); f.barcode.value = ''; f.barcode.focus();
      } catch (err) { box.innerHTML = h`<div class="desk-result err"><b>Not lent</b><span>${err.message}</span></div>`.s; }
      return;
    }
    if (id === 'checkin') {
      const d = formData(f), box = $('#in-result'); box.innerHTML = '';
      try {
        const r = await api('/staff/checkin', { method: 'POST', body: { barcode: d.barcode.trim() } });
        box.innerHTML = h`<div class="desk-result ${r.fine || r.holdFor ? 'warn' : ''}"><b>${r.title}</b><span>Returned by ${r.patron}.</span>
          ${r.fine ? h`<span>Fine: <b>${money(r.fine.amount)}</b> — ${r.daysOverdue} days late, ${r.fine.billableDays} billed at ${money(r.fine.ratePerDay)} a day.</span>` : r.daysOverdue ? h`<span>Late, but inside the grace period. No fine.</span>` : ''}
          ${r.holdFor ? h`<span>📌 Put on the hold shelf for <b>${r.holdFor.patronName}</b> until ${fmtDate(r.holdFor.expiresAt)}.</span>` : ''}</div>`.s;
        deskLog(`In: ${r.title}${r.fine ? ' (fine ' + money(r.fine.amount) + ')' : ''}`); f.barcode.value = ''; f.barcode.focus();
      } catch (err) { box.innerHTML = h`<div class="desk-result err"><b>Not checked in</b><span>${err.message}</span></div>`.s; }
      return;
    }
    if (id === 'newpatron') { try { const r = await api('/staff/patrons', { method: 'POST', body: formData(f) }); closeModal(); secretModal('Student created', `${r.patron.name} · card ${r.patron.cardNumber} · username ${r.patron.username}. Temporary password:`, r.tempPassword); if (route().name === 'patrons') loadPatrons(); } catch (err) { mErr(err.message); } return; }
    if (id === 'newstaff') { try { const r = await api('/admin/users', { method: 'POST', body: formData(f) }); closeModal(); secretModal('Account created', `${r.user.name} (${r.user.role}), username ${r.user.username}. Temporary password:`, r.tempPassword); if (route().name === 'users') VIEWS.users(); } catch (err) { mErr(err.message); } return; }
    if (id === 'newcopy') { try { const r = await api('/staff/items', { method: 'POST', body: { ...formData(f), biblioId: Number(f.dataset.id) } }); toast('Added copy ' + r.barcode, 'ok'); openBook(f.dataset.id); } catch (err) { mErr(err.message); } return; }
    if (id === 'newtitle') { try { const r = await api('/staff/biblio', { method: 'POST', body: formData(f) }); closeModal(); toast(`Added. Barcodes: ${r.barcodes.join(', ')}`, 'ok'); runSearch(); } catch (err) { mErr(err.message); } return; }
    if (id === 'waive') { try { await api(`/staff/fines/${f.dataset.id}/waive`, { method: 'POST', body: formData(f) }); closeModal(); toast('Fine waived', 'ok'); render(); } catch (err) { mErr(err.message); } return; }
    if (id === 'settingsform') {
      const body = {}; for (const [k, v] of new FormData(f).entries()) body[k] = v;
      for (const g of Object.values(SET_FIELDS)) for (const [k, , type] of g) if (type === 'number') body[k] = Number(body[k]);
      body.publicSearch = f.publicSearch.checked;
      setBusy(btn, true, 'Saving…'); try { const r = await api('/admin/settings', { method: 'PUT', body }); S.cfg = { ...S.cfg, ...r.settings }; toast('Settings saved', 'ok'); } catch (err) { toast(err.message, 'err'); } setBusy(btn, false); return;
    }
    if (id === 'pwform') { const eb = $('#pw-err'); eb.classList.add('hidden'); try { await api('/auth/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } }); f.reset(); toast('Password updated. Other devices were signed out.', 'ok'); } catch (err) { eb.textContent = err.message; eb.classList.remove('hidden'); } return; }
  } catch (err) { toast(err.message, 'err'); }
});

// Staff catalogue gets an "Add a book" button without touching the shared search view.
const baseSearch = VIEWS.search;
VIEWS.search = () => { baseSearch(); if (S.me && S.me.role !== 'student') { const head = $('.page-head'); if (head) head.insertAdjacentHTML('beforeend', '<button class="btn" data-act="new-title">+ Add a book</button>'); } };
// Prefill the desk card when arriving from a student profile.
const baseDesk = VIEWS.desk;
VIEWS.desk = () => { baseDesk(); if (S.tmp.prefillCard) { $('#card').value = S.tmp.prefillCard; S.tmp.prefillCard = null; const b = $('#checkout [name=barcode]'); if (b) b.focus(); } };

addEventListener('hashchange', () => { closeModal(); render(); scrollTo(0, 0); });

/* ============ boot ============ */
(async () => {
  try {
    const j = await api('/auth/me');
    if (j.user) { S.me = j.user; S.csrf = j.csrf; S.cfg = { ...S.cfg, ...j.settings }; if (!location.hash) history.replaceState(null, '', '#' + home()); }
    else { S.cfg = { ...S.cfg, ...j.settings }; }
  } catch (e) { if (!location.hash) history.replaceState(null, '', '#search'); }
  render();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
  }
})();
})();
