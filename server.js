const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Bind to loopback unless explicitly told otherwise. Serving the API on
// 0.0.0.0 hands every device on the LAN full read/write access to the
// workspace, so exposing it is an opt-in that also turns the token on.
const HOST = process.env.HOST || process.env.SCRIPTORIUM_HOST || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
const isLoopbackHost = (h) => LOOPBACK_HOSTS.has(String(h || '').replace(/^\[|\]$/g, ''));
const LOOPBACK_ONLY = isLoopbackHost(HOST);

// Simple server-side i18n: accepts Accept-Language header or ?lang= query param.
// Falls back to English if the requested locale is not 'fr'.
const LOCALE_MESSAGES = {
  en: require('./locales/en.json'),
  fr: require('./locales/fr.json'),
};

function serverMsg(req, key, vars) {
  var lang = 'en';
  if (req && req.query && req.query.lang === 'fr') lang = 'fr';
  else if (req && req.headers && req.headers['accept-language'] && req.headers['accept-language'].startsWith('fr')) lang = 'fr';
  var msg = (LOCALE_MESSAGES[lang] && LOCALE_MESSAGES[lang][key]) || key;
  if (vars) {
    for (var k in vars) {
      if (vars.hasOwnProperty(k)) msg = msg.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k]));
    }
  }
  return msg;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Determine client language from request (query param or Accept-Language header)
function getLang(req) {
  if (req && req.query && req.query.lang === 'fr') return 'fr';
  if (req && req.headers && req.headers['accept-language'] && req.headers['accept-language'].startsWith('fr')) return 'fr';
  return 'en';
}

// Persistent config
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CUSTOM_THEME_FILE = path.join(__dirname, 'theme.custom.json');
let workspaceDir = path.join(require('os').homedir(), 'Scriptorium');
let ideasDirSetting = '';

// User preferences live in <workspace>/.scriptorium/settings.json so every
// workspace is an independent, portable unit (theme, fonts, backgrounds,
// icons, spacing, language, …).
function getSettingsFile() {
  return path.join(getScriptoriumDir(), 'settings.json');
}
function loadWorkspaceSettings() {
  try {
    if (fs.existsSync(getSettingsFile())) {
      const data = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8'));
      return (data && typeof data === 'object') ? data : {};
    }
  } catch (err) {
    console.error('Error loading workspace settings:', err);
  }
  return {};
}
function saveWorkspaceSettings(settings) {
  try {
    fs.mkdirSync(getScriptoriumDir(), { recursive: true });
    fs.writeFileSync(getSettingsFile(), JSON.stringify(settings || {}, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving workspace settings:', err);
    return false;
  }
}
let accessToken = '';
let workspaceLocked = false;
// False until config.json records a workspace: the client then shows the
// first-launch chooser instead of silently using the ~/Scriptorium default.
let workspaceConfigured = false;

function loadCustomTheme() {
  try {
    if (fs.existsSync(CUSTOM_THEME_FILE)) {
      return JSON.parse(fs.readFileSync(CUSTOM_THEME_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading custom theme:', err);
  }
  return null;
}

// All app-managed data lives in one hidden folder at the workspace root, so a
// workspace is a complete portable unit. Subfolders: themes, fonts, media,
// icons, snapshots, plus settings.json for the user preferences.
function getScriptoriumDir() {
  return path.join(workspaceDir, '.scriptorium');
}

// Named custom colour themes, one JSON file per theme in
// <workspace>/.scriptorium/themes/. Each file holds { name, vars } where vars
// maps CSS variable -> hex colour.
function getThemesDir() {
  return path.join(getScriptoriumDir(), 'themes');
}

function ensureThemesDir() {
  const dir = getThemesDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    console.error('Error creating themes dir:', err);
    return null;
  }
}

function listColorThemes() {
  const dir = getThemesDir();
  const themes = [];
  if (!fs.existsSync(dir)) return themes;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (data && typeof data === 'object' && data.vars) {
        themes.push({
          id,
          name: (typeof data.name === 'string' && data.name.trim()) ? data.name : id,
          vars: data.vars,
          fonts: (data.fonts && typeof data.fonts === 'object') ? data.fonts : null
        });
      }
    } catch (err) {
      console.error('Error reading theme', file, err);
    }
  }
  return themes;
}

// The pre-2.x single custom theme (theme.custom.json) becomes a theme named
// "Custom" in the new .themes folder, so nothing the user built is lost.
function migrateLegacyCustomTheme() {
  if (!fs.existsSync(CUSTOM_THEME_FILE)) return;
  const dir = ensureThemesDir();
  if (!dir) return;
  const target = path.join(dir, 'custom.json');
  if (fs.existsSync(target)) return;
  try {
    const vars = JSON.parse(fs.readFileSync(CUSTOM_THEME_FILE, 'utf8'));
    if (vars && typeof vars === 'object') {
      fs.writeFileSync(target, JSON.stringify({ name: 'Custom', vars }, null, 2), 'utf8');
    }
  } catch (err) {
    console.error('Error migrating legacy custom theme:', err);
  }
}

function slugifyThemeName(name) {
  return String(name || 'theme').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'theme';
}

// Background media (image or video) the user puts into <workspace>/.media/,
// shown behind the whole app with a configurable opacity.
const MEDIA_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
const MEDIA_VIDEO_EXT = ['.mp4', '.webm', '.mov', '.ogv'];

function getMediaDir() {
  return path.join(getScriptoriumDir(), 'media');
}

function listMediaFiles() {
  const dir = getMediaDir();
  const items = [];
  if (!fs.existsSync(dir)) return items;
  for (const file of fs.readdirSync(dir)) {
    const ext = path.extname(file).toLowerCase();
    const type = MEDIA_IMAGE_EXT.includes(ext) ? 'image' : MEDIA_VIDEO_EXT.includes(ext) ? 'video' : null;
    if (!type) continue;
    items.push({ id: file, name: path.basename(file, ext).replace(/[_-]+/g, ' ').trim() || file, url: '/media/' + encodeURIComponent(file), type });
  }
  return items;
}

// Custom UI icons the user imports into <workspace>/.icons/ (SVG, or raster
// like PNG/WebP/ICO displayed as-is), replaceable per theme.
const ICON_EXTENSIONS = ['.svg', '.png', '.webp', '.ico', '.jpg', '.jpeg'];

function getIconsDir() {
  return path.join(getScriptoriumDir(), 'icons');
}

function listIconFiles() {
  const dir = getIconsDir();
  const items = [];
  if (!fs.existsSync(dir)) return items;
  for (const file of fs.readdirSync(dir)) {
    const ext = path.extname(file).toLowerCase();
    if (!ICON_EXTENSIONS.includes(ext)) continue;
    items.push({
      id: file,
      name: path.basename(file, ext).replace(/[_-]+/g, ' ').trim() || file,
      url: '/icons/' + encodeURIComponent(file),
      svg: ext === '.svg'
    });
  }
  return items;
}

// Custom fonts the user drops into <workspace>/.fonts/, offered alongside the
// built-in font choices for the UI and the editor.
const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'];

function getFontsDir() {
  return path.join(getScriptoriumDir(), 'fonts');
}

function listCustomFonts() {
  const dir = getFontsDir();
  const fonts = [];
  if (!fs.existsSync(dir)) return fonts;
  for (const file of fs.readdirSync(dir)) {
    const ext = path.extname(file).toLowerCase();
    if (!FONT_EXTENSIONS.includes(ext)) continue;
    const name = path.basename(file, ext).replace(/[_-]+/g, ' ').trim() || file;
    fonts.push({ id: file, name, url: '/fonts/' + encodeURIComponent(file), ext });
  }
  return fonts;
}

function getIdeasDir() {
  if (ideasDirSetting && ideasDirSetting.trim() !== '') {
    return path.resolve(ideasDirSetting.trim());
  }
  return path.join(workspaceDir, 'ideas');
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data.workspaceDir) {
        workspaceDir = data.workspaceDir;
        workspaceConfigured = true;
      }
      if (data.ideasDir !== undefined) {
        ideasDirSetting = data.ideasDir;
      }
      if (typeof data.accessToken === 'string') {
        accessToken = data.accessToken;
      }
      if (typeof data.locked === 'boolean') {
        workspaceLocked = data.locked;
      }
    }
  } catch (err) {
    console.error('Error loading config:', err);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      // An env override is for this run only — it must not leak into the file.
      workspaceDir: process.env.SCRIPTORIUM_WORKSPACE ? configuredWorkspaceDir : workspaceDir,
      ideasDir: ideasDirSetting,
      accessToken,
      locked: workspaceLocked
    }, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving config:', err);
  }
}

loadConfig();

// Lets you run against a throwaway workspace (tests, a second corpus) without
// touching the saved config: SCRIPTORIUM_WORKSPACE=/tmp/scratch npm start
let configuredWorkspaceDir = workspaceDir;
if (process.env.SCRIPTORIUM_WORKSPACE) {
  workspaceDir = path.resolve(process.env.SCRIPTORIUM_WORKSPACE);
  // An explicit override counts as configured for this run.
  workspaceConfigured = true;
  console.log(`Workspace overridden by SCRIPTORIUM_WORKSPACE: ${workspaceDir}`);
}

// A token is only meaningful once the server is reachable from outside this
// machine; on loopback the OS already scopes access to the local user.
if (!LOOPBACK_ONLY && !accessToken) {
  accessToken = crypto.randomBytes(24).toString('base64url');
  saveConfig();
}

// ============ PATH SAFETY ============
// Every path the client can influence goes through here. Without it, a section
// id like "../../.." escapes the workspace and reaches the rest of the disk —
// including fs.rmSync(recursive) on DELETE /api/sections.

class PathError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// One path segment: a folder or file name, never a path.
function assertSegment(value, label, req) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new PathError(serverMsg(req, 'server.error_path_missing', { label: label }));
  if (s === '.' || s === '..') throw new PathError(serverMsg(req, 'server.error_path_invalid', { label: label }));
  if (/[\\/]/.test(s)) throw new PathError(serverMsg(req, 'server.error_path_separator', { label: label }));
  if (/[\0<>:"|?*]/.test(s)) throw new PathError(serverMsg(req, 'server.error_path_forbidden_char', { label: label }));
  // Reserved device names on Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s)) {
    throw new PathError(serverMsg(req, 'server.error_path_reserved', { label: label }));
  }
  return s;
}

// Join under `base` and refuse anything that lands outside it, even via
// symlink-free trickery like "a/../../b".
function safeJoin(base, ...segments) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new PathError(serverMsg(null, 'server.error_path_outside'));
  }
  return target;
}

// "<section>/<filename>" as produced by the client. `_general` means the
// workspace root itself.
function resolveDocPath(id, req) {
  if (typeof id !== 'string' || !id.includes('/')) {
    throw new PathError(serverMsg(req, 'server.error_invalid_doc_id'));
  }
  const slash = id.indexOf('/');
  const sectionId = id.slice(0, slash);
  const filename = assertSegment(id.slice(slash + 1), 'Nom de fichier', req);
  if (!/\.(md|markdown|txt)$/i.test(filename)) {
    throw new PathError(serverMsg(req, 'server.error_extension'));
  }
  const folder = resolveSectionFolder(sectionId, req);
  return { sectionId, filename, folder, fullPath: safeJoin(folder, filename) };
}

function resolveSectionFolder(sectionId, req) {
  if (sectionId === '_general') return path.resolve(workspaceDir);
  return safeJoin(workspaceDir, assertSegment(sectionId, 'Section', req));
}

function resolveThemeFile(themeId, req) {
  const id = assertSegment(themeId, 'Thème');
  return safeJoin(getIdeasDir(), `${id.replace(/\.(md|markdown|txt)$/i, '')}.md`);
}

// Wraps a route so PathError becomes a clean 400 instead of a 500 stack.
function guarded(handler) {
  return (req, res) => {
    try {
      return handler(req, res);
    } catch (err) {
      if (err instanceof PathError) return res.status(err.status).json({ error: err.message });
      console.error('Route error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  };
}

// Destructive routes respect the padlock in the UI. Previously the lock was
// purely cosmetic: the API deleted regardless of it.
function requireUnlocked(req, res) {
  if (workspaceLocked) {
    res.status(423).json({ error: serverMsg(req, 'server.error_workspace_locked') });
    return false;
  }
  return true;
}

// ============ ACCESS GUARDS ============

function hostnameOf(value) {
  const s = String(value || '');
  const m = s.match(/^\[([^\]]+)\]/); // [::1]:3000
  if (m) return m[1];
  return s.split(':')[0];
}

// A page on any other origin must not be able to drive this API. Dropping the
// permissive CORS layer makes browsers preflight cross-origin JSON calls and
// get refused; this check covers the rest (and DNS rebinding on loopback).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return res.status(403).json({ error: serverMsg(req, 'server.error_origin_refused') });
    }
    if (originHost !== hostnameOf(req.headers.host)) {
      return res.status(403).json({ error: serverMsg(req, 'server.error_origin_refused') });
    }
  }
  if (LOOPBACK_ONLY && !isLoopbackHost(hostnameOf(req.headers.host))) {
    return res.status(403).json({ error: serverMsg(req, 'server.error_host_refused') });
  }
  next();
});

// When the server is reachable from the LAN (phone, tablet), every API call
// must carry the token printed at startup.
app.use('/api', (req, res, next) => {
  if (!accessToken) return next();
  const provided = req.get('x-scriptorium-token') || req.query.token;
  if (provided && crypto.timingSafeEqual(
    Buffer.from(String(provided).padEnd(accessToken.length).slice(0, accessToken.length)),
    Buffer.from(accessToken)
  )) {
    return next();
  }
  res.status(401).json({ error: serverMsg(req, 'server.error_token_missing') });
});

// ============ VENDORED ASSETS ============
// Served from node_modules instead of a CDN: the app writes to your own disk
// and must keep working with no network — offline, on a plane, on a phone that
// dropped its connection. Without this, formulas fall back to inline code,
// code blocks lose their colours and the typography reverts to system fonts.
const VENDOR_MOUNTS = {
  '/vendor/katex': 'katex/dist',
  // @highlightjs/cdn-assets, not highlight.js: the main package only ships
  // CommonJS, which a browser cannot import. This one is the browser build.
  '/vendor/highlight': '@highlightjs/cdn-assets',
  '/vendor/fonts/inter': '@fontsource/inter',
  '/vendor/fonts/newsreader': '@fontsource/newsreader',
  '/vendor/fonts/jetbrains-mono': '@fontsource/jetbrains-mono'
};
for (const [route, pkg] of Object.entries(VENDOR_MOUNTS)) {
  const dir = path.join(__dirname, 'node_modules', pkg);
  if (fs.existsSync(dir)) {
    app.use(route, express.static(dir, { maxAge: '30d', immutable: true }));
  } else {
    console.warn(`Asset manquant : ${pkg} — lancez "npm install".`);
  }
}

// No max-age: the files are two hops away on the same machine, and an hour of
// caching meant an edited translation only showed up an hour later. The ETag
// still turns the reload into a 304.
app.use('/locales', express.static(path.join(__dirname, 'locales')));
app.use(express.static(path.join(__dirname, 'public')));

// Images pasted or dropped into a document are saved in <workspace>/assets and
// served here so they render in the editor. The workspace can change at
// runtime, so the static middleware is built per request against the current
// workspaceDir.
app.use('/assets', (req, res, next) => {
  const assetsDir = path.join(workspaceDir, 'assets');
  if (!fs.existsSync(assetsDir)) return res.status(404).end();
  express.static(assetsDir)(req, res, next);
});

// SSE (Server-Sent Events) for real-time workspace updates
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

function broadcastEvent(type, data = {}) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (e) {}
  }
}

let workspaceWatcher = null;
let watcherTimer = null;

function setupWorkspaceWatcher() {
  if (workspaceWatcher) {
    try { workspaceWatcher.close(); } catch (e) {}
    workspaceWatcher = null;
  }
  if (!fs.existsSync(workspaceDir)) return;
  try {
    workspaceWatcher = fs.watch(workspaceDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const base = path.basename(filename);
      if (base.startsWith('.') || filename.includes('.trash') || filename.includes('.snapshots')) return;
      // Only real document edits matter for an external-change reload. Everything
      // else (assets, ideas, the app's own settings writes, and the many spurious
      // events Windows recursive fs.watch emits) would re-fire workspace-changed
      // on the app's own writes and disturb the caret while the user is clicking
      // in the editor.
      if (!/\.(md|markdown|txt)$/i.test(filename)) return;
      clearTimeout(watcherTimer);
      watcherTimer = setTimeout(() => {
        broadcastEvent('workspace-changed', { filename });
      }, 350);
    });
  } catch (err) {}
}

// Bilingual welcome demo written into an empty workspace: a complete guide
// to every feature, one file per language.
const WELCOME_DEMO_EN = `# Welcome to Scriptorium

A distraction-free Markdown editor. Your texts are plain \`.md\` files on your disk, in the folder you chose on first launch.

## First steps

- **New document**: "New text" button in the sidebar, or \`Ctrl+N\`.
- **New section**: "New section" button. A section is a folder; a document is a \`.md\` file inside it.
- **Open a document**: click it in the sidebar.
- **Rename**: change the title in the editor. The file is renamed on save.
- **Move**: right-click a document (long-press on mobile), then pick the section.
- **Import**: drag a \`.md\` file onto a section. Drag it onto the ideas panel to import a theme.
- **Sort**: the sort button in the sidebar toggles alphabetical order and order by date.

## Lock the document

Click **Scriptorium.** at the top left to lock edits and deletions. Click again to unlock.

## The right panel

The button at the top right of the panel cycles between three views:

- **Ideas**: your sentence cloud. A theme is a file in the \`ideas\` folder. Click an idea to archive it, right-click to insert it into your text, hover to read it in full. The \`+\` button adds an idea. The "Active" and "Archive" tabs filter the list.
- **Contents**: the headings of the current document. Click a link to jump to that heading.
- **Snapshots**: the document's revision history.

## Snapshots

A snapshot captures the state of a document at a given moment. Take one before a big cut, you can always come back.

- **Create**: "+ Create a snapshot" button, then give it a name.
- **Compare**: the "Compare" button shows the differences with the current version.
- **Restore**: the snapshot's version replaces the current content, and the current version takes its place in the list. Restore again to go back.
- **Delete**: removes the snapshot.

## Ideas

The ideas panel gathers short sentences, grouped by theme. It is a notebook of fragments to reuse.

- Click an idea to archive it (it stays in the "Archive" tab).
- Right-click to insert it into your text at the cursor.
- Hover to read the idea in full.
- The \`+\` button adds an idea to the active theme. Esc cancels.
- The magnifying glass filters the ideas of the current theme as you type.
- **Drag & drop**: drag an idea to reorder it, or drop it on another theme's tab to move it there. A horizontal line shows where it will land. Drag an idea into the editor to insert it as a new block. Select a word in the editor, or drag a whole block, onto the panel to add it as an idea.

## Contents

The contents list the headings of the document. Click a heading to jump straight to the section.

## Breadcrumb

The breadcrumb at the top shows the section, the title and the filename. Click it to go back to the top of the document. Click the filename to copy it.

## Top bar

- **Typewriter** (\`T\`): centres the active line vertically.
- **Paragraph focus** (\`P\`): keeps only the current paragraph visible.
- **Reading mode** (\`R\` or \`Tab\`): cycles between block text, continuous text, and typewriter reading with a fade.
- **Focus mode** (\`F\`): keeps only the text, everything else fades away.
- **Export**: print or PDF, standalone HTML, Markdown.
- **Search** (\`Ctrl+P\`): searches across all documents and ideas.

## Bottom bar

- Counters: words, characters, reading time.
- **Undo / Redo** (\`Ctrl+Z\` / \`Ctrl+Shift+Z\`).
- **Remove empty lines**.
- **Justify**: aligns the text left and right.
- **Readable line length**: next to Justify, toggles the text between a centred readable column and full width.
- **Spell check**: toggles spell checking.
- **Auto-scroll** (\`A\`): scrolls the text, click to set the speed.
- **Find / Replace** (\`Ctrl+F\`).

## Markdown editing

Markdown renders live. The line you are editing switches to raw text, the others stay rendered.

- The toolbar that appears on selection: bold, italic, underline, strikethrough, code, link, headings, quote.
- The \`+\` button in the margin inserts a block: paragraph, headings H1 to H6, lists, checkbox, quote, code block, image, divider.
- The block handle moves it, the trash deletes it.
- Click an image to switch back to its Markdown source and edit the URL directly.
- Pasting or dropping an image saves it into the workspace \`assets\` folder and inserts it as Markdown.
- A quote starting with \`> [!note]\` becomes a coloured callout (tip, warning, danger, question…).
- \`Ctrl\`+click blocks to select several, then merge them into one or delete them together.
- A click between two blocks inserts a new block there.
- Pasting inserts plain text, never foreign formatting.

Shortcuts: \`Ctrl+G\` or \`Ctrl+B\` bold, \`Ctrl+I\` italic, \`Ctrl+K\` then \`C\` to change the heading level, \`Q\` quote, \`L\` list, \`U\` underline, \`D\` inline code.

## Settings

The gear at the top left opens the settings.

- **Folders**: workspace path and ideas folder, with a browse button.
- **Appearance**: colour themes (Default, Ivory, Polaire) plus your own named themes saved in the \`.themes\` folder of the workspace, a UI font and an editor font per theme (custom fonts you drop into \`.fonts\` are offered too), custom UI icons per theme (import SVG, PNG, WebP or ICO into \`.icons\` and replace each one), a background image or video behind the whole app (repeat loop, optional seamless mosaic, opacity slider), text sizes per heading level, the space between blocks, the line height of the blocks, reading fade, hide YAML frontmatter, colour headings and formatting differently.
- **Language**: Français or English.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| \`Ctrl+N\` | New document |
| \`Ctrl+S\` | Save |
| \`Ctrl+P\` | Search |
| \`Ctrl+F\` | Find / Replace |
| \`Ctrl+G\` or \`Ctrl+B\` | Bold |
| \`Ctrl+I\` | Italic |
| \`Ctrl+Z\` / \`Ctrl+Shift+Z\` | Undo / Redo |
| \`T\` | Typewriter |
| \`P\` | Paragraph focus |
| \`R\` | Reading mode |
| \`A\` | Auto-scroll |
| \`Tab\` | Cycle display modes |
| \`F\` | Focus mode |
| \`Ctrl\`+click | Select several blocks |

## Supported Markdown

This document is itself an example. Headings, lists, tables, code blocks, LaTeX, quotes, links and images.

**Bold**, *italic*, ~~strikethrough~~, <u>underline</u>, \`inline code\`, ==highlight==.

An inline formula: $E = mc^2$.

A display formula:

$$ \\int_{-\\infty}^{+\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi} $$

A code block:

\`\`\`python
def greet(name):
    print("Hello, " + name + "!")
\`\`\`

A quote:

> Writing is thinking slowly.

A callout:

> [!note] A note
> Callouts bring attention to a passage. Try tip, warning, danger, question.

A checkbox list:

- [ ] a task to do
- [x] a task already done

A table:

| Style | Example |
|---|---|
| Bold | **text** |
| Italic | *text* |
| Strikethrough | ~~text~~ |

An image:

![Test image](https://picsum.photos/600/300)

Happy writing.
`;

const WELCOME_DEMO_FR = `# Bienvenue dans Scriptorium

Un éditeur Markdown sans distraction. Vos textes sont de simples fichiers \`.md\` sur votre disque, dans le dossier que vous avez choisi au premier lancement.

## Premiers gestes

- **Nouveau texte** : bouton « Nouveau texte » dans la barre latérale, ou \`Ctrl+N\`.
- **Nouvelle section** : bouton « Nouvelle section ». Une section est un dossier ; un document est un fichier \`.md\` dans ce dossier.
- **Ouvrir un document** : cliquez dessus dans la barre latérale.
- **Renommer** : changez le titre dans l'éditeur. Le fichier est renommé à la sauvegarde.
- **Déplacer** : clic droit sur un document (appui long sur mobile), puis choisissez la section.
- **Importer** : glissez un fichier \`.md\` sur une section. Glissez-le sur le panneau d'idées pour importer un thème.
- **Trier** : le bouton de tri dans la barre latérale alterne l'ordre alphabétique et l'ordre par date.

## Verrouiller le document

Cliquez sur **Scriptorium.** en haut à gauche pour verrouiller les modifications et suppressions. Re-cliquez pour déverrouiller.

## Le panneau de droite

Le bouton en haut à droite du panneau alterne entre trois vues :

- **Idées** : votre nuage de phrases. Un thème est un fichier dans le dossier \`ideas\`. Cliquez sur une idée pour l'archiver, clic droit pour l'insérer dans le texte, survol pour la lire en entier. Le bouton \`+\` ajoute une idée. Les onglets « Actives » et « Archive » filtrent la liste.
- **Sommaire** : les titres du document courant. Cliquez un lien pour sauter au titre.
- **Instantanés** : l'historique de révision du document.

## Les instantanés

Un instantané capture l'état d'un document à un moment précis. Prenez-en un avant une coupe importante, vous pourrez toujours revenir en arrière.

- **Créer** : bouton « + Créer un instantané », puis donnez-lui un nom.
- **Comparer** : le bouton « Comparer » affiche les différences avec la version actuelle.
- **Restaurer** : la version de l'instantané remplace le contenu actuel, et la version actuelle prend sa place dans la liste. Restaurer à nouveau revient en arrière.
- **Supprimer** : retire l'instantané.

## Les idées

Le panneau d'idées rassemble des phrases courtes, classées par thème. C'est un carnet de fragments à réutiliser.

- Cliquez sur une idée pour l'archiver (elle reste dans l'onglet « Archive »).
- Clic droit pour l'insérer dans votre texte au curseur.
- Survol pour lire l'idée en entier.
- Le bouton \`+\` ajoute une idée au thème actif. Échap annule.
- La loupe filtre les idées du thème courant au fil de la frappe.
- **Glisser-déposer** : glissez une idée pour la réordonner, ou déposez-la sur l'onglet d'un autre thème pour l'y déplacer. Une ligne horizontale indique l'endroit où elle atterrira. Glissez une idée dans l'éditeur pour l'insérer comme nouveau bloc. Sélectionnez un mot dans l'éditeur, ou glissez un bloc entier, sur le panneau pour l'ajouter comme idée.

## Le sommaire

Le sommaire liste les titres du document. Cliquez un titre pour sauter directement à la section.

## Le fil d'ariane

Le fil d'ariane en haut affiche la section, le titre et le nom du fichier. Cliquez dessus pour remonter tout en haut du document. Cliquez sur le nom de fichier pour le copier.

## La barre du haut

- **Machine à écrire** (\`T\`) : centre la ligne active verticalement.
- **Focus ligne** (\`P\`) : ne laisse visible que le paragraphe courant.
- **Mode lecture** (\`R\` ou \`Tab\`) : alterne entre texte en blocs, texte continu, et lecture machine à écrire avec fondu.
- **Mode focus** (\`F\`) : ne garde que le texte, tout le reste s'efface.
- **Exporter** : imprimer ou PDF, HTML autonome, Markdown.
- **Recherche** (\`Ctrl+P\`) : cherche dans tous les documents et les idées.

## La barre du bas

- Compteurs : mots, caractères, temps de lecture.
- **Annuler / Répéter** (\`Ctrl+Z\` / \`Ctrl+Shift+Z\`).
- **Supprimer les lignes vides**.
- **Justifier** : aligne le texte à gauche et à droite.
- **Longueur de ligne lisible** : à côté de Justifier, alterne entre une colonne lisible centrée et la pleine largeur.
- **Correcteur** : active ou coupe la vérification orthographique.
- **Défilement auto** (\`A\`) : fait défiler le texte, clic pour régler la vitesse.
- **Rechercher / remplacer** (\`Ctrl+F\`).

## Édition Markdown

Le Markdown s'affiche en direct. La ligne que vous éditez passe en texte brut, les autres s'affichent rendues.

- La barre d'outils qui apparaît à la sélection : gras, italique, souligné, barré, code, lien, titres, citation.
- Le bouton \`+\` dans la marge insère un bloc : paragraphe, titres H1 à H6, listes, case à cocher, citation, bloc de code, image, séparateur.
- La poignée de bloc le déplace, la corbeille le supprime.
- Cliquez sur une image pour revenir à son code Markdown et modifier l'URL directement.
- Coller ou déposer une image l'enregistre dans le dossier \`assets\` de l'espace de travail et l'insère en Markdown.
- Une citation commençant par \`> [!note]\` devient une note colorée (tip, warning, danger, question…).
- \`Ctrl\`+clic sur des blocs pour en sélectionner plusieurs, puis les fusionner en un seul ou les supprimer ensemble.
- Un clic entre deux blocs insère un nouveau bloc à cet endroit.
- Coller insère du texte brut, jamais de mise en forme étrangère.

Raccourcis : \`Ctrl+G\` ou \`Ctrl+B\` gras, \`Ctrl+I\` italique, \`Ctrl+K\` puis \`C\` pour changer le niveau de titre, \`Q\` citation, \`L\` liste, \`U\` souligné, \`D\` code en ligne.

## Les réglages

L'engrenage en haut à gauche ouvre les paramètres.

- **Dossiers** : chemin du dossier de travail et du dossier d'idées, avec bouton pour parcourir.
- **Apparence** : thèmes de couleur (Défaut, Ivoire, Polaire) et vos propres thèmes nommés enregistrés dans le dossier \`.themes\` de l'espace de travail, une police d'interface et une police d'éditeur par thème (les polices personnalisées déposées dans \`.fonts\` sont aussi proposées), des icônes d'interface personnalisées par thème (importez SVG, PNG, WebP ou ICO dans \`.icons\` et remplacez chacune), une image ou vidéo de fond derrière toute l'application (boucle répétée, mosaïque seamless optionnelle, curseur d'opacité), tailles de texte par niveau de titre, espacement entre les blocs, hauteur de ligne des blocs, fondu du mode lecture, masquer le frontmatter YAML, colorer différemment les titres et la mise en forme.
- **Langue** : Français ou English.

## Raccourcis clavier

| Raccourci | Action |
|---|---|
| \`Ctrl+N\` | Nouveau texte |
| \`Ctrl+S\` | Enregistrer |
| \`Ctrl+P\` | Recherche |
| \`Ctrl+F\` | Rechercher / remplacer |
| \`Ctrl+G\` ou \`Ctrl+B\` | Gras |
| \`Ctrl+I\` | Italique |
| \`Ctrl+Z\` / \`Ctrl+Shift+Z\` | Annuler / Répéter |
| \`T\` | Machine à écrire |
| \`P\` | Focus paragraphe |
| \`R\` | Mode lecture |
| \`A\` | Défilement auto |
| \`Tab\` | Alterner les modes d'affichage |
| \`F\` | Mode focus |
| \`Ctrl\`+clic | Sélectionner plusieurs blocs |

## Markdown supporté

Ce document est lui-même un exemple. Titres, listes, tableaux, blocs de code, LaTeX, citations, liens et images.

**Gras**, *italique*, ~~barré~~, <u>souligné</u>, \`code en ligne\`, ==surligné==.

Une formule en ligne : $E = mc^2$.

Une formule centrée :

$$ \\int_{-\\infty}^{+\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi} $$

Un bloc de code :

\`\`\`python
def salutation(nom):
    print("Bonjour, " + nom + " !")
\`\`\`

Une citation :

> Écrire, c'est penser lentement.

Une note colorée :

> [!note] Une note
> Les notes mettent en avant un passage. Essayez tip, warning, danger, question.

Une liste à cocher :

- [ ] une tâche à faire
- [x] une tâche déjà faite

Un tableau :

| Style | Exemple |
|---|---|
| Gras | **texte** |
| Italique | *texte* |
| Barré | ~~texte~~ |

Une image :

![Image de test](https://picsum.photos/600/300)

Bonne écriture.
`;

// Migrates pre-.scriptorium workspaces: the old hidden folders (.themes,
// .fonts, .media, .icons, .snapshots) move under .scriptorium/ so every
// workspace is a single portable unit.
function migrateWorkspaceLayout() {
  if (!workspaceConfigured || !fs.existsSync(workspaceDir)) return;
  const moves = [
    ['.themes', 'themes'],
    ['.fonts', 'fonts'],
    ['.media', 'media'],
    ['.icons', 'icons'],
    ['.snapshots', 'snapshots']
  ];
  for (const [oldName, newName] of moves) {
    const src = path.join(workspaceDir, oldName);
    const dst = path.join(getScriptoriumDir(), newName);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) {
      // The new location already has data: keep it, drop the old duplicate.
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
      } catch (err) {
        console.error('Error migrating ' + oldName + ':', err);
      }
    }
  }
}

// Ensure default workspace structure exists
function ensureWorkspaceDirs() {
  // Creates the folder skeleton only. Demo content (welcome docs, idea themes)
  // is seeded once, by seedNewWorkspace(), when a new empty workspace is picked
  // — never at every startup or workspace fetch.
  if (!workspaceConfigured) return;
  try {
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }
    migrateWorkspaceLayout();
    const ideasDir = getIdeasDir();
    if (!fs.existsSync(ideasDir)) {
      fs.mkdirSync(ideasDir, { recursive: true });
    }
    fs.mkdirSync(getScriptoriumDir(), { recursive: true });
    setupWorkspaceWatcher();
  } catch (err) {
    console.error('Error ensuring workspace directories:', err);
  }
}

// Fills a freshly chosen empty workspace with the bilingual welcome docs and
// the two default idea themes. Only called when the user selects a new
// workspace (POST /api/config) and only when that folder has no content.
function seedNewWorkspace() {
  try {
    const items = fs.readdirSync(workspaceDir);
    const resolvedIdeasDir = path.resolve(getIdeasDir());
    const subdirs = items.filter(item => {
      const p = path.resolve(workspaceDir, item);
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch (e) {}
      return isDir && !['.git', 'node_modules', '.scriptorium', '.themes', '.snapshots'].includes(item) && p !== resolvedIdeasDir && item !== 'ideas';
    });
    // A folder that already contains documents must not be polluted with demos.
    if (subdirs.length > 0) return;

    const welcomeEn = path.join(workspaceDir, 'Welcome.md');
    const welcomeFr = path.join(workspaceDir, 'Bienvenue.md');
    if (!fs.existsSync(welcomeEn)) fs.writeFileSync(welcomeEn, WELCOME_DEMO_EN, 'utf8');
    if (!fs.existsSync(welcomeFr)) fs.writeFileSync(welcomeFr, WELCOME_DEMO_FR, 'utf8');

    // Demo idea themes, one per language. Created per file so a workspace whose
    // ideas folder already exists still gets them on a fresh empty workspace.
    const ideasDir = getIdeasDir();
    fs.mkdirSync(ideasDir, { recursive: true });
    const defaultThemes = {
      'general': {
        name: 'General ideas',
        ideas: [
          'Each line starting with a dash is an idea',
          'Click an idea to archive it',
          'Right-click to insert an idea into your text',
          'Hover an idea to read it in full',
          'Add your own ideas, one per line',
          'An ideas theme is just a markdown file'
        ]
      },
      'général': {
        name: 'Idées générales',
        ideas: [
          'Chaque ligne commençant par un tiret est une idée',
          'Cliquez sur une idée pour l\'archiver',
          'Clic droit pour insérer une idée dans votre texte',
          'Survolez une idée pour la lire en entier',
          'Ajoutez vos propres idées, une par ligne',
          'Un thème d\'idées est simplement un fichier markdown'
        ]
      }
    };
    for (const [id, theme] of Object.entries(defaultThemes)) {
      const themeFile = path.join(ideasDir, `${id}.md`);
      if (!fs.existsSync(themeFile)) {
        const fileContent = `# ${theme.name}\n\n` + theme.ideas.map(idea => `- [ ] ${idea}`).join('\n') + '\n';
        fs.writeFileSync(themeFile, fileContent, 'utf8');
      }
    }
  } catch (err) {
    console.error('Error seeding new workspace:', err);
  }
}

ensureWorkspaceDirs();

// Safe filename helper
function safeFilename(s) {
  return (s || 'sans-titre')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9]/gi, '-')     // replace non-alphanumeric with -
    .replace(/-+/g, '-')             // collapse duplicate dashes
    .replace(/^-|-$/g, '')           // trim leading/trailing dashes
    .slice(0, 80) || 'sans-titre';
}

// Markdown parsing helpers
function parseMarkdownDoc(text, filename) {
  const cleanText = (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = cleanText.split('\n');
  let title = filename.replace(/\.(md|markdown|txt)$/i, '');
  let subtitle = '';
  let bodyStart = 0;
  
  // Find first non-empty line
  let firstLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstLineIdx = i;
      break;
    }
  }

  if (firstLineIdx !== -1) {
    const t = lines[firstLineIdx].trim();
    const h1 = t.match(/^#\s+(.+)$/);
    if (h1) {
      title = h1[1];
      bodyStart = firstLineIdx + 1;
      
      // Skip empty lines
      while (bodyStart < lines.length && lines[bodyStart].trim() === '') {
        bodyStart++;
      }
      
      // Look for italic line as subtitle
      if (bodyStart < lines.length) {
        const sub = lines[bodyStart].match(/^\*([^*]+)\*\s*$|^_([^_]+)_\s*$/);
        if (sub) {
          subtitle = sub[1] || sub[2];
          bodyStart++;
        }
      }
    }
  }
  
  // Skip empty lines again for body start
  while (bodyStart < lines.length && lines[bodyStart].trim() === '') {
    bodyStart++;
  }
  
  return {
    title,
    subtitle,
    body: lines.slice(bodyStart).join('\n')
  };
}

function parseIdeasFile(text, filename) {
  const lines = text.split('\n');
  let themeName = filename.replace(/\.(md|markdown|txt)$/i, '');
  const ideas = [];
  
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      themeName = h1[1].replace(/^theme\s*:\s*/i, '').trim();
      continue;
    }
    
    // Checked markdown list item: - [x] or - [ ]
    const checked = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (checked) {
      ideas.push({
        id: Math.random().toString(36).slice(2, 10),
        text: checked[2].trim(),
        archived: checked[1].toLowerCase() === 'x'
      });
      continue;
    }
    
    // Regular markdown list item: - item
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      const txt = bullet[1].trim();
      if (!txt.startsWith('[') && !txt.startsWith(']')) {
        ideas.push({
          id: Math.random().toString(36).slice(2, 10),
          text: txt,
          archived: false
        });
      }
      continue;
    }
    
    // Plain line
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      ideas.push({
        id: Math.random().toString(36).slice(2, 10),
        text: t,
        archived: false
      });
    }
  }
  
  return { themeName, ideas };
}

// API Endpoints

// Get config
app.get('/api/config', (req, res) => {
  res.json({
    workspaceDir,
    ideasDir: ideasDirSetting,
    effectiveIdeasDir: getIdeasDir(),
    locked: workspaceLocked,
    configured: workspaceConfigured,
    appDir: __dirname
  });
});

// Save an image pasted or dropped into a document. Stored in <workspace>/assets
// and returned as a workspace-relative path ("assets/name.png") for the markdown.
app.post('/api/assets', guarded((req, res) => {
  const { filename, dataBase64 } = req.body || {};
  if (!filename || typeof dataBase64 !== 'string' || !dataBase64) {
    return res.status(400).json({ error: 'filename and data are required' });
  }
  const extMatch = String(filename).match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
  if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    return res.status(400).json({ error: 'Unsupported image type' });
  }
  const stem = extMatch ? filename.slice(0, -extMatch[0].length) : filename;
  const safeStem = assertSegment(stem, 'Image');
  const assetsDir = path.join(workspaceDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  let safeName = `${safeStem}.${ext}`;
  let counter = 1;
  while (fs.existsSync(path.join(assetsDir, safeName))) {
    safeName = `${safeStem}-${counter}.${ext}`;
    counter++;
  }

  const buf = Buffer.from(dataBase64, 'base64');
  fs.writeFileSync(path.join(assetsDir, safeName), buf);
  res.json({ success: true, path: `assets/${safeName}` });
}));

// The padlock is enforced server-side, so it has to be persisted here rather
// than in localStorage only.
app.post('/api/lock', (req, res) => {
  const { locked } = req.body || {};
  if (typeof locked !== 'boolean') {
    return res.status(400).json({ error: 'locked (boolean) is required' });
  }
  workspaceLocked = locked;
  saveConfig();
  res.json({ success: true, locked: workspaceLocked });
});

// Update config
app.post('/api/config', (req, res) => {
  const { newPath, ideasPath } = req.body;
  if (!newPath) {
    return res.status(400).json({ error: 'Path is required' });
  }
  
  workspaceDir = path.resolve(newPath);
  if (ideasPath !== undefined) {
    ideasDirSetting = ideasPath ? ideasPath.trim() : '';
  }
  workspaceConfigured = true;
  saveConfig();
  ensureWorkspaceDirs();
  // Demo content is only for a brand-new, empty workspace the user just picked.
  seedNewWorkspace();

  res.json({
    success: true,
    workspaceDir,
    ideasDir: ideasDirSetting,
    effectiveIdeasDir: getIdeasDir(),
    configured: workspaceConfigured
  });
});

// Custom color theme (Settings > Apparence), saved at the project root
app.get('/api/color-theme', (req, res) => {
  res.json({ theme: loadCustomTheme() });
});

app.post('/api/color-theme', (req, res) => {
  const theme = req.body;
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
    return res.status(400).json({ error: 'Invalid theme payload' });
  }
  try {
    fs.writeFileSync(CUSTOM_THEME_FILE, JSON.stringify(theme, null, 2), 'utf8');
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving custom theme:', err);
    res.status(500).json({ error: 'Failed to save theme' });
  }
});

// Named custom themes, saved under <workspace>/.themes/<id>.json
app.get('/api/color-themes', (req, res) => {
  migrateLegacyCustomTheme();
  res.json({ themes: listColorThemes() });
});

app.post('/api/color-themes', (req, res) => {
  const { id, name, vars, fonts } = req.body || {};
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
    return res.status(400).json({ error: 'Invalid theme payload' });
  }
  const dir = ensureThemesDir();
  if (!dir) return res.status(500).json({ error: 'Failed to save theme' });

  let themeId = (typeof id === 'string' && id.trim()) ? id.trim() : slugifyThemeName(name);
  if (!/^[A-Za-z0-9._-]+$/.test(themeId)) themeId = slugifyThemeName(name);
  // Auto-generated ids must not overwrite an existing theme.
  if (!(typeof id === 'string' && id.trim()) && fs.existsSync(path.join(dir, themeId + '.json'))) {
    let n = 2;
    while (fs.existsSync(path.join(dir, themeId + n + '.json'))) n++;
    themeId = themeId + n;
  }
  const themeName = (typeof name === 'string' && name.trim()) ? name.trim() : themeId;
  const payload = { name: themeName, vars };
  if (fonts && typeof fonts === 'object') payload.fonts = fonts;
  try {
    fs.writeFileSync(path.join(dir, themeId + '.json'), JSON.stringify(payload, null, 2), 'utf8');
    res.json({ success: true, id: themeId, name: themeName });
  } catch (err) {
    console.error('Error saving theme:', err);
    res.status(500).json({ error: 'Failed to save theme' });
  }
});

app.delete('/api/color-themes/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid theme id' });
  }
  const file = path.join(getThemesDir(), id + '.json');
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Theme not found' });
    }
  } catch (err) {
    console.error('Error deleting theme:', err);
    res.status(500).json({ error: 'Failed to delete theme' });
  }
});

// Custom fonts from <workspace>/.fonts/
app.get('/api/fonts', (req, res) => {
  res.json({ fonts: listCustomFonts() });
});

app.post('/api/fonts', guarded((req, res) => {
  const { filename, dataBase64 } = req.body || {};
  if (!filename || typeof dataBase64 !== 'string' || !dataBase64) {
    return res.status(400).json({ error: 'filename and data are required' });
  }
  const ext = path.extname(String(filename)).toLowerCase();
  if (!FONT_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: 'Unsupported font type' });
  }
  const stem = path.basename(String(filename), ext);
  const safeStem = assertSegment(stem, 'Font') || 'font';
  const fontsDir = getFontsDir();
  fs.mkdirSync(fontsDir, { recursive: true });
  let safeName = `${safeStem}${ext}`;
  let counter = 1;
  while (fs.existsSync(path.join(fontsDir, safeName))) {
    safeName = `${safeStem}-${counter}${ext}`;
    counter++;
  }
  const buf = Buffer.from(dataBase64, 'base64');
  fs.writeFileSync(path.join(fontsDir, safeName), buf);
  res.json({ success: true, file: safeName });
}));

// Serve the workspace's custom fonts (runtime dir, like /assets).
app.use('/fonts', (req, res, next) => {
  const fontsDir = getFontsDir();
  if (!fs.existsSync(fontsDir)) return res.status(404).end();
  express.static(fontsDir, { maxAge: '30d', immutable: true })(req, res, next);
});

// Background media from <workspace>/.media/
app.get('/api/media', (req, res) => {
  res.json({ media: listMediaFiles() });
});

app.post('/api/media', guarded((req, res) => {
  const { filename, dataBase64 } = req.body || {};
  if (!filename || typeof dataBase64 !== 'string' || !dataBase64) {
    return res.status(400).json({ error: 'filename and data are required' });
  }
  const ext = path.extname(String(filename)).toLowerCase();
  if (!MEDIA_IMAGE_EXT.includes(ext) && !MEDIA_VIDEO_EXT.includes(ext)) {
    return res.status(400).json({ error: 'Unsupported media type' });
  }
  const stem = path.basename(String(filename), ext);
  const safeStem = assertSegment(stem, 'Media') || 'media';
  const dir = getMediaDir();
  fs.mkdirSync(dir, { recursive: true });
  let safeName = `${safeStem}${ext}`;
  let counter = 1;
  while (fs.existsSync(path.join(dir, safeName))) {
    safeName = `${safeStem}-${counter}${ext}`;
    counter++;
  }
  fs.writeFileSync(path.join(dir, safeName), Buffer.from(dataBase64, 'base64'));
  res.json({ success: true, file: safeName });
}));

// Serve the workspace's background media (runtime dir, like /assets).
app.use('/media', (req, res, next) => {
  const dir = getMediaDir();
  if (!fs.existsSync(dir)) return res.status(404).end();
  express.static(dir, { maxAge: '30d', immutable: true })(req, res, next);
});

// Custom UI icons from <workspace>/.icons/
app.get('/api/icons', (req, res) => {
  res.json({ icons: listIconFiles() });
});

// Accepts several files at once: { files: [{ filename, dataBase64 }, ...] }
app.post('/api/icons', guarded((req, res) => {
  const files = (req.body && Array.isArray(req.body.files)) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: 'No files' });
  const dir = getIconsDir();
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of files) {
    const filename = String(f.filename || '');
    const ext = path.extname(filename).toLowerCase();
    if (!ICON_EXTENSIONS.includes(ext) || typeof f.dataBase64 !== 'string') continue;
    const stem = path.basename(filename, ext);
    let safeStem = 'icon';
    try { safeStem = assertSegment(stem, 'Icon'); } catch (e) { /* skip invalid names */ }
    let safeName = `${safeStem}${ext}`;
    let counter = 1;
    while (fs.existsSync(path.join(dir, safeName))) {
      safeName = `${safeStem}-${counter}${ext}`;
      counter++;
    }
    fs.writeFileSync(path.join(dir, safeName), Buffer.from(f.dataBase64, 'base64'));
    saved.push(safeName);
  }
  res.json({ success: true, files: saved });
}));

app.delete('/api/icons/:id', guarded((req, res) => {
  const id = req.params.id;
  const dir = getIconsDir();
  const file = path.join(dir, id);
  if (!id || path.basename(file) !== id) {
    return res.status(400).json({ error: 'Invalid icon id' });
  }
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Icon not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete icon' });
  }
}));

// Serve the workspace's custom icons (runtime dir, like /assets).
app.use('/icons', (req, res, next) => {
  const dir = getIconsDir();
  if (!fs.existsSync(dir)) return res.status(404).end();
  express.static(dir, { maxAge: '30d', immutable: true })(req, res, next);
});

app.delete('/api/media/:id', guarded((req, res) => {
  const id = req.params.id;
  const dir = getMediaDir();
  const file = path.join(dir, id);
  // Reject anything that is not a plain filename inside the media dir.
  if (!id || path.basename(file) !== id || path.extname(id).toLowerCase() === '') {
    return res.status(400).json({ error: 'Invalid media id' });
  }
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Media not found' });
    }
  } catch (err) {
    console.error('Error deleting media:', err);
    res.status(500).json({ error: 'Failed to delete media' });
  }
}));

// Snapshots (revision history) — persisted on disk in the workspace, one JSON
// file per document, under <workspace>/.snapshots/
function snapshotsDir() {
  return path.join(getScriptoriumDir(), 'snapshots');
}

function snapshotsFileFor(docId) {
  if (typeof docId !== 'string' || !docId.trim()) throw new PathError('docId invalide');
  // encodeURIComponent already neutralises separators; safeJoin is the backstop.
  return safeJoin(snapshotsDir(), encodeURIComponent(docId) + '.json');
}

app.get('/api/snapshots', (req, res) => {
  const docId = req.query.docId;
  if (!docId) return res.status(400).json({ error: 'docId is required' });
  try {
    const file = snapshotsFileFor(docId);
    if (fs.existsSync(file)) {
      return res.json({ snapshots: JSON.parse(fs.readFileSync(file, 'utf8')) });
    }
    res.json({ snapshots: [] });
  } catch (err) {
    console.error('Error reading snapshots:', err);
    res.status(500).json({ error: 'Failed to read snapshots' });
  }
});

app.post('/api/snapshots', (req, res) => {
  const { docId, snapshots } = req.body || {};
  if (!docId || !Array.isArray(snapshots)) {
    return res.status(400).json({ error: 'docId and snapshots array are required' });
  }
  try {
    const file = snapshotsFileFor(docId);
    if (snapshots.length === 0) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } else {
      fs.mkdirSync(snapshotsDir(), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(snapshots, null, 2), 'utf8');
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving snapshots:', err);
    res.status(500).json({ error: 'Failed to save snapshots' });
  }
});

// The file manager and the default editor open on the machine running the
// server, so a phone on the LAN must not be able to pop windows on it.
function requireLocalHost(req, res) {
  if (!isLoopbackHost(hostnameOf(req.headers.host))) {
    res.status(403).json({ error: serverMsg(req, 'server.error_host_refused') });
    return false;
  }
  return true;
}

// Open the workspace, the ideas folder, or one section folder in the OS file
// manager.
app.post('/api/open-folder', guarded((req, res) => {
  if (!requireLocalHost(req, res)) return;
  const { type, sectionId } = req.body || {};
  const targetFolder = sectionId ? resolveSectionFolder(sectionId, req)
    : type === 'ideas' ? getIdeasDir()
    : type === 'app' ? __dirname
    : workspaceDir;
  if (!fs.existsSync(targetFolder)) {
    return res.status(404).json({ error: serverMsg(req, 'server.error_folder_not_found') });
  }
  // execFile passes the path as an argv entry, so quotes and & in a folder
  // name can no longer break out into a second shell command.
  const opener = process.platform === 'win32' ? 'explorer'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  execFile(opener, [targetFolder], () => {});
  res.json({ success: true });
}));

// Reveal a document in the OS file manager, or open it with its default app.
// The file manager always opens on the machine running the server, so the UI
// only offers this when the page is served on loopback.
app.post('/api/open-doc', guarded((req, res) => {
  if (!requireLocalHost(req, res)) return;
  const { id, mode } = req.body || {};
  const { folder, fullPath } = resolveDocPath(id, req);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: serverMsg(req, 'server.error_doc_not_found') });
  }

  // "path" launches nothing: the client only wants the absolute path to copy.
  if (mode === 'path') return res.json({ success: true, path: fullPath });

  // execFile, never a shell: a filename with & or a quote stays one argv entry.
  if (process.platform === 'win32') {
    // "explorer /select,<path>" selects the file in its folder; "explorer
    // <path>" hands it to the default handler. Pass the raw path as one argv
    // entry: Windows quotes it for us and explorer handles the quoted path
    // with spaces. Adding quotes inside the argument makes explorer mis-parse
    // it and fall back to the Documents folder.
    execFile('explorer', [mode === 'file' ? fullPath : `/select,${fullPath}`], () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', mode === 'file' ? [fullPath] : ['-R', fullPath], () => {});
  } else {
    // No portable "reveal" on Linux — fall back to opening the folder.
    execFile('xdg-open', [mode === 'file' ? fullPath : folder], () => {});
  }
  res.json({ success: true });
}));

// Pick folder via native Windows FolderBrowserDialog
app.post('/api/pick-folder', (req, res) => {
  const { currentPath } = req.body || {};
  let initial = '';
  if (currentPath && typeof currentPath === 'string' && fs.existsSync(currentPath)) {
    initial = path.resolve(currentPath);
  }

  // macOS: native dialog through osascript.
  if (process.platform === 'darwin') {
    let script = 'POSIX path of (choose folder';
    if (initial) script += ` default location "${initial.replace(/"/g, '\\"')}"`;
    script += ')';
    execFile('osascript', ['-e', script], { timeout: 60000 }, (err, stdout) => {
      if (err) {
        console.error('Folder picker error:', err);
        return res.status(500).json({ error: 'Impossible d\'ouvrir le sélecteur de dossier' });
      }
      const selectedPath = String(stdout || '').trim();
      if (selectedPath) res.json({ success: true, path: selectedPath });
      else res.json({ success: false, cancelled: true });
    });
    return;
  }

  // Linux: prefer zenity, fall back to kdialog.
  if (process.platform === 'linux') {
    const runZenity = () => {
      const args = ['--file-selection', '--directory'];
      if (initial) args.push('--filename', initial + path.sep);
      execFile('zenity', args, { timeout: 60000 }, (err, stdout) => {
        if (err) {
          runKdialog();
          return;
        }
        const selectedPath = String(stdout || '').trim();
        if (selectedPath) res.json({ success: true, path: selectedPath });
        else res.json({ success: false, cancelled: true });
      });
    };
    const runKdialog = () => {
      const args = ['--getexistingdirectory'];
      if (initial) args.push(initial);
      execFile('kdialog', args, { timeout: 60000 }, (err, stdout) => {
        if (err) {
          return res.status(500).json({ error: 'Impossible d\'ouvrir le sélecteur de dossier' });
        }
        const selectedPath = String(stdout || '').trim();
        if (selectedPath) res.json({ success: true, path: selectedPath });
        else res.json({ success: false, cancelled: true });
      });
    };
    runZenity();
    return;
  }

  // Windows: PowerShell FolderBrowserDialog (kept below).

  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Sélectionnez un dossier de travail'
    $initialPath = $env:PICKER_INITIAL_PATH
    if ($initialPath -and (Test-Path $initialPath)) {
      $dialog.SelectedPath = $initialPath
    }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      Write-Output $dialog.SelectedPath
    }
  `;

  const buffer = Buffer.from(psScript, 'utf16le');
  const encoded = buffer.toString('base64');

  execFile('powershell', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
    env: { ...process.env, PICKER_INITIAL_PATH: initial }
  }, (err, stdout, stderr) => {
    if (err) {
      console.error('Folder picker error:', err || stderr);
      return res.status(500).json({ error: 'Impossible d\'ouvrir le sélecteur de dossier' });
    }
    const selectedPath = stdout.trim();
    if (selectedPath) {
      res.json({ success: true, path: selectedPath });
    } else {
      res.json({ success: false, cancelled: true });
    }
  });
});

// Workspace preferences (theme, fonts, backgrounds, icons, spacing, language)
// stored in .scriptorium/settings.json, so each workspace is portable.
app.get('/api/settings', (req, res) => {
  res.json({ settings: loadWorkspaceSettings() });
});

app.post('/api/settings', guarded((req, res) => {
  const settings = (req.body && req.body.settings) || {};
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: 'Invalid settings' });
  }
  if (saveWorkspaceSettings(settings)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to save settings' });
  }
}));

// Get Workspace layout (sections, documents, ideas themes)
app.get('/api/workspace', (req, res) => {
  ensureWorkspaceDirs();
  // No workspace configured yet: return an empty layout, the client shows the
  // first-launch chooser instead.
  if (!workspaceConfigured) {
    return res.json({ configured: false, sections: [], ideaThemes: [], appDir: __dirname });
  }

  try {
    const sections = [];
    const generalDocs = [];
    const ideaThemes = [];
    
    const items = fs.readdirSync(workspaceDir);
    const resolvedIdeasDir = path.resolve(getIdeasDir());
    
    // Scan sections and general docs
    for (const item of items) {
      const fullPath = path.join(workspaceDir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (item.startsWith('.') || item === 'node_modules') continue;
        
        // Skip ideas directory if located inside workspace
        if (path.resolve(fullPath) === resolvedIdeasDir || item === 'ideas') {
          continue;
        }
        
        // Regular section folder
        const docs = [];
        const files = fs.readdirSync(fullPath);
        
        for (const file of files) {
          if (file.endsWith('.md') || file.endsWith('.txt')) {
            const docPath = path.join(fullPath, file);
            const text = fs.readFileSync(docPath, 'utf8');
            const docInfo = parseMarkdownDoc(text, file);
            const fileStat = fs.statSync(docPath);
            
            docs.push({
              id: `${item}/${file}`,
              filename: file,
              title: docInfo.title,
              subtitle: docInfo.subtitle,
              content: docInfo.body,
              createdAt: fileStat.birthtimeMs,
              updatedAt: fileStat.mtimeMs
            });
          }
        }
        
        sections.push({
          id: item,
          name: item,
          collapsed: false,
          documents: docs
        });
      } else if (stat.isFile()) {
        // Files at the root go to "Général"
        if (item.endsWith('.md') || item.endsWith('.txt')) {
          const text = fs.readFileSync(fullPath, 'utf8');
          const docInfo = parseMarkdownDoc(text, item);
          generalDocs.push({
            id: `_general/${item}`,
            filename: item,
            title: docInfo.title,
            subtitle: docInfo.subtitle,
            content: docInfo.body,
            createdAt: stat.birthtimeMs,
            updatedAt: stat.mtimeMs
          });
        }
      }
    }
    
    // Append a "Général" section if root documents exist
    if (generalDocs.length > 0) {
      sections.unshift({
        id: '_general',
        name: 'Général',
        collapsed: false,
        documents: generalDocs
      });
    }

    // Scan ideas themes from getIdeasDir()
    const ideasDir = getIdeasDir();
    if (fs.existsSync(ideasDir)) {
      const ideaFiles = fs.readdirSync(ideasDir);
      for (const file of ideaFiles) {
        if (file.endsWith('.md') || file.endsWith('.txt')) {
          const themePath = path.join(ideasDir, file);
          const text = fs.readFileSync(themePath, 'utf8');
          const theme = parseIdeasFile(text, file);
          ideaThemes.push({
            id: file.replace(/\.(md|markdown|txt)$/i, ''),
            name: theme.themeName,
            ideas: theme.ideas
          });
        }
      }
    }
    
    res.json({ sections, ideaThemes, appDir: __dirname });
  } catch (err) {
    console.error('Error scanning workspace:', err);
    res.status(500).json({ error: 'Failed to scan workspace: ' + err.message });
  }
});

// Last-chance save from navigator.sendBeacon (page closing / app backgrounded).
// Beacons are POST-only, hence the alias. Nobody is around to arbitrate a
// conflict at this point, so a colliding save is written next to the original
// rather than dropped or forced over someone else's version.
function saveViaBeacon(req, res) {
  const { id, title, subtitle, content, knownUpdatedAt } = req.body;
  const { filename, folder, fullPath } = resolveDocPath(id, req);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: serverMsg(req, 'server.error_doc_not_found') });

  let fileContent = '';
  if (title) fileContent += `# ${String(title).trim()}\n\n`;
  if (subtitle) fileContent += `*${String(subtitle).trim()}*\n\n`;
  fileContent += content || '';

  const current = fs.statSync(fullPath).mtimeMs;
  if (typeof knownUpdatedAt === 'number' && current - knownUpdatedAt > 1000) {
    const base = filename.replace(/\.(md|markdown|txt)$/i, '');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sidecar = safeJoin(folder, `${base}.conflit-${stamp}.md`);
    fs.writeFileSync(sidecar, fileContent, 'utf8');
    return res.status(409).json({ error: 'Conflit — version enregistrée à côté', savedAs: path.basename(sidecar) });
  }

  fs.writeFileSync(fullPath, fileContent, 'utf8');
  res.json({ success: true, updatedAt: fs.statSync(fullPath).mtimeMs });
}

// Create document
app.post('/api/documents', guarded((req, res) => {
  const { sectionId, id } = req.body;
  // A body carrying an id but no section is a beacon save, not a creation.
  if (!sectionId && id) return saveViaBeacon(req, res);
  if (!sectionId) return res.status(400).json({ error: 'Section is required' });

  try {
    const sectionFolder = resolveSectionFolder(sectionId, req);
    if (!fs.existsSync(sectionFolder)) {
      fs.mkdirSync(sectionFolder, { recursive: true });
    }

    let baseFilename = 'sans-titre.md';
    let fileIndex = 1;
    let filename = baseFilename;
    while (fs.existsSync(path.join(sectionFolder, filename))) {
      filename = `sans-titre-${fileIndex}.md`;
      fileIndex++;
    }
    
    const docPath = path.join(sectionFolder, filename);
    const content = `# Sans titre\n\n*Sous-titre, ou une ligne pour situer le texte*\n\nCommence à écrire…\n`;
    fs.writeFileSync(docPath, content, 'utf8');
    
    const id = sectionId === '_general' ? `_general/${filename}` : `${sectionId}/${filename}`;
    const fileStat = fs.statSync(docPath);
    
    res.json({
      success: true,
      document: {
        id,
        filename,
        title: 'Sans titre',
        subtitle: 'Sous-titre, ou une ligne pour situer le texte',
        content: 'Commence à écrire…',
        createdAt: fileStat.birthtimeMs,
        updatedAt: fileStat.mtimeMs
      }
    });
  } catch (err) {
    if (err instanceof PathError) throw err;
    console.error('Error creating document:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Save document (Update content / Title / Subtitle)
app.put('/api/documents', guarded((req, res) => {
  const { id, title, subtitle, content, knownUpdatedAt } = req.body;
  if (!id) return res.status(400).json({ error: serverMsg(req, 'server.error_doc_id_required') });

  try {
    const { sectionId, filename: oldFilename, folder: sectionFolder, fullPath: oldPath } = resolveDocPath(id, req);

    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ error: serverMsg(req, 'server.error_doc_not_found') });
    }

    // Optimistic concurrency: if the file moved on since the client last read
    // it (edited on the phone, on another tab, or from an external editor),
    // refuse rather than silently overwrite the other version.
    if (typeof knownUpdatedAt === 'number') {
      const current = fs.statSync(oldPath).mtimeMs;
      // 1s of slack: mtime resolution varies across filesystems.
      if (current - knownUpdatedAt > 1000) {
        return res.status(409).json({
          error: serverMsg(req, 'server.error_doc_conflict'),
          conflict: true,
          diskUpdatedAt: current,
          diskContent: fs.readFileSync(oldPath, 'utf8')
        });
      }
    }

    // Construct new file content
    let fileContent = '';
    if (title) fileContent += `# ${title.trim()}\n\n`;
    if (subtitle) fileContent += `*${subtitle.trim()}*\n\n`;
    fileContent += content || '';
    
    // Check if filename needs to change based on the title
    // The extension of the file on disk is preserved: a .txt imported from
    // elsewhere stays a .txt instead of silently becoming a .md on first save.
    const ext = path.extname(oldFilename) || '.md';
    let newFilename = oldFilename;
    if (title && title.trim() !== '') {
      const safe = safeFilename(title);
      newFilename = `${safe}${ext}`;
    }

    let targetPath = safeJoin(sectionFolder, newFilename);

    // Resolve name collision if renaming
    if (newFilename !== oldFilename && fs.existsSync(targetPath)) {
      let index = 1;
      const base = newFilename.slice(0, -ext.length);
      while (fs.existsSync(path.join(sectionFolder, `${base}-${index}${ext}`))) {
        index++;
      }
      newFilename = `${base}-${index}${ext}`;
      targetPath = safeJoin(sectionFolder, newFilename);
    }
    
    // Write contents to disk
    fs.writeFileSync(oldPath, fileContent, 'utf8');
    
    // Rename if needed
    let finalId = id;
    if (newFilename !== oldFilename) {
      fs.renameSync(oldPath, targetPath);
      finalId = sectionId === '_general' ? `_general/${newFilename}` : `${sectionId}/${newFilename}`;
    }
    
    const fileStat = fs.statSync(targetPath);
    
    res.json({
      success: true,
      document: {
        id: finalId,
        filename: newFilename,
        title: title || '',
        subtitle: subtitle || '',
        content: content || '',
        updatedAt: fileStat.mtimeMs
      }
    });
  } catch (err) {
    if (err instanceof PathError) throw err;
    console.error('Error saving document:', err);
    res.status(500).json({ error: err.message });
  }
}));

function getTrashDir() {
  const trashFolder = path.join(workspaceDir, '.trash');
  if (!fs.existsSync(trashFolder)) fs.mkdirSync(trashFolder, { recursive: true });
  return trashFolder;
}

// Duplicate document
app.post('/api/documents/duplicate', guarded((req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: serverMsg(req, 'server.error_doc_id_required') });

  try {
    const { sectionId, filename: oldFilename, folder: sectionFolder, fullPath: oldPath } = resolveDocPath(id, req);
    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ error: serverMsg(req, 'server.error_doc_not_found') });
    }

    const ext = path.extname(oldFilename) || '.md';
    const base = oldFilename.slice(0, -ext.length);
    const copyTag = getLang(req) === 'fr' ? 'copie' : 'copy';
    let newFilename = `${base} (${copyTag})${ext}`;
    let index = 2;
    while (fs.existsSync(path.join(sectionFolder, newFilename))) {
      newFilename = `${base} (${copyTag} ${index})${ext}`;
      index++;
    }

    const targetPath = safeJoin(sectionFolder, newFilename);
    fs.copyFileSync(oldPath, targetPath);

    const text = fs.readFileSync(targetPath, 'utf8');
    const docInfo = parseMarkdownDoc(text, newFilename);
    const fileStat = fs.statSync(targetPath);
    const newId = sectionId === '_general' ? `_general/${newFilename}` : `${sectionId}/${newFilename}`;

    res.json({
      success: true,
      document: {
        id: newId,
        filename: newFilename,
        title: docInfo.title,
        subtitle: docInfo.subtitle,
        content: docInfo.body,
        createdAt: fileStat.birthtimeMs,
        updatedAt: fileStat.mtimeMs
      }
    });
  } catch (err) {
    if (err instanceof PathError) throw err;
    console.error('Error duplicating document:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Delete document — moves to .trash folder for recovery / undo
app.delete('/api/documents', guarded((req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: serverMsg(req, 'server.error_doc_id_required') });
  if (!requireUnlocked(req, res)) return;

  try {
    const { sectionId, filename, fullPath: filePath } = resolveDocPath(id, req);

    if (fs.existsSync(filePath)) {
      const trashFolder = getTrashDir();
      const trashId = `${Date.now()}_${filename}`;
      const trashPath = path.join(trashFolder, trashId);
      fs.renameSync(filePath, trashPath);

      return res.json({
        success: true,
        trashId,
        sectionId,
        filename
      });
    }

    res.json({ success: true });
  } catch (err) {
    if (err instanceof PathError) throw err;
    console.error('Error deleting document:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Restore trashed document (Undo delete)
app.post('/api/documents/restore-trash', guarded((req, res) => {
  const { trashId, sectionId, filename } = req.body || {};
  if (!trashId || !sectionId || !filename) {
    return res.status(400).json({ error: 'trashId, sectionId, filename required' });
  }

  try {
    const trashFolder = getTrashDir();
    const trashPath = safeJoin(trashFolder, trashId);
    if (!fs.existsSync(trashPath)) {
      return res.status(404).json({ error: serverMsg(req, 'server.error_doc_not_found') });
    }

    const sectionFolder = resolveSectionFolder(sectionId, req);
    if (!fs.existsSync(sectionFolder)) {
      fs.mkdirSync(sectionFolder, { recursive: true });
    }

    let targetFilename = filename;
    const ext = path.extname(filename) || '.md';
    const base = filename.slice(0, -ext.length);
    let index = 1;
    while (fs.existsSync(path.join(sectionFolder, targetFilename))) {
      targetFilename = `${base}-${index}${ext}`;
      index++;
    }

    const targetPath = safeJoin(sectionFolder, targetFilename);
    fs.renameSync(trashPath, targetPath);

    const restoredId = sectionId === '_general' ? `_general/${targetFilename}` : `${sectionId}/${targetFilename}`;

    res.json({ success: true, id: restoredId });
  } catch (err) {
    if (err instanceof PathError) throw err;
    console.error('Error restoring document:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Create Section (Folder)
app.post('/api/sections', guarded((req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const folderName = assertSegment(name, 'Nom de section');
  const folderPath = safeJoin(workspaceDir, folderName);

  try {
    if (fs.existsSync(folderPath)) {
      return res.status(400).json({ error: 'Section folder already exists' });
    }
    fs.mkdirSync(folderPath, { recursive: true });
    res.json({ success: true, section: { id: folderName, name: folderName, documents: [] } });
  } catch (err) {
    if (err instanceof PathError) throw err;
    console.error('Error creating section:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Rename Section (Folder)
app.post('/api/sections/rename', guarded((req, res) => {
  const { oldId, newName } = req.body;
  if (!oldId || !newName || !newName.trim()) return res.status(400).json({ error: 'Old ID and new name required' });
  
  const oldPath = safeJoin(workspaceDir, assertSegment(oldId, 'Section'));
  const newId = assertSegment(newName, 'Nom de section');
  const newPath = safeJoin(workspaceDir, newId);

  try {
    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ error: 'Section folder not found' });
    }
    if (fs.existsSync(newPath)) {
      return res.status(400).json({ error: 'New section folder name already exists' });
    }
    fs.renameSync(oldPath, newPath);
    res.json({ success: true, id: newId, name: newId });
  } catch (err) {
    if (err instanceof PathError) throw err;
    console.error('Error renaming section:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Delete Section (Folder)
app.delete('/api/sections', guarded((req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID is required' });

  if (id === '_general') {
    return res.status(400).json({ error: 'Cannot delete the General section folder' });
  }
  if (!requireUnlocked(req, res)) return;

  const folderPath = safeJoin(workspaceDir, assertSegment(id, 'Section'));

  try {
    if (fs.existsSync(folderPath)) {
      // Remove folder and its contents recursively
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
    res.json({ success: true });
  } catch (err) {
    if (err instanceof PathError) throw err;
    console.error('Error deleting section:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Move document between section folders
app.post('/api/documents/move', guarded((req, res) => {
  const { id, targetSectionId } = req.body;
  if (!id || !targetSectionId) return res.status(400).json({ error: 'Document ID and target section required' });

  try {
    const { filename, fullPath: sourcePath } = resolveDocPath(id, req);
    const targetFolder = resolveSectionFolder(targetSectionId);

    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }

    // Resolve name collision in target folder if necessary
    let destFilename = filename;
    let destPath = safeJoin(targetFolder, destFilename);
    if (fs.existsSync(destPath)) {
      let index = 1;
      const base = filename.replace(/\.(md|txt)$/i, '');
      const ext = filename.match(/\.(md|txt)$/i)?.[0] || '.md';
      while (fs.existsSync(path.join(targetFolder, `${base}-${index}${ext}`))) {
        index++;
      }
      destFilename = `${base}-${index}${ext}`;
      destPath = safeJoin(targetFolder, destFilename);
    }

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Source document not found on disk' });
    }

    fs.renameSync(sourcePath, destPath);

    const finalId = targetSectionId === '_general' ? `_general/${destFilename}` : `${targetSectionId}/${destFilename}`;

    res.json({ success: true, id: finalId, filename: destFilename });
  } catch (err) {
    if (err instanceof PathError) throw err;
    console.error('Error moving document:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Toggle an idea's checkmark status in a theme file
app.post('/api/ideas/toggle', guarded((req, res) => {
  const { themeId, ideaText, archived } = req.body;
  if (!themeId || !ideaText) return res.status(400).json({ error: 'Theme ID and idea text required' });
  
  const themeFile = resolveThemeFile(themeId, req);
  
  try {
    if (!fs.existsSync(themeFile)) {
      return res.status(404).json({ error: 'Theme file not found' });
    }
    
    const text = fs.readFileSync(themeFile, 'utf8');
    const lines = text.split('\n');
    
    let modified = false;
    const newLines = lines.map(line => {
      // Checked markdown list item: - [x] or - [ ]
      const checkedMatch = line.match(/^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+)$/);
      if (checkedMatch && checkedMatch[4].trim() === ideaText.trim()) {
        modified = true;
        if (archived) {
          return `${checkedMatch[1]}x${checkedMatch[3]}${checkedMatch[4]}`;
        } else {
          // Convert back to plain bullet: - text
          return `${checkedMatch[1].slice(0, -1)}${checkedMatch[4]}`;
        }
      }
      
      // Plain bullet list item: - text
      const bulletMatch = line.match(/^(\s*[-*+]\s+)(.+)$/);
      if (bulletMatch && bulletMatch[2].trim() === ideaText.trim()) {
        modified = true;
        if (archived) {
          // Convert to checked item: - [x] text
          return `${bulletMatch[1]}[x] ${bulletMatch[2]}`;
        } else {
          // Keep as plain bullet
          return line;
        }
      }
      
      // Plain line (no bullets)
      const plainTrim = line.trim();
      if (!checkedMatch && !bulletMatch && plainTrim === ideaText.trim() && !line.startsWith('#')) {
        modified = true;
        if (archived) {
          return `- [x] ${line}`;
        } else {
          return line;
        }
      }
      
      return line;
    });
    
    if (modified) {
      fs.writeFileSync(themeFile, newLines.join('\n'), 'utf8');
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error toggling idea:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Edit an idea's text (preserve its checkbox state / prefix style)
app.post('/api/ideas/edit', guarded((req, res) => {
  const { themeId, oldText, newText } = req.body;
  if (!themeId || !oldText || typeof newText !== 'string' || !newText.trim()) {
    return res.status(400).json({ error: 'Theme ID, old text, and new text are required' });
  }

  const themeFile = resolveThemeFile(themeId, req);

  try {
    if (!fs.existsSync(themeFile)) {
      return res.status(404).json({ error: 'Theme file not found' });
    }

    const text = fs.readFileSync(themeFile, 'utf8');
    const lines = text.split('\n');
    const target = oldText.trim();
    const replacement = newText.trim();
    let modified = false;

    const newLines = lines.map(line => {
      // Checked list item: - [x] text  or  - [ ] text
      const checkedMatch = line.match(/^(\s*[-*+]\s+\[[ xX]\]\s+)(.+)$/);
      if (checkedMatch && checkedMatch[2].trim() === target) {
        modified = true;
        return checkedMatch[1] + replacement;
      }
      // Plain bullet: - text
      const bulletMatch = line.match(/^(\s*[-*+]\s+)(.+)$/);
      if (bulletMatch && bulletMatch[2].trim() === target) {
        modified = true;
        return bulletMatch[1] + replacement;
      }
      // Plain line
      const plainTrim = line.trim();
      if (plainTrim === target && !line.startsWith('#')) {
        modified = true;
        // Preserve any leading whitespace
        const ws = line.match(/^(\s*)/)[1];
        return ws + replacement;
      }
      return line;
    });

    if (modified) {
      fs.writeFileSync(themeFile, newLines.join('\n'), 'utf8');
    }

    res.json({ success: true, modified });
  } catch (err) {
    console.error('Error editing idea:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Delete an idea entirely from a theme file
// Reorder the ideas of a theme: `order` lists the idea texts in the new
// order. The theme file is rewritten, preserving each line's checkbox state.
app.post('/api/ideas/reorder', guarded((req, res) => {
  const { themeId, order } = req.body || {};
  if (!themeId || !Array.isArray(order)) {
    return res.status(400).json({ error: 'themeId and order are required' });
  }
  const themeFile = resolveThemeFile(themeId, req);
  if (!fs.existsSync(themeFile)) {
    return res.status(404).json({ error: 'Theme file not found' });
  }
  const text = fs.readFileSync(themeFile, 'utf8');
  const lines = text.split('\n');
  const ideaLines = [];
  const otherLines = [];
  for (const line of lines) {
    if (/^\s*[-*+]\s+/.test(line)) ideaLines.push(line);
    else otherLines.push(line);
  }
  const byText = new Map();
  ideaLines.forEach(line => {
    const t = line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '').replace(/^\s*[-*+]\s+/, '').trim();
    if (t && !byText.has(t)) byText.set(t, line);
  });
  const ordered = [];
  const used = new Set();
  order.forEach(t => {
    if (byText.has(t) && !used.has(t)) {
      ordered.push(byText.get(t));
      used.add(t);
    }
  });
  ideaLines.forEach(line => {
    const t = line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '').replace(/^\s*[-*+]\s+/, '').trim();
    if (!used.has(t)) ordered.push(line);
  });
  fs.writeFileSync(themeFile, [...otherLines, ...ordered].join('\n'), 'utf8');
  res.json({ success: true });
}));

app.post('/api/ideas/delete', guarded((req, res) => {
  const { themeId, ideaText } = req.body;
  if (!themeId || !ideaText) {
    return res.status(400).json({ error: 'Theme ID and idea text are required' });
  }

  const themeFile = resolveThemeFile(themeId, req);

  try {
    if (!fs.existsSync(themeFile)) {
      return res.status(404).json({ error: 'Theme file not found' });
    }

    const text = fs.readFileSync(themeFile, 'utf8');
    const lines = text.split('\n');
    const target = ideaText.trim();
    let removed = false;

    const newLines = lines.filter(line => {
      if (removed) return true; // only delete the first match
      const checkedMatch = line.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/);
      if (checkedMatch && checkedMatch[1].trim() === target) { removed = true; return false; }
      const bulletMatch = line.match(/^\s*[-*+]\s+(.+)$/);
      if (bulletMatch && bulletMatch[1].trim() === target) { removed = true; return false; }
      const plainTrim = line.trim();
      if (plainTrim === target && !line.startsWith('#')) { removed = true; return false; }
      return true;
    });

    if (removed) {
      fs.writeFileSync(themeFile, newLines.join('\n'), 'utf8');
    }

    res.json({ success: true, removed });
  } catch (err) {
    console.error('Error deleting idea:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Add an idea to a theme file
app.post('/api/ideas/add', guarded((req, res) => {
  const { themeId, ideaText } = req.body;
  if (!themeId || !ideaText || (typeof ideaText === 'string' && !ideaText.trim())) {
    return res.status(400).json({ error: 'Theme ID and idea text are required' });
  }
  
  const themeFile = resolveThemeFile(themeId, req);
  
  try {
    if (!fs.existsSync(themeFile)) {
      return res.status(404).json({ error: 'Theme file not found' });
    }
    
    let text = fs.readFileSync(themeFile, 'utf8');
    // Ensure trailing newline
    if (text && !text.endsWith('\n')) {
      text += '\n';
    }
    
    let formatted = '';
    if (Array.isArray(ideaText)) {
      ideaText.forEach(t => {
        if (t && typeof t === 'string' && t.trim()) {
          formatted += `- ${t.trim()}\n`;
        }
      });
    } else if (typeof ideaText === 'string') {
      formatted = `- ${ideaText.trim()}\n`;
    }
    
    fs.writeFileSync(themeFile, text + formatted, 'utf8');
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error adding idea:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Create theme
app.post('/api/themes', guarded((req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Theme name is required' });
  
  const themeId = safeFilename(name);
  const themeFile = resolveThemeFile(themeId, req);
  
  try {
    if (fs.existsSync(themeFile)) {
      return res.status(400).json({ error: 'Theme file already exists' });
    }
    
    const content = `# ${name.trim()}\n\n`;
    fs.writeFileSync(themeFile, content, 'utf8');
    res.json({ success: true, theme: { id: themeId, name: name.trim(), ideas: [] } });
  } catch (err) {
    console.error('Error creating theme:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Delete theme
app.delete('/api/themes', guarded((req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID is required' });
  
  const themeFile = path.join(getIdeasDir(), `${id}.md`);
  
  try {
    if (fs.existsSync(themeFile)) {
      fs.unlinkSync(themeFile);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting theme:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Import documents via drag and drop of file contents
app.post('/api/documents/import', guarded((req, res) => {
  const { sectionId, filename, fileContent } = req.body;
  if (!sectionId || !filename || !fileContent) {
    return res.status(400).json({ error: 'Section, filename, and content required' });
  }
  
  try {
    const sectionFolder = sectionId === '_general' ? workspaceDir : path.join(workspaceDir, sectionId);
    if (!fs.existsSync(sectionFolder)) {
      fs.mkdirSync(sectionFolder, { recursive: true });
    }
    
    let targetFilename = filename;
    let targetPath = path.join(sectionFolder, targetFilename);
    if (fs.existsSync(targetPath)) {
      let index = 1;
      const base = filename.replace(/\.(md|txt)$/i, '');
      const ext = filename.match(/\.(md|txt)$/i)?.[0] || '.md';
      while (fs.existsSync(path.join(sectionFolder, `${base}-${index}${ext}`))) {
        index++;
      }
      targetFilename = `${base}-${index}${ext}`;
      targetPath = path.join(sectionFolder, targetFilename);
    }
    
    fs.writeFileSync(targetPath, fileContent, 'utf8');
    const id = sectionId === '_general' ? `_general/${targetFilename}` : `${sectionId}/${targetFilename}`;
    const fileStat = fs.statSync(targetPath);
    const docInfo = parseMarkdownDoc(fileContent, targetFilename);
    
    res.json({
      success: true,
      document: {
        id,
        filename: targetFilename,
        title: docInfo.title,
        subtitle: docInfo.subtitle,
        content: docInfo.body,
        createdAt: fileStat.birthtimeMs,
        updatedAt: fileStat.mtimeMs
      }
    });
  } catch (err) {
    console.error('Error importing document:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Import theme via drag and drop of file contents
app.post('/api/themes/import', guarded((req, res) => {
  const { filename, fileContent } = req.body;
  if (!filename || !fileContent) {
    return res.status(400).json({ error: 'Filename and content required' });
  }
  
  try {
    const ideasDir = getIdeasDir();
    if (!fs.existsSync(ideasDir)) {
      fs.mkdirSync(ideasDir, { recursive: true });
    }
    
    let themeId = filename.replace(/\.(md|markdown|txt)$/i, '');
    let targetFilename = `${themeId}.md`;
    let targetPath = path.join(ideasDir, targetFilename);
    
    if (fs.existsSync(targetPath)) {
      let index = 1;
      while (fs.existsSync(path.join(ideasDir, `${themeId}-${index}.md`))) {
        index++;
      }
      themeId = `${themeId}-${index}`;
      targetFilename = `${themeId}.md`;
      targetPath = path.join(ideasDir, targetFilename);
    }
    
    fs.writeFileSync(targetPath, fileContent, 'utf8');
    const theme = parseIdeasFile(fileContent, targetFilename);
    
    res.json({
      success: true,
      theme: {
        id: themeId,
        name: theme.themeName,
        ideas: theme.ideas
      }
    });
  } catch (err) {
    console.error('Error importing theme:', err);
    res.status(500).json({ error: err.message });
  }
}));

// Returns the LAN addresses the phone can actually reach.
function lanAddresses() {
  const nets = require('os').networkInterfaces();
  const out = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

app.listen(PORT, HOST, () => {
  console.log(`\n  Scriptorium — http://localhost:${PORT}`);
  console.log(`  Dossier de travail : ${workspaceDir}`);
  if (LOOPBACK_ONLY) {
    console.log(`\n  Accessible depuis cette machine uniquement.`);
    console.log(`  Pour y accéder depuis un téléphone : HOST=0.0.0.0 npm start\n`);
  } else {
    console.log(`\n  ⚠  Exposé sur le réseau (${HOST}) — jeton d'accès requis.`);
    for (const addr of lanAddresses()) {
      console.log(`  Téléphone : http://${addr}:${PORT}/?token=${accessToken}`);
    }
    console.log('');
  }
});
