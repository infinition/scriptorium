//! Scriptorium desktop shell.
//!
//! The desktop app is a plain window over the real web app: it spawns the
//! existing Node server (`node server.js`) and loads its URL. No business
//! logic lives here, so the GUI behaves exactly like the browser version.

use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

// The spawned `node server.js` process, killed when the window closes.
static SERVER: Mutex<Option<Child>> = Mutex::new(None);

// Ports tried in order. A fixed port (rather than a random one) keeps the page
// origin stable between launches, so localStorage (theme, font sizes,
// preferences) survives restarts.
const CANDIDATE_PORTS: [u16; 3] = [48731, 48732, 48733];

// Where server.js, config.json and node_modules live. In dev, cargo runs from
// src-tauri (the project root is its parent); a packaged or ad-hoc run may
// happen from the repo root itself.
fn find_project_root(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    // SCRIPTORIUM_ROOT wins when set explicitly.
    if let Ok(p) = std::env::var("SCRIPTORIUM_ROOT") {
        let root = PathBuf::from(p);
        if root.join("server.js").exists() {
            return Some(root);
        }
    }
    // Tauri's canonical resource directory. A .deb installs the bundle there
    // (e.g. /usr/lib/Scriptorium); the ".." resources land in an _up_ folder,
    // so both the folder itself and its _up_ child are candidates. Without
    // this the packaged binary only walked parents of the executable and never
    // found server.js on Linux.
    if let Some(rd) = resource_dir {
        let candidates = [rd.clone(), rd.join("_up_")];
        for c in &candidates {
            if c.join("server.js").exists() {
                return Some(c.clone());
            }
        }
        // The .deb may place the resources under the product name while Tauri
        // reports a sibling (crate-name) folder; check the parent too.
        if let Some(parent) = rd.parent() {
            let siblings = [parent.join("_up_"), parent.join("Scriptorium").join("_up_")];
            for c in &siblings {
                if c.join("server.js").exists() {
                    return Some(c.clone());
                }
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("server.js").exists() {
            return Some(cwd);
        }
        if let Some(parent) = cwd.parent() {
            if parent.join("server.js").exists() {
                return Some(parent.to_path_buf());
            }
        }
    }
    // Walking up from the executable covers a direct run of the dev binary
    // (src-tauri/target/debug/…), packaged or ad-hoc launches. In a bundled
    // app the server lives in the bundle's resource folder. Tauri rewrites the
    // leading ".." of resources that sit outside src-tauri as "_up_", so both
    // Resources/server.js and Resources/_up_/server.js are candidates.
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        for _ in 0..6 {
            if dir.join("server.js").exists() {
                return Some(dir);
            }
            let resources = dir.join("Resources");
            if resources.join("server.js").exists() {
                return Some(resources);
            }
            let up = resources.join("_up_");
            if up.join("server.js").exists() {
                return Some(up);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
}

// A single self-contained Windows exe carries a compressed payload appended
// after a marker: node.exe, server.js, the assets and node_modules. Extract it
// once into the user data dir, then run node from there. This makes the exe
// work anywhere, with no project folder and no Node install required.
fn extract_portable_payload() -> Option<PathBuf> {
    const MARKER: &[u8] = b"\x00SCRI_PORTABLE_PAYLOAD\x00";
    let exe = std::env::current_exe().ok()?;
    let bytes = fs::read(&exe).ok()?;
    let pos = bytes.windows(MARKER.len()).rposition(|w| w == MARKER)? + MARKER.len();
    if pos >= bytes.len() {
        return None;
    }

    let version = env!("CARGO_PKG_VERSION");
    let base = dirs::data_dir()?.join("Scriptorium").join("portable");
    let marker_file = base.join(".version");
    if fs::read_to_string(&marker_file).ok().as_deref() == Some(version) {
        return Some(base);
    }
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).ok()?;
    let decoder = flate2::read::GzDecoder::new(&bytes[pos..]);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(&base).ok()?;
    let _ = fs::write(&marker_file, version);
    Some(base)
}

fn server_is_up(port: u16) -> bool {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().expect("adresse valide");
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

// Spawns the Node server. On Windows, node is a console app and would open a
// CMD window of its own; CREATE_NO_WINDOW keeps it hidden so the GUI looks
// self-contained. stdout/stderr go nowhere (the GUI does not need the logs).
fn spawn_node(node: &Path, root: &Path, port: u16) -> std::io::Result<Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;
        Command::new(node)
            .arg("server.js")
            .current_dir(root)
            .env("PORT", port.to_string())
            .env("HOST", "127.0.0.1")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }
    #[cfg(not(windows))]
    {
        Command::new(node)
            .arg("server.js")
            .current_dir(root)
            .env("PORT", port.to_string())
            .env("HOST", "127.0.0.1")
            .spawn()
    }
}

// A running server: either spawned by us (child) or reused because one was
// already listening (child is None, so nothing to kill at exit).
struct ServerHandle {
    port: u16,
    child: Option<Child>,
}

// True when a Scriptorium server already answers on this port (a previous
// instance, or a server started by hand). The GUI then hooks onto it instead
// of starting a second one.
fn existing_scriptorium_server(port: u16) -> bool {
    use std::io::{Read, Write};

    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().expect("adresse valide");
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let req = format!(
        "GET /api/config HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 4096];
    let mut body = String::new();
    while let Ok(n) = stream.read(&mut buf) {
        if n == 0 {
            break;
        }
        body.push_str(&String::from_utf8_lossy(&buf[..n]));
        if body.len() > 4096 {
            break;
        }
    }
    body.contains("workspaceDir")
}

// Reuses an already-running server if one is up, otherwise spawns
// `node server.js` and waits until it answers on 127.0.0.1:<port>.
fn start_server(root: &Path) -> Result<ServerHandle, String> {
    for &port in &CANDIDATE_PORTS {
        if existing_scriptorium_server(port) {
            return Ok(ServerHandle { port, child: None });
        }
    }
    for &port in &CANDIDATE_PORTS {
        // Use a bundled node binary when present (portable Windows build, or a
        // macOS/Linux bundle where node sits next to the _up_ server folder),
        // else the system node on PATH.
        let mut node = PathBuf::from("node");
        let mut dir = root.to_path_buf();
        for _ in 0..4 {
            let bn = dir.join("bundle-node");
            let found = [
                dir.join("node.exe"),
                dir.join("node"),
                bn.join("node.exe"),
                bn.join("node"),
            ].iter().find(|p| p.exists()).cloned();
            if let Some(f) = found {
                node = f;
                break;
            }
            if !dir.pop() {
                break;
            }
        }
        let mut child = spawn_node(&node, root, port)
            .map_err(|e| format!("Impossible de lancer node server.js : {e}"))?;

        let mut up = false;
        for _ in 0..40 {
            if server_is_up(port) {
                up = true;
                break;
            }
            // The process died before listening (e.g. missing node_modules).
            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }

        if up {
            return Ok(ServerHandle { port, child: Some(child) });
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    Err("Le serveur Scriptorium n'a pas pu démarrer. Lancez \"npm install\" à la racine du projet, puis réessayez.".to_string())
}

// Shows a native error dialog and returns an error to abort startup.
fn fatal(message: &str) -> Box<dyn std::error::Error> {
    let _ = rfd::MessageDialog::new()
        .set_title("Scriptorium")
        .set_description(message)
        .set_level(rfd::MessageLevel::Error)
        .show();
    Box::new(std::io::Error::other(message))
}

fn kill_server() {
    if let Some(mut child) = SERVER.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

// On Windows, binds `child` to a Job Object configured with "kill on close".
// The OS then terminates node whenever this process exits, even on a
// force-kill (taskkill /F) or a crash, which a plain child.kill() cannot cover.
#[cfg(windows)]
mod job {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub fn bind_kill_on_close(child: &Child) {
        unsafe {
            let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return;
            }
            if AssignProcessToJobObject(job, child.as_raw_handle()) == 0 {
                CloseHandle(job);
                return;
            }
            // Keep the job handle alive for the whole process lifetime: a raw
            // handle is never auto-closed, and the OS closes it when this
            // process exits, which triggers the kill-on-close of every process
            // in the job (the node server).
            let _ = job;
        }
    }
}

#[cfg(not(windows))]
mod job {
    use std::process::Child;

    pub fn bind_kill_on_close(_child: &Child) {}
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let root = find_project_root(app.path().resource_dir().ok())
                .or_else(extract_portable_payload)
                .ok_or_else(|| fatal("Serveur Scriptorium introuvable. Utilisez l'archive portable, ou placez l'application dans le dossier du projet, à côté de server.js."))?;

            let handle = start_server(&root)
                .map_err(|e| fatal(&e))?;

            // Ensure a server we spawned dies with us, even on a force-kill.
            if let Some(child) = &handle.child {
                job::bind_kill_on_close(child);
            }

            let url: tauri::Url = format!("http://127.0.0.1:{}/", handle.port)
                .parse()
                .expect("URL invalide");

            match tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("Scriptorium")
                .inner_size(1200.0, 800.0)
                .min_inner_size(320.0, 480.0)
                .resizable(true)
                // Tauri's native drop handler intercepts drags before the DOM
                // sees them: dragstart fires but dragover/drop never do. Off
                // so the app's own HTML5 drag and drop (ideas, files) works.
                .disable_drag_drop_handler()
                .center()
                .build()
            {
                Ok(_) => {
                    // None when the server was already running: nothing to kill.
                    *SERVER.lock().unwrap() = handle.child;
                    Ok(())
                }
                Err(e) => {
                    if let Some(mut child) = handle.child {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    Err(fatal(&format!("Impossible de créer la fenêtre : {e}")))
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        // Stop node as the event loop dies. On Windows the Job Object already
        // guarantees it; this is the fallback for the other platforms.
        if matches!(event, tauri::RunEvent::Exit) {
            kill_server();
        }
    });

    // The window is closed and the event loop has exited: stop the Node server.
    kill_server();
}
