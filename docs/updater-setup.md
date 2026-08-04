# The in-app updater

Everything is wired: the plugin, the capability, the signed artifacts and the
`latest.json` manifest. One step is left, and only you can do it, because it
involves a secret: putting the signing key into the repository secrets.

## What can and cannot update itself

| Format | In-app update |
|---|---|
| Windows installer (NSIS, MSI) | yes |
| macOS `.app` (from the `.dmg` or the archive) | yes |
| Linux AppImage | yes |
| Linux `.deb`, `.rpm` | no, the package manager owns the install |
| Windows portable `.exe` | no, see the note at the end |

For the two rows that answer no, the app shows the dot on the settings icon and
points at the download page.

## The one step left: the secrets

The key pair is already generated. It lives outside this repository, in
`~/.scriptorium-updater/`:

- `scriptorium.key` is the private key. It signs the updates.
- `scriptorium.key.pub` is the public key. It is already in
  `src-tauri/tauri.conf.json`, and it is meant to be public.
- `passphrase.txt` is the passphrase protecting the private key.

Back that folder up somewhere safe. Losing the private key means no existing
installation will ever accept another update: every one of them has to be
reinstalled by hand.

On GitHub, open the repository, then `Settings`, `Secrets and variables`,
`Actions`, `New repository secret`, and create two:

| Secret name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the whole content of `scriptorium.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the content of `passphrase.txt` |

Paste the file contents whole, including the comment line at the top of the key
and the trailing newline. The workflow already reads both.

Until these two secrets exist, tagging a release still produces working
installers, it simply produces no usable update manifest.

## What was wired, and where

`src-tauri/tauri.conf.json`

- `plugins.updater.endpoints` points at
  `releases/latest/download/latest.json`
- `plugins.updater.pubkey` holds the public key
- `bundle.createUpdaterArtifacts` makes the build produce the signed artifacts
- `app.withGlobalTauri` exposes `window.__TAURI__` to the page, which is what
  `public/app.js` calls

`src-tauri/capabilities/updater.json`

Most Tauri apps load their own bundled files. Scriptorium does not: the window
shows `http://localhost:<port>`, served by the Node process the shell spawns.
Tauri 2 gives a page on an origin it does not own no access at all, so the
capability grants that origin exactly two permissions, `updater:default` and
`process:allow-restart`, and nothing else. Any page served on that origin can
use what the capability opens, so it is deliberately kept to the minimum.

The three ports listed there are the ones `CANDIDATE_PORTS` in `lib.rs` tries,
in order. Keep the two lists in step.

`.github/workflows/build.yml` passes the signing key to the build and sets
`includeUpdaterJson: true`.

## Checking it worked

Tag a release and let the three builds finish, then confirm the release carries
`latest.json` next to the installers. Install the previous version, open
Settings, and the install button appears next to the dot.

What was verified here: the Rust side compiles, and `generate_context!`
validates capability permissions at compile time, so the capability file and
its two permission names are correct. What was not verified here: a full bundle
on each of the three operating systems, and an actual update round trip. Both
need the secrets and a tagged build.

## The portable Windows exe

A running executable is locked by Windows, so it cannot overwrite itself. The
usual answer is to download the new file next to the old one, start a small
helper that waits for the process to exit, swaps the two files and relaunches.
The Tauri updater drives an installer instead, so it does not cover this case.
It is a couple of dozen lines of Rust if you want it later.
