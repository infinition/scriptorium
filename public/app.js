'use strict';

// Application State
let state = {
  sections: [],
  ideaThemes: [],
  activeDocId: null,
  activeThemeId: null,
  ideasMode: 'active', // 'active' | 'archived'
  workspaceDir: ''
};

// Archive timers map: ideaText -> { timer, element }
let archiveTimers = new Map();

// Save timers
let saveTimer;
let dirty = false;

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
const cursorEl = $('cursor');
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
const newDocBtn = $('newDocBtn');
const ideasPanel = $('ideasPanel');

// ============ API COMMUNICATIONS ============

async function fetchWorkspace() {
  docHistory = {}; // Clear history cache on workspace load
  try {
    // Get config first
    const configRes = await fetch('/api/config');
    const configData = await configRes.json();
    state.workspaceDir = configData.workspaceDir;
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
  } catch (err) {
    console.error('Error fetching workspace:', err);
    alert('Erreur lors du chargement du dossier de travail : ' + err.message);
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
        content: getContentMarkdown()
      })
    });
    
    const data = await res.json();
    if (data.success) {
      // If filename/id changed due to renaming
      if (data.document.id !== doc.id) {
        if (docHistory[doc.id]) {
          docHistory[data.document.id] = docHistory[doc.id];
          delete docHistory[doc.id];
        }
        state.activeDocId = data.document.id;
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
      saveText.textContent = 'Enregistré';
      dirty = false;
      
      renderNav();
      updateBreadcrumbAndMeta();
    }
  } catch (err) {
    console.error('Error auto-saving:', err);
    saveText.textContent = 'Erreur de sauvegarde';
  }
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
    }
  } catch (err) {
    console.error(err);
  }
}

async function deleteDocument(docId) {
  if (!confirm('Supprimer définitivement ce document du disque ?')) return;
  
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
    } else {
      alert(data.error || 'Erreur lors de la création de la section');
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
      // If active doc was inside this renamed section, update its ID prefix
      if (state.activeDocId && state.activeDocId.startsWith(oldId + '/')) {
        state.activeDocId = state.activeDocId.replace(oldId + '/', data.id + '/');
      }
      await fetchWorkspace();
    } else {
      alert(data.error || 'Erreur lors du renommage');
    }
  } catch (err) {
    console.error(err);
  }
}

async function deleteSection(sectionId) {
  const section = state.sections.find(s => s.id === sectionId);
  if (!section) return;
  
  const count = section.documents.length;
  if (count > 0 && !confirm(`La section "${section.name}" contient ${count} documents. Tout supprimer définitivement du disque ?`)) {
    return;
  } else if (count === 0 && !confirm(`Supprimer la section "${section.name}" ?`)) {
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
      // Clear active doc if deleted
      if (state.activeDocId && state.activeDocId.startsWith(sectionId + '/')) {
        state.activeDocId = null;
      }
      await fetchWorkspace();
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
    } else {
      alert(data.error || 'Erreur lors de la création du thème');
    }
  } catch (err) {
    console.error(err);
  }
}

async function deleteTheme(id) {
  const theme = state.ideaThemes.find(t => t.id === id);
  if (!theme) return;
  
  if (!confirm(`Supprimer le thème d'idées "${theme.name}" ?`)) return;
  
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
  const d = new Date(ts);
  const months = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "aujourd'hui";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "hier";
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${months[d.getMonth()]}`;
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Render Sidebar Navigation
function renderNav() {
  nav.innerHTML = '';
  
  if (state.sections.length === 0) {
    nav.innerHTML = '<div class="ideas-empty">Aucune section. Créez-en une avec le bouton ci-dessous.</div>';
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
        <button class="icon-btn" data-act="rename" title="Renommer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="icon-btn" data-act="add" title="Ajouter doc">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        ${section.id !== '_general' ? `
        <button class="icon-btn" data-act="delete" title="Supprimer section">
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
        alert('Impossible de renommer la section Général');
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
    
    section.documents.forEach(doc => {
      const item = document.createElement('div');
      item.className = 'nav-item' + (doc.id === state.activeDocId ? ' active' : '');
      item.draggable = true;
      item.innerHTML = `
        <span class="label">${escapeHtml(doc.title || 'Sans titre')}</span>
        <span class="meta">${relDate(doc.updatedAt)}</span>
        <button class="delete-doc" title="Supprimer">
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
    breadcrumb.innerHTML = '<span>Aucun document</span>';
    docMeta.innerHTML = '';
    updateStats();
    if (typeof generateTOC === 'function') generateTOC();
    return;
  }
  
  title.value = doc.title;
  subtitle.value = doc.subtitle;
  loadContentMarkdown(doc.content);

  updateBreadcrumbAndMeta();
  autoGrow(title);
  autoGrow(subtitle);
  updateStats();

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
  const sectionName = parts[0] === '_general' ? 'Général' : parts[0];
  // Fallback to extracting from id if the doc object doesn't carry .filename
  const filename = doc.filename || (parts[1] || '');

  breadcrumb.innerHTML = `
    <span>${escapeHtml(sectionName)}</span>
    <span class="sep">/</span>
    <span class="current">${escapeHtml(doc.title || 'Sans titre')}</span>
    ${filename ? `<span class="sep">/</span><span class="breadcrumb-filename" title="Cliquer pour copier le nom du fichier">${escapeHtml(filename)}</span>` : ''}
  `;

  docMeta.innerHTML = `
    <span>${escapeHtml(sectionName.toLowerCase())}</span>
    <span>·</span>
    ${filename ? `<span class="doc-meta-filename" title="Nom du fichier sur disque — cliquer pour copier">${escapeHtml(filename)}</span><span>·</span>` : ''}
    <span>créé ${relDate(doc.createdAt)}</span>
    <span>·</span>
    <span>modifié ${relDate(doc.updatedAt)}</span>
  `;

  // Copy filename to clipboard on click (both locations)
  const onFilenameClick = async (e) => {
    if (!filename) return;
    try {
      await navigator.clipboard.writeText(filename);
      e.target.classList.add('copied');
      const prev = e.target.textContent;
      e.target.textContent = '✓ copié';
      setTimeout(() => {
        e.target.classList.remove('copied');
        e.target.textContent = prev;
      }, 1100);
    } catch (_) { /* clipboard denied — silent */ }
  };
  const fnInMeta = docMeta.querySelector('.doc-meta-filename');
  if (fnInMeta) fnInMeta.addEventListener('click', onFilenameClick);
  const fnInBc = breadcrumb.querySelector('.breadcrumb-filename');
  if (fnInBc) fnInBc.addEventListener('click', onFilenameClick);
}

// Render theme tabs
function renderThemesTabs() {
  themesTabs.innerHTML = '';
  
  state.ideaThemes.forEach(theme => {
    const tab = document.createElement('button');
    tab.className = 'theme-tab' + (theme.id === state.activeThemeId ? ' active' : '');
    tab.innerHTML = `<span>${escapeHtml(theme.name)}</span><span class="delete-theme" title="Supprimer">×</span>`;
    
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
    themesTabs.appendChild(tab);
  });
  
  const addBtn = document.createElement('button');
  addBtn.className = 'theme-tab add';
  addBtn.textContent = '+ thème';
  addBtn.addEventListener('click', () => {
    const name = prompt('Nom du thème ?');
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
    ideasList.innerHTML = '<div class="ideas-empty">Aucun thème — créez-en un avec le bouton + thème.</div>';
    activeCountEl.textContent = '';
    archivedCountEl.textContent = '';
    return;
  }

  const active = theme.ideas.filter(i => !i.archived);
  const archived = theme.ideas.filter(i => i.archived);
  activeCountEl.textContent = active.length ? `(${active.length})` : '';
  archivedCountEl.textContent = archived.length ? `(${archived.length})` : '';

  const shown = state.ideasMode === 'archived' ? archived : active;

  if (shown.length === 0) {
    ideasList.innerHTML = `<div class="ideas-empty">${state.ideasMode === 'archived' ? 'Aucune idée archivée.' : 'Aucune idée — ajoutez-en une.'}</div>`;
  } else {
    shown.forEach(idea => {
      const chip = document.createElement('div');
      
      // Calculate font size class depending on text length to create a cloud effect
      const sizeClass = `s-${1 + (idea.text.length % 4)}`;
      chip.className = `idea-chip ${sizeClass}` + (idea.archived ? ' archived' : '');
      chip.title = idea.text;
      chip.dataset.id = idea.id;
      chip.setAttribute('tabindex', '0');
      
      const textEl = document.createElement('span');
      textEl.className = 'idea-text';
      textEl.textContent = idea.text;
      chip.appendChild(textEl);
      
      const actionsEl = document.createElement('div');
      actionsEl.className = 'chip-actions';

      // Insert button (plus icon)
      const insertBtn = document.createElement('button');
      insertBtn.className = 'chip-action-btn insert-btn';
      insertBtn.title = "Insérer au curseur";
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
      editBtn.title = "Modifier";
      editBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startEditingIdea(idea, theme, chip);
      });

      // Archive / Restore button (checkmark or restore icon)
      const archiveBtn = document.createElement('button');
      archiveBtn.className = 'chip-action-btn archive-btn';

      if (idea.archived) {
        archiveBtn.title = "Désarchiver";
        archiveBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
        archiveBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleIdea(theme.id, idea.text, false);
        });
      } else {
        archiveBtn.title = "Archiver";
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
      deleteBtn.title = "Supprimer (5 s pour annuler)";
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

      ideasList.appendChild(chip);
    });
  }

  // add idea button
  if (state.ideasMode === 'active') {
    const addBtn = document.createElement('button');
    addBtn.className = 'idea-add';
    addBtn.textContent = '+ ajouter une idée';
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

function startDeleting(themeId, ideaText, chip) {
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
    }
    renderIdeas();
  } catch (err) {
    console.error('Failed to delete idea:', err);
    alert('Erreur lors de la suppression de l’idée');
    renderIdeas();
  }
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
  } catch (err) {
    console.error('Failed to edit idea:', err);
    alert('Erreur lors de la modification de l’idée');
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
  
  const currentState = {
    title: title.value,
    subtitle: subtitle.value,
    content: getContentMarkdown(),
    selectionStart: 0,
    selectionEnd: 0
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

function updateStats() {
  const text = getContentMarkdown().trim();
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const chars = getContentMarkdown().length;
  const minutes = words ? Math.max(1, Math.round(words / 220)) : 0;
  wcEl.textContent = words.toLocaleString('fr-FR');
  ccEl.textContent = chars.toLocaleString('fr-FR');
  rtEl.textContent = minutes + ' min';
  updateCursor();
}

function updateCursor() {
  if (activeLineNode) {
    const index = Array.from(content.children).indexOf(activeLineNode);
    const caretOffset = getCaretCharacterOffsetWithin(activeLineNode);
    cursorEl.textContent = `ln ${index + 1} · col ${caretOffset + 1}`;
  } else {
    cursorEl.textContent = `ln 1 · col 1`;
  }
}

function markDirty() {
  dirty = true;
  saveIndicator.classList.remove('saved');
  saveIndicator.classList.add('dirty');
  saveText.textContent = 'Modifié…';
  
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveDocumentOnDisk();
  }, 600);
}

function insertTextAtCaret(text) {
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
    return `<span class="math-error" title="${escapeHtml(e.message || 'Erreur LaTeX')}">${escapeHtml(formula)}</span>`;
  }
}

let activeLineNode = null;

function renderMarkdownLine(line) {
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
  content.innerHTML = '';
  const lines = markdown.split('\n');
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
  const t = raw;
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
    info: 'Info', tip: 'Astuce', note: 'Note', success: 'Succès',
    warning: 'Attention', danger: 'Danger', error: 'Erreur', quote: 'Citation',
    abstract: 'Résumé', todo: 'À faire', question: 'Question', failure: 'Échec',
    bug: 'Bug', example: 'Exemple', cite: 'Citation'
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

function makeLineRawAndActive(line) {
  if (!line) return;
  const raw = (line.dataset.raw !== undefined) ? line.dataset.raw : line.textContent;
  line.dataset.raw = raw;
  line.textContent = raw;
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

function updateActiveLine() {
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
      // Transition old active line to rendered HTML
      if (activeLineNode && content.contains(activeLineNode)) {
        const raw = activeLineNode.textContent;
        activeLineNode.dataset.raw = raw;
        applyLineKind(activeLineNode, raw);
        activeLineNode.innerHTML = raw.trim() === '' ? '<br>' : renderMarkdownLine(raw);
        activeLineNode.classList.remove('active-line');
      }

      // Transition new active line to raw text
      activeLineNode = node;
      activeLineNode.classList.add('active-line');

      const rawText = activeLineNode.dataset.raw !== undefined ? activeLineNode.dataset.raw : activeLineNode.textContent;
      const offset = getCaretCharacterOffsetWithin(activeLineNode);

      activeLineNode.textContent = rawText;
      applyLineKind(activeLineNode, rawText);
      setCaretPosition(activeLineNode, offset);
      // Re-group / re-highlight after leaving a possible code/callout/table line
      debouncedPostProcess();
    }
  } else {
    // Clicked outside content lines
    if (activeLineNode && content.contains(activeLineNode)) {
      const raw = activeLineNode.textContent;
      activeLineNode.dataset.raw = raw;
      applyLineKind(activeLineNode, raw);
      activeLineNode.innerHTML = raw.trim() === '' ? '<br>' : renderMarkdownLine(raw);
      activeLineNode.classList.remove('active-line');
      activeLineNode = null;
      debouncedPostProcess();
    }
  }
}

function wrapSelectionInline(prefix, suffix = prefix) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !activeLineNode) return;
  
  const range = sel.getRangeAt(0);
  if (!activeLineNode.contains(range.startContainer)) return;
  
  saveHistory(state.activeDocId, true);
  
  const startOffset = range.startOffset;
  const endOffset = range.endOffset;
  const text = activeLineNode.textContent;
  
  const selectedText = text.substring(startOffset, endOffset);
  const replacement = prefix + selectedText + suffix;
  
  document.execCommand('insertText', false, replacement);
  
  const textNode = activeLineNode.firstChild;
  if (textNode) {
    const newStart = startOffset + prefix.length;
    const newEnd = newStart + selectedText.length;
    range.setStart(textNode, newStart);
    range.setEnd(textNode, newEnd);
    sel.removeAllRanges();
    sel.addRange(range);
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

// Settings Modal Events
$('openSettingsBtn').addEventListener('click', () => {
  workspacePathInput.value = state.workspaceDir;
  settingsModal.classList.add('active');
});

$('closeSettingsBtn').addEventListener('click', () => settingsModal.classList.remove('active'));
$('cancelSettingsBtn').addEventListener('click', () => settingsModal.classList.remove('active'));

$('saveSettingsBtn').addEventListener('click', async () => {
  const newPath = workspacePathInput.value.trim();
  if (!newPath) return;
  
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPath })
    });
    const data = await res.json();
    if (data.success) {
      settingsModal.classList.remove('active');
      state.activeDocId = null;
      state.activeThemeId = null;
      await fetchWorkspace();
    }
  } catch (err) {
    alert('Erreur lors du changement de dossier de travail.');
  }
});

$('openFolderBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/open-folder', { method: 'POST' });
  } catch (err) {
    console.error(err);
  }
});

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
        addBtn.textContent = 'Déposer pour ajouter l\'idée';
      }
    }
  }
});

ideasPanel.addEventListener('dragleave', () => {
  ideasPanel.classList.remove('drag-over');
  const addBtn = ideasPanel.querySelector('.idea-add');
  if (addBtn) {
    addBtn.classList.remove('drag-target-active');
    addBtn.textContent = '+ ajouter une idée';
  }
});

ideasPanel.addEventListener('drop', async (e) => {
  ideasPanel.classList.remove('drag-over');
  const addBtn = ideasPanel.querySelector('.idea-add');
  if (addBtn) {
    addBtn.classList.remove('drag-target-active');
    addBtn.textContent = '+ ajouter une idée';
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
      alert("Veuillez sélectionner ou créer un thème d'idées d'abord.");
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

// Editor interactions
content.addEventListener('input', () => {
  // Live-update the line kind so headings/lists/etc. grow/shrink as you type their prefix
  if (activeLineNode && content.contains(activeLineNode)) {
    applyLineKind(activeLineNode, activeLineNode.textContent);
  }
  updateStats();
  markDirty();
  saveHistory(state.activeDocId, false);
  debouncedRegenerateTOC();
  // Re-group code blocks / re-highlight / refresh callouts after typing settles
  debouncedPostProcess();
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
$('addSectionBtn').addEventListener('click', () => {
  const name = prompt('Nom de la nouvelle section (dossier) ?');
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

// Save on exit
window.addEventListener('beforeunload', () => {
  if (dirty) {
    saveDocumentOnDisk();
  }
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
    searchResultsEl.innerHTML = '<div class="search-placeholder">Tapez pour rechercher dans tous vos textes et idées…</div>';
    searchCountEl.textContent = '';
    currentSearchResults = [];
    searchSelectedIndex = -1;
    return;
  }
  const qn = normalizeSearch(q);
  const results = [];

  // --- Documents ---
  state.sections.forEach(section => {
    const sectionLabel = section.id === '_general' ? 'Général' : section.name;
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
        title: doc.title || 'Sans titre',
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
    searchResultsEl.innerHTML = '<div class="search-empty">Aucun résultat.</div>';
    searchCountEl.textContent = '0';
    searchSelectedIndex = -1;
    return;
  }
  searchCountEl.textContent = `${results.length} résultat${results.length > 1 ? 's' : ''}`;
  const q = results[0].query;
  searchResultsEl.innerHTML = results.map((r, i) => {
    const titleHi = highlightAndEscape(r.title, q);
    const typeCls = r.type === 'idea' ? 'type-idea' : 'type-doc';
    const typeLabel = r.type === 'idea' ? (r.archived ? 'idée arch.' : 'idée') : 'doc';
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
  searchResultsEl.innerHTML = '<div class="search-placeholder">Tapez pour rechercher dans tous vos textes et idées…</div>';
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
  return content.querySelectorAll(
    '.editor-line h1, .editor-line h2, .editor-line h3, .editor-line h4, .editor-line h5, .editor-line h6'
  );
}

function generateTOC() {
  const headings = Array.from(getEditorHeadings());

  // Assign stable IDs once
  headings.forEach((h, i) => { h.id = `toc-h-${i}`; });

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
  headings.forEach(h => {
    const id = h.id;
    const level = parseInt(h.tagName.substring(1), 10) || 1;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = `toc-link level-${level}`;
    a.dataset.targetId = id;
    a.dataset.level = level;
    const text = (h.textContent || '').trim() || '—';
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

function updateTOCSvgSize() {
  TOC_INSTANCES.forEach(({ list, svg }) => {
    if (!svg || !list) return;
    if (!list.offsetParent) return; // hidden — skip
    const w = list.offsetWidth;
    const h = list.offsetHeight;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w || 1} ${h || 1}`);
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
  if (lvl <= 1) return -1;
  if (lvl === 2) return 11;
  if (lvl === 3) return 23;
  if (lvl === 4) return 35;
  return 47;
}

function updateTOCActiveState() {
  const headings = Array.from(getEditorHeadings());
  if (!headings.length) return;

  // Compute active set once (shared between both instances)
  const containerRect = editorWrap.getBoundingClientRect();
  const buffer = 12;

  let activeHeadings = headings.filter(h => {
    const rect = h.getBoundingClientRect();
    const relTop = rect.top - containerRect.top;
    const relBottom = rect.bottom - containerRect.top;
    return relTop < containerRect.height - buffer && relBottom > buffer;
  });

  if (!activeHeadings.length) {
    for (let i = headings.length - 1; i >= 0; i--) {
      const rect = headings[i].getBoundingClientRect();
      if (rect.top - containerRect.top <= 100) {
        activeHeadings.push(headings[i]);
        break;
      }
    }
  }
  if (!activeHeadings.length) activeHeadings.push(headings[0]);
  const activeIds = new Set(activeHeadings.map(h => h.id));

  // Apply to both instances
  TOC_INSTANCES.forEach(({ list, path }) => applyActiveToInstance(list, path, activeIds));
}

function applyActiveToInstance(listNode, pathNode, activeIds) {
  if (!listNode || !pathNode) return;
  // Skip hidden instances — offsetParent is null when display:none on any ancestor.
  // (Otherwise offsetTop returns 0 for every link, producing a degenerate path.)
  if (!listNode.offsetParent) return;
  const links = Array.from(listNode.querySelectorAll('.toc-link'));
  if (!links.length) return;

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
  app.classList.toggle('focus-mode');
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
const panelTabIdeas = $('panelTabIdeas');
const panelTabToc = $('panelTabToc');

function setRightPanelView(view) {
  const isToc = view === 'toc';
  ideasPanel.classList.toggle('view-toc-mode', isToc);
  if (panelTabIdeas) panelTabIdeas.classList.toggle('active', !isToc);
  if (panelTabToc)   panelTabToc.classList.toggle('active', isToc);
  try { localStorage.setItem('rightPanelView', view); } catch (e) {}
  if (isToc) {
    // Recompute SVG sizes now that the side container is visible
    setTimeout(() => { updateTOCSvgSize(); scheduleTOCActiveUpdate(); }, 30);
  }
}

if (panelTabIdeas) panelTabIdeas.addEventListener('click', () => setRightPanelView('ideas'));
if (panelTabToc)   panelTabToc.addEventListener('click', () => setRightPanelView('toc'));

// Restore preferred view
try {
  const stored = localStorage.getItem('rightPanelView');
  if (stored === 'toc') setRightPanelView('toc');
} catch (e) {}

// ============ INLINE SELECTION TOOLBAR + BLOCK-ADD GUTTER BUTTON ============

const selToolbar = $('selToolbar');
const blockAddBtn = $('blockAddBtn');
const blockMenu = $('blockMenu');

let selToolbarTimer;
let blockBtnTimer;

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
}

function hideSelectionToolbar() {
  if (selToolbar) selToolbar.classList.remove('visible');
}

document.addEventListener('selectionchange', () => {
  clearTimeout(selToolbarTimer);
  selToolbarTimer = setTimeout(showSelectionToolbar, 40);
  clearTimeout(blockBtnTimer);
  blockBtnTimer = setTimeout(updateBlockAddPosition, 40);
});
editorWrap.addEventListener('scroll', () => { hideSelectionToolbar(); updateBlockAddPosition(); closeBlockMenu(); });
window.addEventListener('resize', () => { hideSelectionToolbar(); updateBlockAddPosition(); closeBlockMenu(); });

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
  // Ensure the line containing the selection is in active/raw mode so the
  // wrap/prefix operations target raw markdown, not rendered HTML.
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const line = getLineForNode(range.startContainer) || getLineForNode(range.endContainer);
  if (line && line !== activeLineNode) {
    makeLineRawAndActive(line);
    // Re-derive offsets within the raw line and reselect
    // (textContent of raw line === raw markdown)
    const newRange = document.createRange();
    const tn = line.firstChild;
    if (tn && tn.nodeType === Node.TEXT_NODE) {
      newRange.setStart(tn, 0);
      newRange.setEnd(tn, tn.nodeValue.length);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
  }

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
  }
  // Re-position the toolbar over the (possibly shifted) selection
  setTimeout(showSelectionToolbar, 30);
}

function insertLinkAroundSelection() {
  const url = prompt('URL ?', 'https://');
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

function setLineBlockType(kind) {
  if (!activeLineNode) return;
  saveHistory(state.activeDocId, true);
  const text = activeLineNode.textContent;
  const inner = stripBlockPrefix(text);
  let newText = inner;
  switch (kind) {
    case 'p':     newText = inner; break;
    case 'h1':    newText = '# '    + inner; break;
    case 'h2':    newText = '## '   + inner; break;
    case 'h3':    newText = '### '  + inner; break;
    case 'h4':    newText = '#### ' + inner; break;
    case 'h5':    newText = '##### '+ inner; break;
    case 'h6':    newText = '######'+ ' ' + inner; break;
    case 'ul':    newText = '- '    + inner; break;
    case 'ol':    newText = '1. '   + inner; break;
    case 'task':  newText = '- [ ] '+ inner; break;
    case 'quote': newText = '> '    + inner; break;
  }
  activeLineNode.textContent = newText;
  activeLineNode.dataset.raw = newText;
  applyLineKind(activeLineNode, newText);
  setCaretInLine(activeLineNode, newText.length);
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
  const gap = Math.max(0, rect.left); // distance from viewport left to line
  const desiredOffset = 30;
  const minOffset = 10;
  const offset = Math.max(minOffset, Math.min(desiredOffset, gap - 4));
  const left = rect.left - offset;
  const top = rect.top + (rect.height / 2) - 11;

  // Last-resort: if the button would go off-screen, hide it.
  if (left < 2) {
    blockAddBtn.classList.remove('visible');
    return;
  }

  blockAddBtn.style.top = top + 'px';
  blockAddBtn.style.left = left + 'px';
  blockAddBtn.classList.add('visible');
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
  // For "hr", replace the active line with --- (if empty) or insert below.
  if (kind === 'hr') {
    saveHistory(state.activeDocId, true);
    if (activeLineNode.textContent.trim() === '') {
      activeLineNode.textContent = '---';
      activeLineNode.dataset.raw = '---';
      applyLineKind(activeLineNode, '---');
    } else {
      const hr = makeLineNode('---');
      activeLineNode.parentNode.insertBefore(hr, activeLineNode.nextSibling);
    }
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

// ============ INITIALIZATION ============

function renderAll() {
  renderNav();
  renderThemesTabs();
  renderIdeas();
  loadActiveDoc();
}

// Start
fetchWorkspace();

document.addEventListener('selectionchange', updateActiveLine);

content.addEventListener('click', (e) => {
  if (e.target === content) {
    const lastLine = content.lastChild;
    if (lastLine && lastLine.classList.contains('editor-line')) {
      lastLine.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(lastLine);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
});

// Prevent deletion of source text from contenteditable on drag drop
content.addEventListener('dragstart', (e) => {
  e.dataTransfer.effectAllowed = 'copy';
});

setTimeout(() => content.focus(), 100);
