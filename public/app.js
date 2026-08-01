'use strict';

// ============ WORKSPACE-SCOPED PREFERENCES ============
// Every scriptorium* localStorage key is mirrored to
// <workspace>/.scriptorium/settings.json, so a workspace is an independent,
// portable unit. The pre-paint script hydrates localStorage from the file;
// here writes are synced back (debounced).
(function () {
  const origSet = Storage.prototype.setItem;
  const origRemove = Storage.prototype.removeItem;
  let saveTimer = null;
  const isPref = (k) => typeof k === 'string' && k.indexOf('scriptorium') === 0;
  function scheduleSync() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const out = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (isPref(k)) out[k] = localStorage.getItem(k);
        }
      } catch (e) {}
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: out })
      }).catch(() => {});
    }, 400);
  }
  Storage.prototype.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (this === localStorage && isPref(k)) scheduleSync();
  };
  Storage.prototype.removeItem = function (k) {
    origRemove.call(this, k);
    if (this === localStorage && isPref(k)) scheduleSync();
  };
})();

// ============ ACCESS TOKEN ============
// When the server is exposed on the LAN (HOST=0.0.0.0), it prints a URL with
// ?token=… — open that once on the phone and the token is remembered here.
// Wrapping fetch keeps every existing call site untouched.
(() => {
  const TOKEN_KEY = 'scriptorium_token';
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    // Drop the token from the address bar so it stays out of history/screenshots.
    const url = new URL(location.href);
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const token = localStorage.getItem(TOKEN_KEY);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (token && url.startsWith('/api/')) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('X-Scriptorium-Token', token);
      init = { ...init, headers };
    }
    return nativeFetch(input, init);
  };
})();

// Application State
let state = {
  sections: [],
  ideaThemes: [],
  activeDocId: null,
  activeThemeId: null,
  ideasMode: 'active', // 'active' | 'archived'
  workspaceDir: '',
  ideasDir: '',
  isLocked: localStorage.getItem('scriptorium_is_locked') !== 'false',
  docSortMode: localStorage.getItem('scriptorium_doc_sort') === 'modified' ? 'modified' : 'alpha'
};

// Archive timers map: ideaText -> { timer, element }
let archiveTimers = new Map();

// Save timers
let saveTimer;
let dirty = false;
// Set right after we wrote a document ourselves: the file watcher echoes the
// write back as "workspace-changed", and that echo must not trigger a full
// reload (which would drop the editor selection) for a change we caused.
let suppressOwnSaveReload = false;

// History state map for documents (docId -> { stack, index, lastSaveTime, lastWasTyping })
let docHistory = {};

// Drag and drop state
let draggedDocId = null;

// Chord mode shortcut state
let chordPending = false;
let chordTimer;

// DOM Helper
const $ = (id) => document.getElementById(id);

// Elements
const app = $('app');
const nav = $('nav');
const title = $('title');
const subtitle = $('subtitle');
const previewPane = $('previewPane');
const previewTitle = $('previewTitle');
const previewSubtitle = $('previewSubtitle');
const previewContent = $('previewContent');
const docMeta = $('docMeta');
const breadcrumb = $('breadcrumb');
const editorWrap = $('editorWrap');
const topbar = $('topbar');
const wcEl = $('wc');
const ccEl = $('cc');
const rtEl = $('rt');
const saveIndicator = $('saveIndicator');
const saveText = $('saveText');
const themesTabs = $('themesTabs');
const ideasList = $('ideasList');
const ideaAddInput = $('ideaAddInput');
const activeCountEl = $('activeCount');
const archivedCountEl = $('archivedCount');
const chordIndicator = $('chordIndicator');
const dropOverlay = $('dropOverlay');
const fileInput = $('fileInput');
const ideasFileInput = $('ideasFileInput');
const backdrop = $('backdrop');
const settingsModal = $('settingsModal');
const workspaceLabel = $('workspaceLabel');
const workspacePathInput = $('workspacePathInput');
const ideasPathInput = $('ideasPathInput');
const newDocBtn = $('newDocBtn');
const sortDocsBtn = $('sortDocsBtn');
const ideasPanel = $('ideasPanel');

// ============ API COMMUNICATIONS ============

let sseInitialized = false;

function initSSE() {
  if (sseInitialized || !window.EventSource) return;
  sseInitialized = true;
  try {
    const ev = new EventSource('/api/events');
    ev.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'workspace-changed') {
          onWorkspaceChangedExternally();
        }
      } catch (err) {}
    };
  } catch (err) {}
}

async function onWorkspaceChangedExternally() {
  // Echo of our own save: swallow it so the editor keeps its selection.
  if (suppressOwnSaveReload) {
    suppressOwnSaveReload = false;
    return;
  }
  if (dirty) {
    showToast('toast.external_change');
    return;
  }
  await fetchWorkspace();
  if (state.activeDocId) {
    const doc = activeDoc();
    if (doc) loadDocIntoEditor(doc);
  }
}

async function fetchWorkspace() {
  updateLockStateUI();
  docHistory = {}; // Clear history cache on workspace load
  try {
    // Get config first
    const configRes = await fetch('/api/config');
    if (configRes.status === 401) {
      await themedAlert(__('alert.token_missing'));
      return;
    }
    const configData = await configRes.json();
    state.workspaceDir = configData.workspaceDir;
    state.ideasDir = configData.ideasDir || '';
    state.appDir = configData.appDir || '';
    // The server owns the padlock now — adopt its value rather than localStorage.
    if (typeof configData.locked === 'boolean') {
      state.isLocked = configData.locked;
      localStorage.setItem('scriptorium_is_locked', state.isLocked);
      updateLockStateUI();
    }

    // First launch: no workspace has ever been chosen, ask the user.
    if (configData.configured === false) {
      showWorkspaceSetupModal();
      return;
    }

    workspaceLabel.textContent = pathBasename(state.workspaceDir);
    workspaceLabel.title = state.workspaceDir;

    // Get layout
    const res = await fetch('/api/workspace');
    const data = await res.json();
    state.sections = data.sections;
    state.ideaThemes = data.ideaThemes;
    
    // Auto-select active doc if none set
    const allDocs = state.sections.flatMap(s => s.documents);
    if (!state.activeDocId && allDocs.length > 0) {
      state.activeDocId = allDocs[0].id;
    }
    
    // Auto-select active theme if none set
    if (!state.activeThemeId && state.ideaThemes.length > 0) {
      state.activeThemeId = state.ideaThemes[0].id;
    }
    
    renderAll();
    initSSE();
  } catch (err) {
    console.error('Error fetching workspace:', err);
    await themedAlert(__('alert.workspace_load_error', { message: err.message }));
  }
}

async function saveDocumentOnDisk() {
  const doc = activeDoc();
  if (!doc) return;

  try {
    const res = await fetch('/api/documents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: doc.id,
        title: title.value,
        subtitle: subtitle.value,
        content: getContentMarkdown(),
        // Lets the server refuse the write if the file changed underneath us
        // — the same document open on a phone, in another tab, or in an
        // external editor used to overwrite whichever copy saved last.
        knownUpdatedAt: doc.updatedAt
      })
    });

    if (res.status === 409) {
      const conflict = await res.json();
      await handleSaveConflict(doc, conflict);
      return;
    }

    const data = await res.json();
    if (data.success) {
      // If filename/id changed due to renaming
      if (data.document.id !== doc.id) {
        if (docHistory[doc.id]) {
          docHistory[data.document.id] = docHistory[doc.id];
          delete docHistory[doc.id];
        }
        // Snapshots are keyed by document id: carry them over to the new id
        // when a title change renamed the file, or they would be orphaned and
        // the panel would read as empty.
        const oldId = doc.id;
        const snapshots = getSnapshots(oldId);
        if (snapshots.length) {
          saveSnapshots(data.document.id, snapshots);
          saveSnapshots(oldId, []);
        } else {
          delete snapshotsCache[oldId];
        }
        state.activeDocId = data.document.id;
        renderSnapshotsList();
      }
      
      // Update local state without full reload
      doc.title = title.value;
      doc.subtitle = subtitle.value;
      doc.content = getContentMarkdown();
      doc.updatedAt = data.document.updatedAt;
      doc.id = data.document.id;
      doc.filename = data.document.filename;
      
      saveIndicator.classList.remove('dirty');
      saveIndicator.classList.add('saved');
      saveText.textContent = __('save.saved');
      dirty = false;
      suppressOwnSaveReload = true;

      renderNav();
      updateBreadcrumbAndMeta();
    }
  } catch (err) {
    console.error('Error auto-saving:', err);
    saveText.textContent = __('save.error');
  }
}

// The file moved on since we opened it. Never resolve this silently: both
// versions are someone's work, so the choice belongs to the user.
async function handleSaveConflict(doc, conflict) {
  saveIndicator.classList.remove('saved');
  saveIndicator.classList.add('dirty');
  saveText.textContent = __('save.conflict');
  dirty = true;

  const keepMine = await themedConfirm(__('confirm.conflict_keep'));

  if (keepMine) {
    // Adopt the disk timestamp so the retry passes the freshness check.
    doc.updatedAt = conflict.diskUpdatedAt;
    saveDocumentOnDisk();
    return;
  }

  // Reload from disk, keeping the local version one undo away.
  saveHistory(state.activeDocId, true);
  const parsed = parseIncomingMarkdown(conflict.diskContent || '', doc.filename || '');
  doc.title = parsed.title;
  doc.subtitle = parsed.subtitle;
  doc.content = parsed.body;
  doc.updatedAt = conflict.diskUpdatedAt;
  loadActiveDoc();
  dirty = false;
  saveIndicator.classList.remove('dirty');
  saveIndicator.classList.add('saved');
  saveText.textContent = __('save.reloaded');
}

// Mirrors the server's parseMarkdownDoc: "# title", optional *subtitle*, body.
function parseIncomingMarkdown(text, filename) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let title = filename.replace(/\.(md|markdown|txt)$/i, '');
  let subtitle = '';
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;

  const h1 = i < lines.length ? lines[i].trim().match(/^#\s+(.+)$/) : null;
  if (h1) {
    title = h1[1];
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
    const sub = i < lines.length ? lines[i].match(/^\*([^*]+)\*\s*$|^_([^_]+)_\s*$/) : null;
    if (sub) {
      subtitle = sub[1] || sub[2];
      i++;
    }
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  return { title, subtitle, body: lines.slice(i).join('\n') };
}

async function createDocument(sectionId) {
  try {
    const res = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sectionId })
    });
    const data = await res.json();
    if (data.success) {
      state.activeDocId = data.document.id;
      await fetchWorkspace();
      setTimeout(() => title.focus(), 50);
      showToast('toast.doc_created');
    }
  } catch (err) {
    console.error(err);
  }
}

async function duplicateDocument(docId) {
  try {
    const res = await fetch('/api/documents/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: docId })
    });
    const data = await res.json();
    if (data.success) {
      state.activeDocId = data.document.id;
      await fetchWorkspace();
      showToast('toast.doc_duplicated');
    }
  } catch (err) {
    console.error(err);
  }
}

async function deleteDocument(docId) {
  if (state.isLocked) {
    await themedAlert(__('alert.locked'));
    return;
  }

  try {
    const res = await fetch('/api/documents', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: docId })
    });
    const data = await res.json();
    if (data.success) {
      if (state.activeDocId === docId) {
        state.activeDocId = null;
      }
      await fetchWorkspace();

      if (data.trashId) {
        showToastWithAction('toast.doc_deleted_undo', null, 'toast.undo_btn', async function () {
          try {
            const restoreRes = await fetch('/api/documents/restore-trash', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ trashId: data.trashId, sectionId: data.sectionId, filename: data.filename })
            });
            const restoreData = await restoreRes.json();
            if (restoreData.success) {
              state.activeDocId = restoreData.id;
              await fetchWorkspace();
              showToast('toast.doc_restored');
            }
          } catch (e) {
            console.error(e);
          }
        }, 5000);
      } else {
        showToast('toast.doc_deleted');
      }
    }
  } catch (err) {
    console.error(err);
  }
}

async function createSection(name) {
  try {
    const res = await fetch('/api/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.success) {
      await fetchWorkspace();
      showToast('toast.section_created');
    } else {
      await themedAlert(data.error || __('alert.section_create_error'));
    }
  } catch (err) {
    console.error(err);
  }
}

async function renameSection(oldId, newName) {
  try {
    const res = await fetch('/api/sections/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldId, newName })
    });
    const data = await res.json();
    if (data.success) {
      if (state.activeDocId && state.activeDocId.startsWith(oldId + '/')) {
        state.activeDocId = state.activeDocId.replace(oldId + '/', data.id + '/');
      }
      await fetchWorkspace();
      showToast('toast.section_renamed');
    } else {
      await themedAlert(data.error || __('alert.section_rename_error'));
    }
  } catch (err) {
    console.error(err);
  }
}

async function deleteSection(sectionId) {
  if (state.isLocked) {
    await themedAlert(__('alert.locked'));
    return;
  }
  const section = state.sections.find(s => s.id === sectionId);
  if (!section) return;

  const count = section.documents.length;
  if (count > 0 && !(await themedConfirm(__('confirm.section_delete_docs', { name: section.name, count: count }), null, true))) {
    return;
  } else if (count === 0 && !(await themedConfirm(__('confirm.section_delete_empty', { name: section.name }), null, true))) {
    return;
  }

  try {
    const res = await fetch('/api/sections', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sectionId })
    });
    const data = await res.json();
    if (data.success) {
      if (state.activeDocId && state.activeDocId.startsWith(sectionId + '/')) {
        state.activeDocId = null;
      }
      await fetchWorkspace();
      showToast('toast.section_deleted');
    }
  } catch (err) {
    console.error(err);
  }
}

async function moveDocument(docId, targetSectionId) {
  try {
    const res = await fetch('/api/documents/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: docId, targetSectionId })
    });
    const data = await res.json();
    if (data.success) {
      if (state.activeDocId === docId) {
        state.activeDocId = data.id;
      }
      await fetchWorkspace();
      showToast('toast.doc_moved');
    }
  } catch (err) {
    console.error(err);
  }
}

async function toggleIdea(themeId, ideaText, archived) {
  try {
    await fetch('/api/ideas/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId, ideaText, archived })
    });
    
    // Update local state directly
    const theme = state.ideaThemes.find(t => t.id === themeId);
    if (theme) {
      const idea = theme.ideas.find(i => i.text === ideaText);
      if (idea) {
        idea.archived = archived;
      }
    }

    renderIdeas();
    showToast(archived ? 'toast.idea_archived' : 'toast.idea_unarchived');
  } catch (err) {
    console.error(err);
  }
}

async function addIdea(themeId, ideaText) {
  try {
    const res = await fetch('/api/ideas/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId, ideaText })
    });
    const data = await res.json();
    if (data.success) {
      const theme = state.ideaThemes.find(t => t.id === themeId);
      if (theme) {
        if (Array.isArray(ideaText)) {
          ideaText.forEach(txt => {
            theme.ideas.push({
              id: Math.random().toString(36).slice(2, 10),
              text: txt,
              archived: false
            });
          });
        } else {
          theme.ideas.push({
            id: Math.random().toString(36).slice(2, 10),
            text: ideaText,
            archived: false
          });
        }
      }
      renderIdeas();
      showToast('toast.idea_added');
    }
  } catch (err) {
    console.error(err);
  }
}

async function createTheme(name) {
  try {
    const res = await fetch('/api/themes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.success) {
      state.activeThemeId = data.theme.id;
      await fetchWorkspace();
      showToast('toast.theme_created');
    } else {
      await themedAlert(data.error || __('alert.theme_create_error'));
    }
  } catch (err) {
    console.error(err);
  }
}

async function deleteTheme(id) {
  if (state.isLocked) {
    await themedAlert(__('alert.locked'));
    return;
  }
  const theme = state.ideaThemes.find(t => t.id === id);
  if (!theme) return;

  if (!(await themedConfirm(__('confirm.theme_delete', { name: theme.name }), null, true))) return;

  try {
    const res = await fetch('/api/themes', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (data.success) {
      if (state.activeThemeId === id) {
        state.activeThemeId = state.ideaThemes.find(t => t.id !== id)?.id || null;
      }
      await fetchWorkspace();
      showToast('toast.theme_deleted');
    }
  } catch (err) {
    console.error(err);
  }
}

async function importFileToServer(file, sectionId) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await fetch('/api/documents/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sectionId,
          filename: file.name,
          fileContent: reader.result
        })
      });
      const data = await res.json();
      if (data.success) {
        state.activeDocId = data.document.id;
        await fetchWorkspace();
      }
      showToast('toast.doc_imported');
    } catch (err) {
      console.error(err);
    }
  };
  reader.readAsText(file);
}

async function importIdeasFileToServer(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await fetch('/api/themes/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          fileContent: reader.result
        })
      });
      const data = await res.json();
      if (data.success) {
        state.activeThemeId = data.theme.id;
        await fetchWorkspace();
      }
      showToast('toast.theme_imported');
    } catch (err) {
      console.error(err);
    }
  };
  reader.readAsText(file);
}

// ============ DOM HELPERS & RENDERING ============

function findDoc(id) {
  for (const s of state.sections) {
    const d = s.documents.find(x => x.id === id);
    if (d) return d;
  }
  return null;
}

function activeDoc() {
  return state.activeDocId ? findDoc(state.activeDocId) : null;
}

function activeTheme() {
  return state.ideaThemes.find(t => t.id === state.activeThemeId);
}

function pathBasename(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function relDate(ts) {
  var d = new Date(ts);
  var months = [__('date.jan'),__('date.feb'),__('date.mar'),__('date.apr'),__('date.may'),__('date.jun'),__('date.jul'),__('date.aug'),__('date.sep'),__('date.oct'),__('date.nov'),__('date.dec')];
  var now = new Date();
  if (d.toDateString() === now.toDateString()) return __('date.today');
  var y = new Date(); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return __('date.yesterday');
  if (d.getFullYear() === now.getFullYear()) return d.getDate() + ' ' + months[d.getMonth()];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ============ TOAST NOTIFICATIONS ============
var toastContainer = null;
var toastTimer = null;

function showToast(key, vars) {
  if (!toastContainer) toastContainer = document.getElementById('toastContainer');
  if (!toastContainer) return;

  if (toastTimer) {
    clearTimeout(toastTimer);
    var old = toastContainer.querySelector('.toast');
    if (old) old.remove();
  }

  var el = document.createElement('div');
  el.className = 'toast';
  el.textContent = __(key, vars);
  toastContainer.appendChild(el);

  toastTimer = setTimeout(function () {
    el.classList.add('toast-out');
    setTimeout(function () { if (el.parentNode) el.remove(); }, 220);
    toastTimer = null;
  }, 2200);
}

function showToastWithAction(key, vars, actionLabelKey, onAction, duration) {
  if (!toastContainer) toastContainer = document.getElementById('toastContainer');
  if (!toastContainer) return;

  if (toastTimer) {
    clearTimeout(toastTimer);
    var old = toastContainer.querySelector('.toast');
    if (old) old.remove();
  }

  var el = document.createElement('div');
  el.className = 'toast toast-action';

  var textSpan = document.createElement('span');
  textSpan.textContent = __(key, vars);
  el.appendChild(textSpan);

  var actBtn = document.createElement('button');
  actBtn.type = 'button';
  actBtn.className = 'toast-action-btn';
  actBtn.textContent = __(actionLabelKey);
  actBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    el.remove();
    onAction();
  });
  el.appendChild(actBtn);

  toastContainer.appendChild(el);

  toastTimer = setTimeout(function () {
    el.classList.add('toast-out');
    setTimeout(function () { if (el.parentNode) el.remove(); }, 220);
    toastTimer = null;
  }, duration || 5000);
}

// On touch devices, show button titles as brief toasts (hover tooltips don't work)
(function () {
  if (!window.matchMedia('(pointer: coarse)').matches) return;
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button, [role="button"], a');
    if (!btn) return;
    if (btn.classList.contains('sel-btn') || btn.classList.contains('block-menu-item')) return;
    var title = btn.title || btn.getAttribute('aria-label');
    if (title && title.length > 3 && title.length < 80) {
      if (!toastContainer) toastContainer = document.getElementById('toastContainer');
      if (!toastContainer) return;
      if (toastContainer.querySelector('.toast:not(.mobile-tooltip)')) return;
      var prev = toastContainer.querySelector('.mobile-tooltip');
      if (prev) prev.remove();
      var el = document.createElement('div');
      el.className = 'toast mobile-tooltip';
      el.textContent = title;
      toastContainer.appendChild(el);
      setTimeout(function () {
        el.classList.add('toast-out');
        setTimeout(function () { if (el.parentNode) el.remove(); }, 220);
      }, 1200);
    }
  });
})();

function documentsForNav(documents) {
  return [...documents].sort((a, b) => {
    if (state.docSortMode === 'modified') {
      const byDate = (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
      if (byDate !== 0) return byDate;
    }
    const aTitle = String(a.title || a.filename || __('new_doc.default_title')).trim();
    const bTitle = String(b.title || b.filename || __('new_doc.default_title')).trim();
    return aTitle.localeCompare(bTitle, getLocale() === 'fr' ? 'fr' : 'en', { sensitivity: 'base', numeric: true });
  });
}

function updateDocSortButton() {
  if (!sortDocsBtn) return;
  const byDate = state.docSortMode === 'modified';
  const alphaIcon = sortDocsBtn.querySelector('.sort-icon-alpha');
  const dateIcon = sortDocsBtn.querySelector('.sort-icon-date');
  const label = byDate ? __('sort.by_date_tooltip') : __('sort.by_alpha_tooltip');
  if (alphaIcon) alphaIcon.classList.toggle('hidden', byDate);
  if (dateIcon) dateIcon.classList.toggle('hidden', !byDate);
  sortDocsBtn.title = label;
  sortDocsBtn.setAttribute('aria-label', label);
}

// Render Sidebar Navigation
function renderNav() {
  nav.innerHTML = '';
  
  if (state.sections.length === 0) {
    nav.innerHTML = '<div class="ideas-empty">' + __('nav.no_sections') + '</div>';
    return;
  }
  
  state.sections.forEach((section) => {
    const sectionEl = document.createElement('div');
    const collapsed = localStorage.getItem(`section-collapsed-${section.id}`) === 'true';
    sectionEl.className = 'nav-section' + (collapsed ? ' collapsed' : '');
    sectionEl.dataset.id = section.id;

    const header = document.createElement('div');
    header.className = 'nav-section-header';
    header.innerHTML = `
      <svg class="chevron" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      <span class="title">${escapeHtml(section.name)}</span>
      <span class="count">${section.documents.length}</span>
      <div class="nav-section-actions">
        <button class="icon-btn" data-act="rename" title="${escapeHtml(__('nav.section_rename_title'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="icon-btn" data-act="add" title="${escapeHtml(__('nav.section_add_title'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        ${section.id !== '_general' ? `
        <button class="icon-btn" data-act="delete" title="${escapeHtml(__('nav.section_delete_title'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>` : ''}
      </div>
    `;

    header.addEventListener('click', (e) => {
      if (e.target.closest('.nav-section-actions')) return;
      if (e.target.closest('[contenteditable]')) return;
      
      const isCollapsed = !sectionEl.classList.contains('collapsed');
      sectionEl.classList.toggle('collapsed', isCollapsed);
      localStorage.setItem(`section-collapsed-${section.id}`, isCollapsed);
    });

    header.querySelector('[data-act="rename"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (section.id === '_general') {
        themedAlert(__('nav.section_rename'));
        return;
      }
      const titleEl = header.querySelector('.title');
      titleEl.contentEditable = 'true';
      titleEl.focus();
      
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const sel = window.getSelection();
      sel.removeAllRanges(); 
      sel.addRange(range);
      
      const finish = () => {
        titleEl.contentEditable = 'false';
        const v = titleEl.textContent.trim();
        if (v && v !== section.name) {
          renameSection(section.id, v);
        } else {
          titleEl.textContent = section.name;
        }
      };
      
      titleEl.addEventListener('blur', finish, { once: true });
      titleEl.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); titleEl.blur(); }
        if (ke.key === 'Escape') { titleEl.textContent = section.name; titleEl.blur(); }
      });
    });

    header.querySelector('[data-act="add"]').addEventListener('click', (e) => {
      e.stopPropagation();
      createDocument(section.id);
    });

    if (section.id !== '_general') {
      header.querySelector('[data-act="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSection(section.id);
      });
    }

    sectionEl.appendChild(header);

    // drag-drop files or documents directly on sections
    let sectionDragCounter = 0;
    sectionEl.addEventListener('dragenter', (e) => {
      if (e.dataTransfer.types.includes('Files') || draggedDocId) {
        sectionDragCounter++;
        sectionEl.classList.add('drop-target');
      }
    });
    sectionEl.addEventListener('dragleave', (e) => {
      if (e.dataTransfer.types.includes('Files') || draggedDocId) {
        sectionDragCounter--;
        if (sectionDragCounter <= 0) {
          sectionDragCounter = 0;
          sectionEl.classList.remove('drop-target');
        }
      }
    });
    sectionEl.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files') || draggedDocId) {
        e.preventDefault();
      }
    });
    sectionEl.addEventListener('drop', (e) => {
      sectionDragCounter = 0;
      sectionEl.classList.remove('drop-target');
      
      // Handle local document drop
      const docId = draggedDocId || e.dataTransfer.getData('application/x-doc-id');
      if (docId) {
        const parts = docId.split('/');
        const sourceSectionId = parts[0];
        if (sourceSectionId === section.id) return; // ignore same section
        e.preventDefault();
        moveDocument(docId, section.id);
        return;
      }
      
      // Handle files drop
      if (e.dataTransfer.files.length) {
        e.preventDefault();
        Array.from(e.dataTransfer.files).forEach(file => {
          importFileToServer(file, section.id);
        });
      }
    });

    const itemsEl = document.createElement('div');
    itemsEl.className = 'nav-items';
    
    documentsForNav(section.documents).forEach(doc => {
      const item = document.createElement('div');
      item.className = 'nav-item' + (doc.id === state.activeDocId ? ' active' : '');
      item.dataset.docId = doc.id;
      item.draggable = true;
      var docLabel = doc.title || __('new_doc.default_title');
      item.innerHTML = `
        <span class="label" title="${escapeHtml(docLabel)}">${escapeHtml(docLabel)}</span>
        <span class="meta">${relDate(doc.updatedAt)}</span>
        <button class="delete-doc" title="${escapeHtml(__('nav.doc_delete_title'))}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      `;
      
      item.addEventListener('click', (e) => {
        if (e.target.closest('.delete-doc')) return;
        openDoc(doc.id);
        if (window.innerWidth <= 720) app.classList.remove('show-sidebar');
      });
      
      item.querySelector('.delete-doc').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteDocument(doc.id);
      });
      
      // Document drag and drop (moving files between folders)
      item.addEventListener('dragstart', (e) => {
        item.classList.add('dragging');
        e.dataTransfer.setData('application/x-doc-id', doc.id);
        e.dataTransfer.effectAllowed = 'move';
        draggedDocId = doc.id;
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        draggedDocId = null;
      });
      itemsEl.appendChild(item);
    });

    sectionEl.appendChild(itemsEl);
    nav.appendChild(sectionEl);
  });
}

function openDoc(id) {
  // Save current before switching
  if (dirty) {
    saveDocumentOnDisk();
  }
  state.activeDocId = id;
  loadActiveDoc();
  renderNav();
}

function loadActiveDoc() {
  // Hide search-highlight pill — the editor is about to be rebuilt
  const _clearBtn = document.getElementById('clearHighlightBtn');
  if (_clearBtn) _clearBtn.classList.add('hidden');

  const doc = activeDoc();
  if (!doc) {
    title.value = '';
    subtitle.value = '';
    content.innerHTML = '';
    breadcrumb.innerHTML = '<span>' + __('breadcrumb.no_doc') + '</span>';
    docMeta.innerHTML = '';
    updateStats();
    if (typeof generateTOC === 'function') generateTOC();
    if (typeof renderSnapshotsList === 'function') renderSnapshotsList();
    return;
  }
  
  title.value = doc.title;
  subtitle.value = doc.subtitle;
  loadContentMarkdown(doc.content);

  updateBreadcrumbAndMeta();
  autoGrow(title);
  autoGrow(subtitle);
  updateStats();
  if (typeof renderSnapshotsList === 'function') renderSnapshotsList();
  if (typeof loadSnapshotsForDoc === 'function') loadSnapshotsForDoc(doc.id);

  // Regenerate TOC for the new document
  setTimeout(() => { if (typeof generateTOC === 'function') generateTOC(); }, 40);
  
  // Initialize history for this document if not already present
  if (!docHistory[doc.id]) {
    docHistory[doc.id] = {
      stack: [{
        title: doc.title,
        subtitle: doc.subtitle,
        content: doc.content,
        selectionStart: 0,
        selectionEnd: 0
      }],
      index: 0,
      lastSaveTime: Date.now(),
      lastWasTyping: false
    };
  }
}

function updateBreadcrumbAndMeta() {
  const doc = activeDoc();
  if (!doc) return;

  const parts = doc.id.split('/');
  const sectionName = parts[0] === '_general' ? __('nav.general_section') : parts[0];
  // Fallback to extracting from id if the doc object doesn't carry .filename
  const filename = doc.filename || (parts[1] || '');

  breadcrumb.innerHTML = `
    <span>${escapeHtml(sectionName)}</span>
    <span class="sep">/</span>
    <span class="current">${escapeHtml(doc.title || __('new_doc.default_title'))}</span>
    ${filename ? `<span class="sep">/</span><span class="breadcrumb-filename" title="${__('breadcrumb.filename_tooltip')}">${escapeHtml(filename)}</span>` : ''}
  `;

  docMeta.innerHTML = `
    <span>${__('meta.created', { date: relDate(doc.createdAt) })}</span>
    <span>·</span>
    <span>${__('meta.modified', { date: relDate(doc.updatedAt) })}</span>
  `;

  // Copy filename to clipboard on click (in breadcrumb only)
  const onFilenameClick = async (e) => {
    if (!filename) return;
    try {
      await navigator.clipboard.writeText(filename);
      e.target.classList.add('copied');
      const prev = e.target.textContent;
      e.target.textContent = __('meta.copied');
      showToast('toast.filename_copied');
      setTimeout(() => {
        e.target.classList.remove('copied');
        e.target.textContent = prev;
      }, 1100);
    } catch (_) { /* clipboard denied — silent */ }
  };

  const fnInBc = breadcrumb.querySelector('.breadcrumb-filename');
  if (fnInBc) fnInBc.addEventListener('click', onFilenameClick);
}

if (breadcrumb) {
  breadcrumb.title = 'Cliquer ou toucher pour revenir en haut du document';
  breadcrumb.addEventListener('click', (e) => {
    if (e.target.closest('.breadcrumb-filename')) return;
    if (editorWrap) {
      editorWrap.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    }
  });
}

// Render theme tabs
function renderThemesTabs() {
  themesTabs.innerHTML = '';
  
  state.ideaThemes.forEach(theme => {
    const tab = document.createElement('button');
    tab.className = 'theme-tab' + (theme.id === state.activeThemeId ? ' active' : '');
    tab.innerHTML = `<span>${escapeHtml(theme.name)}</span><span class="delete-theme" title="${escapeHtml(__('theme.tab_delete_title'))}">×</span>`;
    
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('delete-theme')) {
        e.stopPropagation();
        deleteTheme(theme.id);
        return;
      }
      state.activeThemeId = theme.id;
      renderThemesTabs();
      renderIdeas();
    });
    // Dropping an idea onto a tab moves it to that theme.
    tab.addEventListener('dragover', (e) => {
      if (draggedIdea && draggedIdea.themeId !== theme.id) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tab.classList.add('drag-over');
      }
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      tab.classList.remove('drag-over');
      if (draggedIdea && draggedIdea.themeId !== theme.id) {
        const dragged = draggedIdea;
        draggedIdea = null;
        moveIdeaToTheme(dragged, theme);
      }
    });
    themesTabs.appendChild(tab);
  });
  
  const addBtn = document.createElement('button');
  addBtn.className = 'theme-tab add';
  addBtn.textContent = __('theme.add');
  addBtn.addEventListener('click', async () => {
    const name = await themedPrompt(__('prompt.theme_name'));
    if (!name || !name.trim()) return;
    createTheme(name);
  });
  themesTabs.appendChild(addBtn);
}

// Render ideas word cloud list
function renderIdeas() {
  const theme = activeTheme();
  ideasList.innerHTML = '';
  ideaAddInput.classList.add('hidden');
  ideaAddInput.value = '';

  if (!theme) {
    ideasList.innerHTML = '<div class="ideas-empty">' + __('ideas.no_theme') + '</div>';
    activeCountEl.textContent = '';
    archivedCountEl.textContent = '';
    return;
  }

  const active = theme.ideas.filter(i => !i.archived);
  const archived = theme.ideas.filter(i => i.archived);
  activeCountEl.textContent = active.length ? `(${active.length})` : '';
  archivedCountEl.textContent = archived.length ? `(${archived.length})` : '';

  let shown = state.ideasMode === 'archived' ? archived : active;
  if (ideasSearchQuery) {
    const q = ideasSearchQuery.toLowerCase();
    shown = shown.filter(i => i.text.toLowerCase().indexOf(q) !== -1);
  }

  if (shown.length === 0) {
    ideasList.innerHTML = `<div class="ideas-empty">${state.ideasMode === 'archived' ? __('ideas.empty_archived') : __('ideas.empty_active')}</div>`;
  } else {
    shown.forEach(idea => {
      const chip = document.createElement('div');
      
      // Calculate font size class depending on text length to create a cloud effect
      const sizeClass = `s-${1 + (idea.text.length % 4)}`;
      chip.className = `idea-chip ${sizeClass}` + (idea.archived ? ' archived' : '');
      chip.title = idea.text;
      chip.dataset.id = idea.id;
      chip.dataset.ideaText = idea.text;
      chip.setAttribute('tabindex', '0');
      
      const textEl = document.createElement('span');
      textEl.className = 'idea-text';
      if (ideasSearchQuery) {
        textEl.innerHTML = highlightText(idea.text, ideasSearchQuery);
      } else {
        textEl.textContent = idea.text;
      }
      chip.appendChild(textEl);
      
      const actionsEl = document.createElement('div');
      actionsEl.className = 'chip-actions';

      // Insert button (plus icon)
      const insertBtn = document.createElement('button');
      insertBtn.className = 'chip-action-btn insert-btn';
      insertBtn.title = __('ideas.insert_title');
      insertBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
      insertBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        insertTextAtCaret(idea.text);
        chip.classList.add('pulse');
        setTimeout(() => chip.classList.remove('pulse'), 400);
      });

      // Edit button (pencil)
      const editBtn = document.createElement('button');
      editBtn.className = 'chip-action-btn edit-btn';
      editBtn.title = __('ideas.edit_title');
      editBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startEditingIdea(idea, theme, chip);
      });

      // Archive / Restore button (checkmark or restore icon)
      const archiveBtn = document.createElement('button');
      archiveBtn.className = 'chip-action-btn archive-btn';

      if (idea.archived) {
        archiveBtn.title = __('ideas.unarchive_title');
        archiveBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
        archiveBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleIdea(theme.id, idea.text, false);
        });
      } else {
        archiveBtn.title = __('ideas.archive_title');
        archiveBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        archiveBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (archiveTimers.has(idea.text)) {
            cancelArchiving(idea.text);
          } else {
            startArchiving(theme.id, idea.text, chip);
          }
        });
      }

      // Delete button (X) — 5s fade-out, click again during fade to cancel
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'chip-action-btn delete-btn';
      deleteBtn.title = __('ideas.delete_title');
      deleteBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (deleteTimers.has(idea.text)) {
          cancelDeleting(idea.text);
        } else {
          startDeleting(theme.id, idea.text, chip);
        }
      });

      actionsEl.appendChild(insertBtn);
      actionsEl.appendChild(editBtn);
      actionsEl.appendChild(archiveBtn);
      actionsEl.appendChild(deleteBtn);
      chip.appendChild(actionsEl);
      


      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        insertTextAtCaret(idea.text);

        // Visual feedback pulse
        chip.classList.add('pulse');
        setTimeout(() => chip.classList.remove('pulse'), 400);
      });

      // Drag: reorder within the theme, drop onto another tab to move it, or
      // drop into the editor to insert at the drop point.
      chip.draggable = true;
      chip.addEventListener('dragstart', (e) => {
        draggedIdea = { themeId: theme.id, text: idea.text };
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', idea.text);
        chip.classList.add('dragging');
        e.stopPropagation();
      });
      chip.addEventListener('dragend', () => {
        draggedIdea = null;
        ideaDropHit = null;
        chip.classList.remove('dragging');
        hideIdeasDropIndicator();
        hideGutterIndicator();
      });
      chip.addEventListener('dragover', (e) => {
        if (draggedIdea && draggedIdea.themeId === theme.id && idea.text !== draggedIdea.text) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          // No border highlight on the hovered chip: the line below is the cue.
          // Show where the idea will land: above or below the hovered chip.
          const rect = chip.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          chip.dataset.dropPos = before ? 'before' : 'after';
          positionIdeasDropIndicator(chip, before);
        }
      });
      chip.addEventListener('dragleave', () => {
        chip.classList.remove('drag-over');
        hideIdeasDropIndicator();
      });
      chip.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chip.classList.remove('drag-over');
        hideIdeasDropIndicator();
        if (draggedIdea && draggedIdea.themeId === theme.id && idea.text !== draggedIdea.text) {
          const draggedText = draggedIdea.text;
          const after = chip.dataset.dropPos === 'after';
          delete chip.dataset.dropPos;
          draggedIdea = null;
          reorderIdeas(theme, draggedText, idea.text, after);
        }
      });

      ideasList.appendChild(chip);
    });
  }

  // add idea button
  if (state.ideasMode === 'active') {
    const addBtn = document.createElement('button');
    addBtn.className = 'idea-add';
    addBtn.textContent = __('ideas.add_button');
    addBtn.addEventListener('click', () => {
      ideaAddInput.classList.remove('hidden');
      ideaAddInput.focus();
      addBtn.style.display = 'none';
    });
    ideasList.appendChild(addBtn);
  }
}

// 5-second fade archive logic
function startArchiving(themeId, ideaText, chip) {
  chip.classList.add('archiving');
  
  const timer = setTimeout(() => {
    toggleIdea(themeId, ideaText, true);
    archiveTimers.delete(ideaText);
  }, 5000);
  
  archiveTimers.set(ideaText, { timer, element: chip });
}

function cancelArchiving(ideaText) {
  const t = archiveTimers.get(ideaText);
  if (t) {
    clearTimeout(t.timer);
    t.element.classList.remove('archiving');

    // flash border
    t.element.style.borderColor = 'var(--accent)';
    setTimeout(() => t.element.style.borderColor = '', 400);

    archiveTimers.delete(ideaText);
  }
}

// ============ DELETE IDEA (5s fade-out, click again to cancel) ============

const deleteTimers = new Map(); // ideaText -> { timer, element }
// The idea currently being dragged (for reorder, move to another theme, or
// dropping into the editor). { themeId, text }
let draggedIdea = null;
// The between-blocks boundary under the cursor during an idea drag into the
// editor (from findInsertionBoundary), used by the drop to place the new block.
let ideaDropHit = null;
// While a block is dragged over the ideas panel, remembers where the new idea
// will be inserted: { themeId, beforeText, after } or null when not over a chip.
let blockIdeaDrop = null;

function startDeleting(themeId, ideaText, chip) {
  if (state.isLocked) {
    themedAlert(__('alert.locked'));
    return;
  }
  // If archive was pending, cancel it first
  if (archiveTimers.has(ideaText)) cancelArchiving(ideaText);

  chip.classList.add('deleting');
  const timer = setTimeout(() => {
    commitDeleteIdea(themeId, ideaText);
    deleteTimers.delete(ideaText);
  }, 5000);
  deleteTimers.set(ideaText, { timer, element: chip });
}

function cancelDeleting(ideaText) {
  const t = deleteTimers.get(ideaText);
  if (t) {
    clearTimeout(t.timer);
    t.element.classList.remove('deleting');
    t.element.style.borderColor = 'var(--accent)';
    setTimeout(() => t.element.style.borderColor = '', 400);
    deleteTimers.delete(ideaText);
  }
}

async function commitDeleteIdea(themeId, ideaText) {
  try {
    const res = await fetch('/api/ideas/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId, ideaText })
    });
    if (!res.ok) throw new Error('Delete failed');
    // Mirror server state locally
    const theme = state.ideaThemes.find(t => t.id === themeId);
    if (theme) {
      theme.ideas = theme.ideas.filter(i => i.text !== ideaText);
      showToast('toast.idea_deleted');
    }
    renderIdeas();
  } catch (err) {
    console.error('Failed to delete idea:', err);
    await themedAlert(__('alert.idea_delete_error'));
    renderIdeas();
  }
}

// Inserts an idea's text at the pointer position in the editor. Uses the
// browser's caret-from-point when available so the idea lands where it was
// dropped, not just at the remembered caret.
// Inserts the dropped idea as a new block before or after the line the drag is
// pointing at (the same boundary the block drop indicator shows).
function insertIdeaBlockAtBoundary(text, hit) {
  saveHistory(state.activeDocId, true);
  const newLine = makeLineNode(text);
  if (hit) {
    content.insertBefore(newLine, hit.insertBefore ? hit.line : hit.line.nextSibling);
  } else {
    content.appendChild(newLine);
  }
  makeLineRawAndActive(newLine);
  setCaretInLine(newLine, text.length);
  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();
}

// Reorders the active ideas of a theme so `draggedText` sits just before
// `beforeText`. Persisted by rewriting the theme file.
async function reorderIdeas(theme, draggedText, beforeText, after) {
  const active = theme.ideas.filter(i => !i.archived);
  const dragged = active.find(i => i.text === draggedText);
  if (!dragged) return;
  const rest = active.filter(i => i.text !== draggedText);
  let idx;
  if (beforeText) {
    idx = rest.findIndex(i => i.text === beforeText);
    if (idx !== -1 && after) idx += 1;
  } else {
    idx = after ? rest.length : 0;
  }
  if (idx < 0) idx = rest.length;
  const newActive = [...rest.slice(0, idx), dragged, ...rest.slice(idx)];
  const order = newActive.map(i => i.text);
  try {
    const res = await fetch('/api/ideas/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId: theme.id, order })
    });
    if (res.ok) {
      theme.ideas = [...newActive, ...theme.ideas.filter(i => i.archived)];
      renderIdeas();
    }
  } catch (err) {
    console.error('reorder error', err);
  }
}

// Deletes an idea from its current theme without the delete toast, so a move
// to another theme only announces the final add.
async function removeIdeaDirect(themeId, ideaText) {
  const res = await fetch('/api/ideas/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ themeId, ideaText })
  });
  if (!res.ok) throw new Error('Delete failed');
  const theme = state.ideaThemes.find(t => t.id === themeId);
  if (theme) theme.ideas = theme.ideas.filter(i => i.text !== ideaText);
}

// Moves an idea from its current theme to another theme.
async function moveIdeaToTheme(dragged, targetTheme) {
  if (state.isLocked) {
    themedAlert(__('alert.locked'));
    return;
  }
  try {
    await removeIdeaDirect(dragged.themeId, dragged.text);
    await addIdea(targetTheme.id, dragged.text);
  } catch (err) {
    console.error('move idea error', err);
  }
}

// The horizontal line shown between idea bubbles during a reorder drag, so the
// drop position is visible before releasing (same cue as the editor's blocks).
function positionIdeasDropIndicator(chip, before) {
  const ind = $('ideasDropIndicator');
  if (!ind || !ideasPanel) return;
  const panelRect = ideasPanel.getBoundingClientRect();
  const chipRect = chip.getBoundingClientRect();
  const y = before ? chipRect.top : chipRect.bottom;
  ind.style.top = (y - panelRect.top - 1) + 'px';
  ind.style.left = '6px';
  ind.style.width = (panelRect.width - 12) + 'px';
  ind.style.display = 'block';
}

function hideIdeasDropIndicator() {
  const ind = $('ideasDropIndicator');
  if (ind) ind.style.display = 'none';
}

// During a block drag over the ideas panel, shows the same between-ideas line
// as the reorder drag and remembers the insertion target for the drop.
function updateBlockIdeaDropPosition(clientX, clientY) {
  blockIdeaDrop = null;
  if (state.ideasMode === 'archived' || !ideasPanel || !ideasList) {
    hideIdeasDropIndicator();
    return;
  }
  const panelRect = ideasPanel.getBoundingClientRect();
  if (clientX < panelRect.left || clientX > panelRect.right ||
      clientY < panelRect.top || clientY > panelRect.bottom) {
    hideIdeasDropIndicator();
    return;
  }
  const chips = Array.from(ideasList.children).filter(el => el.classList && el.classList.contains('idea-chip'));
  if (chips.length === 0) {
    hideIdeasDropIndicator();
    return;
  }
  let target = null;
  let before = true;
  for (const chip of chips) {
    const r = chip.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    target = chip;
    if (clientY < mid) {
      before = true;
      break;
    }
    before = false;
  }
  if (!target) {
    hideIdeasDropIndicator();
    return;
  }
  const theme = activeTheme();
  blockIdeaDrop = {
    themeId: theme ? theme.id : null,
    beforeText: target.dataset.ideaText,
    after: !before
  };
  positionIdeasDropIndicator(target, before);
}

// ============ EDIT IDEA (inline) ============

function startEditingIdea(idea, theme, chip) {
  // If a fade is pending on this chip, cancel it
  if (archiveTimers.has(idea.text)) cancelArchiving(idea.text);
  if (deleteTimers.has(idea.text))  cancelDeleting(idea.text);

  // Avoid re-entry
  if (chip.classList.contains('editing')) return;
  chip.classList.add('editing');

  const textEl = chip.querySelector('.idea-text');
  const originalText = idea.text;

  const input = document.createElement('textarea');
  input.className = 'idea-edit-input';
  input.value = originalText;
  input.rows = 1;
  input.spellcheck = false;

  // Insert input before the (now hidden) text span
  if (textEl) {
    textEl.style.display = 'none';
    chip.insertBefore(input, textEl);
  } else {
    chip.insertBefore(input, chip.firstChild);
  }

  const autoresize = () => {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  };
  setTimeout(autoresize, 0);
  input.addEventListener('input', autoresize);

  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    chip.classList.remove('editing');
    const newText = input.value.trim();
    if (save && newText && newText !== originalText) {
      commitEditIdea(theme.id, originalText, newText, idea);
    } else {
      // revert UI
      input.remove();
      if (textEl) textEl.style.display = '';
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

async function commitEditIdea(themeId, oldText, newText, ideaObj) {
  try {
    const res = await fetch('/api/ideas/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId, oldText, newText })
    });
    if (!res.ok) throw new Error('Edit failed');
    if (ideaObj) ideaObj.text = newText;
    renderIdeas();
    showToast('toast.idea_edited');
  } catch (err) {
    console.error('Failed to edit idea:', err);
    await themedAlert(__('alert.idea_edit_error'));
    renderIdeas();
  }
}

// ============ HISTORY MANAGER ============

function saveHistory(docId = state.activeDocId, force = false) {
  if (!docId) return;
  const doc = findDoc(docId);
  if (!doc) return;
  
  if (!docHistory[docId]) {
    docHistory[docId] = { stack: [], index: -1 };
  }
  
  const histObj = docHistory[docId];
  
  // Remember where the caret was so an undo/redo can put it back instead of
  // dropping it at the start of the document.
  let caretLine = -1, caretOffset = 0;
  if (activeLineNode && content.contains(activeLineNode)) {
    caretLine = Array.prototype.indexOf.call(content.children, activeLineNode);
    caretOffset = getCaretCharacterOffsetWithin(activeLineNode);
  }
  const currentState = {
    title: title.value,
    subtitle: subtitle.value,
    content: getContentMarkdown(),
    caretLine,
    caretOffset
  };
  
  // Skip if state is identical to current index
  if (histObj.index >= 0) {
    const last = histObj.stack[histObj.index];
    if (last.title === currentState.title &&
        last.subtitle === currentState.subtitle &&
        last.content === currentState.content) {
      return;
    }
  }
  
  const now = Date.now();
  const isTyping = !force;
  
  if (isTyping && histObj.index >= 0 && histObj.lastSaveTime && (now - histObj.lastSaveTime < 1500) && histObj.lastWasTyping) {
    // Update the last state in the stack instead of creating a new one (debounce typing)
    histObj.stack[histObj.index] = currentState;
    histObj.lastSaveTime = now;
    return;
  }
  
  // Truncate redo history
  histObj.stack = histObj.stack.slice(0, histObj.index + 1);
  histObj.stack.push(currentState);
  if (histObj.stack.length > 100) {
    histObj.stack.shift();
  }
  histObj.index = histObj.stack.length - 1;
  histObj.lastSaveTime = now;
  histObj.lastWasTyping = isTyping;
}

function performUndo() {
  const docId = state.activeDocId;
  if (!docId || !docHistory[docId]) return;
  const histObj = docHistory[docId];
  if (histObj.index > 0) {
    histObj.index--;
    restoreHistoryState(histObj.stack[histObj.index]);
  }
}

function performRedo() {
  const docId = state.activeDocId;
  if (!docId || !docHistory[docId]) return;
  const histObj = docHistory[docId];
  if (histObj.index < histObj.stack.length - 1) {
    histObj.index++;
    restoreHistoryState(histObj.stack[histObj.index]);
  }
}

function restoreHistoryState(stateObj) {
  if (!stateObj) return;

  title.value = stateObj.title;
  subtitle.value = stateObj.subtitle;
  loadContentMarkdown(stateObj.content);

  autoGrow(title);
  autoGrow(subtitle);
  updateStats();
  markDirty();

  content.focus();

  // Put the caret back where it was, if the state recorded it.
  if (stateObj.caretLine >= 0) {
    const lines = content.children;
    const line = lines[Math.min(stateObj.caretLine, lines.length - 1)];
    if (line) setCaretPosition(line, stateObj.caretOffset || 0);
  }

  if (state.activeDocId && docHistory[state.activeDocId]) {
    docHistory[state.activeDocId].lastWasTyping = false;
  }
}

// ============ EDITOR AND TEXT FUNCTIONS ============

function autoGrow(el) {
  const wrap = $('editorWrap');
  if (!wrap) return;
  const editor = $('editorPane');
  if (!editor) return;
  
  // Lock editor min-height to prevent scroll-jumping when textarea collapses
  const originalEditorHeight = editor.offsetHeight;
  editor.style.minHeight = originalEditorHeight + 'px';
  
  const scrollPos = wrap.scrollTop;
  el.style.height = '0px';
  el.style.height = el.scrollHeight + 'px';
  wrap.scrollTop = scrollPos;
  
  editor.style.minHeight = '';
}

// On a phone the statusbar has ~350px for three counters plus four buttons, and
// a long text turns "111 228 signes" into something that shoves the icons off
// the edge. Wide screens keep the exact figure — a writer working to a target
// wants the unit, not an approximation.
const narrowStatusbar = window.matchMedia('(max-width: 720px)');

function formatCount(n) {
  if (!narrowStatusbar.matches || n < 10000) return n.toLocaleString(localeStr());
  if (n >= 1000000) return (Math.round(n / 100000) / 10).toLocaleString(localeStr()) + 'M';
  if (n < 100000) {
    return (Math.round(n / 100) / 10).toLocaleString(localeStr()) + 'k';
  }
  var k = Math.round(n / 1000);
  return k >= 1000 ? '1,0M' : k + 'k';
}

function localeStr() { return getLocale() === 'fr' ? 'fr-FR' : 'en-US'; }

function updateStats() {
  const text = getContentMarkdown().trim();
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const chars = getContentMarkdown().length;
  const minutes = words ? Math.max(1, Math.round(words / 220)) : 0;

  wcEl.textContent = formatCount(words);
  ccEl.textContent = formatCount(chars);
  rtEl.textContent = formatCount(minutes) + ' ' + __('statusbar.min');

  // The exact figure stays reachable when the display is rounded.
  wcEl.title = words.toLocaleString(getLocale() === 'fr' ? 'fr-FR' : 'en-US') + ' ' + __('statusbar.mots');
  ccEl.title = chars.toLocaleString(getLocale() === 'fr' ? 'fr-FR' : 'en-US') + ' ' + __('statusbar.signes');
}

// Rotating the phone, or resizing on desktop, has to reformat what is shown.
narrowStatusbar.addEventListener('change', () => updateStats());

function markDirty() {
  dirty = true;
  saveIndicator.classList.remove('saved');
  saveIndicator.classList.add('dirty');
  saveText.textContent = __('save.modified');

  // No autosave while the user stays inside a block. The file is written when
  // the block is validated (clicking away, moving to another line), on Ctrl+S,
  // when switching documents, and via sendBeacon when the app closes.
  clearTimeout(saveTimer);
}

// Save when the user finishes a block (clicks elsewhere, moves to another
// line), collapsing rapid line changes into a single write.
let validationSaveTimer;
function scheduleBlockValidationSave() {
  if (!dirty || !state.activeDocId) return;
  clearTimeout(validationSaveTimer);
  validationSaveTimer = setTimeout(() => saveDocumentOnDisk(), 300);
}

function insertTextAtCaret(text) {
  // execCommand('insertText') cannot create new lines in the line model.
  if (/[\r\n]/.test(text || '')) return insertMarkdownAtCaret(text);
  if (!activeLineNode) {
    const lastLine = content.lastChild;
    if (lastLine && lastLine.classList.contains('editor-line')) {
      lastLine.focus();
      activeLineNode = lastLine;
      activeLineNode.classList.add('active-line');
      activeLineNode.textContent = activeLineNode.dataset.raw || '';
    } else {
      const newLine = document.createElement('div');
      newLine.className = 'editor-line';
      newLine.dataset.raw = '';
      newLine.textContent = '';
      content.appendChild(newLine);
      newLine.focus();
      activeLineNode = newLine;
      activeLineNode.classList.add('active-line');
    }
  }
  
  saveHistory(state.activeDocId, true);
  
  let insert = text;
  const sel = window.getSelection();
  if (sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const startOffset = range.startOffset;
    const currentText = activeLineNode.textContent;
    const before = currentText.substring(0, startOffset);
    
    const needsLeadingSpace = before.length > 0 && !/\n\s*$/.test(before) && !/\s$/.test(before) && !/^\s/.test(insert);
    if (needsLeadingSpace) {
      insert = ' ' + insert;
    }
  }
  
  document.execCommand('insertText', false, insert);
  
  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
}

// Keyboard shortcuts handlers

function wrapSelection(textarea, prefix, suffix = prefix) {
  saveHistory(state.activeDocId, true);
  
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;
  const sel = val.substring(start, end);
  const replacement = prefix + sel + suffix;
  
  textarea.focus();
  try {
    document.execCommand('insertText', false, replacement);
    const newStart = start + prefix.length;
    const newEnd = newStart + sel.length;
    textarea.setSelectionRange(newStart, newEnd);
  } catch (e) {
    textarea.value = val.substring(0, start) + replacement + val.substring(end);
    const newStart = start + prefix.length;
    const newEnd = newStart + sel.length;
    textarea.setSelectionRange(newStart, newEnd);
  }
  
  autoGrow(textarea);
  markDirty();
  updateStats();
  
  saveHistory(state.activeDocId, true);
}

function prefixLines(textarea, prefix, opts = {}) {
  saveHistory(state.activeDocId, true);
  
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;
  
  // Find full bounds of the selected lines
  const lineStart = val.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = val.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = val.length;
  const block = val.substring(lineStart, lineEnd);
  
  let newBlock = '';
  if (opts.cycleHeading) {
    // Cycles headers: '' -> # -> ## -> ### -> #### -> ##### -> ###### -> ''
    newBlock = block.split('\n').map(line => {
      const m = line.match(/^(#{0,6})\s?(.*)$/);
      const level = m[1].length;
      const text = m[2];
      const next = level >= 6 ? 0 : level + 1;
      return next === 0 ? text : '#'.repeat(next) + ' ' + text;
    }).join('\n');
  } else if (opts.removePrefix) {
    // Un-comment (remove #)
    newBlock = block.split('\n').map(line => {
      return line.startsWith('# ') ? line.substring(2) : (line.startsWith('#') ? line.substring(1) : line);
    }).join('\n');
  } else {
    // Add prefix
    newBlock = block.split('\n').map(line => prefix + line).join('\n');
  }
  
  textarea.focus();
  textarea.setSelectionRange(lineStart, lineEnd);
  try {
    document.execCommand('insertText', false, newBlock);
    if (opts.cycleHeading || opts.removePrefix) {
      textarea.setSelectionRange(lineStart + newBlock.length, lineStart + newBlock.length);
    } else {
      textarea.setSelectionRange(start + prefix.length, end + prefix.length * (newBlock.split('\n').length));
    }
  } catch (e) {
    textarea.value = val.substring(0, lineStart) + newBlock + val.substring(lineEnd);
    if (opts.cycleHeading || opts.removePrefix) {
      textarea.setSelectionRange(lineStart + newBlock.length, lineStart + newBlock.length);
    } else {
      textarea.setSelectionRange(start + prefix.length, end + prefix.length * (newBlock.split('\n').length));
    }
  }
  
  autoGrow(textarea);
  markDirty();
  updateStats();
  
  saveHistory(state.activeDocId, true);
}

function setChord(active) {
  chordPending = active;
  chordIndicator.classList.toggle('active', active);
  if (active) {
    clearTimeout(chordTimer);
    chordTimer = setTimeout(() => setChord(false), 2500);
  }
}

// Markdown Parser
function renderMarkdown(src) {
  if (!src) return '';
  
  // Protect triple-backtick code blocks
  const codeBlocks = [];
  src = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    codeBlocks.push({ lang, code });
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });
  
  // Protect inline code
  const inlineCodes = [];
  src = src.replace(/`([^`\n]+)`/g, (m, c) => {
    inlineCodes.push(c);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  const lines = src.split('\n');
  let html = '';
  let i = 0;
  
  while (i < lines.length) {
    let line = lines[i];

    // headings H1-H6
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { 
      html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; 
      i++; 
      continue; 
    }

    // Horizontal Rule
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) { 
      html += '<hr/>'; 
      i++; 
      continue; 
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      let buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`;
      continue;
    }

    // Unordered List
    if (/^\s*[\-\*\+]\s+/.test(line)) {
      let buf = [];
      while (i < lines.length && /^\s*[\-\*\+]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[\-\*\+]\s+/, ''));
        i++;
      }
      html += '<ul>' + buf.map(b => `<li>${inline(b)}</li>`).join('') + '</ul>';
      continue;
    }

    // Ordered List
    if (/^\s*\d+\.\s+/.test(line)) {
      let buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      html += '<ol>' + buf.map(b => `<li>${inline(b)}</li>`).join('') + '</ol>';
      continue;
    }

    // Code block placeholder
    const cbMatch = line.match(/^\x00CB(\d+)\x00$/);
    if (cbMatch) {
      const cb = codeBlocks[+cbMatch[1]];
      html += `<pre><code>${escapeHtml(cb.code)}</code></pre>`;
      i++;
      continue;
    }

    // Simple Table
    if (i + 1 < lines.length && /\|/.test(line) && /^[\s\|:\-]+$/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      const headerCells = line.split('|').slice(1, -1).map(s => s.trim());
      const rows = [];
      i += 2; // Skip header and alignment separator line
      while (i < lines.length && /\|/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map(s => s.trim()));
        i++;
      }
      html += '<table><thead><tr>' + headerCells.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>';
      continue;
    }

    // Paragraph
    if (line.trim() === '') { 
      i++; 
      continue; 
    }
    
    let buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|>\s?|[\-\*\+]\s+|\d+\.\s+|---+|\*\*\*+|___+|\x00CB)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    html += `<p>${inline(buf.join('\n'))}</p>`;
  }

  // Restore inline codes
  html = html.replace(/\x00IC(\d+)\x00/g, (m, n) => `<code>${escapeHtml(inlineCodes[+n])}</code>`);
  return html;
}

function inline(s) {
  // === 1. EXTRACT (before escaping) things that contain raw chars we mustn't touch ===
  const stash = []; // array of {token, html}
  const stashPush = (html) => {
    const tok = `\x00X${stash.length}\x00`;
    stash.push(html);
    return tok;
  };

  // Inline LaTeX: $...$  (avoid double-$ for display math and avoid escaped \$)
  s = s.replace(/(^|[^\\$])\$([^\$\n]+?)\$(?!\$)/g, (m, pre, formula) => {
    return pre + stashPush(renderMath(formula, false));
  });

  // Wikilinks: [[name]] or [[name|alias]]
  s = s.replace(/\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g, (m, name, alias) => {
    const label = (alias || name).trim();
    return stashPush(`<span class="md-wikilink" data-target="${escapeHtml(name.trim())}">${escapeHtml(label)}</span>`);
  });

  // Images: ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
    return stashPush(`<img class="md-img" alt="${escapeHtml(alt)}" src="${escapeHtml(url)}"/>`);
  });

  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
    return stashPush(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`);
  });

  // === 2. ESCAPE remaining HTML ===
  s = escapeHtml(s);

  // Keep code placeholders intact
  s = s.replace(/\x00IC(\d+)\x00/g, m => m);
  // Keep our stash placeholders intact (escapeHtml encoded the \x00? actually no — escapeHtml only escapes < > & " '. The \x00 char passes through.)

  // === 3. INLINE FORMATTING on escaped text ===

  // Highlight: ==text==
  s = s.replace(/==([^=\n]+)==/g, '<mark class="md-highlight">$1</mark>');

  // Bold: **text** or __text__
  s = s.replace(/\*\*([^\*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  s = s.replace(/(^|[^\*])\*([^\*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

  // Strike: ~~text~~
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // Footnote refs: [^id]
  s = s.replace(/\[\^([^\]\n]+)\]/g, '<sup class="md-footref">$1</sup>');

  // Underline tags: <u>text</u>  (the user can type literal <u></u>)
  s = s.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>');

  // Line breaks
  s = s.replace(/\n/g, '<br/>');

  // === 4. RESTORE stashed (LaTeX / links / images / wikilinks) ===
  s = s.replace(/\x00X(\d+)\x00/g, (m, n) => stash[+n] || '');

  return s;
}

// KaTeX renderer with safe fallback (CDN may be loading, or formula may be invalid)
function renderMath(formula, displayMode) {
  if (typeof katex === 'undefined') {
    // Fallback: render as inline code so the user sees something
    return `<code class="math-pending">${escapeHtml(formula)}</code>`;
  }
  try {
    return katex.renderToString(formula, {
      throwOnError: false,
      displayMode: !!displayMode,
      output: 'html',
      strict: false,
      trust: false
    });
  } catch (e) {
    return `<span class="math-error" title="${escapeHtml(e.message || __('math.error'))}">${escapeHtml(formula)}</span>`;
  }
}

let activeLineNode = null;

function renderMarkdownLine(line) {
  // Merged block: render each markdown line on its own, wrapped so every
  // sub-line keeps its block styling (headings, quotes, bold... intact)
  if (line.indexOf('\n') !== -1) {
    return line.split('\n')
      .map(sub => `<span class="md-subline">${sub.trim() === '' ? '<br>' : renderMarkdownLine(sub)}</span>`)
      .join('');
  }
  line = line.replace(/\r$/, '');
  if (line.trim() === '') return '<br>';

  // Code fence — content not rendered here (post-pass groups + highlights)
  const fence = line.match(/^```\s*([\w+-]*)\s*$/);
  if (fence) {
    return `<span class="fence-marker">${escapeHtml(line)}</span>`;
  }

  // Display math on its own line: $$ formula $$
  const dispMath = line.match(/^\s*\$\$([^$]+)\$\$\s*$/);
  if (dispMath) {
    return renderMath(dispMath[1].trim(), true);
  }

  // Headings
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const level = h[1].length;
    return `<h${level}>${inline(h[2])}</h${level}>`;
  }

  // Callout (Obsidian style): > [!info] Title
  const callout = line.match(/^>\s*\[!(\w+)\](\+|-)?\s*(.*)$/);
  if (callout) {
    const type = callout[1].toLowerCase();
    const title = callout[3].trim() || calloutDefaultTitle(type);
    return `<div class="callout-header"><span class="callout-icon">${calloutIcon(type)}</span><span>${escapeHtml(title)}</span></div>`;
  }

  // Blockquote (single-line)
  if (line.startsWith('> ')) {
    return `<blockquote>${inline(line.substring(2))}</blockquote>`;
  }
  if (line === '>') {
    return `<blockquote></blockquote>`;
  }

  // Task list: - [ ] text  or  - [x] text
  const task = line.match(/^[\s]*[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const checked = task[1].toLowerCase() === 'x';
    return `<ul class="inline-list"><li class="inline-li task${checked ? ' task-done' : ''}"><span class="task-box" role="checkbox" aria-checked="${checked}">${checked ? '✓' : ''}</span>${inline(task[2])}</li></ul>`;
  }

  // Bulleted list
  if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('+ ')) {
    return `<ul class="inline-list"><li class="inline-li">${inline(line.substring(2))}</li></ul>`;
  }

  // Numbered list
  const numMatch = line.match(/^(\d+)\.\s+(.*)$/);
  if (numMatch) {
    return `<ol class="inline-list" start="${numMatch[1]}"><li class="inline-li">${inline(numMatch[2])}</li></ol>`;
  }

  // Table row (very lightweight per-line render — separator line stays invisible)
  if (/^\s*\|.*\|\s*$/.test(line)) {
    const sep = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
    if (sep) return `<span class="table-sep"></span>`;
    const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    return cells.map(c => `<span class="td">${inline(c)}</span>`).join('');
  }

  // Horizontal Rule
  if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
    return '<hr/>';
  }

  // Standard Line / Paragraph
  return `<p>${inline(line)}</p>`;
}

function getCaretCharacterOffsetWithin(element) {
  let caretOffset = 0;
  const doc = element.ownerDocument || element.document;
  const win = doc.defaultView || doc.parentWindow;
  const sel = win.getSelection();
  if (sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(element);
    preCaretRange.setEnd(range.endContainer, range.endOffset);
    caretOffset = preCaretRange.toString().length;
  }
  return caretOffset;
}

function setCaretPosition(element, offset) {
  const range = document.createRange();
  const sel = window.getSelection();
  
  let currentOffset = 0;
  let textNode = null;
  
  function traverse(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (currentOffset + node.length >= offset) {
        textNode = node;
        return true;
      }
      currentOffset += node.length;
    } else {
      for (let i = 0; i < node.childNodes.length; i++) {
        if (traverse(node.childNodes[i])) return true;
      }
    }
    return false;
  }
  
  traverse(element);
  
  if (!textNode) {
    textNode = element;
    offset = element.childNodes.length;
  } else {
    offset = offset - currentOffset;
  }
  
  range.setStart(textNode, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function getContentMarkdown() {
  const lines = [];
  const children = content.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.classList && child.classList.contains('pending-delete')) {
      continue;
    }
    let raw = child.dataset.raw;
    if (child === activeLineNode) {
      raw = child.textContent;
    }
    if (raw === undefined) {
      raw = child.textContent || '';
    }
    lines.push(raw);
  }
  return lines.join('\n');
}

function loadContentMarkdown(markdown) {
  if (typeof clearMultiSelection === 'function') clearMultiSelection();
  content.innerHTML = '';
  const cleanMarkdown = (markdown || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = cleanMarkdown.split('\n');
  lines.forEach(line => {
    const lineDiv = document.createElement('div');
    lineDiv.className = 'editor-line';
    lineDiv.dataset.raw = line;
    applyLineKind(lineDiv, line);
    if (line.trim() === '') {
      lineDiv.innerHTML = '<br>';
    } else {
      lineDiv.innerHTML = renderMarkdownLine(line);
    }
    content.appendChild(lineDiv);
  });
  activeLineNode = null;
  // Group multi-line constructs (code fences, callouts, tables) + syntax highlight
  postProcessRenderedLines();
}

// ============ LINE KIND (visual stability between edit/rendered states) ============

function getLineKind(raw) {
  if (raw == null) return 'p';
  // A merged block holds several markdown lines; each sub-line carries its own
  // styling (.md-subline), so the block itself stays a plain paragraph.
  if (raw.indexOf('\n') !== -1) return 'p';
  const t = raw.replace(/\r$/, '');
  // Code fence open/close
  if (/^```/.test(t)) return 'code-fence';
  // Display math (single-line)
  if (/^\s*\$\$[^$]+\$\$\s*$/.test(t)) return 'mathblock';
  // Callout
  if (/^>\s*\[!\w+\]/.test(t)) return 'callout';
  // Headings
  const h = t.match(/^(#{1,6})\s+/);
  if (h) return 'h' + h[1].length;
  // Quote
  if (/^>\s?/.test(t)) return 'quote';
  // HR
  if (/^(---+|\*\*\*+|___+)\s*$/.test(t)) return 'hr';
  // Task list (must come before plain list)
  if (/^[\s]*[-*+]\s+\[[ xX]\]\s+/.test(t)) return 'task';
  // Lists
  if (/^[\s]*[-*+]\s+/.test(t)) return 'list';
  if (/^\d+\.\s+/.test(t)) return 'olist';
  // Table row (cells separated by |)
  if (/^\s*\|.*\|\s*$/.test(t)) {
    if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(t)) return 'table-row table-divider';
    return 'table-row';
  }
  return 'p';
}

const LINE_KIND_CLASSES = [
  'is-h1','is-h2','is-h3','is-h4','is-h5','is-h6',
  'is-quote','is-hr','is-list','is-olist','is-p',
  'is-task','is-code-fence','is-mathblock','is-callout',
  'is-table-row','is-table-divider','is-table-header',
];

function applyLineKind(lineDiv, raw) {
  const kind = getLineKind(raw);
  const cls = lineDiv.classList;
  LINE_KIND_CLASSES.forEach(c => cls.remove(c));
  // Multi-word kinds (e.g. "table-row table-divider")
  kind.split(/\s+/).forEach(k => k && cls.add('is-' + k));
}

// ============ CALLOUT HELPERS ============
function calloutIcon(type) {
  const map = {
    info: 'ℹ', tip: '◆', note: '▤', success: '✓',
    warning: '⚠', danger: '✕', error: '✕', quote: '"',
    abstract: '☰', todo: '☐', question: '?', failure: '✕',
    bug: '⚡', example: '▸', cite: '"'
  };
  return map[type] || 'ℹ';
}
function calloutDefaultTitle(type) {
  const map = {
    info: __('callout.info'), tip: __('callout.tip'), note: __('callout.note'), success: __('callout.success'),
    warning: __('callout.warning'), danger: __('callout.danger'), error: __('callout.error'), quote: __('callout.quote'),
    abstract: __('callout.abstract'), todo: __('callout.todo'), question: __('callout.question'), failure: __('callout.failure'),
    bug: __('callout.bug'), example: __('callout.example'), cite: __('callout.quote')
  };
  return map[type] || type.charAt(0).toUpperCase() + type.slice(1);
}
function calloutSubclass(type) {
  const cat = {
    info: 'info', tip: 'info', note: 'info', abstract: 'info', question: 'info',
    success: 'success',
    warning: 'warning', todo: 'warning',
    danger: 'danger', error: 'danger', failure: 'danger', bug: 'danger',
    quote: 'quote', cite: 'quote', example: 'quote'
  };
  return 'callout-' + (cat[type] || 'info');
}

// ============ CODE BLOCK GROUPING + SYNTAX HIGHLIGHTING ============
function processCodeBlocks() {
  const lines = Array.from(content.querySelectorAll('.editor-line'));
  let inCode = false;
  let lang = '';
  let openFence = null;
  let blockLines = [];

  const flushHighlight = () => {
    if (!blockLines.length) return;
    const code = blockLines.map(l => l.dataset.raw || '').join('\n');
    if (typeof hljs === 'undefined') {
      blockLines.forEach(line => {
        line.classList.add('in-code');
        if (lang) line.dataset.lang = lang;
        // skip highlighting; just set monospace text content
        if (line !== activeLineNode) {
          const raw = line.dataset.raw || '';
          line.innerHTML = raw === '' ? '<br>' : `<code class="hljs">${escapeHtml(raw)}</code>`;
        }
      });
      return;
    }
    let highlighted;
    try {
      const validLang = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      highlighted = hljs.highlight(code, { language: validLang, ignoreIllegals: true }).value;
    } catch (e) {
      highlighted = escapeHtml(code);
    }
    // Re-distribute highlighted html back to each line by splitting on \n.
    // Re-open spans on each line so multi-line spans render correctly.
    const parts = splitHighlightedByNewline(highlighted);
    blockLines.forEach((line, idx) => {
      line.classList.add('in-code');
      if (lang) line.dataset.lang = lang;
      if (line === activeLineNode) return; // keep raw text in active line
      const piece = parts[idx] || '';
      line.innerHTML = `<code class="hljs">${piece || '​'}</code>`;
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const raw = ln.dataset.raw !== undefined ? ln.dataset.raw : ln.textContent;
    const fence = raw.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      if (!inCode) {
        // OPEN
        inCode = true;
        lang = fence[1] || '';
        openFence = ln;
        blockLines = [];
        ln.classList.add('is-code-fence', 'code-fence-open');
        if (lang) ln.dataset.lang = lang.toUpperCase();
      } else {
        // CLOSE
        ln.classList.add('is-code-fence', 'code-fence-close');
        flushHighlight();
        inCode = false;
        lang = '';
        openFence = null;
        blockLines = [];
      }
    } else if (inCode) {
      blockLines.push(ln);
    } else {
      // Clean up stale code-block classes on lines no longer inside a fence
      ln.classList.remove('in-code', 'is-code-fence', 'code-fence-open', 'code-fence-close');
    }
  }

  // Unclosed block at end of doc — treat its lines as in-code so they don't look wild
  if (inCode && blockLines.length) {
    flushHighlight();
  }
}

// Split highlighted HTML by \n while keeping span context across lines.
// highlight.js can emit spans that span newlines. We close+reopen at each \n.
function splitHighlightedByNewline(html) {
  // Walk through the HTML char by char, tracking nesting of <span> tags.
  const parts = [];
  let buf = '';
  const openStack = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const close = html.indexOf('>', i);
      if (close === -1) { buf += html.slice(i); break; }
      const tag = html.slice(i, close + 1);
      const isClose = tag.startsWith('</');
      if (isClose) {
        openStack.pop();
      } else if (!tag.endsWith('/>')) {
        openStack.push(tag);
      }
      buf += tag;
      i = close + 1;
      continue;
    }
    if (html[i] === '\n') {
      // Close currently-open spans, push the line, then reopen them on the next.
      const closers = openStack.map(() => '</span>').join('');
      const reopeners = openStack.join('');
      parts.push(buf + closers);
      buf = reopeners;
      i++;
      continue;
    }
    buf += html[i];
    i++;
  }
  parts.push(buf);
  return parts;
}

// ============ CALLOUT GROUPING ============
function processCallouts() {
  const lines = Array.from(content.querySelectorAll('.editor-line'));
  lines.forEach(ln => {
    if (!ln.classList.contains('is-callout')) {
      // strip any stale callout subclass
      ['callout-info','callout-warning','callout-danger','callout-success','callout-quote'].forEach(c => ln.classList.remove(c));
      return;
    }
    const raw = ln.dataset.raw || ln.textContent;
    const m = raw.match(/^>\s*\[!(\w+)\]/);
    if (!m) return;
    const sub = calloutSubclass(m[1].toLowerCase());
    ['callout-info','callout-warning','callout-danger','callout-success','callout-quote'].forEach(c => ln.classList.remove(c));
    ln.classList.add(sub);
  });
}

// ============ TABLE HEADER MARKER ============
function processTables() {
  const lines = Array.from(content.querySelectorAll('.editor-line'));
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    ln.classList.remove('is-table-header');
    if (ln.classList.contains('is-table-row') &&
        !ln.classList.contains('is-table-divider') &&
        lines[i + 1] &&
        lines[i + 1].classList.contains('is-table-divider')) {
      ln.classList.add('is-table-header');
    }
  }
}

// Aggregate post-pass: code blocks + callouts + tables
function postProcessRenderedLines() {
  processCodeBlocks();
  processCallouts();
  processTables();
  markFrontmatterLines();
}

// Tag the lines of a leading YAML frontmatter block (Obsidian-style: the very
// first line is "---", closed by the next "---" or "..." line) so the
// "Masquer le frontmatter" setting can hide them via CSS. The block stays in
// the document markdown — only its display is affected.
function markFrontmatterLines() {
  const lines = Array.from(content.children).filter(el => el.classList && el.classList.contains('editor-line'));
  lines.forEach(l => l.classList.remove('is-frontmatter'));
  if (!lines.length) return;

  const rawOf = (l) => {
    if (l === activeLineNode) return l.textContent;
    return (l.dataset.raw !== undefined) ? l.dataset.raw : l.textContent;
  };

  if (rawOf(lines[0]).trim() !== '---') return;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = rawOf(lines[i]).trim();
    if (t === '---' || t === '...') { end = i; break; }
  }
  if (end === -1) return;
  for (let i = 0; i <= end; i++) lines[i].classList.add('is-frontmatter');
}

let postProcessTimer;
function debouncedPostProcess() {
  clearTimeout(postProcessTimer);
  postProcessTimer = setTimeout(postProcessRenderedLines, 220);
}

function getLineForNode(node) {
  while (node && node !== content) {
    if (node.nodeType === 1 && node.classList && node.classList.contains('editor-line')) return node;
    node = node.parentNode;
  }
  return null;
}

function rangeOffsetIn(el, node, offsetInNode) {
  if (!el || !node) return 0;
  if (!el.contains(node) && node !== el) return 0;
  const r = document.createRange();
  try {
    r.selectNodeContents(el);
    r.setEnd(node, offsetInNode);
  } catch (e) {
    return 0;
  }
  return r.toString().length;
}

// Map a "rendered text" offset back to a "raw markdown" offset for a given line.
// We only correct for the BLOCK prefix (#, >, -, etc.) — inline markers (**, *, `)
// are an approximation: we accept slight imprecision for selections crossing inline marks.
function renderedToRawOffset(line, renderedOffset) {
  const raw = (line.dataset.raw !== undefined) ? line.dataset.raw : line.textContent;
  // If line is the active one, the displayed text IS the raw text — no shift.
  if (line === activeLineNode) return Math.min(renderedOffset, raw.length);
  const m = raw.match(/^(\s*)(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s)?/);
  const prefix = (m && m[2]) ? (m[1] || '') + m[2] : (m ? m[1] || '' : '');
  return Math.min(renderedOffset + prefix.length, raw.length);
}

function setCaretInLine(line, charOffset) {
  let textNode = line.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    textNode = document.createTextNode('');
    line.innerHTML = '';
    line.appendChild(textNode);
  }
  const len = textNode.nodeValue.length;
  const off = Math.max(0, Math.min(charOffset, len));
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(textNode, off);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// Re-select [start, end) inside a line's single text node, keeping a visible
// selection after formatting so the effect can be toggled live.
function setSelectionInLine(line, start, end) {
  let textNode = line.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    textNode = document.createTextNode(line.textContent);
    line.innerHTML = '';
    line.appendChild(textNode);
  }
  const len = textNode.nodeValue.length;
  const s = Math.max(0, Math.min(start, len));
  const e = Math.max(s, Math.min(end, len));
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(textNode, s);
  r.setEnd(textNode, e);
  sel.removeAllRanges();
  sel.addRange(r);
}

function makeLineRawAndActive(line) {
  if (!line) return;
  const raw = (line.dataset.raw !== undefined) ? line.dataset.raw : line.textContent;
  // Only on a true activation — a repeat call on the already-active line must
  // not overwrite the remembered on-activation content.
  if (line !== activeLineNode) line.dataset.rawOnActivate = raw;
  line.dataset.raw = raw;
  line.textContent = raw;
  if (activeLineNode && activeLineNode !== line) removeAbandonedEmptyLine(activeLineNode);
  if (activeLineNode && activeLineNode !== line && content.contains(activeLineNode)) {
    // commit old active line back to rendered HTML
    const oldRaw = activeLineNode.textContent;
    activeLineNode.dataset.raw = oldRaw;
    applyLineKind(activeLineNode, oldRaw);
    activeLineNode.innerHTML = oldRaw.trim() === '' ? '<br>' : renderMarkdownLine(oldRaw);
    activeLineNode.classList.remove('active-line');
  }
  activeLineNode = line;
  line.classList.add('active-line');
  applyLineKind(line, raw);
}

function deleteRangeAcrossLines(range) {
  const startLine = getLineForNode(range.startContainer);
  const endLine = getLineForNode(range.endContainer);
  if (!startLine || !endLine) return;

  // Capture rendered offsets BEFORE we mutate the DOM
  const startOffRendered = rangeOffsetIn(startLine, range.startContainer, range.startOffset);
  const endOffRendered = rangeOffsetIn(endLine, range.endContainer, range.endOffset);

  // Map to raw offsets
  const startOffRaw = renderedToRawOffset(startLine, startOffRendered);
  const endOffRaw = renderedToRawOffset(endLine, endOffRendered);

  const startRaw = (startLine.dataset.raw !== undefined) ? startLine.dataset.raw : startLine.textContent;
  const endRaw = (endLine.dataset.raw !== undefined) ? endLine.dataset.raw : endLine.textContent;

  if (startLine === endLine) {
    const newRaw = startRaw.substring(0, startOffRaw) + startRaw.substring(endOffRaw);
    if (startLine !== activeLineNode) makeLineRawAndActive(startLine);
    startLine.textContent = newRaw;
    startLine.dataset.raw = newRaw;
    applyLineKind(startLine, newRaw);
    setCaretInLine(startLine, startOffRaw);
    return;
  }

  const textBefore = startRaw.substring(0, startOffRaw);
  const textAfter = endRaw.substring(endOffRaw);
  const combined = textBefore + textAfter;

  // Remove middle and end lines (clean activeLineNode if it's among them)
  let cur = startLine.nextSibling;
  while (cur && cur !== endLine) {
    const next = cur.nextSibling;
    if (cur === activeLineNode) activeLineNode = null;
    cur.remove();
    cur = next;
  }
  if (endLine.parentNode) {
    if (endLine === activeLineNode) activeLineNode = null;
    endLine.remove();
  }

  // Activate the start line, set combined raw as its text
  if (activeLineNode && activeLineNode !== startLine && content.contains(activeLineNode)) {
    activeLineNode.classList.remove('active-line');
  }
  startLine.dataset.raw = combined;
  startLine.textContent = combined;
  startLine.classList.add('active-line');
  applyLineKind(startLine, combined);
  activeLineNode = startLine;
  setCaretInLine(startLine, textBefore.length);
}

// A block is discarded when the caret leaves it while it holds zero characters
// and it either (a) was created by clicking the editor background, or (b) had
// content when it became active and was emptied by the user. A block holding
// anything — even a single space — is kept, as are empty lines the caret merely
// passed through (paragraph breaks) and lines created with Enter.
function removeAbandonedEmptyLine(line) {
  if (!line || !line.dataset) return false;
  if (line.textContent !== '') {
    delete line.dataset.gutterCreated;
    delete line.dataset.rawOnActivate;
    return false;
  }
  const wasClickCreated = !!line.dataset.gutterCreated;
  const wasEmptiedByUser = line.dataset.rawOnActivate !== undefined && line.dataset.rawOnActivate !== '';
  if (!wasClickCreated && !wasEmptiedByUser) {
    delete line.dataset.rawOnActivate;
    return false;
  }
  if (!content.contains(line)) return false;
  content.removeChild(line);
  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();
  return true;
}

// Set while a right-click is in progress. The browser fires selectionchange
// when the caret moves on right-click; re-rendering the block to raw text at
// that moment destroys the DOM node the native spellcheck menu is about to
// target, so the correction suggestions vanish. Skipping activation keeps the
// rendered block untouched until the context menu is done.
let suppressLineActivation = false;
let suppressLineActivationTimer = null;

function updateActiveLine() {
  if (readingModeState) return;
  if (suppressLineActivation) return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;

  const range = sel.getRangeAt(0);
  let node = range.startContainer;

  while (node && node !== content) {
    if (node.parentNode === content) {
      break;
    }
    node = node.parentNode;
  }

  if (node && node.parentNode === content) {
    if (node !== activeLineNode) {
      hideBlockTrashBtnNow();
      // Transition old active line to rendered HTML (unless it was a still-empty
      // click-created block, which is dropped instead)
      if (activeLineNode && !removeAbandonedEmptyLine(activeLineNode) && content.contains(activeLineNode)) {
        const raw = activeLineNode.textContent;
        activeLineNode.dataset.raw = raw;
        applyLineKind(activeLineNode, raw);
        activeLineNode.innerHTML = raw.trim() === '' ? '<br>' : renderMarkdownLine(raw);
        activeLineNode.classList.remove('active-line');
      }
      // The previous block was just validated (selection moved on): save it.
      scheduleBlockValidationSave();

      // Transition new active line to raw text
      activeLineNode = node;
      activeLineNode.classList.add('active-line');
      if (typewriterState) centerActiveLine(true);

      const rawText = activeLineNode.dataset.raw !== undefined ? activeLineNode.dataset.raw : activeLineNode.textContent;
      // Remember what the block held on activation, so an emptied-out block can
      // be told apart from one that was already empty (see removeAbandonedEmptyLine)
      activeLineNode.dataset.rawOnActivate = rawText;
      const offset = getCaretCharacterOffsetWithin(activeLineNode);

      activeLineNode.textContent = rawText;
      applyLineKind(activeLineNode, rawText);
      setCaretPosition(activeLineNode, offset);
      // Re-group / re-highlight after leaving a possible code/callout/table line
      debouncedPostProcess();
    }
  } else {
    // Clicked outside content lines
    if (activeLineNode && removeAbandonedEmptyLine(activeLineNode)) {
      activeLineNode = null;
    } else if (activeLineNode && content.contains(activeLineNode)) {
      const raw = activeLineNode.textContent;
      activeLineNode.dataset.raw = raw;
      applyLineKind(activeLineNode, raw);
      activeLineNode.innerHTML = raw.trim() === '' ? '<br>' : renderMarkdownLine(raw);
      activeLineNode.classList.remove('active-line');
      activeLineNode = null;
      // The edited block was validated by clicking outside: save it.
      scheduleBlockValidationSave();
      debouncedPostProcess();
    }
  }
}

// True when [s,e) sits immediately inside `prefix`/`suffix` in `text` (selection
// excludes the markers themselves, e.g. selecting "test" inside "**test**").
// Rejects matches that are actually part of a longer run of the same character
// (e.g. a lone '*' check must not fire on text that's really wrapped in '**').
// Not used for asterisk markers — see markerRunDepth() for those, which
// handles combined "***bold italic***" runs instead of just rejecting them.
function isExactlyNestedInPair(text, s, e, prefix, suffix) {
  const before = text.slice(Math.max(0, s - prefix.length), s);
  const after = text.slice(e, e + suffix.length);
  if (before !== prefix || after !== suffix) return false;
  const pChar = prefix.charAt(prefix.length - 1);
  const sChar = suffix.charAt(0);
  if (text.charAt(s - prefix.length - 1) === pChar) return false;
  if (text.charAt(e + suffix.length) === sChar) return false;
  return true;
}

function runLengthBefore(text, pos, ch) {
  let n = 0;
  while (pos - n - 1 >= 0 && text.charAt(pos - n - 1) === ch) n++;
  return n;
}
function runLengthAfter(text, pos, ch) {
  let n = 0;
  while (text.charAt(pos + n) === ch) n++;
  return n;
}

// How many layers of a repeated character (e.g. '*') wrap [s,e) — counting
// markers whether the selection includes them (dragged across the asterisks)
// or sits just inside them. This lets "***bold italic***" register as both
// bold (depth>=2) and italic (depth===1 or >=3) depending on which button is
// toggled, instead of only ever matching the outermost pair.
function markerRunDepth(text, s, e, ch) {
  let innerS = s, innerE = e;
  while (innerS < innerE && text.charAt(innerS) === ch) innerS++;
  while (innerE > innerS && text.charAt(innerE - 1) === ch) innerE--;
  const leadInSel = innerS - s;
  const trailInSel = e - innerE;
  const before = leadInSel > 0 ? leadInSel : runLengthBefore(text, s, ch);
  const after = trailInSel > 0 ? trailInSel : runLengthAfter(text, e, ch);
  return { depth: Math.min(before, after), innerS, innerE };
}

// Nearest asterisk runs of length >= n enclosing the selection, skipping
// shorter runs (e.g. a single '*' when toggling bold). Returns null when the
// selection is not inside an enclosing run of that marker.
function findEnclosingRuns(text, innerS, innerE, n) {
  let leftStart = -1, leftLen = 0;
  let i = innerS - 1;
  while (i >= 0) {
    if (text.charAt(i) === '*') {
      let j = i;
      while (j >= 0 && text.charAt(j) === '*') j--;
      const runStart = j + 1;
      const runLen = i - j;
      if (runLen >= n) { leftStart = runStart; leftLen = runLen; break; }
      i = j;
    } else {
      i--;
    }
  }
  if (leftStart === -1) return null;

  let rightStart = -1, rightLen = 0;
  i = innerE;
  while (i < text.length) {
    if (text.charAt(i) === '*') {
      let j = i;
      while (j < text.length && text.charAt(j) === '*') j++;
      const runLen = j - i;
      if (runLen >= n) { rightStart = i; rightLen = runLen; break; }
      i = j;
    } else {
      i++;
    }
  }
  if (rightStart === -1 || rightStart < innerS) return null;

  return {
    leftStart, leftLen, rightStart, rightLen,
    contentStart: leftStart + leftLen,
    contentEnd: rightStart
  };
}

// Toggle an asterisk marker ('*' italic, '**' bold, '***' bold+italic) around
// [s,e). Wraps plain text, unwraps or splits when the selection sits inside an
// enclosing run (so a word inside a bold paragraph toggles off just that word),
// and when a selection already mixes bold runs, strips every bold marker so a
// paragraph toggles back to plain in one go while italic and strikethrough
// stay untouched.
function toggleAsteriskRun(text, s, e, n) {
  const marker = '*'.repeat(n);

  let innerS = s, innerE = e;
  while (innerS < innerE && text.charAt(innerS) === '*') innerS++;
  while (innerE > innerS && text.charAt(innerE - 1) === '*') innerE--;
  const leadInSel = innerS - s;
  const trailInSel = e - innerE;

  // Italic nests inside bold rather than splitting it: it only unwraps when
  // the selection sits directly between single asterisks (e.g. inside `*...*`),
  // otherwise it wraps and creates `**...*mot*...**`.
  if (n === 1) {
    const leftAdj = leadInSel > 0 ? leadInSel : runLengthBefore(text, innerS, '*');
    const rightAdj = trailInSel > 0 ? trailInSel : runLengthAfter(text, innerE, '*');
    if (leftAdj >= 1 && rightAdj >= 1) {
      return splitAsteriskRun(text, innerS, innerE, 1);
    }
    const selectedText = text.slice(s, e);
    return { newText: text.slice(0, s) + marker + selectedText + marker + text.slice(e), newStart: s + 1, newEnd: s + 1 + selectedText.length };
  }

  const run = findEnclosingRuns(text, innerS, innerE, n);
  if (run) {
    return splitAsteriskRun(text, innerS, innerE, n, run);
  }
  if (text.slice(s, e).indexOf(marker) !== -1) {
    // Mixed bold inside the selection: strip every marker, keeping italic,
    // strikethrough and the rest intact.
    const inner = text.slice(s, e).split(marker).join('');
    return { newText: text.slice(0, s) + inner + text.slice(e), newStart: s, newEnd: s + inner.length };
  }
  const selectedText = text.slice(s, e);
  return { newText: text.slice(0, s) + marker + selectedText + marker + text.slice(e), newStart: s + n, newEnd: s + n + selectedText.length };
}

// Split or unwrap an asterisk run: the selection loses `n` layers while the
// surrounding A/B parts keep their full depth (re-wrapped), and uneven runs
// leave residual asterisks at the edges (italic inside bold closes correctly).
function splitAsteriskRun(text, innerS, innerE, n, run) {
  const found = run || findEnclosingRuns(text, innerS, innerE, n);
  if (!found) return null;

  const { leftStart, leftLen, rightStart, rightLen, contentStart, contentEnd } = found;
  let A = text.slice(contentStart, innerS);
  let B = text.slice(innerE, contentEnd);
  let trailSpace = '', leadSpace = '';
  const mTrail = A.match(/[ \t]+$/);
  if (mTrail) { trailSpace = mTrail[0]; A = A.slice(0, A.length - mTrail[0].length); }
  const mLead = B.match(/^[ \t]+/);
  if (mLead) { leadSpace = mLead[0]; B = B.slice(mLead[0].length); }

  const depth = Math.min(leftLen, rightLen);
  const dMark = '*'.repeat(depth);
  const selMark = '*'.repeat(Math.max(0, depth - n));
  const partA = A ? dMark + A + dMark : '';
  const partB = B ? dMark + B + dMark : '';
  const leftRemain = '*'.repeat(leftLen - depth);
  const rightRemain = '*'.repeat(rightLen - depth);

  const newText = text.slice(0, leftStart) + leftRemain + partA + trailSpace + selMark + text.slice(innerS, innerE) + selMark + leadSpace + partB + rightRemain + text.slice(rightStart + rightLen);
  const newStart = leftStart + leftRemain.length + partA.length + trailSpace.length + selMark.length;
  const newEnd = newStart + (innerE - innerS);
  return { newText, newStart, newEnd };
}

// Toggle `prefix`/`suffix` markup on/off around [s,e) in `text`, returning the
// new text plus the new [start,end) of the (still-selected) inner text.
function toggleInlineMarkers(text, s, e, prefix, suffix) {
  const selectedText = text.slice(s, e);

  if (prefix === suffix && /^\*+$/.test(prefix)) {
    return toggleAsteriskRun(text, s, e, prefix.length);
  }

  if (selectedText.startsWith(prefix) && selectedText.endsWith(suffix) && selectedText.length >= prefix.length + suffix.length) {
    const unwrapped = selectedText.slice(prefix.length, selectedText.length - suffix.length);
    const newText = text.slice(0, s) + unwrapped + text.slice(e);
    return { newText, newStart: s, newEnd: s + unwrapped.length };
  }
  if (isExactlyNestedInPair(text, s, e, prefix, suffix)) {
    const newText = text.slice(0, s - prefix.length) + selectedText + text.slice(e + suffix.length);
    return { newText, newStart: s - prefix.length, newEnd: (s - prefix.length) + selectedText.length };
  }
  const wrapped = prefix + selectedText + suffix;
  const newText = text.slice(0, s) + wrapped + text.slice(e);
  return { newText, newStart: s + prefix.length, newEnd: s + prefix.length + selectedText.length };
}

function wrapSelectionInline(prefix, suffix = prefix) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;

  const startLine = getLineForNode(range.startContainer) || (range.startContainer === content ? content.firstElementChild : null);
  const endLine = getLineForNode(range.endContainer) || (range.endContainer === content ? content.lastElementChild : null);
  if (!startLine || !endLine) return;

  saveHistory(state.activeDocId, true);

  // Capture rendered offsets BEFORE modifying any line state
  const startOffRendered = rangeOffsetIn(startLine, range.startContainer, range.startOffset);
  const endOffRendered = rangeOffsetIn(endLine, range.endContainer, range.endOffset);

  // Convert to raw offsets
  const startOffRaw = renderedToRawOffset(startLine, startOffRendered);
  const endOffRaw = renderedToRawOffset(endLine, endOffRendered);

  // Collect all lines in the selection range
  const linesToProcess = [];
  let curr = startLine;
  while (curr) {
    if (curr.nodeType === 1 && curr.classList.contains('editor-line')) {
      linesToProcess.push(curr);
    }
    if (curr === endLine) break;
    curr = curr.nextSibling;
  }

  if (linesToProcess.length === 0) return;

  if (linesToProcess.length === 1) {
    // Single line selection
    const line = linesToProcess[0];
    if (line !== activeLineNode) {
      makeLineRawAndActive(line);
    }

    const text = line.textContent;
    const s = Math.min(startOffRaw, endOffRaw);
    const e = Math.max(startOffRaw, endOffRaw);
    const selectedText = text.substring(s, e);
    if (!selectedText) return;

    // Toggles off if already wrapped — whether the selection includes the
    // markers themselves or sits just inside them (e.g. selecting exactly
    // "test" within "**test**", or within "***test***" for bold+italic).
    const { newText, newStart, newEnd } = toggleInlineMarkers(text, s, e, prefix, suffix);

    line.textContent = newText;
    line.dataset.raw = newText;
    applyLineKind(line, newText);

    // Re-select the inner formatted text
    let tn = line.firstChild;
    if (!tn || tn.nodeType !== Node.TEXT_NODE) {
      tn = document.createTextNode(newText);
      line.innerHTML = '';
      line.appendChild(tn);
    }
    const newRange = document.createRange();
    newRange.setStart(tn, Math.min(newStart, tn.nodeValue.length));
    newRange.setEnd(tn, Math.min(newEnd, tn.nodeValue.length));
    sel.removeAllRanges();
    sel.addRange(newRange);
  } else {
    // Multi-line selection
    linesToProcess.forEach((line, idx) => {
      if (line !== activeLineNode) {
        makeLineRawAndActive(line);
      }
      const text = line.textContent;
      let s = 0;
      let e = text.length;

      if (idx === 0) {
        s = startOffRaw;
      }
      if (idx === linesToProcess.length - 1) {
        e = endOffRaw;
      }

      if (s >= e) return;

      const selectedText = text.substring(s, e);
      if (!selectedText.trim()) return;

      const { newText } = toggleInlineMarkers(text, s, e, prefix, suffix);

      line.textContent = newText;
      line.dataset.raw = newText;
      applyLineKind(line, newText);
    });

    makeLineRawAndActive(endLine);
  }

  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
}

function prefixActiveLine(prefix, opts = {}) {
  if (!activeLineNode) return;
  
  saveHistory(state.activeDocId, true);
  
  let text = activeLineNode.textContent;
  
  if (opts.cycleHeading) {
    const m = text.match(/^(#{0,6})\s?(.*)$/);
    const level = m[1].length;
    const rest = m[2];
    const next = level >= 6 ? 0 : level + 1;
    text = next === 0 ? rest : '#'.repeat(next) + ' ' + rest;
  } else if (opts.removePrefix) {
    if (text.startsWith('# ')) text = text.substring(2);
    else if (text.startsWith('#')) {
      const m = text.match(/^(#+)\s?(.*)$/);
      if (m) text = m[2];
    }
  } else {
    text = prefix + text;
  }
  
  activeLineNode.textContent = text;
  
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(activeLineNode);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  
  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
}

// ============ GLOBAL INTERACTIVE EVENTS ============

// Shortcuts listener
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const target = e.target;
  const inEditor = content.contains(target) || target === title || target === subtitle;
  const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

  // Chord mode execution
  if (chordPending) {
    const k = e.key.toLowerCase();
    e.preventDefault();
    if (k === 'c') {
      prefixActiveLine('', { cycleHeading: true });
    } else if (k === 'u') {
      wrapSelectionInline('<u>', '</u>');
    } else if (k === 'q') {
      prefixActiveLine('> ');
    } else if (k === 'l') {
      prefixActiveLine('- ');
    } else if (k === 'd') {
      wrapSelectionInline('`');
    }
    setChord(false);
    return;
  }

  // Ctrl+Z or Ctrl+Shift+Z / Ctrl+Y : Undo / Redo (only in editor fields)
  if (inEditor && ctrl && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    try {
      if (e.shiftKey) {
        performRedo();
      } else {
        performUndo();
      }
    } catch (err) {
      console.error('Error in custom undo/redo:', err);
    }
    return;
  }
  if (inEditor && ctrl && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    try {
      performRedo();
    } catch (err) {
      console.error('Error in custom redo:', err);
    }
    return;
  }

  // Ctrl+N : Nouveau texte
  if (ctrl && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    const doc = activeDoc();
    const sectionId = doc ? doc.id.split('/')[0] : (state.sections[0]?.id || 'Manifestes');
    createDocument(sectionId);
    return;
  }

  // Ctrl+S : Force Save
  if (ctrl && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveDocumentOnDisk();
    return;
  }

  // Ctrl+P / Ctrl+Shift+F : Ouvrir la palette de recherche
  if (ctrl && (e.key.toLowerCase() === 'p' || (e.shiftKey && e.key.toLowerCase() === 'f'))) {
    e.preventDefault();
    openSearch();
    return;
  }

  // Toggle Focus Mode (F key when not typing)
  if (e.key.toLowerCase() === 'f' && !ctrl && !inField) {
    e.preventDefault();
    if (typeof toggleFocusMode === 'function') toggleFocusMode();
    else app.classList.toggle('focus-mode');
    return;
  }

  // Simple-letter toggles for the writing modes: T typewriter, P paragraph
  // focus, R reading, A auto-scroll, Tab cycles the three display modes.
  // Like F, they fire only when not typing in a field, so they never insert a
  // letter into the text (Tab keeps indenting while the editor has focus).
  if (!ctrl && !e.altKey && !e.metaKey && !inField) {
    const k = e.key.toLowerCase();
    // Tab cycles the display modes only when no focusable control is focused,
    // so it keeps its standard role of moving focus between buttons and links.
    if (k === 'tab' && target.tagName !== 'BUTTON' && target.tagName !== 'SELECT' && target.tagName !== 'A') {
      e.preventDefault(); applyReadingMode((readingModeState + 1) % 3); return;
    }
    if (k === 't') { e.preventDefault(); applyTypewriterMode(!typewriterState); return; }
    if (k === 'p') { e.preventDefault(); applyFocusLineMode(!focusLineState); return; }
    if (k === 'r') { e.preventDefault(); applyReadingMode((readingModeState + 1) % 3); return; }
    if (k === 'a') { e.preventDefault(); cycleAutoScroll(); return; }
  }

  // Editor specific shortcuts
  if (!content.contains(target)) return;

  // Ctrl+K Chord Initiator
  if (ctrl && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    setChord(true);
    return;
  }

  // Ctrl+G: Gras
  if (ctrl && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    wrapSelectionInline('**');
    return;
  }

  // Ctrl+B: Gras (alt)
  if (ctrl && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    wrapSelectionInline('**');
    return;
  }

  // Ctrl+I: Italique
  if (ctrl && e.key.toLowerCase() === 'i') {
    e.preventDefault();
    wrapSelectionInline('*');
    return;
  }

  // Tab key (indenting / tab completions)
  if (e.key === 'Tab') {
    e.preventDefault();
    if (activeLineNode) {
      saveHistory(state.activeDocId, true);
      if (e.shiftKey) {
        let text = activeLineNode.textContent;
        if (text.startsWith('  ')) {
          activeLineNode.textContent = text.substring(2);
        } else if (text.startsWith(' ')) {
          activeLineNode.textContent = text.substring(1);
        }
      } else {
        document.execCommand('insertText', false, '  ');
      }
      markDirty();
      updateStats();
      saveHistory(state.activeDocId, true);
    }
    return;
  }

  // Backspace / Delete with a non-collapsed selection: delete the selection,
  // even when it spans multiple .editor-line blocks (browser default mishandles this).
  if ((e.key === 'Backspace' || e.key === 'Delete') && content.contains(target)) {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (!range.collapsed) {
        e.preventDefault();
        saveHistory(state.activeDocId, true);
        deleteRangeAcrossLines(range);
        markDirty();
        updateStats();
        saveHistory(state.activeDocId, true);
        debouncedRegenerateTOC();
        return;
      }
    }
  }

  // Backspace at the start of a line: merge with the previous line
  if (e.key === 'Backspace' && activeLineNode) {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (range.collapsed && range.startOffset === 0 && range.endOffset === 0) {
        e.preventDefault();
        const prevLine = activeLineNode.previousSibling;
        if (prevLine && prevLine.classList.contains('editor-line')) {
          saveHistory(state.activeDocId, true);
          
          const currentText = activeLineNode.textContent;
          const prevRaw = prevLine.dataset.raw !== undefined ? prevLine.dataset.raw : prevLine.textContent;
          const oldPrevTextLength = prevRaw.length;
          
          prevLine.textContent = prevRaw + currentText;
          activeLineNode.classList.remove('active-line');
          
          const parent = activeLineNode.parentNode;
          parent.removeChild(activeLineNode);
          
          activeLineNode = prevLine;
          activeLineNode.classList.add('active-line');
          
          prevLine.focus();
          const sel = window.getSelection();
          const newRange = document.createRange();
          let textNode = prevLine.firstChild;
          if (!textNode) {
            textNode = document.createTextNode('');
            prevLine.appendChild(textNode);
          }
          newRange.setStart(textNode, oldPrevTextLength);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);
          
          markDirty();
          updateStats();
          saveHistory(state.activeDocId, true);
        }
        return;
      }
    }
  }

  // Enter: Split line and continue lists
  if (e.key === 'Enter' && !e.shiftKey && activeLineNode) {
    e.preventDefault();
    saveHistory(state.activeDocId, true);
    
    const text = activeLineNode.textContent;
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    const caretOffset = range.startOffset;
    
    const beforeText = text.substring(0, caretOffset);
    const afterText = text.substring(caretOffset);
    
    const listMatch = beforeText.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    let newLineText = '';
    
    if (listMatch) {
      const [, indent, marker, rest] = listMatch;
      if (!rest && !afterText) {
        activeLineNode.textContent = '';
        markDirty();
        updateStats();
        return;
      }
      const nextMarker = /^\d+\./.test(marker) 
        ? (parseInt(marker) + 1) + '.' 
        : marker;
      newLineText = indent + nextMarker + ' ';
    }
    
    activeLineNode.textContent = beforeText;
    
    const newLine = document.createElement('div');
    newLine.className = 'editor-line';
    newLine.dataset.raw = newLineText + afterText;
    newLine.textContent = newLineText + afterText;
    
    activeLineNode.parentNode.insertBefore(newLine, activeLineNode.nextSibling);
    
    newLine.focus();
    const sel = window.getSelection();
    const newRange = document.createRange();
    let textNode = newLine.firstChild;
    if (!textNode) {
      textNode = document.createTextNode('');
      newLine.appendChild(textNode);
    }
    newRange.setStart(textNode, Math.min(newLineText.length, textNode.length));
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    
    const oldRaw = activeLineNode.textContent;
    activeLineNode.dataset.raw = oldRaw;
    activeLineNode.innerHTML = renderMarkdownLine(oldRaw);
    activeLineNode.classList.remove('active-line');
    
    activeLineNode = newLine;
    activeLineNode.classList.add('active-line');
    
    markDirty();
    updateStats();
    saveHistory(state.activeDocId, true);
    return;
  }
});

// ============ COLOR THEME (Settings > Apparence) ============
// Separate concept from state.ideaThemes/state.activeThemeId (document topic
// tabs) — "color theme" here means the app's visual palette.

const COLOR_THEME_FIELD_GROUPS = {
  base: [
    { key: '--bg', label: function () { return __('color.bg'); } },
    { key: '--bg-elevated', label: function () { return __('color.bg_elevated'); } },
    { key: '--bg-hover', label: function () { return __('color.bg_hover'); } },
    { key: '--bg-active', label: function () { return __('color.bg_active'); } },
    { key: '--border', label: function () { return __('color.border'); } },
    { key: '--border-strong', label: function () { return __('color.border_strong'); } },
    { key: '--text', label: function () { return __('color.text'); } },
    { key: '--text-muted', label: function () { return __('color.text_muted'); } },
    { key: '--text-faint', label: function () { return __('color.text_faint'); } },
    { key: '--accent', label: function () { return __('color.accent'); } },
    { key: '--danger', label: function () { return __('color.danger'); } },
  ],
  syntax: [
    { key: '--syn-h1', label: function () { return __('color.syn_h1'); } },
    { key: '--syn-h2', label: function () { return __('color.syn_h2'); } },
    { key: '--syn-h3', label: function () { return __('color.syn_h3'); } },
    { key: '--syn-h4', label: function () { return __('color.syn_h4'); } },
    { key: '--syn-h5', label: function () { return __('color.syn_h5'); } },
    { key: '--syn-h6', label: function () { return __('color.syn_h6'); } },
    { key: '--syn-bold', label: function () { return __('color.syn_bold'); } },
    { key: '--syn-quote', label: function () { return __('color.syn_quote'); } },
    { key: '--syn-link', label: function () { return __('color.syn_link'); } },
    { key: '--syn-code', label: function () { return __('color.syn_code'); } },
    { key: '--syn-strike', label: function () { return __('color.syn_strike'); } },
  ],
};
const COLOR_THEME_ALL_VARS = [
  ...COLOR_THEME_FIELD_GROUPS.base.map(f => f.key),
  ...COLOR_THEME_FIELD_GROUPS.syntax.map(f => f.key),
];

function getBuiltinColorThemes() {
  return [
    { id: 'default', name: __('appearance.theme_default'), bg: '#0d0d0e', dot: '#c9a96a' },
    { id: 'ivoire',  name: __('appearance.theme_ivoire'),  bg: '#f5efe3', dot: '#a8632f' },
    { id: 'polaire', name: __('appearance.theme_polaire'), bg: '#0a0f14', dot: '#5fb3c9' },
  ];
}

let colorThemeState = {
  id: localStorage.getItem('scriptoriumColorTheme') || 'default',
  mdColor: localStorage.getItem('scriptoriumMdColor') === '1',
  customVars: null,
  // Named custom themes loaded from <workspace>/.themes/ ({ id, name, vars }).
  customThemes: [],
};

// A custom theme id is "custom:<themeId>"; built-in ids are plain ('default',
// 'ivoire', 'polaire').
function isCustomThemeId(id) {
  return typeof id === 'string' && id.startsWith('custom:');
}
function customThemeKey(id) {
  return isCustomThemeId(id) ? id.slice('custom:'.length) : id;
}
function getCustomThemeById(id) {
  const key = customThemeKey(id);
  return colorThemeState.customThemes.find(t => t.id === key) || null;
}
async function loadColorThemes() {
  try {
    const res = await fetch('/api/color-themes');
    const data = await res.json();
    colorThemeState.customThemes = (data && Array.isArray(data.themes)) ? data.themes : [];
  } catch (e) {
    colorThemeState.customThemes = [];
  }
}

// Parses a colour as { r, g, b, a } — accepts #RGB, #RRGGBB, #RRGGBBAA and
// rgb()/rgba(). Returns null for anything else (e.g. "transparent").
function parseHexColor(v) {
  const s = String(v || '').trim();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    const clamp = n => Math.max(0, Math.min(255, Math.round(Number(n))));
    let a = 1;
    if (m[4] != null) {
      a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
      a = Math.max(0, Math.min(1, a));
    }
    return { r: clamp(m[1]), g: clamp(m[2]), b: clamp(m[3]), a };
  }
  return null;
}

// The RGB part as a #RRGGBB string (for <input type="color">).
function toHexColor(v) {
  const c = parseHexColor(v);
  return c ? '#' + [c.r, c.g, c.b].map(n => n.toString(16).padStart(2, '0')).join('') : null;
}

// Serialises back to CSS: 8-digit hex keeps the alpha when it is not opaque,
// so a transparent border stays transparent.
function colorToCss(c) {
  const hex = [c.r, c.g, c.b].map(n => n.toString(16).padStart(2, '0')).join('');
  if (c.a >= 1) return '#' + hex;
  return '#' + hex + Math.round(c.a * 255).toString(16).padStart(2, '0');
}

function deriveAccentSoft(hex) {
  const c = parseHexColor(hex);
  if (!c) return null;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a * 0.15).toFixed(3)})`;
}

// Reads the CSS-declared values for a built-in theme without leaving a visible
// flash — swap data-theme, read computed vars, restore, all in one sync pass.
function getComputedThemeVars(themeId) {
  const root = document.documentElement;
  const prevTheme = root.getAttribute('data-theme');
  const prevInline = {};
  COLOR_THEME_ALL_VARS.forEach(v => { prevInline[v] = root.style.getPropertyValue(v); });
  COLOR_THEME_ALL_VARS.forEach(v => root.style.removeProperty(v));
  root.setAttribute('data-theme', themeId);
  const computed = getComputedStyle(root);
  const out = {};
  COLOR_THEME_ALL_VARS.forEach(v => { out[v] = computed.getPropertyValue(v).trim(); });
  if (prevTheme) root.setAttribute('data-theme', prevTheme); else root.removeAttribute('data-theme');
  COLOR_THEME_ALL_VARS.forEach(v => { if (prevInline[v]) root.style.setProperty(v, prevInline[v]); });
  return out;
}

// Paints the given vars onto the "custom" data-theme and derives --accent-soft.
function applyCustomThemeVars(vars) {
  const root = document.documentElement;
  COLOR_THEME_ALL_VARS.forEach(v => root.style.removeProperty(v));
  root.style.removeProperty('--accent-soft');
  root.setAttribute('data-theme', 'custom');
  COLOR_THEME_ALL_VARS.forEach(v => { if (vars && vars[v]) root.style.setProperty(v, vars[v]); });
  const soft = vars ? deriveAccentSoft(vars['--accent']) : null;
  if (soft) root.style.setProperty('--accent-soft', soft);
}

function applyColorTheme(id, opts = {}) {
  colorThemeState.id = id;
  const root = document.documentElement;

  if (isCustomThemeId(id)) {
    const theme = getCustomThemeById(id);
    const vars = (theme && theme.vars) || colorThemeState.customVars || getComputedThemeVars('default');
    colorThemeState.customVars = vars;
    applyCustomThemeVars(vars);
    // Cache for the pre-paint script so a reload paints the theme directly.
    localStorage.setItem('scriptoriumCustomThemeVars', JSON.stringify(vars));
  } else {
    COLOR_THEME_ALL_VARS.forEach(v => root.style.removeProperty(v));
    root.style.removeProperty('--accent-soft');
    root.setAttribute('data-theme', id);
  }

  if (!opts.skipPersist) localStorage.setItem('scriptoriumColorTheme', id);
}

function applyMdColor(on) {
  colorThemeState.mdColor = on;
  document.documentElement.classList.toggle('md-color-on', on);
  localStorage.setItem('scriptoriumMdColor', on ? '1' : '0');
}

function renderColorThemeSwatches() {
  const container = $('colorThemeSwatches');
  if (!container) return;
  container.innerHTML = '';
  var themes = getBuiltinColorThemes();
  var all = themes.concat(colorThemeState.customThemes.map(t => ({ id: 'custom:' + t.id, name: t.name, custom: true, theme: t })));
  all.forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-theme-swatch' + (colorThemeState.id === t.id ? ' active' : '');
    const preview = t.custom
      ? buildCustomThemeSwatchPreview(t.theme)
      : `<span class="color-theme-swatch-preview" style="background:${t.bg}"><span style="background:${t.dot}"></span></span>`;
    btn.innerHTML = `${preview}<span class="color-theme-swatch-label">${escapeHtml(t.name)}</span>`;
    btn.addEventListener('click', () => selectColorTheme(t.id));
    container.appendChild(btn);
  });
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'color-theme-swatch add';
  addBtn.innerHTML = `<span class="color-theme-swatch-preview custom-preview">＋</span><span class="color-theme-swatch-label">${escapeHtml(__('settings.new_theme_btn'))}</span>`;
  addBtn.addEventListener('click', createNewColorTheme);
  container.appendChild(addBtn);
}

// Swatch preview for a custom theme: shows its background media (image/video)
// when one is set, otherwise its background colour with a text-colour dot.
function buildCustomThemeSwatchPreview(theme) {
  const vars = theme.vars || {};
  const bg = toHexColor(vars['--bg']) || '#0d0d0e';
  const text = toHexColor(vars['--text']) || '#d8d4cc';
  const bgSetting = getThemeBackground('custom:' + theme.id);
  // Text-colour dot, also shown on top of an image/video thumbnail.
  const dot = `<span style="background:${text}"></span>`;
  if (bgSetting && bgSetting.src) {
    if (bgSetting.type === 'video') {
      return `<span class="color-theme-swatch-preview media"><video src="${bgSetting.src}" muted playsinline preload="metadata"></video>${dot}</span>`;
    }
    return `<span class="color-theme-swatch-preview media" style="background-image:url('${bgSetting.src}')">${dot}</span>`;
  }
  return `<span class="color-theme-swatch-preview" style="background:${bg}">${dot}</span>`;
}

function selectColorTheme(id) {
  applyColorTheme(id);
  renderColorThemeSwatches();
  applyThemeFonts();
  populateFontSelects();
  applyThemeBackground();
  renderAllIcons();
  syncIconsUI();
  const editor = $('customThemeEditor');
  const isCustom = isCustomThemeId(id);
  if (editor) editor.classList.toggle('hidden', !isCustom);
  // Built-in themes get a reset button (clears font/background overrides).
  const resetBtn = $('resetThemeBtn');
  if (resetBtn) resetBtn.classList.toggle('hidden', isCustom);
  const nameInput = $('customThemeName');
  if (nameInput) {
    if (isCustom) {
      const theme = getCustomThemeById(id);
      nameInput.value = (theme && theme.name) || '';
      nameInput.disabled = false;
    } else {
      nameInput.value = '';
      nameInput.disabled = true;
    }
  }
  if (isCustom) populateCustomThemeFields();
}

// Restores a built-in theme to its defaults: clears the font and background
// overrides stored for it. Custom themes also carry colours, reset in their
// own editor.
function resetCurrentTheme() {
  const themeId = colorThemeState.id;
  const fontMap = loadBuiltinThemeFonts();
  if (fontMap[themeId]) {
    delete fontMap[themeId];
    localStorage.setItem('scriptoriumThemeFonts', JSON.stringify(fontMap));
  }
  const bgMap = loadThemeBackgrounds();
  if (bgMap[themeId]) {
    delete bgMap[themeId];
    saveThemeBackgrounds(bgMap);
  }
  applyThemeFonts();
  populateFontSelects();
  applyThemeBackground();
  showToast('toast.theme_reset');
}
$('resetThemeBtn')?.addEventListener('click', resetCurrentTheme);

// Duplicates the current theme (colours + fonts) under a new name.
async function cloneCurrentTheme() {
  const name = await themedPrompt(__('prompt.clone_theme_name'));
  if (!name || !name.trim()) return;
  let vars, fonts;
  if (isCustomThemeId(colorThemeState.id)) {
    const t = getCustomThemeById(colorThemeState.id);
    vars = (t && t.vars) || colorThemeState.customVars || getComputedThemeVars('default');
    fonts = (t && t.fonts) || null;
  } else {
    vars = getComputedThemeVars(colorThemeState.id);
    fonts = getThemeFonts(colorThemeState.id);
  }
  try {
    const res = await fetch('/api/color-themes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: null, name: name.trim(), vars, fonts })
    });
    const data = await res.json();
    if (data.success) {
      await loadColorThemes();
      colorThemeState.id = 'custom:' + data.id;
      colorThemeState.customVars = vars;
      localStorage.setItem('scriptoriumColorTheme', colorThemeState.id);
      applyColorTheme(colorThemeState.id, { skipPersist: true });
      renderColorThemeSwatches();
      selectColorTheme(colorThemeState.id);
      showToast('toast.theme_cloned');
    }
  } catch (err) {
    console.error('clone theme error', err);
  }
}
$('cloneThemeBtn')?.addEventListener('click', cloneCurrentTheme);

function buildColorFieldGrid(containerId, fields) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';
  fields.forEach(f => {
    const row = document.createElement('div');
    row.className = 'color-field';
    const inputId = 'colorField' + f.key;
    row.innerHTML = `<label for="${inputId}">${f.label()}</label>`;
    const input = document.createElement('input');
    input.type = 'color';
    input.id = inputId;
    input.dataset.varKey = f.key;
    input.addEventListener('input', onCustomColorInput);
    row.appendChild(input);
    // Alpha slider so a colour can be transparent (e.g. a border).
    const alpha = document.createElement('input');
    alpha.type = 'range';
    alpha.min = 0;
    alpha.max = 100;
    alpha.step = 1;
    alpha.value = 100;
    alpha.className = 'color-alpha';
    alpha.id = 'colorAlpha' + f.key;
    alpha.dataset.alphaKey = f.key;
    alpha.title = __('settings.color_alpha_title');
    alpha.addEventListener('input', onCustomColorInput);
    row.appendChild(alpha);
    const value = document.createElement('span');
    value.className = 'color-alpha-value';
    value.id = 'colorAlphaValue' + f.key;
    value.textContent = '100';
    row.appendChild(value);
    container.appendChild(row);
  });
}

function populateCustomThemeFields() {
  const vars = colorThemeState.customVars || getComputedThemeVars('default');
  colorThemeState.customVars = vars;

  buildColorFieldGrid('customThemeBaseFields', COLOR_THEME_FIELD_GROUPS.base);
  COLOR_THEME_FIELD_GROUPS.base.forEach(f => syncColorFieldUI(f.key, vars[f.key]));

  const syntaxTitle = $('customThemeSyntaxTitle');
  const syntaxFields = $('customThemeSyntaxFields');
  const showSyntax = colorThemeState.mdColor;
  if (syntaxTitle) syntaxTitle.classList.toggle('hidden', !showSyntax);
  if (syntaxFields) syntaxFields.classList.toggle('hidden', !showSyntax);
  if (showSyntax) {
    buildColorFieldGrid('customThemeSyntaxFields', COLOR_THEME_FIELD_GROUPS.syntax);
    COLOR_THEME_FIELD_GROUPS.syntax.forEach(f => syncColorFieldUI(f.key, vars[f.key]));
  }
}

// Fills a color field's swatch and alpha slider from the stored CSS value.
function syncColorFieldUI(key, value) {
  const input = $('colorField' + key);
  const alpha = $('colorAlpha' + key);
  const label = $('colorAlphaValue' + key);
  const c = parseHexColor(value);
  if (input) input.value = c ? toHexColor(value) : '#000000';
  const a = c ? Math.round(c.a * 100) : 100;
  if (alpha) alpha.value = a;
  if (label) label.textContent = a;
}

function onCustomColorInput(e) {
  const key = e.target.dataset.varKey || e.target.dataset.alphaKey;
  const input = $('colorField' + key);
  const alpha = $('colorAlpha' + key);
  const label = $('colorAlphaValue' + key);
  const rgb = parseHexColor(input && input.value) || { r: 0, g: 0, b: 0, a: 1 };
  const a = alpha ? Math.max(0, Math.min(100, parseInt(alpha.value, 10) || 0)) / 100 : 1;
  const value = colorToCss({ r: rgb.r, g: rgb.g, b: rgb.b, a });
  if (label) label.textContent = Math.round(a * 100);
  colorThemeState.customVars = colorThemeState.customVars || {};
  colorThemeState.customVars[key] = value;
  document.documentElement.style.setProperty(key, value);
  if (key === '--accent') {
    const soft = deriveAccentSoft(value);
    if (soft) {
      colorThemeState.customVars['--accent-soft'] = soft;
      document.documentElement.style.setProperty('--accent-soft', soft);
    }
  }
  const status = $('customThemeSaveStatus');
  if (status) status.textContent = __('save.unsaved');
}

$('resetCustomThemeBtn')?.addEventListener('click', () => {
  colorThemeState.customVars = getComputedThemeVars('default');
  applyCustomThemeVars(colorThemeState.customVars);
  populateCustomThemeFields();
  const status = $('customThemeSaveStatus');
  if (status) status.textContent = __('save.unsaved');
});

// Persists the currently edited custom theme (name + colours) to .themes/.
$('saveCustomThemeBtn')?.addEventListener('click', async () => {
  if (!isCustomThemeId(colorThemeState.id)) return;
  const status = $('customThemeSaveStatus');
  const nameInput = $('customThemeName');
  const id = customThemeKey(colorThemeState.id);
  const current = getCustomThemeById(colorThemeState.id);
  const name = (nameInput && nameInput.value.trim()) || (current && current.name) || id;
  try {
    const payload = { id, name, vars: colorThemeState.customVars || {}, fonts: (current && current.fonts) || null };
    const res = await fetch('/api/color-themes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      await loadColorThemes();
      colorThemeState.id = 'custom:' + data.id;
      localStorage.setItem('scriptoriumColorTheme', colorThemeState.id);
      renderColorThemeSwatches();
      if (nameInput) nameInput.value = data.name;
      showToast('toast.custom_theme_saved');
      if (status) {
        status.textContent = __('save.saved_ok');
        setTimeout(function () { if (status.textContent === __('save.saved_ok')) status.textContent = ''; }, 2500);
      }
    } else if (status) {
      status.textContent = __('save.error');
    }
  } catch (err) {
    if (status) status.textContent = __('save.error');
  }
});

// Renames the current theme on the server and refreshes the swatch list.
async function renameCurrentTheme(name) {
  const id = customThemeKey(colorThemeState.id);
  const current = getCustomThemeById(colorThemeState.id);
  try {
    const res = await fetch('/api/color-themes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name,
        vars: current ? current.vars : (colorThemeState.customVars || {}),
        fonts: (current && current.fonts) || null
      })
    });
    const data = await res.json();
    if (data.success) {
      await loadColorThemes();
      colorThemeState.id = 'custom:' + data.id;
      localStorage.setItem('scriptoriumColorTheme', colorThemeState.id);
      renderColorThemeSwatches();
      const nameInput = $('customThemeName');
      if (nameInput) nameInput.value = data.name;
      showToast('toast.custom_theme_saved');
    }
  } catch (err) {
    console.error('rename theme error', err);
  }
}

// Rename as soon as the field is committed (blur or Enter), so it is always
// taken into account without depending on the Save button.
$('customThemeName')?.addEventListener('change', () => {
  if (!isCustomThemeId(colorThemeState.id)) return;
  const nameInput = $('customThemeName');
  const newName = nameInput ? nameInput.value.trim() : '';
  if (!newName) return;
  const current = getCustomThemeById(colorThemeState.id);
  if (current && current.name === newName) return;
  renameCurrentTheme(newName);
});
$('customThemeName')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
});

// Starts a brand-new named theme from the current colours.
async function createNewColorTheme() {
  const name = await themedPrompt(__('prompt.color_theme_name'));
  if (!name || !name.trim()) return;
  const base = isCustomThemeId(colorThemeState.id) ? 'default' : colorThemeState.id;
  const vars = colorThemeState.customVars || getComputedThemeVars(base);
  try {
    const res = await fetch('/api/color-themes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: null, name: name.trim(), vars })
    });
    const data = await res.json();
    if (data.success) {
      await loadColorThemes();
      colorThemeState.id = 'custom:' + data.id;
      colorThemeState.customVars = vars;
      localStorage.setItem('scriptoriumColorTheme', colorThemeState.id);
      applyColorTheme(colorThemeState.id, { skipPersist: true });
      renderColorThemeSwatches();
      $('customThemeEditor')?.classList.remove('hidden');
      const nameInput = $('customThemeName');
      if (nameInput) { nameInput.value = data.name; nameInput.disabled = false; }
      populateCustomThemeFields();
      showToast('toast.custom_theme_saved');
    }
  } catch (err) {
    console.error('create theme error', err);
  }
}

$('deleteCustomThemeBtn')?.addEventListener('click', async () => {
  if (!isCustomThemeId(colorThemeState.id)) return;
  const id = customThemeKey(colorThemeState.id);
  const theme = getCustomThemeById(colorThemeState.id);
  const ok = await themedConfirm(__('confirm.theme_delete_custom', { name: theme ? theme.name : id }));
  if (!ok) return;
  try {
    const res = await fetch('/api/color-themes/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      await loadColorThemes();
      colorThemeState.id = 'default';
      localStorage.setItem('scriptoriumColorTheme', 'default');
      applyColorTheme('default', { skipPersist: true });
      renderColorThemeSwatches();
      $('customThemeEditor')?.classList.add('hidden');
      showToast('toast.theme_deleted');
    }
  } catch (err) {
    console.error('delete theme error', err);
  }
});

$('mdColorToggle')?.addEventListener('change', (e) => {
  applyMdColor(e.target.checked);
  if (isCustomThemeId(colorThemeState.id)) populateCustomThemeFields();
});

// Obsidian frontmatter visibility (Settings > Apparence)
let hideFrontmatterState = localStorage.getItem('scriptoriumHideFrontmatter') === '1';

function applyHideFrontmatter(enable) {
  hideFrontmatterState = enable;
  document.documentElement.classList.toggle('hide-frontmatter', enable);
  localStorage.setItem('scriptoriumHideFrontmatter', enable ? '1' : '0');
  const toggle = $('frontmatterToggle');
  if (toggle) toggle.checked = enable;
  markFrontmatterLines();
}

$('frontmatterToggle')?.addEventListener('change', (e) => applyHideFrontmatter(e.target.checked));
applyHideFrontmatter(hideFrontmatterState);

function updateSettingsOverlayState() {
  if (!settingsModal) return;
  const activeTab = document.querySelector('.settings-tab.active');
  const isAppearance = activeTab && activeTab.dataset.panel === 'appearance';
  settingsModal.classList.toggle('transparent-overlay', isAppearance);
}

document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active');
    const panel = document.querySelector(`.settings-panel[data-panel="${tab.dataset.panel}"]`);
    if (panel) panel.classList.remove('hidden');
    updateSettingsOverlayState();
  });
});

async function initColorTheme() {
  const mdToggle = $('mdColorToggle');
  if (mdToggle) mdToggle.checked = colorThemeState.mdColor;
  document.documentElement.classList.toggle('md-color-on', colorThemeState.mdColor);

  await loadColorThemes();

  // Legacy single-custom-theme selection points at the migrated theme.
  if (colorThemeState.id === 'custom') {
    colorThemeState.id = getCustomThemeById('custom:custom') ? 'custom:custom' : 'default';
    localStorage.setItem('scriptoriumColorTheme', colorThemeState.id);
  }
  // A saved custom theme that no longer exists on disk falls back to default.
  if (isCustomThemeId(colorThemeState.id) && !getCustomThemeById(colorThemeState.id)) {
    colorThemeState.id = 'default';
    localStorage.setItem('scriptoriumColorTheme', 'default');
  }

  renderColorThemeSwatches();
  await loadCustomFonts();
  applyThemeFonts();
  populateFontSelects();
  const resetBtnInit = $('resetThemeBtn');
  if (resetBtnInit) resetBtnInit.classList.toggle('hidden', isCustomThemeId(colorThemeState.id));
  if (isCustomThemeId(colorThemeState.id)) {
    const theme = getCustomThemeById(colorThemeState.id);
    colorThemeState.customVars = (theme && theme.vars) || colorThemeState.customVars || getComputedThemeVars('default');
    applyColorTheme(colorThemeState.id, { skipPersist: true });
    $('customThemeEditor')?.classList.remove('hidden');
    const nameInput = $('customThemeName');
    if (nameInput) { nameInput.value = (theme && theme.name) || ''; nameInput.disabled = false; }
    populateCustomThemeFields();
  }
}

// ============ FONTS (Settings > Apparence) ============
// Per-theme font choice: one family for the UI (--sans) and one for the editor
// (--serif), each a cross-platform stack. Custom fonts imported into
// <workspace>/.fonts/ are offered on top of these built-ins.

const FONT_UI_OPTIONS = [
  { id: 'system', name: 'System default', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  { id: 'inter', name: 'Inter', stack: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { id: 'segoe', name: 'Segoe UI', stack: "'Segoe UI', 'Segoe UI Variable', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  { id: 'sfpro', name: 'SF Pro', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif" },
  { id: 'roboto', name: 'Roboto', stack: "'Roboto', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" },
  { id: 'opensans', name: 'Open Sans', stack: "'Open Sans', 'Segoe UI', Roboto, Arial, sans-serif" },
  { id: 'notosans', name: 'Noto Sans', stack: "'Noto Sans', 'Segoe UI', Roboto, Arial, sans-serif" },
];

const FONT_EDITOR_OPTIONS = [
  { id: 'newsreader', name: 'Newsreader', stack: "'Newsreader', Georgia, serif" },
  { id: 'serif-system', name: 'System serif', stack: "Georgia, 'Times New Roman', 'Droid Serif', serif" },
  { id: 'georgia', name: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
  { id: 'merriweather', name: 'Merriweather', stack: "'Merriweather', Georgia, 'Times New Roman', serif" },
  { id: 'lora', name: 'Lora', stack: "'Lora', Georgia, serif" },
  { id: 'sourceserif', name: 'Source Serif', stack: "'Source Serif 4', 'Source Serif Pro', Georgia, serif" },
  { id: 'sans-system', name: 'System sans', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif" },
  { id: 'mono-system', name: 'System mono', stack: "'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', monospace" },
];

// { id, name, url, ext } loaded from <workspace>/.fonts/ via /api/fonts.
let customFontState = [];

function customFontFamily(f) {
  return 'ScriptoriumFont ' + String(f.name).replace(/['"\\]/g, '');
}

function getAllUiFonts() {
  return FONT_UI_OPTIONS.concat(customFontState.map(f => ({
    id: 'custom:' + f.id,
    name: f.name,
    stack: `'${customFontFamily(f)}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
  })));
}
function getAllEditorFonts() {
  return FONT_EDITOR_OPTIONS.concat(customFontState.map(f => ({
    id: 'custom:' + f.id,
    name: f.name,
    stack: `'${customFontFamily(f)}', Georgia, serif`
  })));
}
function getFontStack(type, id) {
  const list = type === 'ui' ? getAllUiFonts() : getAllEditorFonts();
  const f = list.find(x => x.id === id);
  return f ? f.stack : null;
}

function registerCustomFontFace(f) {
  const existing = document.getElementById('fontface-' + f.id);
  if (existing) return;
  const style = document.createElement('style');
  style.id = 'fontface-' + f.id;
  const ext = (f.ext || '').toLowerCase();
  const format = ext === '.woff2' ? " format('woff2')"
    : ext === '.woff' ? " format('woff')"
    : ext === '.otf' ? " format('opentype')"
    : ext === '.ttf' ? " format('truetype')"
    : '';
  style.textContent = `@font-face { font-family: '${customFontFamily(f)}'; src: url('${f.url}')${format}; font-display: swap; }`;
  document.head.appendChild(style);
}

async function loadCustomFonts() {
  try {
    const res = await fetch('/api/fonts');
    const data = await res.json();
    customFontState = (data && Array.isArray(data.fonts)) ? data.fonts : [];
  } catch (e) {
    customFontState = [];
  }
  customFontState.forEach(registerCustomFontFace);
}

// Per-theme font choice. Built-in themes: a localStorage map keyed by theme id.
// Custom themes: stored in their .themes/<id>.json file (portable).
function loadBuiltinThemeFonts() {
  try {
    return JSON.parse(localStorage.getItem('scriptoriumThemeFonts')) || {};
  } catch (e) { return {}; }
}

function getThemeFonts(themeId) {
  if (isCustomThemeId(themeId)) {
    const t = getCustomThemeById(themeId);
    return (t && t.fonts) || null;
  }
  return loadBuiltinThemeFonts()[themeId] || null;
}

// Applies the current theme's font choice to --sans (UI) and --serif (editor).
function applyThemeFonts() {
  const fonts = getThemeFonts(colorThemeState.id);
  const root = document.documentElement;
  let uiStack = null, edStack = null;
  if (fonts) {
    uiStack = getFontStack('ui', fonts.ui);
    edStack = getFontStack('editor', fonts.editor);
    if (uiStack) root.style.setProperty('--sans', uiStack);
    if (edStack) root.style.setProperty('--serif', edStack);
  } else {
    root.style.removeProperty('--sans');
    root.style.removeProperty('--serif');
  }
  // Cache the resolved stacks so the pre-paint script restores them instantly.
  try { localStorage.setItem('scriptoriumActiveFonts', JSON.stringify({ ui: uiStack, editor: edStack })); } catch (e) {}
}

async function setThemeFonts(fonts) {
  const themeId = colorThemeState.id;
  if (isCustomThemeId(themeId)) {
    const id = customThemeKey(themeId);
    const t = getCustomThemeById(themeId);
    try {
      await fetch('/api/color-themes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: (t && t.name) || id, vars: colorThemeState.customVars || {}, fonts })
      });
      await loadColorThemes();
    } catch (err) { console.error('save theme fonts error', err); }
  } else {
    const map = loadBuiltinThemeFonts();
    map[themeId] = fonts;
    localStorage.setItem('scriptoriumThemeFonts', JSON.stringify(map));
  }
  applyThemeFonts();
  populateFontSelects();
}

function populateFontSelects() {
  const uiSelect = $('uiFontSelect');
  const edSelect = $('editorFontSelect');
  if (!uiSelect || !edSelect) return;
  const current = getThemeFonts(colorThemeState.id) || {};
  const uiList = getAllUiFonts();
  uiSelect.innerHTML = uiList.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join('');
  uiSelect.value = current.ui || 'inter';
  const edList = getAllEditorFonts();
  edSelect.innerHTML = edList.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join('');
  edSelect.value = current.editor || 'newsreader';
}

$('uiFontSelect')?.addEventListener('change', (e) => {
  const current = getThemeFonts(colorThemeState.id) || {};
  setThemeFonts({ ui: e.target.value, editor: current.editor || 'newsreader' });
});
$('editorFontSelect')?.addEventListener('change', (e) => {
  const current = getThemeFonts(colorThemeState.id) || {};
  setThemeFonts({ ui: current.ui || 'inter', editor: e.target.value });
});

async function importFontFiles(files) {
  for (const file of Array.from(files || [])) {
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.indexOf(',') !== -1 ? result.slice(result.indexOf(',') + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    try {
      await fetch('/api/fonts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, dataBase64 })
      });
    } catch (err) { console.error('import font error', err); }
  }
  await loadCustomFonts();
  populateFontSelects();
  applyThemeFonts();
  showToast('toast.font_imported');
}

$('fontImportBtn')?.addEventListener('click', () => $('fontImportInput')?.click());
$('fontImportInput')?.addEventListener('change', (e) => {
  importFontFiles(e.target.files);
  e.target.value = '';
});

// ============ APP BACKGROUND (image / video) ============
// A full-window layer behind the whole app: image (cover or seamless mosaic)
// or video (loop: repeat or ping-pong reverse), with an opacity slider.

// The background is per-theme (like fonts): a map keyed by theme id in
// localStorage. appBackgroundState is the current theme's background.
function loadThemeBackgrounds() {
  try {
    const map = JSON.parse(localStorage.getItem('scriptoriumThemeBackground')) || {};
    return typeof map === 'object' && map ? map : {};
  } catch (e) { return {}; }
}
function saveThemeBackgrounds(map) {
  try { localStorage.setItem('scriptoriumThemeBackground', JSON.stringify(map)); } catch (e) {}
}
function getThemeBackground(themeId) {
  const entry = loadThemeBackgrounds()[themeId];
  return (entry && entry.src) ? entry : null;
}

let appBackgroundState = null; // the current theme's background
let appMediaFiles = []; // { id, name, url, type } from <workspace>/.media/

async function loadAppMedia() {
  try {
    const res = await fetch('/api/media');
    const data = await res.json();
    appMediaFiles = (data && Array.isArray(data.media)) ? data.media : [];
  } catch (e) { appMediaFiles = []; }
}

function applyAppBackground(bg) {
  const layer = $('appBg');
  if (!layer) return;
  layer.innerHTML = '';
  layer.classList.remove('mosaic');
  layer.style.backgroundImage = 'none';
  document.documentElement.classList.toggle('has-app-bg', !!(bg && bg.src));
  if (!bg || !bg.src) {
    layer.style.opacity = '0';
    document.documentElement.style.removeProperty('--bg-media-opacity');
    return;
  }
  const opacity = typeof bg.opacity === 'number' ? Math.max(0, Math.min(1, bg.opacity)) : 0.25;
  document.documentElement.style.setProperty('--bg-media-opacity', String(opacity));

  const mosaic = bg.type === 'image' && !!bg.mosaic;
  layer.classList.toggle('mosaic', mosaic);

  if (bg.type === 'image') {
    layer.style.backgroundImage = `url('${bg.src}')`;
    layer.style.backgroundSize = mosaic ? 'auto' : 'cover';
    layer.style.backgroundRepeat = mosaic ? 'repeat' : 'no-repeat';
  } else if (bg.type === 'video') {
    const video = document.createElement('video');
    video.src = bg.src;
    video.muted = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    layer.appendChild(video);
    const play = () => { video.play().catch(() => {}); };
    video.addEventListener('canplay', play);
    play();
  }
  layer.style.opacity = String(opacity);
}

// Loads and applies the current theme's background.
function applyThemeBackground() {
  appBackgroundState = getThemeBackground(colorThemeState.id);
  applyAppBackground(appBackgroundState);
  syncAppBackgroundUI();
}

// Persists the background for the current theme only.
function setThemeBackground(bg) {
  const map = loadThemeBackgrounds();
  if (bg && bg.src) {
    map[colorThemeState.id] = { src: bg.src, type: bg.type, opacity: bg.opacity, mosaic: bg.mosaic };
  } else {
    delete map[colorThemeState.id];
  }
  saveThemeBackgrounds(map);
  applyThemeBackground();
}

async function importAppMediaFiles(files) {
  for (const file of Array.from(files || [])) {
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.indexOf(',') !== -1 ? result.slice(result.indexOf(',') + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    try {
      await fetch('/api/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, dataBase64 })
      });
    } catch (err) { console.error('import media error', err); }
  }
  await loadAppMedia();
  syncAppBackgroundUI();
  showToast('toast.media_imported');
}

function syncAppBackgroundUI() {
  const list = $('appBgList');
  if (!list) return;
  const bg = appBackgroundState;
  list.innerHTML = '';

  // "None" item: no background.
  const noneItem = document.createElement('div');
  noneItem.className = 'app-bg-item' + (!bg ? ' active' : '');
  noneItem.innerHTML = `<span class="app-bg-thumb none"></span><span class="app-bg-name">${escapeHtml(__('settings.bg_none'))}</span>`;
  noneItem.addEventListener('click', () => setThemeBackground(null));
  list.appendChild(noneItem);

  // Imported media, each with a thumbnail and a delete cross.
  appMediaFiles.forEach(media => {
    const item = document.createElement('div');
    item.className = 'app-bg-item' + (bg && bg.src === media.url ? ' active' : '');
    const thumb = media.type === 'video'
      ? `<video src="${media.url}" muted playsinline preload="metadata"></video>`
      : `<img src="${media.url}" alt="" />`;
    item.innerHTML = `<span class="app-bg-thumb">${thumb}</span><span class="app-bg-name">${escapeHtml(media.name)}</span>`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'app-bg-delete';
    del.title = __('settings.bg_delete_title');
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAppMedia(media);
    });
    item.appendChild(del);
    item.addEventListener('click', () => {
      setThemeBackground({
        src: media.url,
        type: media.type,
        opacity: bg ? bg.opacity : 0.25,
        mosaic: (bg && bg.mosaic) || false
      });
    });
    list.appendChild(item);
  });

  const isImage = !!(bg && bg.type === 'image');
  $('appBgMosaicRow')?.classList.toggle('hidden', !isImage);

  const mosaic = $('appBgMosaic');
  if (mosaic) mosaic.checked = !!(bg && bg.mosaic);

  const op = bg ? bg.opacity : 0.25;
  const slider = $('appBgOpacitySlider');
  const valueEl = $('appBgOpacityValue');
  if (slider) slider.value = Math.round(op * 100);
  if (valueEl) valueEl.textContent = Math.round(op * 100) + '%';
}

async function deleteAppMedia(media) {
  const ok = await themedConfirm(__('confirm.bg_delete', { name: media.name }));
  if (!ok) return;
  try {
    const res = await fetch('/api/media/' + encodeURIComponent(media.id), { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      // Drop the deleted media from every theme that used it.
      const map = loadThemeBackgrounds();
      let changed = false;
      for (const key of Object.keys(map)) {
        if (map[key] && map[key].src === media.url) { delete map[key]; changed = true; }
      }
      if (changed) {
        saveThemeBackgrounds(map);
        applyThemeBackground();
      }
      await loadAppMedia();
      syncAppBackgroundUI();
      showToast('toast.media_deleted');
    }
  } catch (err) {
    console.error('delete media error', err);
  }
}

async function initAppBackgroundControl() {
  applyThemeBackground();
  await loadAppMedia();
  syncAppBackgroundUI();

  $('appBgOpacitySlider')?.addEventListener('input', (e) => {
    const op = parseInt(e.target.value, 10) / 100;
    const valueEl = $('appBgOpacityValue');
    if (valueEl) valueEl.textContent = Math.round(op * 100) + '%';
    if (appBackgroundState) {
      setThemeBackground({
        src: appBackgroundState.src,
        type: appBackgroundState.type,
        opacity: op,
        mosaic: appBackgroundState.mosaic || false
      });
    }
  });

  $('appBgMosaic')?.addEventListener('change', (e) => {
    if (!appBackgroundState) return;
    setThemeBackground({
      src: appBackgroundState.src,
      type: appBackgroundState.type,
      opacity: appBackgroundState.opacity,
      mosaic: e.target.checked
    });
  });

  $('appBgClearBtn')?.addEventListener('click', () => setThemeBackground(null));
}

$('appBgImportBtn')?.addEventListener('click', () => $('appBgImportInput')?.click());
$('appBgImportInput')?.addEventListener('change', (e) => {
  importAppMediaFiles(e.target.files);
  e.target.value = '';
});

// ============ FONT SIZES (Settings > Apparence) ============
// Independent sliders per heading level + body text, each an absolute px
// CSS var — so levels can be sized independently rather than scaling
// together the way the old em-based sizing did.

const FONT_SIZE_KEYS = ['--fs-doc-title', '--fs-doc-subtitle', '--fs-base', '--fs-h1', '--fs-h2', '--fs-h3', '--fs-h4', '--fs-h5', '--fs-h6'];
const FONT_SIZE_DEFAULTS = {
  '--fs-doc-title': 34, '--fs-doc-subtitle': 17, '--fs-base': 17.5, '--fs-h1': 35, '--fs-h2': 27, '--fs-h3': 22, '--fs-h4': 19, '--fs-h5': 16.6, '--fs-h6': 14.9,
};

function loadFontSizes() {
  try {
    const raw = localStorage.getItem('scriptoriumFontSizes');
    if (raw) return { ...FONT_SIZE_DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {}
  return { ...FONT_SIZE_DEFAULTS };
}

let fontSizeState = loadFontSizes();

function saveFontSizes() {
  localStorage.setItem('scriptoriumFontSizes', JSON.stringify(fontSizeState));
}

function applyFontSizes(sizes) {
  FONT_SIZE_KEYS.forEach((key) => {
    const v = sizes[key];
    if (typeof v === 'number') document.documentElement.style.setProperty(key, v + 'px');
  });
}

function formatFontSizePx(v) {
  return (Number.isInteger(v) ? v : Math.round(v * 10) / 10) + 'px';
}

function syncFontSizeSliderUI() {
  document.querySelectorAll('[data-fs-key]').forEach((input) => {
    const key = input.dataset.fsKey;
    const v = fontSizeState[key];
    input.value = v;
    const valueEl = $(input.id.replace('fsSlider', 'fsValue'));
    if (valueEl) valueEl.textContent = formatFontSizePx(v);
  });
}

function initFontSizeControls() {
  applyFontSizes(fontSizeState);
  syncFontSizeSliderUI();

  document.querySelectorAll('[data-fs-key]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.fsKey;
      const v = parseFloat(input.value);
      fontSizeState[key] = v;
      document.documentElement.style.setProperty(key, v + 'px');
      const valueEl = $(input.id.replace('fsSlider', 'fsValue'));
      if (valueEl) valueEl.textContent = formatFontSizePx(v);
      saveFontSizes();
    });
  });

  $('resetFontSizesBtn')?.addEventListener('click', () => {
    fontSizeState = { ...FONT_SIZE_DEFAULTS };
    applyFontSizes(fontSizeState);
    syncFontSizeSliderUI();
    saveFontSizes();
  });
}

// Space between blocks, in em so it scales with the base font size. The gap
// between two blocks is also the click target that inserts a new block there.
const BLOCK_GAP_DEFAULT = 0.62;
function loadBlockGap() {
  const raw = parseFloat(localStorage.getItem('scriptoriumBlockGap'));
  return isFinite(raw) && raw >= 0 ? raw : BLOCK_GAP_DEFAULT;
}
let blockGapState = loadBlockGap();
function formatBlockGap(v) {
  return (Number.isInteger(v) ? v : Math.round(v * 100) / 100) + 'em';
}
function applyBlockGap(v) {
  blockGapState = v;
  document.documentElement.style.setProperty('--block-gap', v + 'em');
  localStorage.setItem('scriptoriumBlockGap', String(v));
}
function syncBlockGapSliderUI() {
  const input = $('blockGapSlider');
  const valueEl = $('blockGapValue');
  if (input) input.value = blockGapState;
  if (valueEl) valueEl.textContent = formatBlockGap(blockGapState);
}
function initBlockGapControl() {
  applyBlockGap(blockGapState);
  syncBlockGapSliderUI();
  $('blockGapSlider')?.addEventListener('input', () => {
    applyBlockGap(parseFloat($('blockGapSlider').value));
    const valueEl = $('blockGapValue');
    if (valueEl) valueEl.textContent = formatBlockGap(blockGapState);
  });
}

// Line height of the blocks: the half-leading above and below each text line is
// what reads as space inside the block, even with the gap between blocks at 0.
const LINE_HEIGHT_DEFAULT = 1.8;
function loadLineHeight() {
  const raw = parseFloat(localStorage.getItem('scriptoriumLineHeight'));
  return isFinite(raw) && raw >= 1 ? raw : LINE_HEIGHT_DEFAULT;
}
let lineHeightState = loadLineHeight();
function formatLineHeight(v) {
  return (Number.isInteger(v) ? v : Math.round(v * 100) / 100) + '';
}
function applyLineHeight(v) {
  lineHeightState = v;
  document.documentElement.style.setProperty('--line-height', String(v));
  localStorage.setItem('scriptoriumLineHeight', String(v));
}
function syncLineHeightSliderUI() {
  const input = $('lineHeightSlider');
  const valueEl = $('lineHeightValue');
  if (input) input.value = lineHeightState;
  if (valueEl) valueEl.textContent = formatLineHeight(lineHeightState);
}
function initLineHeightControl() {
  applyLineHeight(lineHeightState);
  syncLineHeightSliderUI();
  $('lineHeightSlider')?.addEventListener('input', () => {
    applyLineHeight(parseFloat($('lineHeightSlider').value));
    const valueEl = $('lineHeightValue');
    if (valueEl) valueEl.textContent = formatLineHeight(lineHeightState);
  });
}

// Settings Modal Events
async function saveAndCloseSettings() {
  const newPath = workspacePathInput ? workspacePathInput.value.trim() : '';
  const ideasPath = ideasPathInput ? ideasPathInput.value.trim() : '';
  
  settingsModal.classList.remove('active');
  
  if (newPath && (newPath !== state.workspaceDir || (ideasPathInput && ideasPath !== state.ideasDir))) {
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPath, ideasPath })
      });
      const data = await res.json();
      if (data.success) {
        state.activeDocId = null;
        state.activeThemeId = null;
        await fetchWorkspace();
        showToast('toast.settings_saved');
      }
    } catch (err) {
      console.error(__('alert.config_save_error') + ':', err);
    }
  }
}

$('openSettingsBtn').addEventListener('click', () => {
  workspacePathInput.value = state.workspaceDir || '';
  ideasPathInput.value = state.ideasDir || '';
  const appDirInput = $('appDirInput');
  if (appDirInput) appDirInput.value = state.appDir || '';
  settingsModal.classList.add('active');
  updateSettingsOverlayState();
});

// Opens the app folder (server.js, config.json) in the OS file manager.
$('openAppDirBtn')?.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'app' })
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch (err) {
    console.error(err);
    showToast('toast.open_failed');
  }
});

// Resets every preference (the app's localStorage) and reloads. This is the
// cross-platform equivalent of clearing the WebView browser data: it does not
// touch documents, themes or the workspace itself.
$('resetAppBtn')?.addEventListener('click', async () => {
  const ok = await themedConfirm(__('confirm.reset_app'));
  if (!ok) return;
  try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
  location.reload();
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    saveAndCloseSettings();
  }
});

$('closeSettingsBtn').addEventListener('click', () => saveAndCloseSettings());
$('cancelSettingsBtn').addEventListener('click', () => settingsModal.classList.remove('active'));

$('saveSettingsBtn').addEventListener('click', () => saveAndCloseSettings());

// ============ LANGUAGE SETTINGS (i18n) ============
function initLanguageSettings() {
  var select = $('languageSelect');
  if (!select) return;
  select.value = getLocale();
  select.addEventListener('change', function () {
    var locale = this.value;
    setLocale(locale, function () {
      renderAll();
      updateLockStateUI();
      updateDocSortButton();
      if (typeof updateBreadcrumbAndMeta === 'function') updateBreadcrumbAndMeta();
      if (typeof updateStats === 'function') updateStats();
      showToast('toast.lang_changed', { lang: locale });
    });
  });
}

// ============ READING FADE SLIDER (Settings > Appearance) ============
var READING_FADE_DEFAULT = 18; // %

function initReadingFadeSlider() {
  var slider = $('readingFadeSlider');
  var valueEl = $('readingFadeValue');
  if (!slider || !valueEl) return;

  // Load saved value
  var saved = localStorage.getItem('scriptoriumReadingFade');
  var fadePct = saved !== null ? parseInt(saved, 10) : READING_FADE_DEFAULT;

  // Apply
  applyReadingFade(fadePct);

  // Sync UI
  slider.value = fadePct;
  valueEl.textContent = fadePct + '%';

  // Live input: apply the fade to the shared preview while dragging.
  slider.addEventListener('input', function () {
    var v = parseInt(this.value, 10);
    applyReadingFade(v);
    valueEl.textContent = v + '%';
    localStorage.setItem('scriptoriumReadingFade', String(v));
    var prev = $('fontSizePreview');
    if (prev) prev.classList.add('fade-previewing');
  });
  // Released: the fade preview disappears.
  slider.addEventListener('change', function () {
    var prev = $('fontSizePreview');
    if (prev) prev.classList.remove('fade-previewing');
  });
}

function applyReadingFade(pct) {
  var val = pct + '%';
  if (editorWrap) editorWrap.style.setProperty('--fade-pct', val);
  // Shared on the root so the settings preview uses the same value.
  document.documentElement.style.setProperty('--fade-pct', val);
}

async function handlePickFolder(inputEl, btnEl) {
  if (btnEl) btnEl.classList.add('loading');
  try {
    const currentPath = inputEl ? inputEl.value.trim() : '';
    // The Node server opens a native dialog on this machine (osascript on
    // macOS, zenity/kdialog on Linux, PowerShell on Windows).
    const res = await fetch('/api/pick-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPath })
    });
    const data = await res.json();
    if (data.success && data.path) {
      inputEl.value = data.path;
    }
  } catch (err) {
    console.error('Pick folder error:', err);
  } finally {
    if (btnEl) btnEl.classList.remove('loading');
  }
}

const pickWorkspaceFolderBtn = $('pickWorkspaceFolderBtn');
if (pickWorkspaceFolderBtn) {
  pickWorkspaceFolderBtn.addEventListener('click', () => {
    handlePickFolder(workspacePathInput, pickWorkspaceFolderBtn);
  });
}

const pickIdeasFolderBtn = $('pickIdeasFolderBtn');
if (pickIdeasFolderBtn) {
  pickIdeasFolderBtn.addEventListener('click', () => {
    handlePickFolder(ideasPathInput, pickIdeasFolderBtn);
  });
}

$('openFolderBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/open-folder', { method: 'POST' });
  } catch (err) {
    console.error(err);
  }
});

// Clicking the workspace label at the bottom of the sidebar opens that folder
// in the OS file manager.
workspaceLabel.addEventListener('click', async () => {
  try {
    await fetch('/api/open-folder', { method: 'POST' });
  } catch (err) {
    console.error(err);
    showToast('toast.open_failed');
  }
});

if (sortDocsBtn) {
  updateDocSortButton();
  sortDocsBtn.addEventListener('click', () => {
    state.docSortMode = state.docSortMode === 'alpha' ? 'modified' : 'alpha';
    localStorage.setItem('scriptorium_doc_sort', state.docSortMode);
    updateDocSortButton();
    renderNav();
    showToast('toast.sort_changed');
  });
}

function updateLockStateUI() {
  const lockToggleBtn = $('lockToggleBtn');
  if (!lockToggleBtn) return;
  const brandLockBtn = $('brandRevealBtn');
  const iconUnlocked = lockToggleBtn.querySelector('.icon-unlocked');
  const iconLocked = lockToggleBtn.querySelector('.icon-locked');

  if (state.isLocked) {
    app.classList.add('workspace-locked');
    lockToggleBtn.classList.add('locked');
    lockToggleBtn.title = __('lock.locked_title');
    if (brandLockBtn) {
      brandLockBtn.title = __('lock.unlock_aria');
      brandLockBtn.setAttribute('aria-label', __('lock.unlock_aria'));
    }
    if (iconUnlocked) iconUnlocked.classList.add('hidden');
    if (iconLocked) iconLocked.classList.remove('hidden');
  } else {
    app.classList.remove('workspace-locked');
    lockToggleBtn.classList.remove('locked');
    lockToggleBtn.title = __('lock.unlocked_title');
    if (brandLockBtn) {
      brandLockBtn.title = __('lock.lock_aria');
      brandLockBtn.setAttribute('aria-label', __('lock.lock_aria'));
    }
    if (iconUnlocked) iconUnlocked.classList.remove('hidden');
    if (iconLocked) iconLocked.classList.add('hidden');
  }
}

function toggleWorkspaceLock() {
  state.isLocked = !state.isLocked;
  localStorage.setItem('scriptorium_is_locked', state.isLocked);
  updateLockStateUI();
  showToast(state.isLocked ? 'toast.workspace_locked' : 'toast.workspace_unlocked');
  // The server enforces the padlock on destructive routes, so it has to know.
  fetch('/api/lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locked: state.isLocked })
  }).catch(() => {});
}

const lockToggleBtn = $('lockToggleBtn');
if (lockToggleBtn) {
  lockToggleBtn.addEventListener('click', toggleWorkspaceLock);
}

// Drag and drop import global overlays
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  dragCounter++;
  dropOverlay.classList.add('active');
});
window.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter <= 0) { 
    dragCounter = 0; 
    dropOverlay.classList.remove('active'); 
  }
});
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('active');
  
  const ideasRect = $('ideasPanel').getBoundingClientRect();
  const sidebarRect = $('sidebar').getBoundingClientRect();
  const x = e.clientX, y = e.clientY;
  
  if (x >= ideasRect.left && x <= ideasRect.right && y >= ideasRect.top && y <= ideasRect.bottom && ideasRect.width > 0) {
    // Dropped on ideas panel
    Array.from(e.dataTransfer.files).forEach(file => {
      importIdeasFileToServer(file);
    });
  } else {
    // Dropped on editor or sidebar
    const targetSection = state.sections[0]?.id || 'Manifestes';
    Array.from(e.dataTransfer.files).forEach(file => {
      importFileToServer(file, targetSection);
    });
  }
});

function processDraggedText(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const ideas = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    // Strip markdown bullets or numbered lists (e.g. "- ", "* ", "+ ", "1. ", "12. ")
    line = line.replace(/^\s*([-*+]\s+|[0-9]+\.\s+)/, '').trim();
    if (line) {
      ideas.push(line);
    }
  }
  return ideas;
}

// Ideas Panel Drag and Drop (Text and Files)
ideasPanel.addEventListener('dragover', (e) => {
  // An idea being reordered or moved handles its own chip/tab highlight; the
  // whole-panel target state is only for external drops.
  if (draggedIdea) return;
  // The TOC / snapshots views have no ideas list to drop into.
  if (!isIdeasViewActive()) return;

  const hasText = e.dataTransfer.types.includes('text/plain');
  const hasFiles = e.dataTransfer.types.includes('Files');

  if (hasText || hasFiles) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    ideasPanel.classList.add('drag-over');

    // Highlight "+ ajouter une idée" button for text drag only
    if (hasText && !hasFiles) {
      const addBtn = ideasPanel.querySelector('.idea-add');
      if (addBtn) {
        addBtn.classList.add('drag-target-active');
        addBtn.textContent = __('ideas.drop_to_add');
      }
    }
  }
});

ideasPanel.addEventListener('dragleave', () => {
  ideasPanel.classList.remove('drag-over');
  const addBtn = ideasPanel.querySelector('.idea-add');
  if (addBtn) {
    addBtn.classList.remove('drag-target-active');
    addBtn.textContent = __('ideas.add_button');
  }
});

ideasPanel.addEventListener('drop', async (e) => {
  ideasPanel.classList.remove('drag-over');
  const addBtn = ideasPanel.querySelector('.idea-add');
  if (addBtn) {
    addBtn.classList.remove('drag-target-active');
    addBtn.textContent = __('ideas.add_button');
  }

  // TOC / snapshots views have no ideas list: nothing to add there.
  if (!isIdeasViewActive()) return;

  // An idea dropped on empty panel space is not an external add: the chip
  // handlers already dealt with reorders, so this only cancels the drag.
  if (draggedIdea) {
    e.preventDefault();
    draggedIdea = null;
    return;
  }

  if (e.dataTransfer.files.length > 0) {
    e.preventDefault();
    Array.from(e.dataTransfer.files).forEach(file => {
      importIdeasFileToServer(file);
    });
    return;
  }
  
  const rawText = e.dataTransfer.getData('text/plain')?.trim();
  if (rawText) {
    e.preventDefault();
    const theme = activeTheme();
    if (!theme) {
      themedAlert(__('alert.no_theme'));
      return;
    }
    
    const processedIdeas = processDraggedText(rawText);
    if (processedIdeas.length > 0) {
      addIdea(theme.id, processedIdeas);
    }
  }
});

// Import & Export buttons
$('importBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) {
    const targetSection = state.sections[0]?.id || 'Manifestes';
    Array.from(fileInput.files).forEach(file => {
      importFileToServer(file, targetSection);
    });
    fileInput.value = '';
  }
});

$('importIdeasBtn').addEventListener('click', () => ideasFileInput.click());
ideasFileInput.addEventListener('change', () => {
  if (ideasFileInput.files.length) {
    Array.from(ideasFileInput.files).forEach(file => {
      importIdeasFileToServer(file);
    });
    ideasFileInput.value = '';
  }
});

// Mode Focus & Mobile Drawer Menus
$('focusToggle').addEventListener('click', () => {
  if (typeof toggleFocusMode === 'function') toggleFocusMode();
  else app.classList.toggle('focus-mode');
});

$('mobileMenuBtn').addEventListener('click', () => {
  app.classList.toggle('show-sidebar');
  app.classList.remove('show-ideas');
});
$('mobileIdeasBtn').addEventListener('click', () => {
  app.classList.toggle('show-ideas');
  app.classList.remove('show-sidebar');
});
backdrop.addEventListener('click', () => {
  app.classList.remove('show-sidebar');
  app.classList.remove('show-ideas');
});

// Active / Archive Theme Tabs
$('activeTab').addEventListener('click', () => {
  state.ideasMode = 'active';
  $('activeTab').classList.add('active');
  $('archiveTab').classList.remove('active');
  renderIdeas();
});
$('archiveTab').addEventListener('click', () => {
  state.ideasMode = 'archived';
  $('archiveTab').classList.add('active');
  $('activeTab').classList.remove('active');
  renderIdeas();
});

// ============ IDEAS SEARCH ============
// Filters the current theme's bubbles and highlights the matches. The loupe
// button toggles the field; Esc clears and closes, the cross clears the text.
let ideasSearchQuery = '';
const ideasSearchBtn = $('ideasSearchBtn');
const ideasSearch = $('ideasSearch');
const ideasSearchInput = $('ideasSearchInput');
const ideasSearchClear = $('ideasSearchClear');

function clearIdeasSearch() {
  ideasSearchQuery = '';
  if (ideasSearchInput) ideasSearchInput.value = '';
  if (ideasSearchClear) ideasSearchClear.classList.add('hidden');
  renderIdeas();
}

function toggleIdeasSearch(show) {
  if (!ideasSearch) return;
  const open = show !== undefined ? show : ideasSearch.classList.contains('hidden');
  ideasSearch.classList.toggle('hidden', !open);
  if (open && ideasSearchInput) {
    ideasSearchInput.focus();
  } else {
    clearIdeasSearch();
  }
}

function highlightText(text, query) {
  if (!query) return escapeHtml(text);
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let out = '';
  let i = 0;
  while (true) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) { out += escapeHtml(text.slice(i)); break; }
    out += escapeHtml(text.slice(i, idx)) + '<mark class="idea-hl">' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>';
    i = idx + q.length;
  }
  return out;
}

if (ideasSearchBtn) {
  ideasSearchBtn.addEventListener('click', () => toggleIdeasSearch());
}
if (ideasSearchInput) {
  ideasSearchInput.addEventListener('input', () => {
    ideasSearchQuery = ideasSearchInput.value.trim();
    if (ideasSearchClear) ideasSearchClear.classList.toggle('hidden', !ideasSearchQuery);
    renderIdeas();
  });
  ideasSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      toggleIdeasSearch(false);
      if (ideasSearchBtn) ideasSearchBtn.focus();
    }
  });
}
if (ideasSearchClear) {
  ideasSearchClear.addEventListener('click', () => {
    ideasSearchQuery = '';
    if (ideasSearchInput) ideasSearchInput.value = '';
    ideasSearchClear.classList.add('hidden');
    if (ideasSearchInput) ideasSearchInput.focus();
    renderIdeas();
  });
}

// Editor interactions
content.addEventListener('input', () => {
  // Live-update the line kind so headings/lists/etc. grow/shrink as you type their prefix
  if (activeLineNode && content.contains(activeLineNode)) {
    applyLineKind(activeLineNode, activeLineNode.textContent);
  }
  if (typewriterState) centerActiveLine(true);
  updateStats();
  markDirty();
  saveHistory(state.activeDocId, false);
  debouncedRegenerateTOC();
  // Re-group code blocks / re-highlight / refresh callouts after typing settles
  debouncedPostProcess();
});

// Block the WebView's native undo/redo so Ctrl+Z always runs our custom
// history stack instead of the contenteditable's built-in one.
content.addEventListener('beforeinput', (e) => {
  if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
    e.preventDefault();
    return;
  }
  // Spellcheck correction on a rendered (non-active) block: the browser edits
  // the displayed text, but the saved source lives in dataset.raw, so the fix
  // would be lost on the next render. Switch that block to raw edit mode and
  // apply the replacement to the raw markdown instead.
  if (e.inputType === 'insertReplacementText' && !readingModeState) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const line = getLineForNode(range.startContainer);
    if (!line || line === activeLineNode || !content.contains(line)) return;
    e.preventDefault();
    const replacement = (e.data != null) ? String(e.data) : '';
    const word = range.toString();
    const renderedStart = rangeOffsetIn(line, range.startContainer, range.startOffset);
    makeLineRawAndActive(line);
    const raw = line.textContent;
    // Locate the misspelled word in the raw source, preferring the occurrence
    // nearest the caret (renderedToRawOffset is exact only for block prefixes,
    // so a nearest-index search handles words inside **bold** etc.).
    let rawStart = -1;
    if (word) {
      const approx = renderedToRawOffset(line, renderedStart);
      let best = -1, bestDist = Infinity;
      let from = 0;
      while (true) {
        const idx = raw.indexOf(word, from);
        if (idx === -1) break;
        const dist = Math.abs(idx - approx);
        if (dist < bestDist) { bestDist = dist; best = idx; }
        from = idx + 1;
      }
      rawStart = best;
    }
    if (rawStart === -1) rawStart = renderedToRawOffset(line, renderedStart);
    const newRaw = raw.slice(0, rawStart) + replacement + raw.slice(rawStart + word.length);
    line.textContent = newRaw;
    line.dataset.raw = newRaw;
    setCaretInLine(line, rawStart + replacement.length);
    markDirty();
    updateStats();
    saveHistory(state.activeDocId, true);
    debouncedRegenerateTOC();
  }
});

title.addEventListener('input', () => {
  autoGrow(title);
  markDirty();
  saveHistory(state.activeDocId, false);
});
subtitle.addEventListener('input', () => {
  autoGrow(subtitle);
  markDirty();
  saveHistory(state.activeDocId, false);
});

editorWrap.addEventListener('scroll', () => {
  topbar.classList.toggle('scrolled', editorWrap.scrollTop > 8);
  onEditorScrollForTOC();
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 720) {
    app.classList.remove('show-sidebar');
    app.classList.remove('show-ideas');
  }
});

// Add Section action
$('addSectionBtn').addEventListener('click', async () => {
  const name = await themedPrompt(__('prompt.section_name'));
  if (!name || !name.trim()) return;
  createSection(name);
});

// New Document action
newDocBtn.addEventListener('click', () => {
  const doc = activeDoc();
  const sectionId = doc ? doc.id.split('/')[0] : (state.sections[0]?.id || 'Manifestes');
  createDocument(sectionId);
});

// Add Idea text area validator
ideaAddInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const txt = ideaAddInput.value.trim();
    if (!txt) { 
      ideaAddInput.classList.add('hidden'); 
      renderIdeas(); 
      return; 
    }
    const theme = activeTheme();
    if (!theme) return;
    addIdea(theme.id, txt);
  } else if (e.key === 'Escape') {
    ideaAddInput.classList.add('hidden');
    renderIdeas();
  }
});

// ============ SAVE ON EXIT ============
// beforeunload is unreliable: the async fetch it fired was routinely cancelled
// mid-flight, and iOS Safari does not fire it at all — switching apps on a
// phone simply lost the last edits. pagehide + visibilitychange cover both
// desktop close and mobile backgrounding; sendBeacon survives the teardown.

function flushSave() {
  if (!dirty) return;
  const doc = activeDoc();
  if (!doc) return;

  const payload = JSON.stringify({
    id: doc.id,
    title: title.value,
    subtitle: subtitle.value,
    content: getContentMarkdown(),
    knownUpdatedAt: doc.updatedAt
  });

  // A beacon cannot carry custom headers, so the token rides in the query
  // string here — it is a same-origin request that never leaves the machine.
  const token = localStorage.getItem('scriptorium_token');
  const url = '/api/documents' + (token ? '?token=' + encodeURIComponent(token) : '');

  // sendBeacon is POST-only; the server accepts it as an alias of PUT below.
  const sent = navigator.sendBeacon &&
    navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));

  if (!sent) {
    // keepalive lets the request outlive the page when beacon is unavailable.
    fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(() => {});
  }
  dirty = false;
}

window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
});

// ============ SEARCH ENGINE ============

const searchOverlay = $('searchModalOverlay');
const searchInput = $('searchInput');
const searchResultsEl = $('searchResults');
const searchCountEl = $('searchCount');
const searchBtn = $('searchBtn');
const clearHighlightBtn = $('clearHighlightBtn');
const highlightQueryLabel = $('highlightQueryLabel');

let searchSelectedIndex = -1;
let currentSearchResults = [];
let searchDebounceTimer;
let currentHighlightQuery = null;

// Accent + case insensitive — length-preserving (1 char in -> 1 char out)
function normalizeSearch(s) {
  if (!s) return '';
  return s.toString().toLowerCase().split('').map(c => {
    const d = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return d || c;
  }).join('');
}

// Highlight raw text safely: escape HTML AND wrap matches in <mark>
function highlightAndEscape(rawText, query) {
  if (!query) return escapeHtml(rawText);
  const qn = normalizeSearch(query);
  const tn = normalizeSearch(rawText);
  if (!qn) return escapeHtml(rawText);
  let out = '';
  let i = 0;
  while (i < rawText.length) {
    if (tn.substr(i, qn.length) === qn) {
      out += '<mark>' + escapeHtml(rawText.substr(i, qn.length)) + '</mark>';
      i += qn.length;
    } else {
      out += escapeHtml(rawText[i]);
      i++;
    }
  }
  return out;
}

function buildSnippet(text, query, before = 50, after = 110) {
  if (!text) return '';
  const norm = normalizeSearch(text);
  const qn = normalizeSearch(query);
  const idx = norm.indexOf(qn);
  if (idx === -1) return '';
  const start = Math.max(0, idx - before);
  const end = Math.min(text.length, idx + qn.length + after);
  // Trim word boundaries for cleaner snippets
  let realStart = start;
  if (realStart > 0) {
    const sp = text.lastIndexOf(' ', realStart + 8);
    if (sp > start - 20 && sp < idx) realStart = sp + 1;
  }
  let realEnd = end;
  if (realEnd < text.length) {
    const sp = text.indexOf(' ', realEnd - 8);
    if (sp > idx && sp < end + 20) realEnd = sp;
  }
  let raw = text.substring(realStart, realEnd).replace(/\s*\n+\s*/g, ' · ');
  let html = highlightAndEscape(raw, query);
  if (realStart > 0) html = '…' + html;
  if (realEnd < text.length) html = html + '…';
  return html;
}

function performSearch(query) {
  const q = (query || '').trim();
  if (!q) {
    searchResultsEl.innerHTML = '<div class="search-placeholder">' + __('search.waiting') + '</div>';
    searchCountEl.textContent = '';
    currentSearchResults = [];
    searchSelectedIndex = -1;
    return;
  }
  const qn = normalizeSearch(q);
  const results = [];

  // --- Documents ---
  state.sections.forEach(section => {
    const sectionLabel = section.id === '_general' ? __('search.section_general') : section.name;
    section.documents.forEach(doc => {
      const tn = normalizeSearch(doc.title || '');
      const sn = normalizeSearch(doc.subtitle || '');
      const cn = normalizeSearch(doc.content || '');
      const tHit = tn.indexOf(qn);
      const sHit = sn.indexOf(qn);
      const cHit = cn.indexOf(qn);
      if (tHit === -1 && sHit === -1 && cHit === -1) return;

      // Score: title is strongest, then subtitle, then content (with frequency bonus)
      let score = 0;
      if (tHit !== -1) score += 1000 - Math.min(tHit, 200);
      if (sHit !== -1) score += 500 - Math.min(sHit, 200);
      if (cHit !== -1) {
        // count occurrences (capped)
        let count = 0, pos = 0;
        while ((pos = cn.indexOf(qn, pos)) !== -1 && count < 10) { count++; pos += qn.length; }
        score += 100 + count * 5;
      }

      let snippet = '';
      if (cHit !== -1) snippet = buildSnippet(doc.content, q);
      else if (sHit !== -1) snippet = buildSnippet(doc.subtitle, q, 30, 80);

      results.push({
        type: 'doc',
        refId: doc.id,
        title: doc.title || __('new_doc.default_title'),
        section: sectionLabel,
        snippet, score, query: q
      });
    });
  });

  // --- Ideas ---
  state.ideaThemes.forEach(theme => {
    const tnn = normalizeSearch(theme.name || '');
    theme.ideas.forEach(idea => {
      const itn = normalizeSearch(idea.text || '');
      const ihit = itn.indexOf(qn);
      const thit = tnn.indexOf(qn);
      if (ihit === -1 && thit === -1) return;
      let score = 0;
      if (ihit !== -1) score += 800 - Math.min(ihit, 200);
      if (thit !== -1) score += 200;
      if (idea.archived) score -= 50;
      results.push({
        type: 'idea',
        refId: theme.id,
        ideaText: idea.text,
        archived: idea.archived,
        title: idea.text,
        section: theme.name,
        snippet: '',
        score, query: q
      });
    });
  });

  results.sort((a, b) => b.score - a.score);
  currentSearchResults = results.slice(0, 50);
  renderSearchResults(currentSearchResults);
}

function renderSearchResults(results) {
  if (!results.length) {
    searchResultsEl.innerHTML = '<div class="search-empty">' + __('search.no_results') + '</div>';
    searchCountEl.textContent = '0';
    searchSelectedIndex = -1;
    return;
  }
  searchCountEl.textContent = results.length > 1 ? __('search.count_plural', { count: results.length }) : __('search.count', { count: results.length });
  const q = results[0].query;
  searchResultsEl.innerHTML = results.map((r, i) => {
    const titleHi = highlightAndEscape(r.title, q);
    const typeCls = r.type === 'idea' ? 'type-idea' : 'type-doc';
    const typeLabel = r.type === 'idea' ? (r.archived ? __('search.result_idea_archived') : __('search.result_idea')) : __('search.result_doc');
    const meta = escapeHtml(r.section);
    return `<div class="search-result" data-idx="${i}">
      <div class="search-result-header">
        <span class="search-result-title">${titleHi}</span>
        <span class="search-result-badge"><span class="${typeCls}">${typeLabel}</span><span class="sep">·</span>${meta}</span>
      </div>
      ${r.snippet ? `<div class="search-result-snippet">${r.snippet}</div>` : ''}
    </div>`;
  }).join('');
  searchSelectedIndex = 0;
  updateSearchSelection();

  searchResultsEl.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('click', () => {
      searchSelectedIndex = parseInt(el.dataset.idx, 10);
      selectCurrentSearchResult();
    });
    el.addEventListener('mouseenter', () => {
      searchSelectedIndex = parseInt(el.dataset.idx, 10);
      updateSearchSelection();
    });
  });
}

function updateSearchSelection() {
  const items = searchResultsEl.querySelectorAll('.search-result');
  items.forEach((el, i) => {
    if (i === searchSelectedIndex) {
      el.classList.add('selected');
      el.scrollIntoView({ block: 'nearest' });
    } else {
      el.classList.remove('selected');
    }
  });
}

function selectCurrentSearchResult() {
  if (searchSelectedIndex < 0 || !currentSearchResults[searchSelectedIndex]) return;
  const r = currentSearchResults[searchSelectedIndex];
  closeSearch();
  if (r.type === 'doc') {
    const sameDoc = state.activeDocId === r.refId;
    openDoc(r.refId);
    // openDoc rewrites the editor; wait a tick then highlight
    setTimeout(() => highlightInEditor(r.query), sameDoc ? 30 : 160);
    // close sidebar drawer on mobile
    if (window.innerWidth <= 720) app.classList.remove('show-sidebar');
  } else if (r.type === 'idea') {
    state.activeThemeId = r.refId;
    state.ideasMode = r.archived ? 'archived' : 'active';
    const activeBtn = $('activeTab');
    const archBtn = $('archiveTab');
    if (r.archived) { activeBtn.classList.remove('active'); archBtn.classList.add('active'); }
    else { archBtn.classList.remove('active'); activeBtn.classList.add('active'); }
    renderThemesTabs();
    renderIdeas();
    if (window.innerWidth <= 720) app.classList.add('show-ideas');
    setTimeout(() => {
      const chips = ideasList.querySelectorAll('.idea-chip');
      for (const c of chips) {
        if ((c.textContent || '').trim() === (r.ideaText || '').trim()) {
          c.classList.add('highlight-pulse');
          c.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setTimeout(() => c.classList.remove('highlight-pulse'), 1700);
          break;
        }
      }
    }, 50);
  }
}

function highlightInEditor(query) {
  if (!query) return;
  clearSearchHighlights(false);
  const qn = normalizeSearch(query);
  if (!qn) return;
  let firstMatch = null;
  const lines = content.querySelectorAll('.editor-line');
  lines.forEach(line => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      const text = node.nodeValue;
      if (!text) return;
      const norm = normalizeSearch(text);
      if (norm.indexOf(qn) === -1) return;
      const frag = document.createDocumentFragment();
      let i = 0;
      while (i < text.length) {
        if (norm.substr(i, qn.length) === qn) {
          const mark = document.createElement('mark');
          mark.className = 'search-match' + (firstMatch ? '' : ' first-match');
          mark.textContent = text.substr(i, qn.length);
          frag.appendChild(mark);
          if (!firstMatch) firstMatch = mark;
          i += qn.length;
        } else {
          let j = i + 1;
          while (j < text.length && norm.substr(j, qn.length) !== qn) j++;
          frag.appendChild(document.createTextNode(text.substring(i, j)));
          i = j;
        }
      }
      node.parentNode.replaceChild(frag, node);
    });
  });
  currentHighlightQuery = query;
  highlightQueryLabel.textContent = query.length > 20 ? query.slice(0, 18) + '…' : query;
  clearHighlightBtn.classList.remove('hidden');
  if (firstMatch) {
    firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function clearSearchHighlights(hideBtn = true) {
  const marks = content.querySelectorAll('mark.search-match');
  marks.forEach(m => {
    const text = document.createTextNode(m.textContent);
    const parent = m.parentNode;
    if (parent) {
      parent.replaceChild(text, m);
      parent.normalize();
    }
  });
  currentHighlightQuery = null;
  if (hideBtn) clearHighlightBtn.classList.add('hidden');
}

function openSearch() {
  searchOverlay.classList.add('active');
  searchInput.value = '';
  searchResultsEl.innerHTML = '<div class="search-placeholder">' + __('search.waiting') + '</div>';
  searchCountEl.textContent = '';
  currentSearchResults = [];
  searchSelectedIndex = -1;
  setTimeout(() => searchInput.focus(), 30);
}

function closeSearch() {
  searchOverlay.classList.remove('active');
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => performSearch(searchInput.value), 80);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!currentSearchResults.length) return;
    searchSelectedIndex = (searchSelectedIndex + 1) % currentSearchResults.length;
    updateSearchSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!currentSearchResults.length) return;
    searchSelectedIndex = (searchSelectedIndex - 1 + currentSearchResults.length) % currentSearchResults.length;
    updateSearchSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectCurrentSearchResult();
  }
});

searchOverlay.addEventListener('click', (e) => {
  if (e.target === searchOverlay) closeSearch();
});

if (searchBtn) searchBtn.addEventListener('click', openSearch);
if (clearHighlightBtn) clearHighlightBtn.addEventListener('click', () => clearSearchHighlights(true));

// ============ COMPACT SIDEBAR HEADER ============
const sidebarHeader = document.querySelector('.sidebar-header');
const sidebarRevealZone = $('sidebarRevealZone');
const brandRevealBtn = $('brandRevealBtn');

function setHeaderActionsRevealed(revealed) {
  if (!sidebarRevealZone || !brandRevealBtn) return;
  sidebarRevealZone.classList.toggle('is-revealed', revealed);
  brandRevealBtn.setAttribute('aria-expanded', String(revealed));
}

// A touch has no hover: pointerenter fires on tap and pointerleave fires the
// instant the finger lifts, so the row collapsed before anything in it could
// be tapped. Hover drives the reveal for a mouse only; touch toggles it.
function isMouseEvent(event) {
  if (event && typeof event.pointerType === 'string') return event.pointerType === 'mouse';
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

if (sidebarRevealZone && sidebarHeader && brandRevealBtn) {
  brandRevealBtn.addEventListener('pointerenter', (event) => {
    if (!isMouseEvent(event)) return;
    setHeaderActionsRevealed(true);
  });

  sidebarRevealZone.addEventListener('pointerleave', (event) => {
    if (!isMouseEvent(event)) return;
    setHeaderActionsRevealed(false);
  });

  brandRevealBtn.addEventListener('click', (event) => {
    if (!isMouseEvent(event)) {
      // The padlock has its own button inside the row; making the tap that
      // opens the row also lock the workspace hid "Nouveau texte" behind a
      // gesture nobody asked for.
      setHeaderActionsRevealed(!sidebarRevealZone.classList.contains('is-revealed'));
      return;
    }
    setHeaderActionsRevealed(true);
    toggleWorkspaceLock();
  });

  // Tapping anywhere else closes it, the way the row used to close on mouse-out.
  document.addEventListener('pointerdown', (event) => {
    if (isMouseEvent(event)) return;
    if (!sidebarRevealZone.classList.contains('is-revealed')) return;
    if (sidebarRevealZone.contains(event.target)) return;
    setHeaderActionsRevealed(false);
  });

  sidebarRevealZone.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setHeaderActionsRevealed(false);
      brandRevealBtn.focus();
    }
  });
}

// ============ TABLE OF CONTENTS ============

// Both TOC instances: the floating one (focus-mode only) and the side one (inside right panel)
const tocAside = $('tocAside');
const tocList = $('tocList');
const tocPath = $('tocPath');
const tocSvg = $('tocSvg');
const tocTopBtn = $('tocTopBtn');

const tocListSide = $('tocListSide');
const tocPathSide = $('tocPathSide');
const tocSvgSide = $('tocSvgSide');
const tocTopBtnSide = $('tocTopBtnSide');
const tocSideEmpty = $('tocSideEmpty');
const tocWrapSide = $('tocWrapSide');

const TOC_INSTANCES = [
  { list: tocList,     path: tocPath,     svg: tocSvg },
  { list: tocListSide, path: tocPathSide, svg: tocSvgSide },
];

let tocRegenTimer;
let tocActiveRaf = null;

function getEditorHeadings() {
  if (!content) return [];

  // Query all potential line containers and heading elements
  const candidates = Array.from(
    content.querySelectorAll('.editor-line, h1, h2, h3, h4, h5, h6, [class*="is-h"]')
  );
  if (candidates.length === 0 && content.children.length > 0) {
    Array.from(content.children).forEach(child => candidates.push(child));
  }

  const headings = [];
  const processedElements = new Set();

  candidates.forEach((el) => {
    const lineEl = getLineForNode(el) || el;
    if (processedElements.has(lineEl)) return;

    let level = 0;

    // 1. Check classes is-h1..is-h6 on line element
    for (let i = 1; i <= 6; i++) {
      if (lineEl.classList.contains(`is-h${i}`)) {
        level = i;
        break;
      }
    }

    // 2. Check inner or self HTML tag (H1..H6)
    if (!level) {
      const hTag = (lineEl.tagName && /^H[1-6]$/i.test(lineEl.tagName))
        ? lineEl
        : lineEl.querySelector('h1, h2, h3, h4, h5, h6');
      if (hTag) {
        level = parseInt(hTag.tagName.substring(1), 10) || 1;
      }
    }

    // 3. Check raw text starting with # .. ######
    const rawText = (lineEl.dataset.raw || lineEl.textContent || lineEl.innerText || '').trim();
    if (!level) {
      const match = rawText.match(/^(#{1,6})(?:\s+|$)/);
      if (match) {
        level = match[1].length;
      }
    }

    if (level > 0) {
      processedElements.add(lineEl);

      // Strip leading `#` hashes for clean display in TOC
      let cleanText = rawText.replace(/^(#{1,6})\s*/, '').trim();
      if (!cleanText) {
        const innerNode = lineEl.querySelector('h1, h2, h3, h4, h5, h6') || lineEl;
        cleanText = (innerNode.textContent || innerNode.innerText || '').replace(/^(#{1,6})\s*/, '').trim() || '—';
      }

      headings.push({
        element: lineEl,
        // Keep the DOM id when headings are collected again during scrolling.
        // generateTOC() assigns it once; updateTOCActiveState() then relies on
        // this value to match the corresponding TOC link.
        id: lineEl.id || null,
        level: level,
        text: cleanText
      });
    }
  });

  return headings;
}

function generateTOC() {
  const headings = getEditorHeadings();

  // A newly rendered document reuses ids such as `toc-h-0`. Reset the cached
  // active id so the visible TOC is centred even when the first id is the same
  // as in the previously opened document.
  lastActiveTocLinkId = null;

  // Assign stable IDs once
  headings.forEach((item, i) => {
    const id = `toc-h-${i}`;
    item.element.id = id;
    item.id = id;
  });

  // Update empty states
  if (!headings.length) {
    if (tocAside) tocAside.classList.add('empty');
    if (tocSideEmpty) tocSideEmpty.classList.remove('hidden');
    if (tocWrapSide) tocWrapSide.classList.add('hidden');
  } else {
    if (tocAside) tocAside.classList.remove('empty');
    if (tocSideEmpty) tocSideEmpty.classList.add('hidden');
    if (tocWrapSide) tocWrapSide.classList.remove('hidden');
  }

  // Populate both instances
  TOC_INSTANCES.forEach(({ list, path }) => populateTocList(list, path, headings));

  updateTOCSvgSize();
  scheduleTOCActiveUpdate();
}

function populateTocList(listNode, pathNode, headings) {
  if (!listNode) return;
  listNode.innerHTML = '';

  if (!headings.length) {
    if (pathNode) { pathNode.setAttribute('d', ''); pathNode.classList.remove('active'); }
    return;
  }
  headings.forEach(item => {
    const id = item.id;
    const level = item.level;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = `toc-link level-${level}`;
    a.dataset.targetId = id;
    a.dataset.level = level;
    const text = item.text || '—';
    a.textContent = text;
    a.title = text;
    a.href = '#' + id;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(id);
      if (!target) return;
      const containerTop = editorWrap.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      editorWrap.scrollTo({
        top: editorWrap.scrollTop + targetTop - containerTop - 48,
        behavior: 'smooth'
      });
    });
    li.appendChild(a);
    listNode.appendChild(li);
  });
}

let lastActiveTocLinkId = null;

function updateTOCSvgSize() {
  TOC_INSTANCES.forEach(({ list, svg }) => {
    if (!svg || !list) return;
    const h = list.scrollHeight || list.offsetHeight || 0;
    const w = list.scrollWidth || list.offsetWidth || 0;
    if (h > 0) {
      svg.setAttribute('height', h + 'px');
    }
    if (w > 0) {
      svg.setAttribute('width', Math.max(220, w) + 'px');
    }
  });
}

function scheduleTOCActiveUpdate() {
  if (tocActiveRaf) return;
  tocActiveRaf = requestAnimationFrame(() => {
    tocActiveRaf = null;
    updateTOCActiveState();
  });
}

// X position based on heading level — matches the wiki's exact grid:
// H1 sits 1px LEFT of the UL container (overflow:visible lets it show),
// each subsequent level is +12px (the wiki's ml-3/ml-6 indent unit).
function tocXForLevel(lvl) {
  if (lvl <= 1) return 1;
  if (lvl === 2) return 13;
  if (lvl === 3) return 25;
  if (lvl === 4) return 37;
  if (lvl === 5) return 49;
  return 61;
}

function updateTOCActiveState() {
  const headings = getEditorHeadings();
  if (!headings.length) return;

  const containerRect = editorWrap.getBoundingClientRect();
  const buffer = 12;

  let activeHeadings = headings.filter(item => {
    const rect = item.element.getBoundingClientRect();
    const relTop = rect.top - containerRect.top;
    const relBottom = rect.bottom - containerRect.top;
    return relTop < containerRect.height - buffer && relBottom > buffer;
  });

  if (!activeHeadings.length) {
    for (let i = headings.length - 1; i >= 0; i--) {
      const rect = headings[i].element.getBoundingClientRect();
      if (rect.top - containerRect.top <= 100) {
        activeHeadings.push(headings[i]);
        break;
      }
    }
  }
  if (!activeHeadings.length) activeHeadings.push(headings[0]);
  const activeIds = new Set(activeHeadings.map(item => item.id));

  // Determine if active link actually changed to trigger scrolling
  const activeId = activeHeadings[0].id;
  const changed = (lastActiveTocLinkId !== activeId);
  if (changed) {
    lastActiveTocLinkId = activeId;
  }

  // Apply to both instances
  TOC_INSTANCES.forEach(({ list, path }) => applyActiveToInstance(list, path, activeIds, changed));
}

function scrollActiveTocLinkIntoView(listNode, activeLink) {
  if (!listNode || !activeLink) return;
  const wrap = listNode.closest('.toc-wrap');
  if (!wrap) return;

  // Don't calculate if the wrap is not visible
  if (wrap.offsetHeight === 0) return;

  const wrapRect = wrap.getBoundingClientRect();
  const linkRect = activeLink.getBoundingClientRect();

  if (linkRect.top < wrapRect.top + 30 || linkRect.bottom > wrapRect.bottom - 30) {
    const targetScrollTop = wrap.scrollTop + (linkRect.top - wrapRect.top) - (wrapRect.height / 2) + (linkRect.height / 2);
    wrap.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth'
    });
  }
}

function applyActiveToInstance(listNode, pathNode, activeIds, changed) {
  if (!listNode || !pathNode) return;
  const links = Array.from(listNode.querySelectorAll('.toc-link'));
  if (!links.length) {
    pathNode.setAttribute('d', '');
    pathNode.classList.remove('active');
    return;
  }

  const activeLinks = [];
  links.forEach(link => {
    if (activeIds.has(link.dataset.targetId)) {
      link.classList.add('active');
      activeLinks.push(link);
    } else {
      link.classList.remove('active');
    }
  });

  if (activeLinks.length === 0) {
    pathNode.setAttribute('d', '');
    pathNode.classList.remove('active');
    return;
  }

  if (changed) {
    scrollActiveTocLinkIntoView(listNode, activeLinks[0]);
  }

  // Same path-tracing algorithm as the wiki: contiguous active links share
  // a continuous segment; gaps start a new M command.
  let d = '';
  let lastIndex = -2;
  activeLinks.forEach(link => {
    const lvl = parseInt(link.dataset.level, 10) || 1;
    const x = tocXForLevel(lvl);
    const yTop = link.offsetTop;
    const yBottom = yTop + link.offsetHeight;
    const linkIndex = links.indexOf(link);
    if (linkIndex !== lastIndex + 1) {
      d += ` M ${x} ${yTop} L ${x} ${yBottom}`;
    } else {
      d += ` L ${x} ${yTop} L ${x} ${yBottom}`;
    }
    lastIndex = linkIndex;
  });

  pathNode.setAttribute('d', d.trim());
  pathNode.classList.add('active');
}

function debouncedRegenerateTOC() {
  clearTimeout(tocRegenTimer);
  tocRegenTimer = setTimeout(generateTOC, 280);
}

function toggleFocusMode() {
  var isFocus = !app.classList.contains('focus-mode');
  app.classList.toggle('focus-mode');
  showToast(isFocus ? 'toast.focus_on' : 'toast.focus_off');
}

function onEditorScrollForTOC() {
  scheduleTOCActiveUpdate();
}

if (tocTopBtn)     tocTopBtn.addEventListener('click', () => editorWrap.scrollTo({ top: 0, behavior: 'smooth' }));
if (tocTopBtnSide) tocTopBtnSide.addEventListener('click', () => editorWrap.scrollTo({ top: 0, behavior: 'smooth' }));

window.addEventListener('resize', () => {
  updateTOCSvgSize();
  scheduleTOCActiveUpdate();
});

// ============ RIGHT-PANEL VIEW SWITCHER ============
function setRightPanelView(view) {
  const isToc = view === 'toc';
  const isSnapshots = view === 'snapshots';
  ideasPanel.classList.toggle('view-toc-mode', isToc);
  ideasPanel.classList.toggle('view-snapshots-mode', isSnapshots);
  // Update panel title and cycle button label
  var titleKey = isToc ? 'ideas.tab_toc' : (isSnapshots ? 'ideas.tab_snapshots' : 'ideas.tab_ideas');
  if (panelCycleLabel) {
    panelCycleLabel.textContent = __(titleKey);
    panelCycleLabel.setAttribute('data-i18n', titleKey);
  }
  try { localStorage.setItem('rightPanelView', view); } catch (e) {}

  if (isSnapshots) {
    renderSnapshotsList();
    loadSnapshotsForDoc(state.activeDocId);
  }
  requestAnimationFrame(() => {
    generateTOC();
    updateTOCSvgSize();
    updateTOCActiveState();
  });
}

// Panel cycle button: cycles through Ideas -> TOC -> Snapshots -> Ideas
var PANEL_VIEWS = ['ideas', 'toc', 'snapshots'];
var panelCycleBtn = $('panelCycleBtn');
var panelCycleLabel = $('panelCycleLabel');

function cyclePanel() {
  var current = ideasPanel.classList.contains('view-toc-mode') ? 'toc'
    : ideasPanel.classList.contains('view-snapshots-mode') ? 'snapshots'
    : 'ideas';
  var idx = PANEL_VIEWS.indexOf(current);
  var next = PANEL_VIEWS[(idx + 1) % PANEL_VIEWS.length];
  setRightPanelView(next);
}

if (panelCycleBtn) {
  panelCycleBtn.addEventListener('click', cyclePanel);
}

// The main view is always the ideas panel on load; the cycle button switches
// and remembers the choice for the rest of the session.
setRightPanelView('ideas');

// ============ INLINE SELECTION TOOLBAR + BLOCK-ADD GUTTER BUTTON ============

const selToolbar = $('selToolbar');
const blockAddBtn = $('blockAddBtn');
const blockDragBtn = $('blockDragBtn');
const blockTrashBtn = $('blockTrashBtn');
const blockDropIndicator = $('blockDropIndicator');
const blockMenu = $('blockMenu');

let selToolbarTimer;
let blockBtnTimer;
let hoveredLineNode = null;

function getSelectionInContent() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return null;
  // Selection must originate inside the editor content
  if (!content.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== content) {
    return null;
  }
  return range;
}

function showSelectionToolbar() {
  if (!selToolbar) return;
  const range = getSelectionInContent();
  if (!range) { hideSelectionToolbar(); return; }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) { hideSelectionToolbar(); return; }
  // Render once to measure
  selToolbar.classList.add('visible');
  const tbRect = selToolbar.getBoundingClientRect();
  let top = rect.top - tbRect.height - 8;
  if (top < 60) top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - tbRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tbRect.width - 8));
  selToolbar.style.top = top + 'px';
  selToolbar.style.left = left + 'px';
  updateToolbarActiveStates(range);
}

function hideSelectionToolbar() {
  if (selToolbar) selToolbar.classList.remove('visible');
}

function getLineRawText(line) {
  if (line === activeLineNode) return line.textContent;
  return (line.dataset.raw !== undefined) ? line.dataset.raw : line.textContent;
}

// Highlights B/I/U/S/H1/H2/H3/quote on the floating toolbar when the current
// selection is already wrapped in that markup, so re-clicking removes it
// instead of stacking another layer of markers.
function updateToolbarActiveStates(range) {
  if (!selToolbar) return;
  const marks = { bold: false, italic: false, underline: false, strike: false, code: false };
  let blockKind = null;

  if (range) {
    const startLine = getLineForNode(range.startContainer);
    const endLine = getLineForNode(range.endContainer);
    if (startLine && startLine === endLine) {
      const raw = getLineRawText(startLine);
      const startOffRendered = rangeOffsetIn(startLine, range.startContainer, range.startOffset);
      const endOffRendered = rangeOffsetIn(startLine, range.endContainer, range.endOffset);
      const startOffRaw = renderedToRawOffset(startLine, startOffRendered);
      const endOffRaw = renderedToRawOffset(startLine, endOffRendered);
      const s = Math.min(startOffRaw, endOffRaw);
      const e = Math.max(startOffRaw, endOffRaw);

      const isWrapped = (prefix, suffix = prefix) => {
        const sel = raw.slice(s, e);
        if (sel.startsWith(prefix) && sel.endsWith(suffix) && sel.length >= prefix.length + suffix.length) return true;
        return isExactlyNestedInPair(raw, s, e, prefix, suffix);
      };

      // Asterisk depth handles "***bold italic***" as both at once, not just
      // the outermost pair (a plain **/`*` prefix check would miss that).
      const starDepth = markerRunDepth(raw, s, e, '*').depth;
      marks.bold = starDepth >= 2;
      marks.italic = starDepth === 1 || starDepth >= 3;
      marks.strike = isWrapped('~~');
      marks.underline = isWrapped('<u>', '</u>');
      marks.code = isWrapped('`');

      blockKind = currentBlockKind(raw);
    }
  }

  selToolbar.querySelectorAll('.sel-btn').forEach(btn => {
    const act = btn.dataset.act;
    const isActive = (act in marks) ? marks[act] : (blockKind === act);
    btn.classList.toggle('active', isActive);
  });
}

document.addEventListener('selectionchange', () => {
  clearTimeout(selToolbarTimer);
  selToolbarTimer = setTimeout(showSelectionToolbar, 40);
  clearTimeout(blockBtnTimer);
  blockBtnTimer = setTimeout(() => {
    updateBlockAddPosition();
    updateBlockDragPosition();
  }, 40);
});
editorWrap.addEventListener('scroll', () => { hideSelectionToolbar(); updateBlockAddPosition(); updateBlockDragPosition(); closeBlockMenu(); hideBlockTrashBtnNow(); });
window.addEventListener('resize', () => { hideSelectionToolbar(); updateBlockAddPosition(); updateBlockDragPosition(); closeBlockMenu(); hideBlockTrashBtnNow(); });

// Prevent the buttons from stealing the selection on mousedown
if (selToolbar) {
  selToolbar.addEventListener('mousedown', (e) => e.preventDefault());
  selToolbar.querySelectorAll('.sel-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      applyInlineFormat(btn.dataset.act);
    });
  });
}

function applyInlineFormat(act) {
  if (!act) return;

  switch (act) {
    case 'bold':       wrapSelectionInline('**'); break;
    case 'italic':     wrapSelectionInline('*'); break;
    case 'underline':  wrapSelectionInline('<u>', '</u>'); break;
    case 'strike':     wrapSelectionInline('~~'); break;
    case 'code':       wrapSelectionInline('`'); break;
    case 'link':       insertLinkAroundSelection(); break;
    case 'h1':         setLineBlockType('h1'); break;
    case 'h2':         setLineBlockType('h2'); break;
    case 'h3':         setLineBlockType('h3'); break;
    case 'quote':      setLineBlockType('quote'); break;
    case 'addidea':    addSelectionToIdeas(); break;
  }
  // Re-position the toolbar over the (possibly shifted) selection
  setTimeout(showSelectionToolbar, 30);
}

// Adds the selected text to the currently open ideas theme.
async function addSelectionToIdeas() {
  const theme = activeTheme();
  if (!theme) {
    themedAlert(__('alert.no_theme'));
    return;
  }
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';
  if (!text) return;
  await addIdea(theme.id, text);
}

async function insertLinkAroundSelection() {
  // The themed prompt is async and steals focus, which would drop the editor
  // selection before wrapSelectionInline runs. Capture and restore it.
  const sel = window.getSelection();
  const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const url = await themedPrompt(__('prompt.url'), 'https://');
  if (saved) {
    const selNow = window.getSelection();
    if (selNow) {
      selNow.removeAllRanges();
      selNow.addRange(saved);
    }
  }
  if (!url) return;
  wrapSelectionInline('[', `](${url})`);
}

// Strip any block-level prefix from a raw line and return the bare inner text.
function stripBlockPrefix(text) {
  return text
    .replace(/^(#{1,6})\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^[-*+]\s+\[[ xX]\]\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '');
}

// The block kind a raw line's prefix currently encodes, e.g. '# ' -> 'h1'.
function currentBlockKind(text) {
  const h = text.match(/^(#{1,6})\s/);
  if (h) return 'h' + h[1].length;
  if (/^>\s?/.test(text)) return 'quote';
  if (/^[-*+]\s\[[ xX]\]\s/.test(text)) return 'task';
  if (/^[-*+]\s/.test(text)) return 'ul';
  if (/^\d+\.\s/.test(text)) return 'ol';
  return 'p';
}

function setLineBlockType(kind) {
  // Format the line that actually holds the selection, not only the remembered
  // active line (they can drift apart after toolbar clicks).
  const sel = window.getSelection();
  let line = activeLineNode;
  if (sel && sel.rangeCount) {
    line = getLineForNode(sel.getRangeAt(0).startContainer) || activeLineNode;
  }
  if (!line || !content.contains(line)) return;

  // Capture selection offsets before any DOM mutation. If the line is not raw
  // yet (inactive rendered line), map the rendered offsets to raw ones.
  let selStart = null, selEnd = null;
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    if (line.contains(r.startContainer) && line.contains(r.endContainer)) {
      selStart = rangeOffsetIn(line, r.startContainer, r.startOffset);
      selEnd = rangeOffsetIn(line, r.endContainer, r.endOffset);
      if (line !== activeLineNode) {
        selStart = renderedToRawOffset(line, selStart);
        selEnd = renderedToRawOffset(line, selEnd);
      }
    }
  }

  if (line !== activeLineNode) makeLineRawAndActive(line);

  saveHistory(state.activeDocId, true);
  const text = line.textContent;
  const inner = stripBlockPrefix(text);
  // Clicking the format that's already applied toggles it back to a plain paragraph.
  const targetKind = currentBlockKind(text) === kind ? 'p' : kind;
  const PREFIX = { p: '', h1: '# ', h2: '## ', h3: '### ', h4: '#### ', h5: '##### ', h6: '###### ', ul: '- ', ol: '1. ', task: '- [ ] ', quote: '> ' };
  const oldPrefixLen = (PREFIX[currentBlockKind(text)] || '').length;
  const newPrefixLen = (PREFIX[targetKind] || '').length;
  const newText = (PREFIX[targetKind] || '') + inner;

  // Keep the caret or selection where it was instead of jumping to the end, so
  // H1 then H2 can be pressed in a row and the result is visible live.
  line.textContent = newText;
  line.dataset.raw = newText;
  applyLineKind(line, newText);

  if (selStart !== null) {
    const shift = (pos) => {
      if (pos <= oldPrefixLen) return Math.min(pos + newPrefixLen - oldPrefixLen, newPrefixLen);
      return Math.min(pos + newPrefixLen - oldPrefixLen, newText.length);
    };
    const ns = shift(selStart);
    const ne = shift(selEnd);
    setSelectionInLine(line, ns, ne);
    // Deferred post-processing (TOC, code grouping) may rebuild the line and
    // drop the selection: re-apply it once the dust settles.
    const target = line;
    setTimeout(() => {
      if (target === activeLineNode && content.contains(target)) {
        target.textContent = target.dataset.raw !== undefined ? target.dataset.raw : target.textContent;
        setSelectionInLine(target, ns, ne);
      }
    }, 280);
  } else {
    setCaretInLine(line, newText.length);
  }
  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();
}

// ============ GUTTER "+" BUTTON ============

function updateBlockAddPosition() {
  if (!blockAddBtn) return;
  // Hide if no active line or if there's a non-collapsed selection
  if (!activeLineNode || !content.contains(activeLineNode)) {
    blockAddBtn.classList.remove('visible');
    return;
  }
  const sel = window.getSelection();
  if (sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) {
    blockAddBtn.classList.remove('visible');
    return;
  }

  const rect = activeLineNode.getBoundingClientRect();
  const editorRect = editorWrap.getBoundingClientRect();
  // Hide if the line is scrolled off the editor's visible viewport
  if (rect.bottom < editorRect.top + 20 || rect.top > editorRect.bottom - 20) {
    blockAddBtn.classList.remove('visible');
    return;
  }

  // Adaptive offset: ideal is 30px to the LEFT of the line text, but if the
  // editor column is narrow (sidebar + ideas both open), we shrink the gap so
  // the button still sits just before the line rather than disappearing.
  // Minimum 10px gap so we never overlap the text itself.
  const isMobile = window.innerWidth <= 720;
  const gap = Math.max(0, rect.left); // distance from viewport left to line
  const desiredOffset = isMobile ? 22 : 30;
  const minOffset = isMobile ? 4 : 10;
  const offset = Math.max(minOffset, Math.min(desiredOffset, gap - 2));
  let left = rect.left - offset;
  if (isMobile) left = Math.max(2, left);
  const top = rect.top + (rect.height / 2) - (isMobile ? 12 : 11);

  // On desktop, if the button would go off-screen, hide it.
  if (!isMobile && left < 2) {
    blockAddBtn.classList.remove('visible');
    return;
  }

  blockAddBtn.style.top = top + 'px';
  blockAddBtn.style.left = left + 'px';
  blockAddBtn.classList.add('visible');
}

// ============ BLOCK DRAG & DROP REORDERING ============

let isDraggingBlock = false;
let draggedLineNode = null;
let blockDragGhostEl = null;
let targetDropLine = null;
let dropInsertBefore = true;
let autoScrollAnimFrame = null;
let autoScrollSpeed = 0;
let lastDragEvent = null;
let dragStartX = null;

const DELETE_ZONE_PX = 36;    // this close to the edge = releasing here deletes the block
const DELETE_APPROACH_PX = 110; // this close to the edge = start showing the zone at all
// Same threshold as the approach preview: once the red zone is visible, dropping
// inside it must delete. A stricter threshold made the zone appear while a drop
// silently did nothing, which read as "delete is broken".
const MIN_DELETE_DRAG_PX = 18;   // must also have dragged the block this far *toward* that edge
const MIN_APPROACH_DRAG_PX = 18; // the preview appears at the same moment deletion is armed
let deleteZoneLeftEl = null;
let deleteZoneRightEl = null;

// Which edge of the EDITOR PANE (not the whole window — that would reach into
// the right sidebar) the cursor is currently over, if any. On narrow panes the
// drag handle already rests inside this zone, so proximity alone isn't enough —
// the block must also have been dragged sideways, toward that edge, by at
// least `minDrag` px from where the drag started. Otherwise a plain up/down
// reorder (mouse X barely moving) would register as "dragged into the red zone".
function getEdgeNearPoint(clientX, wrapRect, zonePx, minDrag) {
  const nearLeft = clientX <= wrapRect.left + zonePx;
  const nearRight = clientX >= wrapRect.right - zonePx;
  if (!nearLeft && !nearRight) return null;
  if (typeof dragStartX !== 'number') return nearLeft ? 'left' : 'right';
  if (nearRight && (clientX - dragStartX) >= minDrag) return 'right';
  if (nearLeft && (dragStartX - clientX) >= minDrag) return 'left';
  return null;
}

function getDeleteEdge(clientX, wrapRect) {
  return getEdgeNearPoint(clientX, wrapRect, DELETE_ZONE_PX, MIN_DELETE_DRAG_PX);
}

function getDeleteApproachEdge(clientX, wrapRect) {
  return getEdgeNearPoint(clientX, wrapRect, DELETE_APPROACH_PX, MIN_APPROACH_DRAG_PX);
}

function ensureDeleteZoneEls() {
  if (!deleteZoneLeftEl) {
    deleteZoneLeftEl = document.createElement('div');
    deleteZoneLeftEl.className = 'editor-delete-zone left';
    document.body.appendChild(deleteZoneLeftEl);
  }
  if (!deleteZoneRightEl) {
    deleteZoneRightEl = document.createElement('div');
    deleteZoneRightEl.className = 'editor-delete-zone right';
    document.body.appendChild(deleteZoneRightEl);
  }
}

function positionDeleteZoneEls(wrapRect) {
  [deleteZoneLeftEl, deleteZoneRightEl].forEach(el => {
    el.style.top = wrapRect.top + 'px';
    el.style.height = wrapRect.height + 'px';
    el.style.width = DELETE_ZONE_PX + 'px';
  });
  deleteZoneLeftEl.style.left = wrapRect.left + 'px';
  deleteZoneRightEl.style.left = (wrapRect.right - DELETE_ZONE_PX) + 'px';
}

// Only reveal a zone once the cursor is actually nearing that edge, so a plain
// up/down drag (reordering, not deleting) never flashes red.
function updateDeleteZoneVisibility(clientX, wrapRect) {
  ensureDeleteZoneEls();
  positionDeleteZoneEls(wrapRect);
  const approachEdge = getDeleteApproachEdge(clientX, wrapRect);
  deleteZoneLeftEl.style.display = approachEdge === 'left' ? 'block' : 'none';
  deleteZoneRightEl.style.display = approachEdge === 'right' ? 'block' : 'none';
}

function updateDeleteZoneHighlight(edge) {
  if (deleteZoneLeftEl) deleteZoneLeftEl.classList.toggle('active', edge === 'left');
  if (deleteZoneRightEl) deleteZoneRightEl.classList.toggle('active', edge === 'right');
}

function hideDeleteZones() {
  if (deleteZoneLeftEl) deleteZoneLeftEl.style.display = 'none';
  if (deleteZoneRightEl) deleteZoneRightEl.style.display = 'none';
}

// The block the drag handle applies to: the active line when one is being
// edited, otherwise the hovered block so a freshly opened document (no active
// line) can still drag any block, e.g. onto the ideas panel.
function getBlockHandleTarget() {
  if (activeLineNode && content.contains(activeLineNode)) return activeLineNode;
  if (hoveredLineNode && content.contains(hoveredLineNode)) return hoveredLineNode;
  return null;
}

function updateBlockDragPosition() {
  if (!blockDragBtn) return;
  if (isDraggingBlock) return; // Keep visible while dragging

  const target = getBlockHandleTarget();
  if (!target) {
    blockDragBtn.classList.remove('visible');
    return;
  }
  const sel = window.getSelection();
  if (sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) {
    blockDragBtn.classList.remove('visible');
    return;
  }

  const rect = target.getBoundingClientRect();
  const editorRect = editorWrap.getBoundingClientRect();
  // Hide if the line is scrolled off the editor's visible viewport
  if (rect.bottom < editorRect.top + 20 || rect.top > editorRect.bottom - 20) {
    blockDragBtn.classList.remove('visible');
    return;
  }

  // Position at the right edge of the block / editor pane
  const containerRect = editorContainer.getBoundingClientRect();
  let left = rect.right + 10;
  if (left > containerRect.right - 28) {
    left = containerRect.right - 28;
  }
  if (left > window.innerWidth - 30) {
    left = window.innerWidth - 30;
  }

  const top = rect.top + (rect.height / 2) - 11;

  blockDragBtn.style.top = top + 'px';
  blockDragBtn.style.left = left + 'px';
  blockDragBtn.classList.add('visible');
}

// True when the right panel is showing the Ideas view (not TOC / snapshots).
function isIdeasViewActive() {
  return !!ideasPanel && !ideasPanel.classList.contains('view-toc-mode') && !ideasPanel.classList.contains('view-snapshots-mode');
}

// True when the pointer is over the ideas panel AND it is showing the Ideas
// view: a drag landing there adds the dragged text as an idea instead of
// deleting or moving the block. The TOC / snapshots views have no ideas list.
function isOverIdeasPanel(x, y) {
  if (!ideasPanel) return false;
  if (!isIdeasViewActive()) return false;
  const r = ideasPanel.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

async function addBlockTextToIdeas(text) {
  const theme = activeTheme();
  if (!theme) {
    themedAlert(__('alert.no_theme'));
    return;
  }
  await addIdea(theme.id, text);
}

// Adds the block's text as a new idea in `themeId`, then moves it to sit just
// before or after `beforeText`, matching the line shown during the drag.
async function addBlockTextToIdeasAt(text, themeId, beforeText, after) {
  const theme = state.ideaThemes.find(t => t.id === themeId);
  if (!theme) {
    themedAlert(__('alert.no_theme'));
    return;
  }
  await addIdea(themeId, text);
  const fresh = state.ideaThemes.find(t => t.id === themeId);
  if (fresh) await reorderIdeas(fresh, text, beforeText, after);
}

function startBlockDrag(line, e) {
  if (!line || !content.contains(line)) return;

  isDraggingBlock = true;
  draggedLineNode = line;
  draggedLineNode.classList.add('dragging-line');
  if (blockDragBtn) blockDragBtn.classList.add('dragging');
  setHoveredLine(null);
  hideBlockTrashBtnNow();
  dragStartX = e.clientX;
  // Chips must not look hovered while dragging a block: the drop line is the cue.
  if (ideasPanel) ideasPanel.classList.add('block-dragging');

  // Create drag ghost element
  if (blockDragGhostEl) blockDragGhostEl.remove();
  blockDragGhostEl = document.createElement('div');
  blockDragGhostEl.className = 'block-drag-ghost';
  blockDragGhostEl.textContent = (line.textContent || '').trim() || '(Bloc vide)';
  document.body.appendChild(blockDragGhostEl);
  updateGhostPosition(e.clientX, e.clientY);

  if (blockDropIndicator) {
    blockDropIndicator.style.display = 'block';
  }
  ensureDeleteZoneEls();

  window.addEventListener('mousemove', onBlockDragMove);
  window.addEventListener('mouseup', onBlockDragEnd);
}

function updateGhostPosition(x, y) {
  if (blockDragGhostEl) {
    blockDragGhostEl.style.left = x + 'px';
    blockDragGhostEl.style.top = y + 'px';
  }
}

function onBlockDragMove(e) {
  if (!isDraggingBlock) return;
  lastDragEvent = e;
  updateGhostPosition(e.clientX, e.clientY);

  // Smooth Auto-scroll when mouse gets near top or bottom edges of editor window
  const wrapRect = editorWrap.getBoundingClientRect();
  const topThreshold = wrapRect.top + 70;
  const bottomThreshold = wrapRect.bottom - 70;

  if (e.clientY < topThreshold) {
    const dist = topThreshold - e.clientY;
    autoScrollSpeed = -Math.min(32, Math.max(5, dist * 0.45));
  } else if (e.clientY > bottomThreshold) {
    const dist = e.clientY - bottomThreshold;
    autoScrollSpeed = Math.min(32, Math.max(5, dist * 0.45));
  } else {
    autoScrollSpeed = 0;
  }

  if (autoScrollSpeed !== 0 && !autoScrollAnimFrame) {
    runAutoScrollLoop();
  }

  updateDeleteZoneVisibility(e.clientX, wrapRect);
  // Over the ideas panel the drop means "add as an idea", never a delete.
  const overIdeas = isOverIdeasPanel(e.clientX, e.clientY);
  const deleteEdge = overIdeas ? null : getDeleteEdge(e.clientX, wrapRect);
  updateDeleteZoneHighlight(deleteEdge);
  if (deleteEdge) {
    blockDragGhostEl.classList.add('delete-mode');
    draggedLineNode.classList.add('delete-mode');
    if (blockDropIndicator) blockDropIndicator.style.display = 'none';
    hideIdeasDropIndicator();
  } else if (overIdeas) {
    blockDragGhostEl.classList.remove('delete-mode');
    draggedLineNode.classList.remove('delete-mode');
    if (blockDropIndicator) blockDropIndicator.style.display = 'none';
    // Dropping among the ideas has nothing to do with deletion: the red edge
    // zones must not stay visible over the panel.
    hideDeleteZones();
    updateBlockIdeaDropPosition(e.clientX, e.clientY);
  } else {
    blockDragGhostEl.classList.remove('delete-mode');
    draggedLineNode.classList.remove('delete-mode');
    hideIdeasDropIndicator();
    updateDropIndicatorPosition(e.clientY);
  }
}

function updateDropIndicatorPosition(mouseY) {
  if (!blockDropIndicator || !content) return;
  const lines = Array.from(content.children).filter(el => el.classList && el.classList.contains('editor-line'));
  if (lines.length === 0) return;

  targetDropLine = null;
  dropInsertBefore = true;
  let indicatorTop = 0;
  let targetLineRect = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const r = l.getBoundingClientRect();
    const mid = r.top + r.height / 2;

    if (mouseY < mid) {
      targetDropLine = l;
      dropInsertBefore = true;
      indicatorTop = r.top - 2;
      targetLineRect = r;
      break;
    } else {
      targetDropLine = l;
      dropInsertBefore = false;
      indicatorTop = r.bottom - 1;
      targetLineRect = r;
    }
  }

  if (targetLineRect) {
    const wrapRect = editorWrap.getBoundingClientRect();
    const containerRect = editorContainer.getBoundingClientRect();

    blockDropIndicator.style.top = (indicatorTop - wrapRect.top + editorWrap.scrollTop) + 'px';
    blockDropIndicator.style.left = (containerRect.left - wrapRect.left + editorWrap.scrollLeft) + 'px';
    blockDropIndicator.style.width = containerRect.width + 'px';
    blockDropIndicator.style.display = 'block';
  }
}

function runAutoScrollLoop() {
  if (!isDraggingBlock || autoScrollSpeed === 0) {
    autoScrollAnimFrame = null;
    return;
  }

  editorWrap.scrollTop += autoScrollSpeed;
  if (lastDragEvent) {
    updateDropIndicatorPosition(lastDragEvent.clientY);
  }

  autoScrollAnimFrame = requestAnimationFrame(runAutoScrollLoop);
}

// Marks a line for deletion with a 5s grace period — clicking it during that
// window cancels the delete. Used by drag-to-edge deletion.
// After a block is actually removed, leave the editor in a neutral state
// instead of letting the browser drop the caret into whatever block now sits
// where the deleted one was — no stray cursor, no handles floating over a
// block the user didn't ask to edit.
function clearEditorFocusAfterDelete() {
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  updateBlockAddPosition();
  updateBlockDragPosition();
  hideBlockTrashBtnNow();
}

function softDeleteLine(nodeToDelete) {
  nodeToDelete.classList.add('pending-delete');

  const timeoutId = setTimeout(() => {
    if (nodeToDelete.parentNode) {
      saveHistory(state.activeDocId, true);
      nodeToDelete.remove();
      if (activeLineNode === nodeToDelete) {
        activeLineNode = null;
        clearEditorFocusAfterDelete();
      }
      markDirty();
      updateStats();
      debouncedRegenerateTOC();
      saveHistory(state.activeDocId, true);
    }
  }, 5000);

  const cancelDelete = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    clearTimeout(timeoutId);
    nodeToDelete.classList.remove('pending-delete');
    nodeToDelete.removeEventListener('mousedown', cancelDelete);
  };
  nodeToDelete.addEventListener('mousedown', cancelDelete);

  // Update stats and TOC without the node (it's hidden from getContentMarkdown)
  markDirty();
  updateStats();
  debouncedRegenerateTOC();
}

// True instant delete, no grace period — used by the floating trash button
// next to the drag handle.
function deleteLineImmediately(line) {
  if (!line || !line.parentNode) return;
  saveHistory(state.activeDocId, true);
  line.remove();
  if (activeLineNode === line) {
    activeLineNode = null;
    clearEditorFocusAfterDelete();
  }
  markDirty();
  updateStats();
  debouncedRegenerateTOC();
  saveHistory(state.activeDocId, true);
}

function onBlockDragEnd(e) {
  if (!isDraggingBlock) return;

  window.removeEventListener('mousemove', onBlockDragMove);
  window.removeEventListener('mouseup', onBlockDragEnd);

  if (autoScrollAnimFrame) {
    cancelAnimationFrame(autoScrollAnimFrame);
    autoScrollAnimFrame = null;
  }
  autoScrollSpeed = 0;

  if (blockDragGhostEl) {
    blockDragGhostEl.remove();
    blockDragGhostEl = null;
  }

  if (blockDropIndicator) {
    blockDropIndicator.style.display = 'none';
  }
  hideDeleteZones();

  if (blockDragBtn) {
    blockDragBtn.classList.remove('dragging');
  }

  if (draggedLineNode) {
    draggedLineNode.classList.remove('dragging-line');

    // Dropping a block onto the ideas panel adds its text as an idea instead
    // of deleting or moving it. The cleanup below still runs so the gutter
    // and drag handle come back to life after the drop.
    if (isOverIdeasPanel(e.clientX, e.clientY)) {
      const text = (draggedLineNode.textContent || '').trim();
      draggedLineNode.classList.remove('delete-mode');
      hideIdeasDropIndicator();
      // The ideas panel starts right at the editor's right edge, where the red
      // delete zone sits. Aiming at that zone, a release a few px into the
      // panel is still a delete attempt, not an idea add.
      const dropRect = editorWrap.getBoundingClientRect();
      const overshotDelete = text &&
        e.clientY >= dropRect.top && e.clientY <= dropRect.bottom &&
        e.clientX >= dropRect.right - DELETE_ZONE_PX && e.clientX <= dropRect.right + 14;
      if (overshotDelete) {
        softDeleteLine(draggedLineNode);
      } else if (text) {
        if (blockIdeaDrop && blockIdeaDrop.themeId && blockIdeaDrop.beforeText) {
          addBlockTextToIdeasAt(text, blockIdeaDrop.themeId, blockIdeaDrop.beforeText, blockIdeaDrop.after);
        } else {
          addBlockTextToIdeas(text);
        }
      }
    } else {
      const isDeleteZone = !!getDeleteEdge(e.clientX, editorWrap.getBoundingClientRect());

      if (isDeleteZone) {
        draggedLineNode.classList.remove('delete-mode');
        softDeleteLine(draggedLineNode);
      } else if (targetDropLine && targetDropLine !== draggedLineNode) {
        saveHistory(state.activeDocId, true);

        if (dropInsertBefore) {
          content.insertBefore(draggedLineNode, targetDropLine);
        } else {
          content.insertBefore(draggedLineNode, targetDropLine.nextSibling);
        }

        makeLineRawAndActive(draggedLineNode);
        markDirty();
        updateStats();
        saveHistory(state.activeDocId, true);
        debouncedRegenerateTOC();
      }
    }
  }

  isDraggingBlock = false;
  draggedLineNode = null;
  targetDropLine = null;
  lastDragEvent = null;
  dragStartX = null;
  blockIdeaDrop = null;
  if (ideasPanel) ideasPanel.classList.remove('block-dragging');

  updateBlockAddPosition();
  updateBlockDragPosition();
}

if (blockDragBtn) {
  blockDragBtn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left button only — a right-click here must not start a drag
    e.preventDefault();
    e.stopPropagation();
    const target = getBlockHandleTarget();
    if (target) {
      startBlockDrag(target, e);
    }
  });
}

if (blockAddBtn) {
  blockAddBtn.addEventListener('mousedown', (e) => e.preventDefault());
  blockAddBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (blockMenu.classList.contains('visible')) {
      closeBlockMenu();
      return;
    }
    const r = blockAddBtn.getBoundingClientRect();
    blockMenu.classList.add('visible');
    blockAddBtn.classList.add('active');
    // Position menu just below-right of the button; flip up if it would go off-screen
    const mr = blockMenu.getBoundingClientRect();
    let top = r.bottom + 6;
    let left = r.left;
    if (top + mr.height > window.innerHeight - 10) {
      top = Math.max(10, r.top - mr.height - 6);
    }
    if (left + mr.width > window.innerWidth - 10) {
      left = window.innerWidth - mr.width - 10;
    }
    blockMenu.style.top = top + 'px';
    blockMenu.style.left = left + 'px';
  });
}

// ============ FLOATING QUICK-DELETE (hover the drag handle ~1s) ============
// A separate button next to the drag handle — never replaces its icon.
// Deletes instantly, no grace period (unlike drag-to-edge / softDeleteLine).

let blockTrashRevealTimer = null;
let blockTrashHideTimer = null;

function positionBlockTrashBtn() {
  if (!blockTrashBtn || !blockDragBtn) return;
  const r = blockDragBtn.getBoundingClientRect();
  blockTrashBtn.style.top = r.top + 'px';
  blockTrashBtn.style.left = (r.left - 26) + 'px';
}

function showBlockTrashBtn() {
  if (!blockTrashBtn || !activeLineNode || isDraggingBlock) return;
  positionBlockTrashBtn();
  blockTrashBtn.classList.add('visible');
}

function hideBlockTrashBtnNow() {
  clearTimeout(blockTrashRevealTimer);
  blockTrashRevealTimer = null;
  if (blockTrashBtn) blockTrashBtn.classList.remove('visible');
}

function scheduleHideBlockTrashBtn() {
  clearTimeout(blockTrashHideTimer);
  blockTrashHideTimer = setTimeout(hideBlockTrashBtnNow, 650);
}

function cancelHideBlockTrashBtn() {
  clearTimeout(blockTrashHideTimer);
}

if (blockDragBtn && blockTrashBtn) {
  blockDragBtn.addEventListener('mouseenter', () => {
    if (isDraggingBlock) return;
    cancelHideBlockTrashBtn();
    clearTimeout(blockTrashRevealTimer);
    blockTrashRevealTimer = setTimeout(showBlockTrashBtn, 1000);
  });
  blockDragBtn.addEventListener('mouseleave', () => {
    clearTimeout(blockTrashRevealTimer);
    scheduleHideBlockTrashBtn();
  });
  // Bridge the hover across the small gap between the two buttons.
  blockTrashBtn.addEventListener('mouseenter', cancelHideBlockTrashBtn);
  blockTrashBtn.addEventListener('mouseleave', scheduleHideBlockTrashBtn);

  blockTrashBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  blockTrashBtn.addEventListener('click', (e) => {
    e.preventDefault();
    hideBlockTrashBtnNow();
    if (activeLineNode) deleteLineImmediately(activeLineNode);
  });
}

function closeBlockMenu() {
  if (!blockMenu) return;
  blockMenu.classList.remove('visible');
  if (blockAddBtn) blockAddBtn.classList.remove('active');
}

if (blockMenu) {
  blockMenu.addEventListener('mousedown', (e) => e.preventDefault());
  blockMenu.querySelectorAll('.block-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const kind = item.dataset.block;
      applyBlockChoice(kind);
      closeBlockMenu();
    });
  });
}

// Close the menu on outside click / Escape
document.addEventListener('click', (e) => {
  if (!blockMenu || !blockAddBtn) return;
  if (e.target.closest('#blockMenu') || e.target.closest('#blockAddBtn')) return;
  closeBlockMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && blockMenu && blockMenu.classList.contains('visible')) {
    closeBlockMenu();
  }
});

// ============ MULTI-BLOCK SELECTION (Ctrl+clic) ============
// Ctrl+clic toggles blocks in/out of the selection; a floating toolbar offers
// "Fusionner" (merge into one block, keeping every sub-line's markdown intact)
// and "Supprimer".

const multiSelToolbar = $('multiSelToolbar');
let multiSelectedLines = new Set();

function clearMultiSelection() {
  multiSelectedLines.forEach(l => l.classList && l.classList.remove('multi-selected'));
  multiSelectedLines.clear();
  updateMultiSelToolbar();
}

function updateMultiSelToolbar() {
  if (!multiSelToolbar) return;
  multiSelectedLines.forEach(l => { if (!content.contains(l)) multiSelectedLines.delete(l); });
  const n = multiSelectedLines.size;
  if (!n) { multiSelToolbar.classList.remove('visible'); return; }

  const countEl = $('multiSelCount');
  if (countEl) countEl.textContent = n > 1 ? __('multi.block_count_plural', { count: n }) : __('multi.block_count', { count: n });
  const mergeBtn = $('multiMergeBtn');
  if (mergeBtn) mergeBtn.disabled = n < 2;
  multiSelToolbar.classList.add('visible');

  // Centre the toolbar above the selection's bounding box, clamped to the viewport
  let top = Infinity, left = Infinity, right = -Infinity;
  multiSelectedLines.forEach(l => {
    const r = l.getBoundingClientRect();
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  });
  const tbRect = multiSelToolbar.getBoundingClientRect();
  const wrapRect = editorWrap.getBoundingClientRect();
  let t = top - tbRect.height - 10;
  if (t < wrapRect.top + 8) t = wrapRect.top + 8;
  let x = (left + right) / 2 - tbRect.width / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - tbRect.width - 8));
  multiSelToolbar.style.top = t + 'px';
  multiSelToolbar.style.left = x + 'px';
}

content.addEventListener('mousedown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (readingModeState) return;
  const line = e.target.closest ? e.target.closest('.editor-line') : null;
  if (!line || !content.contains(line)) return;
  e.preventDefault(); // keep the caret where it is
  if (multiSelectedLines.has(line)) {
    multiSelectedLines.delete(line);
    line.classList.remove('multi-selected');
  } else {
    multiSelectedLines.add(line);
    line.classList.add('multi-selected');
  }
  updateMultiSelToolbar();
});

// Any plain interaction outside the toolbar drops the selection
document.addEventListener('mousedown', (e) => {
  if (!multiSelectedLines.size) return;
  if (e.ctrlKey || e.metaKey) return;
  if (e.target.closest && e.target.closest('#multiSelToolbar')) return;
  clearMultiSelection();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && multiSelectedLines.size) clearMultiSelection();
});
editorWrap.addEventListener('scroll', () => {
  if (multiSelectedLines.size) updateMultiSelToolbar();
});

function deleteSelectedBlocks() {
  if (!multiSelectedLines.size) return;
  saveHistory(state.activeDocId, true);
  multiSelectedLines.forEach(line => {
    if (line === activeLineNode) activeLineNode = null;
    if (content.contains(line)) line.remove();
  });
  clearMultiSelection();
  // Keep at least one line so the editor stays usable
  if (!content.querySelector('.editor-line')) {
    const div = document.createElement('div');
    div.className = 'editor-line';
    div.dataset.raw = '';
    div.innerHTML = '<br>';
    content.appendChild(div);
  }
  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();
  debouncedPostProcess();
}

function mergeSelectedBlocks() {
  if (multiSelectedLines.size < 2) return;
  // Document order, not click order
  const lines = getEditorLines().filter(l => multiSelectedLines.has(l));
  if (lines.length < 2) return;
  saveHistory(state.activeDocId, true);

  const rawOf = (l) => {
    if (l === activeLineNode) return l.textContent;
    return (l.dataset.raw !== undefined) ? l.dataset.raw : l.textContent;
  };
  const merged = lines.map(rawOf).join('\n');

  const first = lines[0];
  if (multiSelectedLines.has(activeLineNode)) activeLineNode = null;
  delete first.dataset.gutterCreated;
  delete first.dataset.rawOnActivate;
  first.dataset.raw = merged;
  applyLineKind(first, merged);
  first.classList.remove('active-line');
  first.innerHTML = renderMarkdownLine(merged);
  lines.slice(1).forEach(l => l.remove());

  clearMultiSelection();
  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();
  debouncedPostProcess();
}

if (multiSelToolbar) {
  multiSelToolbar.addEventListener('mousedown', (e) => e.preventDefault());
  $('multiDeleteBtn')?.addEventListener('click', deleteSelectedBlocks);
  $('multiMergeBtn')?.addEventListener('click', mergeSelectedBlocks);
}

function applyBlockChoice(kind) {
  if (!activeLineNode) return;
  // For "code", insert ```fences around the active line as new lines.
  if (kind === 'code') {
    saveHistory(state.activeDocId, true);
    const before = makeLineNode('```');
    const after  = makeLineNode('```');
    activeLineNode.parentNode.insertBefore(before, activeLineNode);
    activeLineNode.parentNode.insertBefore(after, activeLineNode.nextSibling);
    markDirty();
    updateStats();
    saveHistory(state.activeDocId, true);
    debouncedRegenerateTOC();
    return;
  }
  if (kind === 'hr') {
    saveHistory(state.activeDocId, true);
    if (activeLineNode.textContent.trim() === '') {
      activeLineNode.textContent = '---';
      activeLineNode.dataset.raw = '---';
      applyLineKind(activeLineNode, '---');
      showToast('toast.blocks_deleted');
      showToast('toast.blocks_merged');
    } else {
      const hr = makeLineNode('---');
      activeLineNode.parentNode.insertBefore(hr, activeLineNode.nextSibling);
    }
    markDirty();
    updateStats();
    saveHistory(state.activeDocId, true);
    return;
  }
  // For "image", format as markdown image
  if (kind === 'image') {
    saveHistory(state.activeDocId, true);
    const text = activeLineNode.textContent.trim();
    const newText = `![${text || 'description'}](url_de_l_image)`;
    activeLineNode.textContent = newText;
    activeLineNode.dataset.raw = newText;
    applyLineKind(activeLineNode, newText);
    
    // Position caret at 'url_de_l_image' so user can easily replace it
    setCaretInLine(activeLineNode, newText.indexOf('url_de_l_image') + 'url_de_l_image'.length);
    markDirty();
    updateStats();
    saveHistory(state.activeDocId, true);
    return;
  }
  // All other kinds: transform the current line (replacing its block prefix).
  setLineBlockType(kind);
}

function makeLineNode(raw) {
  const div = document.createElement('div');
  div.className = 'editor-line';
  div.dataset.raw = raw;
  applyLineKind(div, raw);
  div.innerHTML = raw.trim() === '' ? '<br>' : renderMarkdownLine(raw);
  return div;
}

// ============ PASTE ============
// The editor's invariant is "one .editor-line div = one markdown line, source
// in dataset.raw". A native paste breaks it in both directions: multi-line text
// lands as nested nodes inside a single line (so "a\nb\nc" reads back as "abc"),
// and rich text injects HTML that dataset.raw never learns about — meaning the
// paste is silently dropped on the next save. So we do the insertion ourselves.

function insertMarkdownAtCaret(text) {
  const clean = String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (!clean) return;

  saveHistory(state.activeDocId, true);

  const sel = window.getSelection();
  let range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;

  // Replace the selection first, so pasting over text behaves as expected.
  if (range && !range.collapsed && content.contains(range.commonAncestorContainer)) {
    deleteRangeAcrossLines(range);
    range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  }

  let line = range ? getLineForNode(range.startContainer) : null;
  if (!line) line = activeLineNode;
  if (!line) {
    line = content.lastElementChild;
    if (!line) {
      line = makeLineNode('');
      content.appendChild(line);
    }
    range = null;
  }

  // Offsets must be read before makeLineRawAndActive() swaps the line's DOM.
  let rawOffset;
  if (range && line.contains(range.startContainer)) {
    rawOffset = renderedToRawOffset(line, rangeOffsetIn(line, range.startContainer, range.startOffset));
  } else {
    rawOffset = ((line.dataset.raw !== undefined) ? line.dataset.raw : line.textContent).length;
  }

  if (line !== activeLineNode) makeLineRawAndActive(line);
  const raw = line.textContent;
  const before = raw.slice(0, rawOffset);
  const after = raw.slice(rawOffset);

  const parts = clean.split('\n');

  if (parts.length === 1) {
    const newRaw = before + parts[0] + after;
    line.textContent = newRaw;
    line.dataset.raw = newRaw;
    applyLineKind(line, newRaw);
    setCaretInLine(line, before.length + parts[0].length);
  } else {
    // First line keeps what was before the caret, last line inherits what followed.
    const firstRaw = before + parts[0];
    const lastRaw = parts[parts.length - 1] + after;

    line.textContent = firstRaw;
    line.dataset.raw = firstRaw;
    applyLineKind(line, firstRaw);
    line.innerHTML = firstRaw.trim() === '' ? '<br>' : renderMarkdownLine(firstRaw);
    line.classList.remove('active-line');

    let ref = line;
    for (let i = 1; i < parts.length - 1; i++) {
      const node = makeLineNode(parts[i]);
      ref.after(node);
      ref = node;
    }
    const lastNode = makeLineNode(lastRaw);
    ref.after(lastNode);

    // `line` is already committed to its rendered form above, so clear the
    // pointer to stop makeLineRawAndActive from committing it a second time.
    activeLineNode = null;
    makeLineRawAndActive(lastNode);
    setCaretInLine(lastNode, parts[parts.length - 1].length);
  }

  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();
  debouncedPostProcess();
}

content.addEventListener('paste', (e) => {
  const cd = e.clipboardData || window.clipboardData;
  if (!cd) return;
  // If the clipboard holds an image (screenshot, copied picture), save it into
  // the workspace assets folder and insert its markdown reference.
  const imgItem = Array.from(cd.items || []).find(it => it.type && it.type.indexOf('image/') === 0);
  if (imgItem) {
    e.preventDefault();
    const file = imgItem.getAsFile();
    if (file) handlePastedImage(file, 'image');
    return;
  }
  e.preventDefault();
  // Plain text only: pasting from Word or a web page should give the markdown
  // source you can see and edit, not an HTML blob the line model can't hold.
  insertMarkdownAtCaret(cd.getData('text/plain'));
});

// Same reasoning for drag-and-dropped text inside the editor. Image files
// dropped here are saved and inserted as markdown instead.
// Let text and ideas be dropped onto the editor (a drop is only offered when
// a dragover has been allowed).
content.addEventListener('dragover', (e) => {
  const types = e.dataTransfer && e.dataTransfer.types;
  if (types && (types.indexOf('text/plain') !== -1 || draggedIdea)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
  // While dragging an idea, show the same between-blocks insertion line as the
  // block drag, and remember the boundary for the drop.
  if (draggedIdea) {
    const hit = findInsertionBoundary(e.clientY);
    ideaDropHit = hit;
    if (hit) showGutterIndicator(hit);
  } else {
    hideGutterIndicator();
  }
});

content.addEventListener('dragleave', (e) => {
  if (!content.contains(e.relatedTarget)) hideGutterIndicator();
});

content.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  if (!dt) return;
  // An idea dragged from the panel lands as a new block at the shown boundary.
  if (draggedIdea) {
    e.preventDefault();
    e.stopPropagation();
    hideGutterIndicator();
    const draggedText = draggedIdea.text;
    const hit = ideaDropHit;
    draggedIdea = null;
    ideaDropHit = null;
    insertIdeaBlockAtBoundary(draggedText, hit);
    return;
  }
  const imageFiles = Array.from(dt.files || []).filter(f => f.type && f.type.indexOf('image/') === 0);
  if (imageFiles.length) {
    e.preventDefault();
    e.stopPropagation();
    imageFiles.forEach(f => handlePastedImage(f, f.name));
    return;
  }
  if (!dt.types || dt.types.includes('Files')) return;
  const text = dt.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  e.stopPropagation();
  insertMarkdownAtCaret(text);
});

// Reads an image (clipboard or dropped file), uploads it to <workspace>/assets
// and inserts its markdown reference at the caret.
async function handlePastedImage(file, suggestedName) {
  const dataBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.indexOf(',') !== -1 ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
  const ext = extMap[file.type] || 'png';
  const base = String(suggestedName || 'image')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';
  try {
    const res = await fetch('/api/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: `${base}.${ext}`, dataBase64 })
    });
    const data = await res.json();
    if (data.path) {
      insertMarkdownAtCaret(`![${base}](${data.path})`);
      markDirty();
      updateStats();
      showToast('toast.image_added');
    } else {
      showToast('toast.image_save_error');
    }
  } catch (err) {
    console.error('Image save error:', err);
    showToast('toast.image_save_error');
  }
}

// ============ FIND / REPLACE ============
// Operates on each line's raw markdown source (like a plain-text find/replace
// tool) rather than the rendered HTML, so what you type as a replacement is
// exactly what ends up on disk — and matches work the same whether a line is
// currently active (raw) or rendered.

const findReplaceBar = $('findReplaceBar');
const findInput = $('findInput');
const replaceInput = $('replaceInput');
const findCountEl = $('findCount');
const findMatchCaseEl = $('findMatchCase');

let findMatches = [];
let findCurrentIndex = -1;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findGetLineRaw(line) {
  return line === activeLineNode ? line.textContent : (line.dataset.raw !== undefined ? line.dataset.raw : line.textContent);
}

function computeFindMatches() {
  const term = findInput.value;
  if (!term) return [];
  const flags = findMatchCaseEl.checked ? 'g' : 'gi';
  let re;
  try {
    re = new RegExp(escapeRegExp(term), flags);
  } catch (e) {
    return [];
  }
  const matches = [];
  getEditorLines().forEach((line) => {
    const raw = findGetLineRaw(line);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(raw))) {
      matches.push({ line, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex++;
    }
  });
  return matches;
}

// ---- Visual "highlight every match" ----
// Separate from the raw-offset match list above (which drives navigation and
// replace): this searches each line's currently DISPLAYED text — raw for the
// active line, rendered for the rest — so it always highlights exactly what's
// on screen (including matches inside **bold**/*italic*/links) without
// mapping raw <-> rendered offsets.
//
// Implemented by physically wrapping matches in a real <mark> element rather
// than the CSS Custom Highlight API (::highlight()) — that API turned out not
// to paint reliably here, while <mark> is guaranteed to render since it's
// just a normal styled element. The current match is left unmarked; it
// already gets the browser's native text-selection highlight.
function clearFindMarks() {
  // Rebuilding from source (rather than unwrapping the <mark> in place) avoids
  // leftover empty tags — wrapping a match nested inside e.g. <strong> can
  // split that element, leaving an empty <strong></strong> shell behind that
  // a simple unwrap wouldn't clean up.
  const linesToRestore = new Set();
  document.querySelectorAll('mark.find-match-mark').forEach((mark) => {
    const line = mark.closest('.editor-line');
    if (line) linesToRestore.add(line);
  });
  linesToRestore.forEach((line) => {
    const raw = line.dataset.raw !== undefined ? line.dataset.raw : line.textContent;
    line.innerHTML = raw.trim() === '' ? '<br>' : renderMarkdownLine(raw);
  });
}

function computeDisplayMatches() {
  const term = findInput.value;
  if (!term) return [];
  const flags = findMatchCaseEl.checked ? 'g' : 'gi';
  let re;
  try {
    re = new RegExp(escapeRegExp(term), flags);
  } catch (e) {
    return [];
  }
  const matches = [];
  getEditorLines().forEach((line) => {
    const text = line.textContent;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      matches.push({ line, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex++;
    }
  });
  return matches;
}

function rangeForDisplayOffsets(line, start, end) {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let pos = 0, startNode = null, startOffset = 0, endNode = null, endOffset = 0, n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (startNode === null && pos + len >= start) { startNode = n; startOffset = start - pos; }
    if (pos + len >= end) { endNode = n; endOffset = end - pos; break; }
    pos += len;
  }
  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch (e) {
    return null;
  }
}

// The official (raw-based) match list and the display-based one above can
// differ in exact character offsets whenever markdown syntax precedes a match
// on the same line — but they list matches on each line in the same order, so
// we pair them by "nth match on this line" instead of by raw offset.
function applyFindHighlights() {
  clearFindMarks();
  if (findMatches.length === 0) return;

  const currentMatch = findCurrentIndex >= 0 ? findMatches[findCurrentIndex] : null;
  let currentOrdinal = -1;
  if (currentMatch) {
    currentOrdinal = 0;
    for (let i = 0; i < findCurrentIndex; i++) {
      if (findMatches[i].line === currentMatch.line) currentOrdinal++;
    }
  }

  const ordinalByLine = new Map();
  computeDisplayMatches().forEach((m) => {
    const ordinal = ordinalByLine.get(m.line) || 0;
    ordinalByLine.set(m.line, ordinal + 1);
    // The current match also gets marked (not just left to the native
    // selection) — the selection dims to a barely-visible grey the instant
    // focus moves to the find field, which is exactly what selectRangeInLine
    // does right after selecting it, so relying on it alone made the
    // highlight look like it "vanished immediately".
    const isCurrent = !!(currentMatch && m.line === currentMatch.line && ordinal === currentOrdinal);

    const range = rangeForDisplayOffsets(m.line, m.start, m.end);
    if (!range) return;
    // Range.surroundContents() throws whenever the match is nested inside an
    // inline tag (e.g. **bold**) — it's stricter than it looks, rejecting
    // even a range that fully spans one tag's only text node. extractContents
    // + insertNode has no such restriction and handles nesting correctly.
    try {
      const mark = document.createElement('mark');
      mark.className = isCurrent ? 'find-match-mark find-match-current' : 'find-match-mark';
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
      if (isCurrent) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) {
      // Pathological case — still counted/navigable, just not marked.
    }
  });
}

function clearFindHighlights() {
  clearFindMarks();
}

// Scrolls to the match without switching its line into raw/active editing
// mode — a line flipping to show literal markdown syntax (then back to
// rendered) is exactly what made the highlight look like it "vanished
// immediately". Visual highlighting is applyFindHighlights()'s job (<mark>,
// applied right after this runs); this only has to get the line on screen.
function selectRangeInLine(line) {
  line.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (findInput && findReplaceBar && findReplaceBar.classList.contains('visible') && document.activeElement !== replaceInput) {
    findInput.focus({ preventScroll: true });
  }
}

function updateFindCount() {
  if (!findCountEl) return;
  if (!findInput.value) {
    findCountEl.textContent = '0/0';
    findCountEl.classList.remove('no-match');
  } else if (findMatches.length === 0) {
    findCountEl.textContent = '0/0';
    findCountEl.classList.add('no-match');
  } else {
    findCountEl.textContent = `${findCurrentIndex + 1}/${findMatches.length}`;
    findCountEl.classList.remove('no-match');
  }
}

// Re-run the search, trying to keep the same logical match selected (by
// position) rather than always snapping back to the first result.
function refreshFindMatches(preferIndex) {
  const prevMatch = findCurrentIndex >= 0 ? findMatches[findCurrentIndex] : null;
  findMatches = computeFindMatches();

  if (typeof preferIndex === 'number') {
    findCurrentIndex = findMatches.length ? Math.min(preferIndex, findMatches.length - 1) : -1;
  } else if (prevMatch) {
    const sameLineIdx = findMatches.findIndex(m => m.line === prevMatch.line && m.start >= prevMatch.start);
    findCurrentIndex = sameLineIdx !== -1 ? sameLineIdx : (findMatches.length ? 0 : -1);
  } else {
    findCurrentIndex = findMatches.length ? 0 : -1;
  }

  updateFindCount();
  if (findCurrentIndex >= 0) {
    const m = findMatches[findCurrentIndex];
    // Activating the target line commits the *previous* active line back to
    // rendered HTML, rebuilding its text nodes — so highlights must be built
    // AFTER this, or ranges on either line end up pointing at orphaned nodes.
    selectRangeInLine(m.line, m.start, m.end);
  }
  applyFindHighlights();
}

function goToFindMatch(delta) {
  if (findMatches.length === 0) return;
  findCurrentIndex = (findCurrentIndex + delta + findMatches.length) % findMatches.length;
  updateFindCount();
  const m = findMatches[findCurrentIndex];
  selectRangeInLine(m.line, m.start, m.end);
  applyFindHighlights();
}

function commitLineRaw(line, newRaw) {
  if (line === activeLineNode) {
    line.textContent = newRaw;
    line.dataset.raw = newRaw;
    applyLineKind(line, newRaw);
  } else {
    line.dataset.raw = newRaw;
    applyLineKind(line, newRaw);
    line.innerHTML = newRaw.trim() === '' ? '<br>' : renderMarkdownLine(newRaw);
  }
}

function replaceCurrentFindMatch() {
  if (findCurrentIndex < 0 || !findMatches[findCurrentIndex]) return;
  const { line, start, end } = findMatches[findCurrentIndex];
  const replacement = replaceInput.value;
  saveHistory(state.activeDocId, true);

  const raw = findGetLineRaw(line);
  const newRaw = raw.slice(0, start) + replacement + raw.slice(end);
  commitLineRaw(line, newRaw);

  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();

  refreshFindMatches(findCurrentIndex);
}

function replaceAllFindMatches() {
  if (findMatches.length === 0) return;
  const replacement = replaceInput.value;
  const term = findInput.value;
  if (!term) return;

  saveHistory(state.activeDocId, true);

  const flags = findMatchCaseEl.checked ? 'g' : 'gi';
  const re = new RegExp(escapeRegExp(term), flags);
  let count = 0;
  getEditorLines().forEach((line) => {
    const raw = findGetLineRaw(line);
    let replaced = 0;
    const newRaw = raw.replace(re, () => { replaced++; return replacement; });
    if (replaced > 0) {
      count += replaced;
      commitLineRaw(line, newRaw);
    }
  });

  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();

  refreshFindMatches();
  if (findCountEl) {
    const prevText = findCountEl.textContent;
    findCountEl.textContent = `${count} ✓`;
    setTimeout(() => { if (findCurrentIndex >= 0 || findMatches.length) updateFindCount(); else findCountEl.textContent = prevText; }, 1600);
  }
}

function openFindReplaceBar() {
  if (!findReplaceBar) return;
  findReplaceBar.classList.add('visible');
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) {
    findInput.value = sel.toString().split('\n')[0].slice(0, 200);
  }
  findInput.focus();
  findInput.select();
  refreshFindMatches();
}

function closeFindReplaceBar() {
  if (!findReplaceBar) return;
  findReplaceBar.classList.remove('visible');
  findMatches = [];
  findCurrentIndex = -1;
  clearFindHighlights();
}

if ($('findReplaceBtn')) {
  $('findReplaceBtn').addEventListener('click', () => {
    if (findReplaceBar.classList.contains('visible')) closeFindReplaceBar();
    else openFindReplaceBar();
  });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    if (!content.contains(document.activeElement) && document.activeElement !== title && document.activeElement !== subtitle) return;
    e.preventDefault();
    openFindReplaceBar();
  }
});

if (findInput) {
  findInput.addEventListener('input', () => refreshFindMatches());
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation(); // don't let the document-wide "Enter splits the line" handler also fire
      if (e.shiftKey) goToFindMatch(-1); else goToFindMatch(1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFindReplaceBar();
      content.focus();
    }
  });
}
if (replaceInput) {
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); replaceCurrentFindMatch(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFindReplaceBar(); content.focus(); }
  });
}
if (findMatchCaseEl) findMatchCaseEl.addEventListener('change', () => refreshFindMatches());
if ($('findPrevBtn')) $('findPrevBtn').addEventListener('click', () => goToFindMatch(-1));
if ($('findNextBtn')) $('findNextBtn').addEventListener('click', () => goToFindMatch(1));
if ($('findCloseBtn')) $('findCloseBtn').addEventListener('click', () => { closeFindReplaceBar(); content.focus(); });
if ($('replaceOneBtn')) $('replaceOneBtn').addEventListener('click', replaceCurrentFindMatch);
if ($('replaceAllBtn')) $('replaceAllBtn').addEventListener('click', replaceAllFindMatches);

// ============ PRO WRITER TOOLS: JUSTIFY, SPELLCHECK, TYPEWRITER, LINE FOCUS, EXPORT, SNAPSHOTS ============

let textJustifyState = localStorage.getItem('scriptoriumTextJustify') === 'true';
let spellcheckState = localStorage.getItem('scriptoriumSpellcheck') !== 'false';
let typewriterState = localStorage.getItem('scriptoriumTypewriter') === 'true';
let focusLineState = localStorage.getItem('scriptoriumFocusLine') === 'true';
let fullWidthState = localStorage.getItem('scriptoriumFullWidth') === 'true';
let readingModeState = parseInt(localStorage.getItem('scriptoriumReading')) || 0;
// 0 = off, 1 = reading, 2 = reading-typewriter
let autoScrollState = 0; // 0=off, 1=slow, 2=medium, 3=normal
let autoScrollTimerId = null;
let autoScrollPaused = false;
var AUTO_SCROLL_TICK_MS = 40;    // ~25 fps, smooth enough
var AUTO_SCROLL_RATES = [0, 0.6, 1.8, 3.6]; // px per tick (0.6*25=15px/s, 1.8*25=45px/s, 3.6*25=90px/s)
let activeDiffSnapshot = null;

function applyTextJustify(enable) {
  textJustifyState = enable;
  document.documentElement.classList.toggle('text-justified', enable);
  const btn = $('justifyBtn');
  if (btn) btn.classList.toggle('active', enable);
  localStorage.setItem('scriptoriumTextJustify', enable ? 'true' : 'false');
  showToast('toast.text_justified');
}

function applyFullWidth(enable) {
  fullWidthState = enable;
  document.documentElement.classList.toggle('full-line-length', enable);
  const btn = $('lineLengthBtn');
  if (btn) btn.classList.toggle('active', enable);
  localStorage.setItem('scriptoriumFullWidth', enable ? 'true' : 'false');
  showToast(enable ? 'toast.line_length_on' : 'toast.line_length_off');
}

function applySpellcheck(enable) {
  spellcheckState = enable;
  showToast('toast.spellcheck_toggled', { state: enable ? __('toast.state_on') : __('toast.state_off') });
  const attr = enable ? 'true' : 'false';
  
  if (content) {
    content.setAttribute('spellcheck', attr);
    content.setAttribute('lang', getLocale() === 'fr' ? 'fr' : 'en');
  }
  if (title) {
    title.setAttribute('spellcheck', attr);
    title.setAttribute('lang', getLocale() === 'fr' ? 'fr' : 'en');
  }
  if (subtitle) {
    subtitle.setAttribute('spellcheck', attr);
    subtitle.setAttribute('lang', getLocale() === 'fr' ? 'fr' : 'en');
  }

  const btn = $('spellcheckBtn');
  if (btn) btn.classList.toggle('active', enable);
  localStorage.setItem('scriptoriumSpellcheck', enable ? 'true' : 'false');
}

function centerActiveLine(smooth = true) {
  if (!typewriterState || !activeLineNode || !editorWrap) return;
  const lineRect = activeLineNode.getBoundingClientRect();
  const wrapRect = editorWrap.getBoundingClientRect();
  const targetY = wrapRect.top + (wrapRect.height / 2);
  const lineCenterY = lineRect.top + (lineRect.height / 2);
  const diff = lineCenterY - targetY;
  
  if (Math.abs(diff) > 4) {
    editorWrap.scrollBy({
      top: diff,
      behavior: smooth ? 'smooth' : 'auto'
    });
  }
}

function applyTypewriterMode(enable) {
  typewriterState = enable;
  document.documentElement.classList.toggle('typewriter-on', enable);
  const btn = $('typewriterToggle');
  if (btn) btn.classList.toggle('active', enable);
  localStorage.setItem('scriptoriumTypewriter', enable ? 'true' : 'false');
  if (enable) centerActiveLine(true);
  showToast(enable ? 'toast.typewriter_on' : 'toast.typewriter_off');
}

function applyFocusLineMode(enable) {
  focusLineState = enable;
  document.documentElement.classList.toggle('focus-line-on', enable);
  const btn = $('focusLineBtn');
  if (btn) btn.classList.toggle('active', enable);
  localStorage.setItem('scriptoriumFocusLine', enable ? 'true' : 'false');
  showToast(enable ? 'toast.focus_line_on' : 'toast.focus_line_off');
}

function applyReadingMode(mode) {
  readingModeState = mode;
  var isReading = mode >= 1;
  var isTypewriter = mode === 2;

  document.documentElement.classList.toggle('reading-on', isReading);
  document.documentElement.classList.toggle('reading-typewriter-on', isTypewriter);

  var btn = $('readingToggle');
  if (btn) {
    btn.classList.toggle('active', isReading);
    btn.classList.toggle('reading-typewriter', isTypewriter);
  }

  localStorage.setItem('scriptoriumReading', String(mode));

  if (mode === 0) showToast('toast.reading_off');
  else if (mode === 1) showToast('toast.reading_on');
  else showToast('toast.reading_typewriter_on');

  // Update tooltip to reflect current mode
  if (btn) {
    var tooltipKey = mode === 2 ? 'topbar.reading_typewriter_title' : 'topbar.reading_title';
    btn.setAttribute('data-i18n-title', tooltipKey);
    btn.title = __(tooltipKey);
  }

  if (content) content.setAttribute('contenteditable', isReading ? 'false' : 'true');

  if (isReading) {
    // Flush the raw active line back to rendered markdown so the text reads clean
    hideGutterIndicator();
    setHoveredLine(null);
    hideSelectionToolbar();
    if (activeLineNode && !removeAbandonedEmptyLine(activeLineNode) && content.contains(activeLineNode)) {
      var raw = activeLineNode.textContent;
      activeLineNode.dataset.raw = raw;
      applyLineKind(activeLineNode, raw);
      activeLineNode.innerHTML = raw.trim() === '' ? '<br>' : renderMarkdownLine(raw);
      activeLineNode.classList.remove('active-line');
    }
    activeLineNode = null;
    var sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }

  // Stop auto-scroll when leaving reading mode entirely
  if (mode === 0) {
    stopAutoScroll();
    autoScrollState = 0;
    autoScrollPaused = false;
    var asBtn = $('autoScrollBtn');
    if (asBtn) {
      asBtn.classList.remove('active', 'speed-1', 'speed-2', 'speed-3');
      asBtn.setAttribute('data-i18n-title', 'statusbar.autoscroll_title');
      asBtn.title = __('statusbar.autoscroll_title');
    }
  }
}

// ============ AUTO-SCROLL (reading mode only) ============

// Cycles the auto-scroll speed, matching the button: 0, slow, faster, normal, stop.
function cycleAutoScroll() {
  if (autoScrollPaused && autoScrollState > 0) {
    startAutoScroll(autoScrollState);
    showToast('toast.autoscroll_speed' + autoScrollState);
  } else {
    applyAutoScroll((autoScrollState + 1) % 4);
  }
}

function applyAutoScroll(speed) {
  autoScrollState = speed;
  var btn = $('autoScrollBtn');
  if (btn) {
    btn.classList.toggle('active', speed > 0);
    btn.classList.remove('speed-1', 'speed-2', 'speed-3');
    if (speed > 0) btn.classList.add('speed-' + speed);
    // Update tooltip
    var key = speed === 0 ? 'statusbar.autoscroll_title'
      : 'statusbar.autoscroll_speed' + speed + '_title';
    btn.setAttribute('data-i18n-title', key);
    btn.title = __(key);
  }

  if (speed === 0) {
    stopAutoScroll();
    showToast('toast.autoscroll_off');
  } else {
    startAutoScroll(speed);
    var toastKey = 'toast.autoscroll_speed' + speed;
    showToast(toastKey);
  }
}

function startAutoScroll(speed) {
  stopAutoScroll();
  if (!editorWrap || speed === 0) return;
  autoScrollState = speed;
  autoScrollPaused = false;
  autoScrollTimerId = setInterval(autoScrollTick, AUTO_SCROLL_TICK_MS);
}

function autoScrollTick() {
  if (autoScrollPaused || autoScrollState === 0 || !readingModeState) {
    stopAutoScroll();
    return;
  }

  var maxScroll = editorWrap.scrollHeight - editorWrap.clientHeight;
  if (maxScroll <= 0) return; // content fits viewport, nothing to scroll
  if (editorWrap.scrollTop >= maxScroll - 1) {
    // Reached bottom, stop and reset state
    stopAutoScroll();
    applyAutoScroll(0);
    return;
  }

  editorWrap.scrollTop += AUTO_SCROLL_RATES[autoScrollState];
}

function stopAutoScroll() {
  if (autoScrollTimerId) {
    clearInterval(autoScrollTimerId);
    autoScrollTimerId = null;
  }
}

function onUserScroll() {
  if (autoScrollState > 0 && !autoScrollPaused) {
    autoScrollPaused = true;
    showToast('toast.autoscroll_paused');
  }
}

// Bulk-remove every strictly empty line. Lines holding anything — even a lone
// space (deliberate spacer) — are kept, as are blank lines inside code blocks.
function removeAllEmptyLines() {
  if (!content) return;
  const lines = Array.from(content.children).filter(el => el.classList && el.classList.contains('editor-line'));
  const toRemove = lines.filter(line => {
    if (line.classList.contains('in-code') || line.classList.contains('is-code-fence')) return false;
    const raw = (line === activeLineNode)
      ? line.textContent
      : (line.dataset.raw !== undefined ? line.dataset.raw : line.textContent);
    return raw === '';
  });
  if (!toRemove.length) {
    showToast('toast.no_empty_lines');
    return;
  }

  saveHistory(state.activeDocId, true);
  toRemove.forEach(line => {
    if (line === activeLineNode) activeLineNode = null;
    line.remove();
  });
  // Keep at least one line so the editor stays usable
  if (!content.querySelector('.editor-line')) {
    const div = document.createElement('div');
    div.className = 'editor-line';
    div.dataset.raw = '';
    div.innerHTML = '<br>';
    content.appendChild(div);
  }
  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();
  debouncedPostProcess();
  showToast('toast.empty_lines_removed');
}

// Export Dropdown
const exportMenu = $('exportMenu');
function closeExportMenu() {
  if (exportMenu) exportMenu.classList.remove('visible');
}
function openExportMenu() {
  if (!exportMenu || !$('exportBtn')) return;
  const rect = $('exportBtn').getBoundingClientRect();
  exportMenu.style.top = (rect.bottom + 6) + 'px';
  exportMenu.style.left = Math.min(window.innerWidth - 230, rect.left - 180) + 'px';
  exportMenu.classList.toggle('visible');
}

function exportPdf() {
  closeExportMenu();
  window.print();
}

function exportHtml() {
  closeExportMenu();
  const doc = activeDoc();
  const docTitle = title ? title.value : (doc ? doc.title : 'Document');
  const docSubtitle = subtitle ? subtitle.value : '';
  const htmlContent = content ? content.innerHTML : '';
  
  const fullHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(docTitle)}</title>
<style>
  body { font-family: 'Newsreader', Georgia, serif; max-width: 750px; margin: 40px auto; padding: 0 20px; color: #111; line-height: 1.7; background: #faf8f5; }
  h1.doc-title { font-size: 32px; font-weight: normal; margin-bottom: 6px; }
  p.doc-subtitle { font-size: 16px; font-style: italic; color: #666; margin-bottom: 40px; }
  h1 { font-size: 26px; margin-top: 1.5em; } h2 { font-size: 22px; margin-top: 1.2em; } h3 { font-size: 18px; }
  blockquote { border-left: 2px solid #c9a96a; padding-left: 16px; margin: 20px 0; color: #555; font-style: italic; }
  code { font-family: monospace; background: #eee; padding: 2px 4px; border-radius: 3px; }
  a { color: #2b789e; text-decoration: none; }
</style>
</head>
<body>
<h1 class="doc-title">${escapeHtml(docTitle)}</h1>
${docSubtitle ? `<p class="doc-subtitle">${escapeHtml(docSubtitle)}</p>` : ''}
<div class="content">${htmlContent}</div>
</body>
</html>`;

  const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(docTitle || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportMarkdown() {
  closeExportMenu();
  const doc = activeDoc();
  const docTitle = title ? title.value : (doc ? doc.title : 'Document');
  const mdText = getContentMarkdown();
  
  const blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(docTitle || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// Snapshots & Diff Management — persisted on disk via the server
// (<workspace>/.snapshots/), with localStorage as fallback when the running
// server predates the /api/snapshots route.
let snapshotsCache = {}; // docId -> list

function getSnapshots(docId) {
  if (!docId) return [];
  if (snapshotsCache[docId]) return snapshotsCache[docId];
  try {
    const raw = localStorage.getItem(`scriptoriumSnapshots_${docId}`);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return [];
}

function saveSnapshots(docId, list) {
  if (!docId) return;
  snapshotsCache[docId] = list;
  fetch('/api/snapshots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId, snapshots: list })
  }).then(res => {
    if (!res.ok) throw new Error('server refused');
    // Disk write confirmed: the localStorage copy is now redundant
    try { localStorage.removeItem(`scriptoriumSnapshots_${docId}`); } catch (e) {}
  }).catch(() => {
    try { localStorage.setItem(`scriptoriumSnapshots_${docId}`, JSON.stringify(list)); } catch (e) {}
  });
}

// Refresh the cache from disk; merges in (and migrates) any snapshots still
// sitting in localStorage from before disk persistence existed.
async function loadSnapshotsForDoc(docId) {
  if (!docId) return;
  try {
    const res = await fetch(`/api/snapshots?docId=${encodeURIComponent(docId)}`);
    if (!res.ok) throw new Error('server refused');
    const data = await res.json();
    let list = Array.isArray(data.snapshots) ? data.snapshots : [];

    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem(`scriptoriumSnapshots_${docId}`) || 'null'); } catch (e) {}
    if (Array.isArray(legacy) && legacy.length) {
      const known = new Set(list.map(s => s.id));
      list = list.concat(legacy.filter(s => !known.has(s.id)));
      list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      saveSnapshots(docId, list); // pushes the merged list to disk
    } else {
      snapshotsCache[docId] = list;
    }
  } catch (e) {
    // Old server without the route: getSnapshots falls back to localStorage
  }
  renderSnapshotsList();
}

async function createSnapshot() {
  if (!state.activeDocId) return;
  // "Révision du 13:54" announced a date and gave a time. The label has to
  // stand on its own: it survives a swap, which moves the entry's timestamp.
  const now = new Date();
  var dateStr = now.toLocaleDateString(getLocale() === 'fr' ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'long' });
  var defaultName = __('prompt.default_snapshot_name', { date: dateStr, time: clockTime(now.getTime()) });
  var name = await themedPrompt(__('prompt.snapshot_name'), defaultName);
  if (!name) return;

  const docTitle = title ? title.value : '';
  const docSubtitle = subtitle ? subtitle.value : '';
  const mdContent = getContentMarkdown();

  const list = getSnapshots(state.activeDocId);
  list.unshift({
    id: 'snap_' + Date.now(),
    name,
    timestamp: Date.now(),
    title: docTitle,
    subtitle: docSubtitle,
    markdown: mdContent
  });

  saveSnapshots(state.activeDocId, list);
  renderSnapshotsList();
  showToast('toast.snapshot_created');
}

function deleteSnapshot(snapId) {
  if (!state.activeDocId) return;
  let list = getSnapshots(state.activeDocId);
  list = list.filter(s => s.id !== snapId);
  saveSnapshots(state.activeDocId, list);
  renderSnapshotsList();
  showToast('toast.snapshot_deleted');
}

function diffStrings(oldStr, newStr) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  let result = '';

  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result += escapeHtml(newLines[j]) + '\n';
      i++;
      j++;
    } else if (j < newLines.length && (!oldLines.slice(i).includes(newLines[j]))) {
      result += `<span class="diff-add">+ ${escapeHtml(newLines[j])}</span>\n`;
      j++;
    } else if (i < oldLines.length) {
      result += `<span class="diff-del">- ${escapeHtml(oldLines[i])}</span>\n`;
      i++;
    } else {
      result += `<span class="diff-add">+ ${escapeHtml(newLines[j])}</span>\n`;
      j++;
    }
  }
  return result;
}

function openDiffModal(snapId) {
  const list = getSnapshots(state.activeDocId);
  const snap = list.find(s => s.id === snapId);
  if (!snap) return;

  activeDiffSnapshot = snap;
  const modal = $('diffModal');
  const meta = $('diffMeta');
  const contentEl = $('diffContent');

  if (meta) meta.textContent = __('snapshot.diff_meta', { name: snap.name, date: new Date(snap.timestamp).toLocaleString() });
  
  const currentMd = getContentMarkdown();
  if (contentEl) contentEl.innerHTML = diffStrings(snap.markdown, currentMd);

  if (modal) modal.classList.add('active');
}

// Restoring swaps rather than overwrites: the version leaving the editor takes
// the snapshot's place, so restoring again brings it straight back. Without the
// swap, the state you were in when you clicked Restore is simply gone.
async function restoreActiveSnapshot() {
  if (!activeDiffSnapshot || !state.activeDocId) return false;
  if (!(await themedConfirm(
    __('confirm.restore_snapshot', { name: activeDiffSnapshot.name })
  ))) return false;

  saveHistory(state.activeDocId, true);

  const incoming = activeDiffSnapshot;
  const outgoing = {
    title: title ? title.value : '',
    subtitle: subtitle ? subtitle.value : '',
    markdown: getContentMarkdown()
  };

  if (title) title.value = incoming.title || '';
  if (subtitle) subtitle.value = incoming.subtitle || '';
  loadContentMarkdown(incoming.markdown || '');

  // The snapshot keeps its id and position in the list; only its payload is
  // exchanged, so the entry the user has been aiming at stays where it was.
  const list = getSnapshots(state.activeDocId);
  const entry = list.find((s) => s.id === incoming.id);
  if (entry) {
    entry.title = outgoing.title;
    entry.subtitle = outgoing.subtitle;
    entry.markdown = outgoing.markdown;
    entry.timestamp = Date.now();
    entry.name = swappedSnapshotName(entry.name);
    saveSnapshots(state.activeDocId, list);
  }

  markDirty();
  updateStats();
  debouncedRegenerateTOC();
  renderSnapshotsList();

  if ($('diffModal')) $('diffModal').classList.remove('active');
  activeDiffSnapshot = null;
  return true;
}

// Marks an entry as holding the version that was just swapped out, and toggles
// the marker back off when it is swapped in again — so the label tracks the
// back-and-forth instead of stacking "(remplacé) (remplacé)".
function swappedSnapshotName(name) {
  var SUFFIX = __('snapshot.swapped_suffix');
  return name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : name + SUFFIX;
}

// The card used to print the time alone, so a snapshot taken three days ago
// read as "13:54" — indistinguishable from one taken this afternoon. Snapshots
// are kept precisely to reach back past today.
function clockTime(ts) {
  return new Date(ts).toLocaleTimeString(getLocale() === 'fr' ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
}

function snapshotStamp(ts) {
  return relDate(ts) + ' ' + clockTime(ts);
}

function fullDateTime(ts) {
  return new Date(ts).toLocaleString(getLocale() === 'fr' ? 'fr-FR' : 'en-US', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function renderSnapshotsList() {
  const listEl = $('snapshotsList');
  const emptyEl = $('snapshotsEmpty');
  if (!listEl) return;

  const list = getSnapshots(state.activeDocId);
  listEl.innerHTML = '';

  if (!list.length) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  list.forEach(snap => {
    const card = document.createElement('div');
    card.className = 'snapshot-card';
    card.innerHTML =
      '<div class="snapshot-card-header">' +
        '<span class="snapshot-name">' + escapeHtml(snap.name) + '</span>' +
        '<span class="snapshot-date" title="' + escapeHtml(fullDateTime(snap.timestamp)) + '">' + escapeHtml(snapshotStamp(snap.timestamp)) + '</span>' +
      '</div>' +
      '<div class="snapshot-actions">' +
        '<button class="snapshot-btn view-diff-btn" type="button">' + __('snapshot.view_diff') + '</button>' +
        '<button class="snapshot-btn restore-btn" type="button">' + __('snapshot.restore') + '</button>' +
        '<button class="snapshot-btn delete-btn" type="button" style="color: var(--danger);">' + __('snapshot.delete') + '</button>' +
      '</div>';

    card.querySelector('.view-diff-btn').addEventListener('click', () => openDiffModal(snap.id));
    card.querySelector('.restore-btn').addEventListener('click', async () => {
      activeDiffSnapshot = snap;
      if (await restoreActiveSnapshot()) {
        showToast('toast.snapshot_restored');
      }
    });
    card.querySelector('.delete-btn').addEventListener('click', () => deleteSnapshot(snap.id));

    listEl.appendChild(card);
  });
}

function initProWriterTools() {
  applyTextJustify(textJustifyState);
  applySpellcheck(spellcheckState);
  applyTypewriterMode(typewriterState);
  applyFocusLineMode(focusLineState);
  applyFullWidth(fullWidthState);
  applyReadingMode(readingModeState);

  $('undoBtn')?.addEventListener('click', () => performUndo());
  $('redoBtn')?.addEventListener('click', () => performRedo());
  $('justifyBtn')?.addEventListener('click', () => applyTextJustify(!textJustifyState));
  $('lineLengthBtn')?.addEventListener('click', () => applyFullWidth(!fullWidthState));
  $('spellcheckBtn')?.addEventListener('click', () => applySpellcheck(!spellcheckState));
  $('typewriterToggle')?.addEventListener('click', () => applyTypewriterMode(!typewriterState));
  $('focusLineBtn')?.addEventListener('click', () => applyFocusLineMode(!focusLineState));
  $('readingToggle')?.addEventListener('click', () => {
    var next = (readingModeState + 1) % 3;
    applyReadingMode(next);
  });
  $('removeEmptyLinesBtn')?.addEventListener('click', removeAllEmptyLines);
  $('autoScrollBtn')?.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (autoScrollPaused && autoScrollState > 0) {
      // Resume at current speed
      startAutoScroll(autoScrollState);
      showToast('toast.autoscroll_speed' + autoScrollState);
    } else {
      var next = (autoScrollState + 1) % 4;
      applyAutoScroll(next);
    }
  });

  // Detect manual scroll (wheel/touch/keyboard) to pause auto-scroll
  if (editorWrap) {
    editorWrap.addEventListener('wheel', onUserScroll, { passive: true });
    editorWrap.addEventListener('touchmove', onUserScroll, { passive: true });
  }
  document.addEventListener('keydown', function(e) {
    if (autoScrollState === 0 || autoScrollPaused) return;
    var key = e.key;
    if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight' ||
        key === 'PageUp' || key === 'PageDown' || key === 'Home' || key === 'End' || key === ' ') {
      onUserScroll();
    }
  });

  // Export menu
  $('exportBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openExportMenu();
  });
  $('exportPdfBtn')?.addEventListener('click', exportPdf);
  $('exportHtmlBtn')?.addEventListener('click', exportHtml);
  $('exportMdBtn')?.addEventListener('click', exportMarkdown);

  document.addEventListener('click', (e) => {
    if (exportMenu && !e.target.closest('#exportMenu') && !e.target.closest('#exportBtn')) {
      closeExportMenu();
    }
  });

  // Snapshots & Diff
  $('createSnapshotBtn')?.addEventListener('click', createSnapshot);
  $('closeDiffBtn')?.addEventListener('click', () => $('diffModal')?.classList.remove('active'));
  $('closeDiffModalBtn')?.addEventListener('click', () => $('diffModal')?.classList.remove('active'));
  $('restoreSnapshotBtn')?.addEventListener('click', async () => {
    if (await restoreActiveSnapshot()) showToast('toast.snapshot_restored');
  });
}

// ============ INITIALIZATION ============

function renderAll() {
  renderNav();
  renderThemesTabs();
  renderIdeas();
  loadActiveDoc();
}

// ============ EMOJI PICKER (@@ trigger) ============
const EMOJI_CATEGORIES = [
  { name: 'Smileys', emojis: [
    {e:'😀',n:'grinning face'},{e:'😁',n:'beaming face'},{e:'😂',n:'joy'},{e:'🤣',n:'rofl'},{e:'😊',n:'smile'},{e:'😍',n:'heart eyes'},{e:'😘',n:'kiss'},{e:'😎',n:'cool'},{e:'😉',n:'wink'},{e:'🤔',n:'thinking'},{e:'🤨',n:'raised eyebrow'},{e:'😐',n:'neutral'},{e:'😏',n:'smirk'},{e:'😒',n:'unamused'},{e:'🙄',n:'eye roll'},{e:'😬',n:'grimace'},{e:'🤥',n:'lying'},{e:'😌',n:'relieved'},{e:'😔',n:'pensive'},{e:'😪',n:'sleepy'},{e:'🤤',n:'drooling'},{e:'😴',n:'sleeping'},{e:'😷',n:'mask'},{e:'🤒',n:'thermometer'},{e:'🤢',n:'nauseated'},{e:'🤮',n:'vomiting'},{e:'🥵',n:'hot'},{e:'🥶',n:'cold'},{e:'😳',n:'flushed'},{e:'🥺',n:'pleading'},{e:'😢',n:'crying'},{e:'😭',n:'loudly crying'},{e:'😱',n:'scream'},{e:'😖',n:'anguished'},{e:'😣',n:'persevering'},{e:'😫',n:'tired'},{e:'🥱',n:'yawning'},{e:'😡',n:'angry'},{e:'😠',n:'mad'},{e:'🤬',n:'cursing'},{e:'😈',n:'devil'},{e:'👿',n:'angry devil'},{e:'💀',n:'skull'},{e:'👻',n:'ghost'},{e:'👽',n:'alien'},{e:'🤖',n:'robot'},{e:'😺',n:'cat grin'},{e:'💩',n:'poop'}
  ]},
  { name: 'People', emojis: [
    {e:'👋',n:'wave'},{e:'✋',n:'stop hand'},{e:'👌',n:'ok hand'},{e:'✌️',n:'victory'},{e:'🤞',n:'crossed fingers'},{e:'🤟',n:'love you'},{e:'👍',n:'thumbs up'},{e:'👎',n:'thumbs down'},{e:'👊',n:'fist'},{e:'✊',n:'raised fist'},{e:'👏',n:'clap'},{e:'🙌',n:'raised hands'},{e:'👐',n:'open hands'},{e:'🤝',n:'handshake'},{e:'🙏',n:'pray'},{e:'💪',n:'muscle'},{e:'🦵',n:'leg'},{e:'🦶',n:'foot'},{e:'👂',n:'ear'},{e:'👃',n:'nose'},{e:'🧠',n:'brain'},{e:'🦷',n:'tooth'},{e:'👀',n:'eyes'},{e:'👤',n:'bust'},{e:'🧔',n:'beard'},{e:'👩',n:'woman'},{e:'👨',n:'man'},{e:'🧑',n:'person'},{e:'👶',n:'baby'},{e:'👧',n:'girl'},{e:'👦',n:'boy'},{e:'👵',n:'old woman'},{e:'👴',n:'old man'},{e:'🧓',n:'older person'},{e:'👳',n:'turban'},{e:'🧕',n:'hijab'},{e:'👮',n:'police'},{e:'🕵️',n:'detective'},{e:'👷',n:'worker'},{e:'👸',n:'princess'}
  ]},
  { name: 'Animals & Nature', emojis: [
    {e:'🐶',n:'dog'},{e:'🐱',n:'cat'},{e:'🐭',n:'mouse'},{e:'🐹',n:'hamster'},{e:'🐰',n:'rabbit'},{e:'🦊',n:'fox'},{e:'🐻',n:'bear'},{e:'🐼',n:'panda'},{e:'🐨',n:'koala'},{e:'🐯',n:'tiger'},{e:'🦁',n:'lion'},{e:'🐮',n:'cow'},{e:'🐷',n:'pig'},{e:'🐸',n:'frog'},{e:'🐵',n:'monkey face'},{e:'🐔',n:'chicken'},{e:'🐧',n:'penguin'},{e:'🐦',n:'bird'},{e:'🐤',n:'chick'},{e:'🦆',n:'duck'},{e:'🦅',n:'eagle'},{e:'🦉',n:'owl'},{e:'🦄',n:'unicorn'},{e:'🐝',n:'bee'},{e:'🐛',n:'bug'},{e:'🦋',n:'butterfly'},{e:'🐌',n:'snail'},{e:'🐞',n:'ladybug'},{e:'🐢',n:'turtle'},{e:'🐍',n:'snake'},{e:'🦎',n:'lizard'},{e:'🐙',n:'octopus'},{e:'🐬',n:'dolphin'},{e:'🐳',n:'whale'},{e:'🐊',n:'crocodile'},{e:'🦈',n:'shark'},{e:'🐟',n:'fish'},{e:'🐴',n:'horse'},{e:'🦌',n:'deer'},{e:'🐘',n:'elephant'},{e:'🦒',n:'giraffe'},{e:'🐒',n:'monkey'},{e:'🦇',n:'bat'},{e:'🐺',n:'wolf'},{e:'🌸',n:'cherry blossom'},{e:'🌹',n:'rose'},{e:'🌺',n:'hibiscus'},{e:'🌻',n:'sunflower'},{e:'🌼',n:'blossom'},{e:'🌷',n:'tulip'},{e:'🌱',n:'sprout'},{e:'🌲',n:'pine'},{e:'🌳',n:'tree'},{e:'🍀',n:'four leaf clover'}
  ]},
  { name: 'Food & Drink', emojis: [
    {e:'🍏',n:'green apple'},{e:'🍎',n:'apple'},{e:'🍐',n:'pear'},{e:'🍊',n:'orange'},{e:'🍋',n:'lemon'},{e:'🍌',n:'banana'},{e:'🍉',n:'watermelon'},{e:'🍇',n:'grapes'},{e:'🍓',n:'strawberry'},{e:'🍒',n:'cherry'},{e:'🍑',n:'peach'},{e:'🥭',n:'mango'},{e:'🍍',n:'pineapple'},{e:'🥥',n:'coconut'},{e:'🥝',n:'kiwi'},{e:'🍅',n:'tomato'},{e:'🥑',n:'avocado'},{e:'🥦',n:'broccoli'},{e:'🥒',n:'cucumber'},{e:'🌽',n:'corn'},{e:'🥕',n:'carrot'},{e:'🥔',n:'potato'},{e:'🍞',n:'bread'},{e:'🥐',n:'croissant'},{e:'🧀',n:'cheese'},{e:'🍖',n:'meat'},{e:'🍗',n:'drumstick'},{e:'🥩',n:'steak'},{e:'🍔',n:'burger'},{e:'🍟',n:'fries'},{e:'🍕',n:'pizza'},{e:'🌭',n:'hot dog'},{e:'🥪',n:'sandwich'},{e:'🌮',n:'taco'},{e:'🌯',n:'burrito'},{e:'🥗',n:'salad'},{e:'🍜',n:'noodles'},{e:'🍝',n:'pasta'},{e:'🍣',n:'sushi'},{e:'🍤',n:'shrimp'},{e:'🍚',n:'rice'},{e:'🍦',n:'ice cream'},{e:'🍨',n:'ice cream bowl'},{e:'🍩',n:'donut'},{e:'🍪',n:'cookie'},{e:'🎂',n:'cake'},{e:'🍰',n:'shortcake'},{e:'🧁',n:'cupcake'},{e:'🍫',n:'chocolate'},{e:'🍬',n:'candy'},{e:'🍭',n:'lollipop'},{e:'☕',n:'coffee'},{e:'🍵',n:'tea'},{e:'🥤',n:'cup'},{e:'🍺',n:'beer'},{e:'🍻',n:'beers'},{e:'🥂',n:'champagne'},{e:'🍷',n:'wine'},{e:'🥃',n:'whiskey'}
  ]},
  { name: 'Activities', emojis: [
    {e:'⚽',n:'soccer'},{e:'🏀',n:'basketball'},{e:'🏈',n:'football'},{e:'⚾',n:'baseball'},{e:'🎾',n:'tennis'},{e:'🏐',n:'volleyball'},{e:'🏉',n:'rugby'},{e:'🎱',n:'billiards'},{e:'🏓',n:'ping pong'},{e:'🏸',n:'badminton'},{e:'🏒',n:'hockey'},{e:'⛳',n:'golf'},{e:'🏄',n:'surf'},{e:'🏊',n:'swim'},{e:'🚴',n:'bike'},{e:'🏋️',n:'weight lifting'},{e:'🤸',n:'cartwheel'},{e:'🎿',n:'ski'},{e:'🎯',n:'target'},{e:'🎮',n:'video game'},{e:'🎲',n:'dice'},{e:'♟️',n:'chess'},{e:'🎭',n:'theater'},{e:'🎨',n:'art'},{e:'🎬',n:'movie'},{e:'🎤',n:'mic'},{e:'🎧',n:'headphones'},{e:'🎼',n:'music'},{e:'🎹',n:'piano'},{e:'🥁',n:'drum'},{e:'🎸',n:'guitar'},{e:'🎻',n:'violin'},{e:'🏆',n:'trophy'},{e:'🥇',n:'gold medal'},{e:'🥈',n:'silver medal'},{e:'🥉',n:'bronze medal'},{e:'🏅',n:'medal'},{e:'🎫',n:'ticket'},{e:'🎪',n:'circus'}
  ]},
  { name: 'Travel & Places', emojis: [
    {e:'🚗',n:'car'},{e:'🚕',n:'taxi'},{e:'🚙',n:'suv'},{e:'🚌',n:'bus'},{e:'🏎️',n:'race car'},{e:'🚓',n:'police car'},{e:'🚑',n:'ambulance'},{e:'🚒',n:'fire truck'},{e:'🚚',n:'truck'},{e:'🚜',n:'tractor'},{e:'🛴',n:'scooter'},{e:'🚲',n:'bicycle'},{e:'🏍️',n:'motorcycle'},{e:'✈️',n:'airplane'},{e:'🚀',n:'rocket'},{e:'🛸',n:'ufo'},{e:'🚁',n:'helicopter'},{e:'⛵',n:'sailboat'},{e:'🚤',n:'speedboat'},{e:'🛳️',n:'ship'},{e:'🚉',n:'station'},{e:'🚄',n:'train'},{e:'🚇',n:'metro'},{e:'🚧',n:'construction'},{e:'🏠',n:'house'},{e:'🏡',n:'house garden'},{e:'🏢',n:'office'},{e:'🏫',n:'school'},{e:'🏥',n:'hospital'},{e:'🏨',n:'hotel'},{e:'🏔️',n:'mountain'},{e:'🌋',n:'volcano'},{e:'🗻',n:'fuji'},{e:'🏖️',n:'beach'},{e:'🏜️',n:'desert'},{e:'🏝️',n:'island'},{e:'🌊',n:'ocean'},{e:'🌅',n:'sunrise'},{e:'🌠',n:'shooting star'},{e:'🌃',n:'night'},{e:'🌉',n:'bridge'},{e:'🗼',n:'tower'},{e:'🗽',n:'statue'}
  ]},
  { name: 'Objects', emojis: [
    {e:'⌚',n:'watch'},{e:'📱',n:'phone'},{e:'💻',n:'laptop'},{e:'⌨️',n:'keyboard'},{e:'🖥️',n:'computer'},{e:'🖨️',n:'printer'},{e:'📷',n:'camera'},{e:'📹',n:'video camera'},{e:'🎥',n:'movie camera'},{e:'📺',n:'tv'},{e:'📻',n:'radio'},{e:'🎙️',n:'microphone'},{e:'⏰',n:'alarm'},{e:'⏳',n:'hourglass'},{e:'📅',n:'calendar'},{e:'📁',n:'folder'},{e:'📂',n:'open folder'},{e:'📝',n:'memo'},{e:'✏️',n:'pencil'},{e:'🖊️',n:'pen'},{e:'📌',n:'pin'},{e:'📍',n:'round pin'},{e:'📎',n:'paperclip'},{e:'✂️',n:'scissors'},{e:'🔑',n:'key'},{e:'🔒',n:'locked'},{e:'🔓',n:'unlocked'},{e:'🔨',n:'hammer'},{e:'🔧',n:'wrench'},{e:'🔪',n:'knife'},{e:'💡',n:'light bulb'},{e:'🔦',n:'flashlight'},{e:'📚',n:'books'},{e:'📖',n:'book'},{e:'🎒',n:'backpack'},{e:'💼',n:'briefcase'},{e:'📦',n:'package'},{e:'🔋',n:'battery'}
  ]},
  { name: 'Symbols', emojis: [
    {e:'❤️',n:'heart'},{e:'🧡',n:'orange heart'},{e:'💛',n:'yellow heart'},{e:'💚',n:'green heart'},{e:'💙',n:'blue heart'},{e:'💜',n:'purple heart'},{e:'🖤',n:'black heart'},{e:'🤍',n:'white heart'},{e:'💔',n:'broken heart'},{e:'💕',n:'two hearts'},{e:'💞',n:'revolving hearts'},{e:'💓',n:'beating heart'},{e:'💗',n:'growing heart'},{e:'💖',n:'sparkling heart'},{e:'💘',n:'cupid'},{e:'💝',n:'gift heart'},{e:'⭐',n:'star'},{e:'🌟',n:'glowing star'},{e:'✨',n:'sparkles'},{e:'⚡',n:'lightning'},{e:'🔥',n:'fire'},{e:'💥',n:'collision'},{e:'💫',n:'dizzy'},{e:'💦',n:'sweat droplets'},{e:'💨',n:'dash'},{e:'💬',n:'speech bubble'},{e:'💭',n:'thought'},{e:'❗',n:'exclamation'},{e:'❓',n:'question'},{e:'💯',n:'hundred'},{e:'🔴',n:'red circle'},{e:'🟠',n:'orange circle'},{e:'🟡',n:'yellow circle'},{e:'🟢',n:'green circle'},{e:'🔵',n:'blue circle'},{e:'⚫',n:'black circle'},{e:'⚪',n:'white circle'},{e:'✅',n:'check'},{e:'❌',n:'cross'},{e:'➡️',n:'arrow right'},{e:'⬅️',n:'arrow left'},{e:'⬆️',n:'arrow up'},{e:'⬇️',n:'arrow down'},{e:'🔔',n:'bell'},{e:'📣',n:'megaphone'}
  ]},
];

let emojiPickerTarget = null; // { el, isContentEditable, replaceStart, replaceEnd, range }

function openEmojiPicker(ctx) {
  emojiPickerTarget = ctx;
  const search = $('emojiSearch');
  if (search) search.value = '';
  renderEmojiGrid('');
  const modal = $('emojiModal');
  if (modal) modal.classList.add('active');
  if (search) search.focus();
}
function closeEmojiPicker(removeTrigger) {
  const modal = $('emojiModal');
  if (modal) modal.classList.remove('active');
  // Left without choosing: the two @@@ that opened the picker should go away.
  if (removeTrigger && emojiPickerTarget) removeEmojiTrigger(emojiPickerTarget);
  emojiPickerTarget = null;
}
function removeEmojiTrigger(ctx) {
  if (ctx.isContentEditable) {
    const line = ctx.line;
    if (line && line.isConnected) {
      const raw = line.textContent;
      const start = Math.max(0, Math.min(ctx.lineOff || 0, raw.length));
      if (raw.slice(start, start + 2) === '@@') {
        const newRaw = raw.slice(0, start) + raw.slice(start + 2);
        line.textContent = newRaw;
        line.dataset.raw = newRaw;
        setCaretInLine(line, start);
        if (content) content.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  } else {
    const el = ctx.el;
    if (!el) return;
    const v = el.value || '';
    const start = typeof ctx.replaceStart === 'number' ? ctx.replaceStart : 0;
    const end = typeof ctx.replaceEnd === 'number' ? ctx.replaceEnd : v.length;
    if (v.slice(start, start + 2) === '@@') {
      el.value = v.slice(0, start) + v.slice(end);
      el.selectionStart = el.selectionEnd = start;
      el.focus();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
}
function renderEmojiGrid(query) {
  const grid = $('emojiGrid');
  if (!grid) return;
  const q = (query || '').trim().toLowerCase();
  grid.innerHTML = '';
  let shown = 0;
  EMOJI_CATEGORIES.forEach(cat => {
    const items = q ? cat.emojis.filter(e => e.n.toLowerCase().includes(q)) : cat.emojis;
    if (!items.length) return;
    if (!q) {
      const title = document.createElement('div');
      title.className = 'emoji-cat-title';
      title.textContent = cat.name;
      grid.appendChild(title);
    }
    items.forEach(e => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-item';
      btn.textContent = e.e;
      btn.title = e.n;
      btn.addEventListener('click', () => insertEmoji(e.e));
      grid.appendChild(btn);
      shown++;
    });
  });
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'emoji-cat-title';
    empty.textContent = __('emoji.no_results');
    grid.appendChild(empty);
  }
}
function insertEmoji(emoji) {
  const ctx = emojiPickerTarget;
  closeEmojiPicker();
  if (!ctx) return;
  if (ctx.isContentEditable) {
    const line = ctx.line;
    if (line && line.isConnected) {
      const raw = line.textContent;
      let start = Math.max(0, Math.min(ctx.lineOff || 0, raw.length));
      if (raw.slice(start, start + 2) !== '@@') {
        // The offset drifted: replace the last '@@' in the line as a fallback.
        const idx = raw.lastIndexOf('@@');
        start = idx !== -1 ? idx : raw.length;
      }
      const newRaw = raw.slice(0, start) + emoji + raw.slice(start + 2);
      line.textContent = newRaw;
      line.dataset.raw = newRaw;
      setCaretInLine(line, start + emoji.length);
    } else if (ctx.range) {
      ctx.range.insertNode(document.createTextNode(emoji));
    }
    if (content) content.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const el = ctx.el;
    if (!el) return;
    const v = el.value || '';
    const start = typeof ctx.replaceStart === 'number' ? ctx.replaceStart : 0;
    const end = typeof ctx.replaceEnd === 'number' ? ctx.replaceEnd : v.length;
    el.value = v.slice(0, start) + emoji + v.slice(end);
    const pos = start + emoji.length;
    el.selectionStart = el.selectionEnd = pos;
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
$('emojiCloseBtn')?.addEventListener('click', () => closeEmojiPicker(true));
$('emojiSearch')?.addEventListener('input', (e) => renderEmojiGrid(e.target.value));
$('emojiModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeEmojiPicker(true); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEmojiPicker(true); });

// Typing or pasting @@ in any text field opens the picker, remembering where
// to insert. A paste can fire input before the caret has settled, so a deferred
// re-check catches it too.
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el) return;
  if (el.closest && el.closest('#emojiModal')) return; // the picker's own search
  if (e.isComposing || emojiPickerTarget) return;

  const tryTrigger = () => {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const v = el.value || '';
      const pos = el.selectionStart;
      if (typeof pos === 'number' && v.slice(pos - 2, pos) === '@@') {
        openEmojiPicker({ el, isContentEditable: false, replaceStart: pos - 2, replaceEnd: pos });
        return true;
      }
    } else if (el.isContentEditable) {
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        const off = range.startOffset;
        const line = getLineForNode(node);
        const lineOff = line ? rangeOffsetIn(line, node, off) : -1;
        // Compare against the whole line text: a pasted @@ can be split across
        // several text nodes, so the immediate text node alone is not enough.
        if (line && lineOff >= 2) {
          const lineText = line.textContent;
          if (lineText.slice(lineOff - 2, lineOff) === '@@') {
            openEmojiPicker({ el, isContentEditable: true, line, lineOff: lineOff - 2 });
            return true;
          }
        }
      }
    }
    return false;
  };

  if (!tryTrigger()) setTimeout(tryTrigger, 0);
});

// ============ CUSTOM UI ICONS (per theme) ============
// Every UI icon has a stable key and a default SVG. A theme may override any
// key with an imported icon (SVG inline, or PNG/WebP/ICO as an <img>). The
// defaults below stay as the built-in look.

const UI_ICONS = {
  'topbar-mobile-menu': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  'topbar-clear': '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  'topbar-preview': '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  'topbar-typewriter': '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
  'topbar-focus-line': '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h20M7 6h10M7 18h10"/></svg>',
  'topbar-reading': '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  'topbar-focus': '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  'topbar-export': '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>',
  'topbar-mobile-ideas': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="1.5"/><circle cx="19" cy="5" r="1.5"/><circle cx="5" cy="19" r="1.5"/><circle cx="19" cy="19" r="1.5"/></svg>',
  'header-search': '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  'header-settings': '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  'header-folder': '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  'status-undo': '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  'status-redo': '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  'status-remove-empty': '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="20" y2="12"/><path d="M12 3v5M9.5 5.5 12 8l2.5-2.5"/><path d="M12 21v-5M9.5 18.5 12 16l2.5 2.5"/></svg>',
  'status-justify': '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>',
  'status-line-length': '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="20" y2="12"/><path d="M6 9l-3 3 3 3M18 9l3 3-3 3"/></svg>',
  'status-spellcheck': '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 16 3-8 3 8"/><path d="M7 13h4"/><path d="m16 8 2 3-2 3"/><path d="M14 16.5 16 18.5 22 12.5"/></svg>',
  'status-autoscroll': '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  'status-find': '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  'sidebar-import': '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  'nav-new-doc': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  'nav-add-section': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  'ideas-panel-cycle': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>',
  'ideas-import-theme': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  'ideas-search': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
};

// Per-theme icon overrides: localStorage map { [themeId]: { [iconKey]: url } }
function loadThemeIcons() {
  try {
    const map = JSON.parse(localStorage.getItem('scriptoriumThemeIcons')) || {};
    return typeof map === 'object' && map ? map : {};
  } catch (e) { return {}; }
}
function saveThemeIcons(map) {
  try { localStorage.setItem('scriptoriumThemeIcons', JSON.stringify(map)); } catch (e) {}
}
function getThemeIconOverrides() {
  return loadThemeIcons()[colorThemeState.id] || {};
}

// The SVG/HTML to render for a key in the current theme (override or default).
function iconSvg(key) {
  const override = getThemeIconOverrides()[key];
  if (override) return `<img class="ui-icon-img" src="${override}" alt="" draggable="false" />`;
  return UI_ICONS[key] || '';
}

// Fills every [data-icon] element with the current theme's rendering.
function renderAllIcons() {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const key = el.getAttribute('data-icon');
    if (key) el.innerHTML = iconSvg(key);
  });
}

// Imported icons from <workspace>/.icons/
let appIconFiles = [];
async function loadAppIcons() {
  try {
    const res = await fetch('/api/icons');
    const data = await res.json();
    appIconFiles = (data && Array.isArray(data.icons)) ? data.icons : [];
  } catch (e) { appIconFiles = []; }
}

async function importIconFiles(files) {
  const payload = [];
  for (const file of Array.from(files || [])) {
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.indexOf(',') !== -1 ? result.slice(result.indexOf(',') + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    payload.push({ filename: file.name, dataBase64 });
  }
  if (!payload.length) return;
  try {
    await fetch('/api/icons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: payload })
    });
    await loadAppIcons();
    syncIconsUI();
    showToast('toast.icons_imported');
  } catch (err) {
    console.error('import icons error', err);
  }
}

// Settings UI: a collapsible list of every icon with its current rendering.
function syncIconsUI() {
  const list = $('iconEditList');
  if (!list) return;
  // Gallery of the imported icons, so you can see what each one looks like.
  const gallery = $('iconGallery');
  if (gallery) {
    gallery.innerHTML = '';
    if (appIconFiles.length) {
      appIconFiles.forEach(ic => {
        const item = document.createElement('div');
        item.className = 'icon-gallery-item';
        item.title = ic.name;
        const img = document.createElement('img');
        img.src = ic.url;
        img.alt = '';
        item.appendChild(img);
        const name = document.createElement('span');
        name.textContent = ic.name;
        item.appendChild(name);
        gallery.appendChild(item);
      });
    } else {
      const hint = document.createElement('div');
      hint.className = 'icon-gallery-empty';
      hint.textContent = __('settings.icons_empty');
      gallery.appendChild(hint);
    }
  }
  const q = ($('iconSearchInput') ? $('iconSearchInput').value : '').trim().toLowerCase();
  const overrides = getThemeIconOverrides();
  const keys = Object.keys(UI_ICONS).filter(k => !q || k.toLowerCase().includes(q));
  list.innerHTML = '';
  keys.forEach(key => {
    const row = document.createElement('div');
    row.className = 'icon-edit-row';
    const preview = document.createElement('span');
    preview.className = 'icon-edit-preview';
    preview.innerHTML = iconSvg(key);
    row.appendChild(preview);
    const label = document.createElement('span');
    label.className = 'icon-edit-name';
    label.textContent = key;
    row.appendChild(label);
    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'icon-pick-btn';
    const override = overrides[key];
    pickBtn.textContent = override
      ? ((appIconFiles.find(ic => ic.url === override) || {}).name || __('settings.icon_default'))
      : __('settings.icon_default');
    pickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openIconPicker(key, pickBtn);
    });
    row.appendChild(pickBtn);
    list.appendChild(row);
  });
}

// Custom dropdown for choosing an imported icon (with thumbnails).
let iconPickTarget = null;

function openIconPicker(key, btn) {
  iconPickTarget = key;
  const overrides = getThemeIconOverrides();
  const picker = $('iconPicker');
  if (!picker) return;
  picker.innerHTML = '';
  const addItem = (label, thumb, active, onClick) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'icon-pick-item' + (active ? ' active' : '');
    item.innerHTML = `<span class="icon-pick-thumb">${thumb}</span><span class="icon-pick-label">${label}</span>`;
    item.addEventListener('click', onClick);
    picker.appendChild(item);
  };
  addItem(__('settings.icon_default'), UI_ICONS[key] || '', !overrides[key], () => setIconOverride(key, ''));
  appIconFiles.forEach(ic => {
    addItem(escapeHtml(ic.name), `<img src="${ic.url}" alt="" />`, overrides[key] === ic.url, () => setIconOverride(key, ic.url));
  });
  picker.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const pr = picker.getBoundingClientRect();
  picker.style.top = Math.min(r.bottom + 4, Math.max(8, window.innerHeight - pr.height - 8)) + 'px';
  picker.style.left = Math.min(r.left, Math.max(8, window.innerWidth - pr.width - 8)) + 'px';
}

function setIconOverride(key, url) {
  const map = loadThemeIcons();
  const themeOverrides = map[colorThemeState.id] || {};
  if (url) themeOverrides[key] = url;
  else delete themeOverrides[key];
  map[colorThemeState.id] = themeOverrides;
  saveThemeIcons(map);
  renderAllIcons();
  syncIconsUI();
  iconPickTarget = null;
  const picker = $('iconPicker');
  if (picker) picker.classList.add('hidden');
}

document.addEventListener('mousedown', (e) => {
  if (iconPickTarget && !(e.target.closest && e.target.closest('#iconPicker'))) {
    iconPickTarget = null;
    const picker = $('iconPicker');
    if (picker) picker.classList.add('hidden');
  }
});

async function initIconControl() {
  await loadAppIcons();
  renderAllIcons();
  syncIconsUI();
  $('iconSearchInput')?.addEventListener('input', () => syncIconsUI());
  $('iconImportBtn')?.addEventListener('click', () => $('iconImportInput')?.click());
  $('iconImportInput')?.addEventListener('change', (e) => { importIconFiles(e.target.files); e.target.value = ''; });
  $('iconCollapseToggle')?.addEventListener('click', () => {
    $('iconEditSection')?.classList.toggle('hidden');
  });
}

// Start
fetchWorkspace();
initColorTheme();
initIconControl();
initFontSizeControls();
initBlockGapControl();
initLineHeightControl();
initAppBackgroundControl();
initProWriterTools();
initLanguageSettings();
initReadingFadeSlider();

// ============ FIRST-LAUNCH WORKSPACE SETUP ============
// Shown only when no workspace has ever been configured (config.json without
// a workspaceDir). The user picks an existing folder or types a new path,
// which the server creates on the spot.

function showWorkspaceSetupModal() {
  const modal = $('workspaceModal');
  if (modal) modal.classList.add('active');
}

function closeWorkspaceSetupModal() {
  const modal = $('workspaceModal');
  if (modal) modal.classList.remove('active');
}

function initWorkspaceSetupModal() {
  const pathInput = $('workspaceSetupPathInput');
  const browseBtn = $('workspaceSetupBrowseBtn');
  const confirmBtn = $('workspaceSetupConfirmBtn');

  // Language choice on first launch, English by default.
  const langSelect = $('workspaceSetupLanguage');
  if (langSelect) {
    langSelect.value = getLocale() === 'fr' ? 'fr' : 'en';
    langSelect.addEventListener('change', () => {
      if (typeof setLocale === 'function') setLocale(langSelect.value);
    });
  }

  if (browseBtn) {
    browseBtn.addEventListener('click', () => {
      handlePickFolder(pathInput, browseBtn);
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const newPath = pathInput ? pathInput.value.trim() : '';
      if (!newPath) {
        showToast('workspace.path_required');
        return;
      }
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPath })
        });
        const data = await res.json();
        if (data.success) {
          closeWorkspaceSetupModal();
          state.activeDocId = null;
          state.activeThemeId = null;
          await fetchWorkspace();
          showToast('toast.workspace_set');
        }
      } catch (err) {
        console.error('Workspace setup error:', err);
        showToast('alert.config_save_error');
      }
    });
  }

  if (pathInput) {
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && confirmBtn) confirmBtn.click();
    });
  }
}

initWorkspaceSetupModal();

// ============ THEMED DIALOGS ============
// Replace native browser confirm()/alert()/prompt() with a themed modal that
// follows the current color theme, on desktop and mobile alike.

let activeDialogResolve = null;

const DIALOG_ICON_CONFIRM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const DIALOG_ICON_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
const DIALOG_ICON_PROMPT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

function showDialog(options) {
  return new Promise((resolve) => {
    activeDialogResolve = resolve;
    const modal = $('dialogModal');
    const titleEl = $('dialogTitle');
    const msgEl = $('dialogMessage');
    const inputEl = $('dialogInput');
    const iconEl = $('dialogIcon');
    const okBtn = $('dialogOkBtn');
    const cancelBtn = $('dialogCancelBtn');
    const closeBtn = $('dialogCloseBtn');
    const useInput = !!options.input;
    const cancelable = !!options.cancelLabel;

    if (titleEl) titleEl.textContent = options.title || '';
    if (iconEl) {
      iconEl.innerHTML = options.icon || '';
      iconEl.classList.toggle('danger', !!options.danger);
    }
    if (msgEl) {
      msgEl.textContent = options.message || '';
      msgEl.classList.toggle('hidden', !options.message);
    }
    if (inputEl) {
      inputEl.classList.toggle('hidden', !useInput);
      if (useInput) inputEl.value = options.defaultValue || '';
    }
    if (okBtn) {
      okBtn.textContent = options.okLabel || __('dialog.ok');
      okBtn.classList.toggle('btn-danger', !!options.danger);
    }
    if (cancelBtn) {
      cancelBtn.textContent = options.cancelLabel || '';
      cancelBtn.classList.toggle('hidden', !cancelable);
    }
    if (closeBtn) closeBtn.classList.toggle('hidden', !cancelable);

    const finish = (result) => {
      if (modal) modal.classList.remove('active');
      if (okBtn) okBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      if (closeBtn) closeBtn.onclick = null;
      if (modal) modal.onclick = null;
      if (inputEl) inputEl.onkeydown = null;
      if (titleEl) titleEl.textContent = '';
      const r = activeDialogResolve;
      activeDialogResolve = null;
      if (r) r(result);
    };

    okBtn.onclick = () => finish(useInput ? (inputEl ? inputEl.value : '') : true);
    cancelBtn.onclick = () => finish(cancelable ? (useInput ? null : false) : undefined);
    closeBtn.onclick = () => finish(cancelable ? (useInput ? null : false) : undefined);
    if (modal) {
      modal.onclick = (e) => {
        if (e.target === modal && cancelable) finish(useInput ? null : false);
      };
    }

    if (useInput && inputEl) {
      setTimeout(() => inputEl.focus(), 30);
      inputEl.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
        else if (e.key === 'Escape' && cancelable) { e.preventDefault(); cancelBtn.click(); }
      };
    }

    if (modal) modal.classList.add('active');
  });
}

async function themedConfirm(message, title, danger) {
  const result = await showDialog({
    title: title || __('dialog.title_confirm'),
    message,
    okLabel: __('dialog.confirm'),
    cancelLabel: __('dialog.cancel'),
    icon: DIALOG_ICON_CONFIRM,
    danger: !!danger
  });
  return result === true;
}

async function themedAlert(message, title) {
  await showDialog({
    title: title || __('app.name'),
    message,
    okLabel: __('dialog.ok'),
    cancelLabel: null,
    icon: DIALOG_ICON_ALERT
  });
}

async function themedPrompt(message, defaultValue, title) {
  const result = await showDialog({
    title: title || __('app.name'),
    message,
    input: true,
    defaultValue: defaultValue || '',
    okLabel: __('dialog.confirm'),
    cancelLabel: __('dialog.cancel'),
    icon: DIALOG_ICON_PROMPT
  });
  return typeof result === 'string' ? result : null;
}

document.addEventListener('selectionchange', updateActiveLine);

// Right-click must not switch the block to raw edit mode: the browser then
// loses the misspelled word the native spellcheck menu was about to act on.
content.addEventListener('mousedown', (e) => {
  if (e.button !== 2) return;
  suppressLineActivation = true;
  clearTimeout(suppressLineActivationTimer);
  suppressLineActivationTimer = setTimeout(() => { suppressLineActivation = false; }, 600);
});
content.addEventListener('contextmenu', () => {
  clearTimeout(suppressLineActivationTimer);
  suppressLineActivation = false;
}, { capture: true });

// ============ GUTTER CLICK-TO-INSERT ============
// Clicking in the empty space before the first block, between two blocks, or
// after the last one inserts a new empty block right there instead of just
// moving the caret to the end of the document. Hovering that space previews
// the exact insertion point with the same indicator line used by block drag.

function getEditorLines() {
  return Array.from(content.children).filter(el => el.classList && el.classList.contains('editor-line'));
}

// An empty trailing line already catches clicks below it (focus, no new block needed).
function isMootGutterHit(hit) {
  return !!hit && !!hit.atTail && hit.line.textContent.trim() === '';
}

// ============ INSERT / EDIT DETENT ============
// The gap between two blocks is 0.5em (~9px) and the hover outline is drawn
// 3px into it on each side, so the target for "insert here" was a ~3px band.
// Aiming one pixel high put the caret in the block above instead.
//
// The boundary is now a detent: it reaches a little way *into* the blocks on
// either side, and once engaged it holds until the pointer travels clearly
// away (hysteresis). A hand that shakes by two pixels no longer flips modes.

let gutterMode = 'edit';         // 'edit' | 'insert'
let gutterHit = null;

// Returns the insertion boundary the pointer is on, or null.
//
// Hard rule: a point that lies inside a block's own box is NEVER an insertion.
// An earlier attempt let the boundary bite a few pixels into each block to make
// it easier to hit; that quietly stole the top and bottom of every block, so
// clicking the first line of a paragraph inserted an empty block instead of
// putting the caret in it — the block looked unerodable. The gap is the target,
// and it is made comfortable by spacing the blocks, not by eating them.
function findInsertionBoundary(clientY) {
  const lines = getEditorLines();
  if (!lines.length) return null;

  // Open space above the first block and below the last is unambiguous.
  const firstRect = lines[0].getBoundingClientRect();
  if (clientY < firstRect.top) {
    return { line: lines[0], insertBefore: true, edgeY: firstRect.top };
  }

  const lastLine = lines[lines.length - 1];
  const lastRect = lastLine.getBoundingClientRect();
  if (clientY > lastRect.bottom) {
    return { line: lastLine, insertBefore: false, edgeY: lastRect.bottom, atTail: true };
  }

  // Strictly between two blocks.
  for (let i = 0; i < lines.length - 1; i++) {
    const r = lines[i].getBoundingClientRect();
    const nr = lines[i + 1].getBoundingClientRect();
    if (clientY < r.bottom || clientY > nr.top) continue;
    // The indicator sits at the middle of the gap and stays there for the whole
    // gap: "after block i" and "before block i+1" are the same insertion, and
    // snapping between the two edges made the line jump for no reason.
    const mid = (r.bottom + nr.top) / 2;
    return clientY < mid
      ? { line: lines[i], insertBefore: false, edgeY: mid }
      : { line: lines[i + 1], insertBefore: true, edgeY: mid };
  }
  return null;
}

// Drives the two mutually exclusive affordances. Showing the block outline and
// the insertion line at the same time was half the confusion: the cursor now
// commits to one reading of what a click will do.
function setGutterMode(mode, hit) {
  const changed = mode !== gutterMode;
  gutterMode = mode;
  gutterHit = hit || null;

  if (mode === 'insert') {
    setHoveredLine(null);
    showGutterIndicator(hit);
    content.classList.add('gutter-insert');
    // A short pulse marks the detent on touch, where there is no hover state
    // to read and the finger hides the indicator anyway.
    if (changed && navigator.vibrate && window.matchMedia('(pointer: coarse)').matches) {
      navigator.vibrate(6);
    }
  } else {
    hideGutterIndicator();
    content.classList.remove('gutter-insert');
  }
  return changed;
}

// Resolves a pointer position into a mode. Used by hover on a mouse and by the
// tap itself on touch, where the mode cannot be previewed.
function resolveGutterMode(clientY, target) {
  if (readingModeState || isDraggingBlock) return { mode: 'edit', hit: null };

  const line = target && target.closest ? target.closest('.editor-line') : null;
  const onBlock = line && content.contains(line);

  // Second guard, belt and braces: whatever the geometry says, a pointer that
  // is over a block edits that block. Nothing may take a click away from it.
  if (!onBlock) {
    const hit = findInsertionBoundary(clientY);
    if (hit && !isMootGutterHit(hit)) return { mode: 'insert', hit };
  }

  return { mode: 'edit', hit: null, line: onBlock ? line : null };
}

function insertBlockAtBoundary(hit) {
  saveHistory(state.activeDocId, true);
  const newLine = makeLineNode('');
  // Flagged so the block is auto-removed if the caret leaves it while still empty
  newLine.dataset.gutterCreated = '1';
  content.insertBefore(newLine, hit.insertBefore ? hit.line : hit.line.nextSibling);
  makeLineRawAndActive(newLine);
  setCaretInLine(newLine, 0);
  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();
}

function showGutterIndicator(hit) {
  if (!blockDropIndicator) return;
  const wrapRect = editorWrap.getBoundingClientRect();
  const containerRect = editorContainer.getBoundingClientRect();
  blockDropIndicator.style.top = (hit.edgeY - wrapRect.top + editorWrap.scrollTop) + 'px';
  blockDropIndicator.style.left = (containerRect.left - wrapRect.left + editorWrap.scrollLeft) + 'px';
  blockDropIndicator.style.width = containerRect.width + 'px';
  blockDropIndicator.style.display = 'block';
}

function hideGutterIndicator() {
  if (!blockDropIndicator || isDraggingBlock) return;
  blockDropIndicator.style.display = 'none';
}

// Soft outline on the block currently under the cursor, so it's clear where a
// block starts/ends — and by extension, where clicking above/below it will
// insert a new one (see the gutter-insertion logic below).
function setHoveredLine(line) {
  // An empty block has nothing to frame, and framing it would suggest there is
  // something there to edit. Blank lines stay silent.
  if (line && line.textContent.trim() === '') line = null;
  if (hoveredLineNode === line) return;
  if (hoveredLineNode) hoveredLineNode.classList.remove('line-hover-outline');
  hoveredLineNode = line;
  if (hoveredLineNode) hoveredLineNode.classList.add('line-hover-outline');
  // No active line yet (fresh document): the drag handle follows the hover so
  // any block can be dragged without activating it first.
  if (!activeLineNode) updateBlockDragPosition();
}

// Hover previews the mode on a mouse. The whole editor is watched now, not
// just its background: the detent reaches into the blocks, so the pointer is
// often over a block while the answer is still "insert".
content.addEventListener('mousemove', (e) => {
  if (isDraggingBlock) return;
  if (readingModeState) { setGutterMode('edit', null); setHoveredLine(null); return; }

  const resolved = resolveGutterMode(e.clientY, e.target);
  setGutterMode(resolved.mode, resolved.hit);
  if (resolved.mode === 'edit') setHoveredLine(resolved.line);
});

content.addEventListener('mouseleave', () => {
  setGutterMode('edit', null);
  setHoveredLine(null);
});

// What the click does is decided from where the button actually went down, not
// from the last hover. Moving fast and clicking before the next mousemove fired
// used to act on a stale boundary — inserting the block, and throwing the caret,
// wherever the pointer happened to be a moment earlier.
let pressGutterHit = null;

content.addEventListener('mousedown', (e) => {
  pressGutterHit = null;
  if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
  if (readingModeState || isDraggingBlock) return;

  const resolved = resolveGutterMode(e.clientY, e.target);
  setGutterMode(resolved.mode, resolved.hit);
  if (resolved.mode !== 'insert' || !resolved.hit) return;

  pressGutterHit = resolved.hit;
  // Stops the browser from dropping the caret into the block the detent
  // overlaps before the click handler gets to insert.
  e.preventDefault();
});

// Clicking a rendered image switches the block back to raw edit mode and
// selects the URL, so you can retype it directly in the markdown.
content.addEventListener('mousedown', (e) => {
  const img = e.target && e.target.closest ? e.target.closest('.md-img') : null;
  if (!img || !content.contains(img)) return;
  e.preventDefault(); // keep the caret where it is, we set it ourselves
  const line = getLineForNode(img);
  if (!line) return;
  const idx = Array.from(line.querySelectorAll('.md-img')).indexOf(img);
  if (idx === -1) return;

  makeLineRawAndActive(line);
  // The Nth rendered image corresponds to the Nth image pattern in the raw.
  const raw = line.textContent;
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let m, count = 0;
  while ((m = imgRe.exec(raw)) !== null) {
    if (count === idx) {
      const urlStart = m.index + m[0].lastIndexOf('(') + 1;
      const urlEnd = m.index + m[0].lastIndexOf(')');
      setSelectionInLine(line, urlStart, urlEnd);
      break;
    }
    count++;
  }
});

// Touch has no hover: the mode is resolved by the tap itself, and the pulse is
// what tells the finger which one it got.
content.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || readingModeState || isDraggingBlock) return;
  const resolved = resolveGutterMode(e.clientY, e.target);
  setGutterMode(resolved.mode, resolved.hit);
  pressGutterHit = resolved.mode === 'insert' ? resolved.hit : null;
});

// Clicking the checkbox of a task list toggles it between [ ] and [x], in
// reading and editing modes alike. Handled on mousedown so the caret does not
// move into the block first (which would switch it to raw and destroy the box).
content.addEventListener('mousedown', (e) => {
  const box = e.target.closest ? e.target.closest('.task-box') : null;
  if (!box) return;
  e.preventDefault();
  e.stopPropagation();
  const line = getLineForNode(box);
  if (line && content.contains(line)) toggleTaskBox(line);
});

function toggleTaskBox(line) {
  const raw = line.dataset.raw !== undefined ? line.dataset.raw : line.textContent;
  const m = raw.match(/^([\s]*[-*+]\s+)\[([ xX])\]/);
  if (!m) return;
  const check = m[2].toLowerCase() === 'x' ? ' ' : 'x';
  const newRaw = raw.slice(0, m.index) + m[1] + '[' + check + ']' + raw.slice(m.index + m[0].length);
  line.dataset.raw = newRaw;
  if (line === activeLineNode) {
    line.textContent = newRaw;
    applyLineKind(line, newRaw);
  } else {
    applyLineKind(line, newRaw);
    line.innerHTML = newRaw.trim() === '' ? '<br>' : renderMarkdownLine(newRaw);
  }
  markDirty();
  updateStats();
  saveHistory(state.activeDocId, true);
  debouncedRegenerateTOC();
}

content.addEventListener('click', (e) => {
  const hit = pressGutterHit;
  pressGutterHit = null;

  if (readingModeState) return;
  if (e.ctrlKey || e.metaKey) return; // Ctrl+clic = sélection multiple, pas d'insertion

  if (hit) {
    e.preventDefault();
    setGutterMode('edit', null);
    insertBlockAtBoundary(hit);
    return;
  }

  if (e.target !== content) return; // a click inside a block edits it, as before

  // No insertion zone (empty doc, or clicked below an already-empty last line): just focus it.
  const lastLine = content.lastChild;
  if (lastLine && lastLine.classList && lastLine.classList.contains('editor-line')) {
    const range = document.createRange();
    range.selectNodeContents(lastLine);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

// Prevent deletion of source text from contenteditable on drag drop
content.addEventListener('dragstart', (e) => {
  e.dataTransfer.effectAllowed = 'copy';
});

// Registering the worker is what makes the app installable on a phone and
// lets the shell open without a network. The API is never cached (see sw.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn(__('sw.not_registered', { message: err.message }));
    });
  });
}

// ============ MOBILE / TACTILE ============
// Everything below exists because the desktop affordances are mouse-only:
// block reordering listens to mousedown/mousemove, moving a document between
// sections relies on HTML5 drag-and-drop (which touch browsers do not fire),
// and the layout assumes a viewport that the on-screen keyboard never covers.

const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

// --- Keyboard-aware height ---------------------------------------------
// When the virtual keyboard opens, dvh does not shrink: the layout keeps its
// full height and the statusbar (plus often the caret) ends up behind the
// keyboard. visualViewport is the only thing that reports the real area.
(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  let frame = null;
  const sync = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      // Below ~1px of difference this is just rounding noise.
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      if (covered > 1) {
        document.documentElement.style.setProperty('--app-h', vv.height + 'px');
      } else {
        document.documentElement.style.removeProperty('--app-h');
      }
    });
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
})();

// Keep the caret visible above the keyboard while typing.
if (isCoarsePointer) {
  content.addEventListener('input', () => {
    if (!activeLineNode || !window.visualViewport) return;
    const rect = activeLineNode.getBoundingClientRect();
    const limit = window.visualViewport.height - 40;
    if (rect.bottom > limit) {
      editorWrap.scrollTop += rect.bottom - limit + 24;
    }
  });
}

// --- Edge swipes to open/close the panels -------------------------------
// The burger and ideas buttons are small targets in the corners; a swipe from
// the edge is how every mobile app opens a drawer.
(() => {
  if (!isCoarsePointer) return;
  const EDGE = 28;        // px from the screen edge that arm an opening swipe
  const THRESHOLD = 55;   // px of travel before it counts as a swipe
  let startX = 0, startY = 0, tracking = false, fromLeftEdge = false, fromRightEdge = false;

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    // Never hijack a gesture that starts inside a scrollable panel or a modal.
    if (e.target.closest('.modal, .search-modal-overlay, .block-menu')) { tracking = false; return; }
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    fromLeftEdge = startX <= EDGE;
    fromRightEdge = startX >= window.innerWidth - EDGE;
    tracking = true;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    // Horizontal intent only, so vertical scrolling is never mistaken for one.
    if (Math.abs(dx) < THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    const sidebarOpen = app.classList.contains('show-sidebar');
    const ideasOpen = app.classList.contains('show-ideas');

    if (dx > 0) {
      if (ideasOpen) app.classList.remove('show-ideas');
      else if (fromLeftEdge && !sidebarOpen) app.classList.add('show-sidebar');
    } else {
      if (sidebarOpen) app.classList.remove('show-sidebar');
      else if (fromRightEdge && !ideasOpen) app.classList.add('show-ideas');
    }
  }, { passive: true });
})();

// --- Touch equivalent of the block drag handle --------------------------
// startBlockDrag() only reads clientX/clientY off the event, so touch points
// can be forwarded to the same code path as the mouse.
(() => {
  const handle = $('blockDragBtn');
  if (!handle) return;

  const asPoint = (touch) => ({
    clientX: touch.clientX,
    clientY: touch.clientY,
    preventDefault() {},
    stopPropagation() {}
  });

  const onTouchMove = (e) => {
    if (!e.touches[0]) return;
    e.preventDefault(); // stop the page from scrolling under the drag
    onBlockDragMove(asPoint(e.touches[0]));
  };

  const onTouchEnd = (e) => {
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchEnd);
    const t = e.changedTouches[0];
    onBlockDragEnd(t ? asPoint(t) : { clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
  };

  handle.addEventListener('touchstart', (e) => {
    if (!activeLineNode || e.touches.length !== 1) return;
    e.preventDefault();
    startBlockDrag(activeLineNode, asPoint(e.touches[0]));
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);
  }, { passive: false });
})();

// --- Move a document without drag-and-drop ------------------------------
// Long-press (or right-click) a document in the sidebar to pick a destination
// section. On touch this is the only way to reorganise the workspace.
(() => {
  let menuEl = null;

  const closeMenu = () => {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  };

  // The file manager opens on the machine running the server, so revealing a
  // document only makes sense when the page is that same machine.
  const isLocalMachine = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);

  async function openDocOnDisk(docId, mode) {
    try {
      const res = await fetch('/api/open-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: docId, mode })
      });
      if (!res.ok) throw new Error(String(res.status));
      if (mode === 'path') {
        const data = await res.json();
        await navigator.clipboard.writeText(data.path);
        showToast('toast.path_copied');
      }
    } catch (err) {
      console.error(err);
      showToast('toast.open_failed');
    }
  }

  async function openSectionFolder(sectionId) {
    try {
      const res = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionId })
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch (err) {
      console.error(err);
      showToast('toast.open_failed');
    }
  }

  // Shared shell for both context menus.
  function buildMenu(x, y, titleText) {
    menuEl = document.createElement('div');
    menuEl.className = 'block-menu visible doc-move-menu';
    menuEl.innerHTML = `<div class="block-menu-title">${escapeHtml(titleText)}</div>`;
    return () => {
      document.body.appendChild(menuEl);
      const r = menuEl.getBoundingClientRect();
      menuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
      menuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    };
  }

  function addItem(ico, label, onClick) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'block-menu-item';
    item.innerHTML = `<span class="ico">${ico}</span><span></span>`;
    item.lastChild.textContent = label;
    item.addEventListener('click', () => { closeMenu(); onClick(); });
    menuEl.appendChild(item);
  }

  function openSectionMenu(sectionId, x, y) {
    closeMenu();
    const section = state.sections.find(s => s.id === sectionId);
    if (!section || !isLocalMachine) return;
    const place = buildMenu(x, y, section.name);
    addItem('📁', __('nav.section_open_folder'), () => openSectionFolder(sectionId));
    place();
  }

  function openMoveMenu(docId, x, y) {
    closeMenu();
    const doc = findDoc(docId);
    if (!doc) return;
    const currentSection = state.sections.find(s => s.documents.some(d => d.id === docId));

    const place = buildMenu(x, y, doc.title || __('new_doc.default_title'));

    if (isLocalMachine) {
      addItem('📄', __('nav.doc_open_file'), () => openDocOnDisk(docId, 'file'));
      addItem('📁', __('nav.doc_reveal'), () => openDocOnDisk(docId, 'reveal'));
      addItem('⧉', __('nav.doc_copy_path'), () => openDocOnDisk(docId, 'path'));
      addItem('📋', __('nav.doc_duplicate'), () => duplicateDocument(docId));
      menuEl.insertAdjacentHTML('beforeend', '<div class="block-menu-sep"></div>');
    } else {
      addItem('📋', __('nav.doc_duplicate'), () => duplicateDocument(docId));
      menuEl.insertAdjacentHTML('beforeend', '<div class="block-menu-sep"></div>');
    }

    const moveLabel = document.createElement('div');
    moveLabel.className = 'block-menu-section';
    moveLabel.textContent = __('nav.doc_move_section');
    menuEl.appendChild(moveLabel);
    const beforeSections = menuEl.children.length;

    state.sections
      .filter(s => !currentSection || s.id !== currentSection.id)
      .forEach(section => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'block-menu-item';
        item.textContent = section.name;
        item.addEventListener('click', () => {
          closeMenu();
          moveDocument(docId, section.id);
        });
        menuEl.appendChild(item);
      });

    if (menuEl.children.length === beforeSections) {
      const empty = document.createElement('div');
      empty.className = 'block-menu-empty';
      empty.textContent = __('nav.doc_no_other_section');
      menuEl.appendChild(empty);
    }

    place();
  }

  // renderNav stamps the id on the element, so the menu always acts on the
  // document that was actually clicked — not on whatever now sits at that
  // position after a sort or a filter.
  const docIdOf = (item) => item.dataset.docId || null;

  nav.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.nav-item');
    if (item) {
      e.preventDefault();
      const id = docIdOf(item);
      if (id) openMoveMenu(id, e.clientX, e.clientY);
      return;
    }
    // Right-clicking the section header opens its folder on disk.
    const sectionEl = e.target.closest('.nav-section');
    if (!sectionEl || !isLocalMachine) return;
    e.preventDefault();
    openSectionMenu(sectionEl.dataset.id, e.clientX, e.clientY);
  });

  // Own long-press detection: contextmenu on long-press is inconsistent across
  // mobile browsers, and a moving finger must cancel it.
  let pressTimer = null, pressStart = null;
  nav.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.nav-item');
    if (!item || e.touches.length !== 1) return;
    const t = e.touches[0];
    pressStart = { x: t.clientX, y: t.clientY };
    pressTimer = setTimeout(() => {
      pressTimer = null;
      const id = docIdOf(item);
      if (id) {
        if (navigator.vibrate) navigator.vibrate(12);
        openMoveMenu(id, pressStart.x, pressStart.y);
      }
    }, 500);
  }, { passive: true });

  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  nav.addEventListener('touchend', cancelPress, { passive: true });
  nav.addEventListener('touchcancel', cancelPress, { passive: true });
  nav.addEventListener('touchmove', (e) => {
    if (!pressTimer || !pressStart || !e.touches[0]) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) > 10) cancelPress();
  }, { passive: true });

  document.addEventListener('click', (e) => {
    if (menuEl && !e.target.closest('.doc-move-menu')) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
})();

setTimeout(() => content.focus(), 100);
