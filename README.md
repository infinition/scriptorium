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
to find your workspace folder. The default points at
`C:\DEV\coding\nexearch\solutions\manifest` — change it from the gear icon in
the sidebar, or edit `config.json` directly.

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
up in the gutter on the active line — click it for headings, lists, checkbox,
quote, code block, divider.

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
- No framework on the client — `public/{index.html, app.js, style.css}`.
- `highlight.js` and `KaTeX` are loaded from a CDN; they degrade gracefully
  if offline (formulas show as inline code, blocks lose syntax colours but
  stay readable).
- Fonts: Newsreader (body), Inter (UI), JetBrains Mono (code).

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
