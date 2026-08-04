# Setting up the in-app updater

The update check ships already: the server asks the GitHub releases API at most
once every six hours, a dot appears on the settings icon, and the modal links to
the release. That part needs no key and no configuration.

Installing the update from inside the app is the part described here. It needs a
signing key, because the Tauri updater refuses to install a package whose
signature it cannot verify. The key has nothing to do with the API rate limit:
the limit applies to the check, the key applies to the install.

## What can and cannot update itself

| Format | In-app update |
|---|---|
| Windows installer (NSIS, MSI) | yes |
| macOS `.app` (from the `.dmg` or the archive) | yes |
| Linux AppImage | yes |
| Linux `.deb`, `.rpm` | no, the package manager owns the install |
| Windows portable `.exe` | no, see the note at the end |

For the two rows that answer no, the app shows the dot and points at the
download page. That behaviour is already in place.

## 1. Generate the key pair

Run this once, on your machine. It writes the private key to the file you name
and prints the public key.

```bash
npx @tauri-apps/cli signer generate -w "$HOME/.scriptorium-updater.key"
```

Keep the file out of the repository, and back it up somewhere safe. Losing it
means no existing installation can accept another update: they all have to be
reinstalled by hand.

## 2. Add the secrets on GitHub

In the repository, `Settings` then `Secrets and variables` then `Actions`, add:

- `TAURI_SIGNING_PRIVATE_KEY`: the whole content of the private key file
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the passphrase you typed, or an empty
  value if you chose none

Then declare them in the build step of `.github/workflows/build.yml`, next to
`GITHUB_TOKEN`:

```yaml
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          includeUpdaterJson: true
```

`includeUpdaterJson` publishes the `latest.json` manifest that the app reads to
learn a new version exists and where to fetch it.

## 3. Declare the updater in the app

`src-tauri/tauri.conf.json`, with the public key printed in step 1:

```json
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/infinition/scriptorium/releases/latest/download/latest.json"
      ],
      "pubkey": "PASTE THE PUBLIC KEY HERE"
    }
  }
```

`src-tauri/Cargo.toml`:

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

`src-tauri/src/lib.rs`, in the builder chain:

```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

## 4. The part specific to Scriptorium

Most Tauri apps load their own bundled files. Scriptorium does not: the window
shows `http://localhost:<port>`, served by the Node process the shell spawns.
Tauri 2 does not expose its API to a page on an origin it does not own, so
`window.__TAURI__` is absent today and the client already falls back to opening
the download page.

To let the page drive the updater, the localhost origin has to be granted that
one capability, and only that one. Create `src-tauri/capabilities/updater.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "updater",
  "windows": ["main"],
  "remote": {
    "urls": ["http://localhost:48731", "http://localhost:48732", "http://localhost:48733"]
  },
  "permissions": ["updater:default", "process:allow-restart"]
}
```

The three ports are the ones `CANDIDATE_PORTS` in `lib.rs` tries, in order. Keep
the two lists in step.

Grant nothing beyond these two permissions. Any page served on that origin can
call whatever the capability opens up, and the origin is a local HTTP server.
Loopback binding keeps that contained, but there is no reason to widen it.

Set `"withGlobalTauri": true` under `app` in `tauri.conf.json` so the page sees
`window.__TAURI__` without a bundler step, which is what `public/app.js` expects.

## 5. Check it worked

Tag a release, wait for the three builds, then confirm the release carries
`latest.json` next to the installers. Install the previous version, open
Settings, and the install button should appear next to the dot.

I could not test this section here: it needs a full bundle on each of the three
operating systems and a signing key. The steps above follow the Tauri 2 updater
documentation, and the capability shape in step 4 is the part worth checking
against the current docs before you tag.

## The portable Windows exe

A running executable is locked by Windows, so it cannot overwrite itself. The
usual answer is to download the new file next to the old one, start a small
helper that waits for the process to exit, swaps the two files and relaunches.
The Tauri updater drives an installer instead, so it does not cover this case.
It is a couple of dozen lines of Rust if you want it later.
