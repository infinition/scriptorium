# Scriptorium

A distraction-free markdown writer that reads and writes plain `.md` files on
your own disk. Built for long-form work: manifestos, essays, notes, drafts.

The editor stays out of your way. Headings, lists, code blocks and math render
in place; the line under your cursor switches to raw markdown so you can edit
it like a regular text file. Nothing leaves your machine.

## Running

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

On first launch the server reads `config.json` (created next to `server.js`)
to find your workspace folder. The default is `~/Scriptorium`; change it from
the gear icon in the sidebar, or edit `config.json` directly. To run against a
different folder for one session without touching the saved config, set
`SCRIPTORIUM_WORKSPACE`.

### From a phone or tablet

The server binds to `127.0.0.1` by default, so nothing outside this machine can
reach your files. To use Scriptorium from another device on your network:

```bash
HOST=0.0.0.0 npm start
```

It then prints a URL containing an access token:

```
  Téléphone : http://192.168.1.20:3000/?token=xxxxxxxx
```

Open that link once on the phone — the token is stored in `localStorage` and
removed from the address bar, and every later visit works from the plain URL.
The token lives in `config.json`; delete it there to revoke access.

Add it to your home screen and it installs as a standalone app: the shell is
cached by a service worker, so it opens without a network. Editing still needs
the server, since that is what reads and writes your files.

## Offline

No CDN, no external font host — KaTeX, highlight.js and the three typefaces are
installed by `npm install` and served from `node_modules`. The only network
traffic is between your browser and your own machine.

## Workspace layout

The workspace is a folder you own. Scriptorium mirrors its structure 1:1:

```
workspace/
  Manifestos/                      <- section (sidebar group)
    on-time.md                     <- document
    against-clarity.md
  Essays/
    welcome.md
  ideas/                           <- sentence-cloud source
    quantum.md                     <- one theme per file
    consciousness.md
```

- A subfolder is a section. Rename a folder, the section renames.
- A `.md` at the root lands in the implicit "General" section.
- Drag a `.md` onto a section in the sidebar to import it.
- `ideas/*.md` files hold the right-panel cloud. Each line starting with `- `
  is an idea; `- [x] ...` means archived. The files are rewritten in place
  whenever you click on an idea, so editing them from outside the app works too.

Filenames are derived from the document title (slugified, ASCII). Rename a
title and the file gets renamed on next save. Section renames are immediate.

## Keyboard

| Shortcut         | Action                              |
|------------------|-------------------------------------|
| `Ctrl+N`         | New document                        |
| `Ctrl+S`         | Force save                          |
| `Ctrl+P`         | Open search palette                 |
| `Ctrl+Shift+F`   | Open search palette (alternative)   |
| `F`              | Toggle focus mode (outside fields)  |
| `Ctrl+G` / `Ctrl+B` | Bold the selection               |
| `Ctrl+I`         | Italic                              |
| `Ctrl+K` then `C`| Cycle heading level on current line |
| `Ctrl+K` then `Q`| Toggle blockquote                   |
| `Ctrl+K` then `L`| Toggle bullet list                  |
| `Ctrl+K` then `U`| Wrap selection in `<u>...</u>`      |
| `Ctrl+K` then `D`| Wrap selection in inline code       |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo per-document   |

A floating toolbar appears whenever you select text. A small `+` button shows
up in the gutter on the active line; click it for headings, lists, checkbox,
quote, code block, divider.

Clicking in the space between two blocks inserts a new one there. That space is
the only place an insertion happens: a click anywhere inside a block always
edits that block, with no exception. The cursor says which one you will get —
`text` over a block, `cell` over a gap — and only one of the two highlights is
ever shown. On touch, a short vibration marks the gap.

Pasting always inserts plain text: content copied from a word processor or a
web page arrives as the markdown source you can see and edit, and multi-line
pastes become real lines rather than one glued-together paragraph.

## Touch

- Swipe from the left edge to open the sidebar, from the right for the ideas
  panel; swipe back to close.
- Long-press a document in the sidebar to move it to another section (this
  replaces the drag-and-drop, which touch browsers do not fire). Right-click
  does the same on desktop.
- The drag handle on the active line works with a finger.

## Snapshots

Restoring a snapshot swaps it with what is currently in the editor rather than
overwriting it: the version you were looking at takes the snapshot's place in
the list, so clicking Restore again takes you straight back. The entry keeps
its id and position; only its contents move.

## Concurrent edits

Documents are saved with the timestamp they were opened at. If the file changed
in the meantime — the same document open on your phone, in another tab, or in
an external editor — the save is refused and you are asked which version to
keep, instead of one silently overwriting the other. When the conflict happens
as the page is closing, and there is nobody to ask, the incoming version is
written next to the original as `<name>.conflit-<date>.md`.

## Markdown support

Standard CommonMark plus a few extras used by Obsidian/GitHub:

- Headings, lists, ordered lists, task lists (`- [ ]` / `- [x]`)
- Bold, italic, strikethrough, underline (via `<u>`), inline code, highlight (`==text==`)
- Links, wikilinks (`[[name]]`), images
- Blockquotes and Obsidian-style callouts (`> [!info] Title`)
- Tables (single-line cells)
- Horizontal rules
- Fenced code blocks with syntax highlighting via `highlight.js`
  (common languages bundled; Rust, Go, YAML, Dockerfile, LaTeX added explicitly)
- Inline LaTeX (`$x^2$`) and display LaTeX (`$$ \int ... $$`) via KaTeX
- Footnote references (`[^1]`)

The renderer is line-oriented: code fences and tables get grouped after the
fact so they look like real blocks while still letting you edit any line
in source.

## Stack

- Node.js + Express on the server side. The whole API is in `server.js`.
- No framework on the client: `public/{index.html, app.js, style.css}`.
- `highlight.js` and `KaTeX` are installed as dependencies and served from
  `node_modules` under `/vendor`.
- Fonts: Newsreader (body), Inter (UI), JetBrains Mono (code), self-hosted via
  `@fontsource`.
- `public/sw.js` caches the app shell so it opens offline; `/api/` is never
  cached.

Paths coming from the client are confined to the workspace folder
(`safeJoin`/`assertSegment` in `server.js`): a section or document name can
only ever be a single path segment. The padlock in the sidebar is enforced by
the server, not just the UI.

## Star History

<a href="https://www.star-history.com/?repos=infinition%2Fscriptorium&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=infinition/scriptorium&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=infinition/scriptorium&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=infinition/scriptorium&type=date&legend=top-left" />
 </picture>
</a>

## License

ISC. See `package.json`.
