use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::net::{Ipv4Addr, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cartographer::{assets, observer::{self, Observer}, pick_pid, setting};
use tiny_http::{Header, Response, Server, StatusCode};

/// The viewer's files from `src/host/web`, embedded by build.rs.
mod web { include!(concat!(env!("OUT_DIR"), "/web_assets.rs")); }
/// films-ui's sources as JavaScript, embedded by build.rs and served under `/ui/`.
mod ui { include!(concat!(env!("OUT_DIR"), "/ui_assets.rs")); }
mod server;
mod terminal;
mod typescript;

const USAGE: &str = concat!(
    "Usage: cartographer --version\n",
    "       cartographer [pid] status|snapshot\n",
    "       cartographer [pid] capture [seconds]\n",
    "       cartographer [pid] serve [port] [--lan [address]] [--no-browser]\n",
    "       cartographer server [--game <install folder>] [--dry-run]\n",
    "       cartographer [pid] navmesh <out.json> [--blob <file>]\n",
    "\n\
serve listens on this PC on port 17843 by default. Use --lan to allow other PCs on the network
to open it, through all adapters or the specified IPv4 address. It opens the default browser
at the viewer address. Add --no-browser to keep the browser closed.

capture records snapshots for 60 seconds unless given a duration, to logs\\ in the current folder.

server starts the LAN dedicated server in its own console, directly, as the game's LAN menu does.
It finds the Steam install automatically, or --game names one. --dry-run prints the launch
without starting anything. An existing server is never stopped or replaced. Then use serve to view it.

navmesh (experimental, for development) writes the loaded map's floor plan, read from the server's
navigation mesh during a match, in the map data's plan format, with the kill and safe volumes it found.
--blob also saves the Forge map's navmesh.blob as the server holds it.

Development (serve only):
  CARTOGRAPHER_WEB_DIR=<web folder>    serve the viewer from disk and reload the page when a file changes
  CARTOGRAPHER_UI_DIR=<films-ui src>   serve films-ui's TypeScript from disk, converted per request, reloading on change
  CARTOGRAPHER_REPLAY=<capture.jsonl>  serve a capture's snapshots in a loop instead of reading a server
  CARTOGRAPHER_<PART>_DIR=<folder>     serve one part of the built-in map data from a folder on disk:
                                       LEVELS, PLAYABLE, MAPS, OBJECTIVES, ICONS, MARKERS, MODES, TEAMS or FONTS
  CARTOGRAPHER_ACCESS_DIR=<folder>     make the data view's limits from a folder of film-assets access files",
);

/// Dev-only client that the server adds to the page while it serves the viewer or films-ui from
/// disk. It polls their file times: a stylesheet change swaps that sheet in place, any other change
/// reloads.
const RELOAD_JS: &str = r#"let last = null;
async function tick() {
  try {
    const files = await (await fetch("/__dev/stamp", { cache: "no-store" })).json();
    const changed = last ? [...new Set([...Object.keys(files), ...Object.keys(last)])].filter(name => files[name] !== last[name]) : [];
    last = files;
    if (changed.length && !changed.every(name => name.endsWith(".css"))) return location.reload();
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const url = new URL(link.href, location.href);
      if (!changed.includes(url.pathname.slice(1))) continue;
      url.searchParams.set("v", files[url.pathname.slice(1)]);
      const next = link.cloneNode();
      next.href = url.href;
      next.onload = () => link.remove();
      link.after(next);
    }
  } catch {}
  setTimeout(tick, 400);
}
tick();
"#;

/// Maps a request path to a file under the web folder: `/` is `index.html`, and only plain relative
/// names are accepted (no dot segments or hidden files, empty segments, backslashes or escapes).
fn web_path(path: &str) -> Option<&str> {
    let relative = path.strip_prefix('/')?;
    if relative.is_empty() { return Some("index.html"); }
    relative.split('/').all(|segment| !segment.is_empty() && !segment.starts_with('.')
        && segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
        .then_some(relative)
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, extension)| extension) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn with_reload(page: &[u8]) -> Vec<u8> {
    const TAG: &str = r#"<script type="module" src="/__dev/reload.js"></script>"#;
    let page = String::from_utf8_lossy(page);
    let at = page.rfind("</body>").unwrap_or(page.len());
    [&page[..at], TAG, &page[at..]].concat().into_bytes()
}

/// Modification time in ms of every file under `root`, keyed like `web_path` names them.
fn stamps(root: &Path) -> BTreeMap<String, u64> {
    let mut stamps = BTreeMap::new();
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((directory, prefix)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(metadata) = entry.metadata() else { continue };
            if name.starts_with('.') { continue; }
            if metadata.is_dir() { pending.push((entry.path(), format!("{prefix}{name}/"))); continue; }
            let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok());
            stamps.insert(format!("{prefix}{name}"), modified.map_or(0, |time| u64::try_from(time.as_millis()).unwrap_or(u64::MAX)));
        }
    }
    stamps
}

/// A capture's snapshots, served in a loop at the pace they were captured.
struct Replay { frames: Vec<(u64, Vec<u8>)>, length: u64, started: Instant }

impl Replay {
    fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
        Self::parse(&text).map_err(|error| format!("{}: {error}", path.display()))
    }

    /// A capture's lines. The reads that failed are in it too, as `{"error": ...}`. Only the
    /// snapshots are replayed.
    fn parse(text: &str) -> Result<Self, String> {
        let mut frames = Vec::new();
        for (index, line) in text.lines().enumerate().filter(|(_, line)| !line.trim().is_empty()) {
            let value: serde_json::Value = serde_json::from_str(line).map_err(|error| format!("line {}: {error}", index + 1))?;
            if value.get("error").is_some() { continue; }
            let at = value.get("captured_unix_ms").and_then(serde_json::Value::as_u64)
                .ok_or_else(|| format!("line {}: no captured_unix_ms", index + 1))?;
            frames.push((at, line.as_bytes().to_vec()));
        }
        Self::from_frames(frames).ok_or_else(|| "no snapshots".to_owned())
    }

    fn from_frames(mut frames: Vec<(u64, Vec<u8>)>) -> Option<Self> {
        frames.sort_by_key(|frame| frame.0);
        let (first, last) = (frames.first()?.0, frames.last()?.0);
        for frame in &mut frames { frame.0 -= first; }
        // The loop lasts one average frame interval past the last frame.
        let step = u64::try_from(frames.len() - 1).ok().filter(|&count| count > 0).map_or(250, |count| (last - first) / count);
        Some(Self { length: last - first + step.max(1), frames, started: Instant::now() })
    }

    fn frame_at(&self, elapsed_ms: u64) -> &[u8] {
        let at = elapsed_ms % self.length;
        &self.frames[self.frames.partition_point(|frame| frame.0 <= at).saturating_sub(1)].1
    }

    fn current(&self) -> &[u8] { self.frame_at(u64::try_from(self.started.elapsed().as_millis()).unwrap_or(0)) }
}

/// Development switches for `serve`, all off unless their environment variable is set (USAGE).
struct Dev {
    web: Option<PathBuf>,
    ui: Option<PathBuf>,
    replay: Option<Replay>,
    /// The parts of the map data served from a folder instead (the stores read the same settings).
    data: Vec<(&'static str, PathBuf)>,
}

impl Dev {
    fn from_env() -> Result<Self, String> {
        let folder = |name: &str, root: Option<PathBuf>| match root {
            Some(root) if !root.is_dir() => Err(format!("CARTOGRAPHER_{name} is not a folder: {}", root.display())),
            root => Ok(root),
        };
        let web = folder("WEB_DIR", setting("WEB_DIR").map(PathBuf::from))?;
        let ui = folder("UI_DIR", setting("UI_DIR").map(PathBuf::from))?;
        let replay = setting("REPLAY").map(|path| Replay::load(Path::new(&path))).transpose()?;
        let mut data = Vec::new();
        for part in assets::PARTS {
            let name = format!("{}_DIR", part.to_ascii_uppercase());
            if let Some(root) = folder(&name, assets::override_dir(part))? { data.push((part, root)); }
        }
        // The data view's limits, made from film-assets access files on disk (geometry.rs).
        if let Some(root) = folder("ACCESS_DIR", assets::override_dir("access"))? { data.push(("access", root)); }
        Ok(Self { web, ui, replay, data })
    }

    /// Whether the page reloads itself on a change: while the viewer or films-ui is served from disk.
    fn live(&self) -> bool { self.web.is_some() || self.ui.is_some() }

    /// Modification times for the reload client: the viewer's files, and films-ui's under `ui/`.
    fn stamps(&self) -> BTreeMap<String, u64> {
        let mut files = self.web.as_deref().map(stamps).unwrap_or_default();
        if let Some(ui) = &self.ui { files.extend(stamps(ui).into_iter().map(|(name, time)| (format!("ui/{name}"), time))); }
        files
    }

    /// A films-ui module (`relative` names it as `.js`): its `.ts` source under
    /// `CARTOGRAPHER_UI_DIR`, converted now, else the embedded conversion. An error converting is the
    /// response's body, so the browser's console says what broke.
    fn ui_module(&self, relative: &str) -> Option<Result<Vec<u8>, String>> {
        match &self.ui {
            Some(root) => {
                let source = root.join(relative.strip_suffix(".js")?).with_extension("ts");
                let text = std::fs::read_to_string(&source).ok()?;
                Some(typescript::to_javascript(&source, &text).map(String::into_bytes))
            }
            None => ui::UI_ASSETS.iter().find(|(path, _)| *path == relative).map(|(_, body)| Ok(body.to_vec())),
        }
    }

    /// A viewer file: from disk under `CARTOGRAPHER_WEB_DIR`, else the embedded copy. The page
    /// carries the reload client while anything is served from disk.
    fn asset(&self, relative: &str) -> Option<Vec<u8>> {
        let body = match &self.web {
            Some(root) => std::fs::read(root.join(relative)).ok()?,
            None => web::WEB_ASSETS.iter().find(|(path, _)| *path == relative).map(|(_, body)| body.to_vec())?,
        };
        Some(if relative == "index.html" && self.live() { with_reload(&body) } else { body })
    }
}

enum Mode {
    Status,
    Snapshot,
    Capture(u64),
    Serve(u16, Reach, bool),
    Server(Option<PathBuf>, bool),
    /// Experimental: the plan from the server's navmesh, and where to save its navmesh.blob.
    Navmesh(PathBuf, Option<PathBuf>),
}

/// Who can open `serve`: this PC only (the default), or other PCs on the network too (`--lan`),
/// through every network adapter or only the one with the given address.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Reach {
    Local,
    Lan(Option<Ipv4Addr>),
}

fn parse(arguments: &[String]) -> Result<(Option<u32>, Mode), String> {
    let (pid, arguments) = match arguments.first().and_then(|argument| argument.parse::<u32>().ok()) {
        Some(pid) if pid != 0 => (Some(pid), &arguments[1..]),
        _ => (None, arguments),
    };
    let mode = match arguments {
        [mode] if mode == "status" => Mode::Status,
        [mode] if mode == "snapshot" => Mode::Snapshot,
        [mode] if mode == "capture" => Mode::Capture(60),
        [mode, seconds] if mode == "capture" => {
            let seconds = seconds.parse().map_err(|_| "seconds must be a whole number")?;
            if !(1..=3600).contains(&seconds) { return Err("capture duration must be 1..3600 seconds".into()); }
            Mode::Capture(seconds)
        }
        [mode, rest @ ..] if mode == "serve" => {
            let (mut port, mut reach, mut port_given) = (17843, Reach::Local, false);
            let mut browser = true;
            let mut rest = rest.iter().peekable();
            while let Some(argument) = rest.next() {
                if argument == "--lan" && reach == Reach::Local {
                    let address = rest.peek().and_then(|next| next.parse::<Ipv4Addr>().ok());
                    if address.is_some() { rest.next(); }
                    reach = Reach::Lan(address);
                } else if argument == "--no-browser" && browser {
                    browser = false;
                } else if !port_given && !argument.starts_with("--") {
                    port = argument.parse().map_err(|_| "invalid port")?;
                    if port == 0 { return Err("port cannot be zero".into()); }
                    port_given = true;
                } else {
                    return Err(USAGE.into());
                }
            }
            Mode::Serve(port, reach, browser)
        }
        [mode, rest @ ..] if mode == "server" && pid.is_none() => {
            let (mut game, mut dry_run) = (None, false);
            let mut rest = rest.iter();
            while let Some(argument) = rest.next() {
                match argument.as_str() {
                    "--game" if game.is_none() => {
                        let path = rest.next().filter(|path| !path.is_empty() && !path.starts_with("--"))
                            .ok_or("--game requires the Halo Infinite install folder")?;
                        game = Some(PathBuf::from(path));
                    }
                    "--dry-run" if !dry_run => dry_run = true,
                    _ => return Err(USAGE.into()),
                }
            }
            Mode::Server(game, dry_run)
        }
        [mode, out] if mode == "navmesh" && !out.starts_with("--") => Mode::Navmesh(PathBuf::from(out), None),
        [mode, out, flag, blob] if mode == "navmesh" && flag == "--blob" && !out.starts_with("--") && !blob.starts_with("--") => {
            Mode::Navmesh(PathBuf::from(out), Some(PathBuf::from(blob)))
        }
        _ => return Err(USAGE.into()),
    };
    Ok((pid, mode))
}

fn capture(observer: &mut Observer, seconds: u64) -> Result<PathBuf, String> {
    let directory = std::env::current_dir().map_err(|error| error.to_string())?.join("logs");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
    let path = directory.join(format!("observer-{}-{stamp}.jsonl", std::process::id()));
    let mut file = OpenOptions::new().create_new(true).write(true).open(&path).map_err(|error| error.to_string())?;
    println!("Read-only capture for {seconds}s: {}", path.display());
    let started = Instant::now();
    let mut frames = 0;
    while started.elapsed() < Duration::from_secs(seconds) {
        let value = match observer.snapshot() {
            Ok(snapshot) => serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
            Err(error) => {
                let at = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis();
                serde_json::json!({"schema": cartographer::observer::ERROR_SCHEMA, "captured_unix_ms": at, "error": error})
            }
        };
        serde_json::to_writer(&mut file, &value).map_err(|error| error.to_string())?;
        writeln!(file).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        frames += 1;
        thread::sleep(Duration::from_millis(100));
    }
    println!("Captured {frames} samples. No process memory was modified.");
    Ok(path)
}

/// The experimental navmesh plan: the plan as one line of JSON, and the navmesh.blob on request.
fn navmesh(observer: &mut Observer, out: &Path, blob: Option<&Path>) -> Result<(), String> {
    let (floor, bytes) = observer.live_floor()?;
    let mut text = serde_json::to_string(&floor).map_err(|error| error.to_string())?;
    text.push('\n');
    std::fs::write(out, text).map_err(|error| format!("{}: {error}", out.display()))?;
    let points: usize = floor.rings.iter().map(|ring| ring.p.len() / 2).sum();
    println!("Experimental plan from the server's navmesh: {} ({} sections, {} rings, {points} points, {} Forge volumes, {} level kill volumes)",
        out.display(), floor.live.sections.len(), floor.rings.len(), floor.live.forge_volumes.as_ref().map_or(0, Vec::len),
        floor.live.level_kill_volumes.as_ref().map_or(0, Vec::len));
    for warning in &floor.live.warnings { println!("note: {warning}"); }
    match (blob, bytes) {
        (Some(path), Some(bytes)) => {
            std::fs::write(path, &bytes).map_err(|error| format!("{}: {error}", path.display()))?;
            println!("navmesh.blob ({} bytes): {}", bytes.len(), path.display());
        }
        (Some(_), None) => println!("note: the server holds no Forge navmesh.blob (a studio level, or no baked navmesh)"),
        (None, _) => {}
    }
    println!("No process memory was modified.");
    Ok(())
}

/// Which addresses a request may name in its `Host` (and `Origin`). A browser names the address it
/// was given, so a page from another site that points its own hostname here (DNS rebinding) names
/// that site and is refused. Always 127.0.0.1 and localhost, and on the LAN also this PC's name and
/// its own IPv4 addresses (or only the one `--lan` named).
struct Access {
    port: u16,
    reach: Reach,
    computer: Option<String>,
    own: fn(Ipv4Addr) -> bool,
}

/// Whether `address` is one of this PC's (only those can be bound).
fn own_address(address: Ipv4Addr) -> bool {
    !address.is_unspecified() && UdpSocket::bind((address, 0)).is_ok()
}

impl Access {
    fn new(port: u16, reach: Reach) -> Self {
        Self { port, reach, computer: std::env::var("COMPUTERNAME").ok().filter(|name| !name.is_empty()), own: own_address }
    }

    fn host_ok(&self, host: &str) -> bool {
        let Some(name) = host.strip_suffix(&format!(":{}", self.port)) else { return false; };
        if name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost") { return true; }
        let Reach::Lan(only) = self.reach else { return false; };
        let computer = self.computer.as_deref().is_some_and(|computer| {
            name.eq_ignore_ascii_case(computer) || name.strip_suffix(".local").is_some_and(|base| base.eq_ignore_ascii_case(computer))
        });
        computer || name.parse::<Ipv4Addr>().is_ok_and(|address| only.map_or_else(|| (self.own)(address), |only| address == only))
    }

    fn allowed(&self, host: Option<&str>, origin: Option<&str>, site: Option<&str>) -> bool {
        host.is_some_and(|host| self.host_ok(host))
            && origin.is_none_or(|origin| origin.strip_prefix("http://").is_some_and(|host| self.host_ok(host)))
            && site != Some("cross-site")
    }
}

/// The address other PCs reach this one by: the one its default route leaves from (a UDP
/// "connection" only picks the route, and nothing is sent).
fn lan_address() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(address) if !address.is_loopback() && !address.is_unspecified() => Some(address),
        _ => None,
    }
}

fn viewer_url(port: u16, reach: Reach, detected: Option<Ipv4Addr>) -> String {
    let address = match reach {
        Reach::Local => Ipv4Addr::LOCALHOST,
        Reach::Lan(Some(address)) => address,
        Reach::Lan(None) => detected.filter(|address| !address.is_unspecified() && !address.is_loopback())
            .unwrap_or(Ipv4Addr::LOCALHOST),
    };
    format!("http://{address}:{port}/")
}

fn open_browser(url: String, opener: impl FnOnce(&str) -> io::Result<()> + Send + 'static) -> io::Result<thread::JoinHandle<()>> {
    thread::Builder::new().name("open-browser".into()).spawn(move || {
        if let Err(error) = opener(&url) {
            eprintln!("\n  Could not open the default browser: {error}\n  The viewer is still running. Open:\n\n    {url}\n");
        }
    })
}

fn request_path(url: &str) -> &str { url.split_once('?').map_or(url, |(path, _)| path) }

fn snapshot_failure(error: &str) -> serde_json::Value {
    let transient = observer::is_transient(error);
    let waiting = error.starts_with("no DS found (") || error == "Waiting for a LAN dedicated server";
    serde_json::json!({
        "error": error,
        "transient": transient,
        "waiting_for_server": waiting,
        "server_error": !transient && !waiting,
    })
}

fn serve(pid: Option<u32>, port: u16, reach: Reach, browser: bool) -> Result<(), String> {
    let dev = Dev::from_env()?;
    let listen = match reach {
        Reach::Local => Ipv4Addr::LOCALHOST,
        Reach::Lan(None) => Ipv4Addr::UNSPECIFIED,
        Reach::Lan(Some(address)) if own_address(address) => address,
        Reach::Lan(Some(address)) => return Err(format!("{address} is not an address of this PC")),
    };
    let server = Server::http((listen, port)).map_err(|error| {
        format!("cannot listen on {listen}:{port}: {error}. Select another port with 'cartographer serve <port>'")
    })?;
    let access = Access::new(port, reach);
    let lan = match reach { Reach::Local => None, Reach::Lan(only) => only.or_else(lan_address) };
    let url = viewer_url(port, reach, lan);
    let network = if matches!(reach, Reach::Lan(_)) {
        access.computer.as_ref().map(|computer| format!("http://{computer}:{port}/"))
    } else { None };
    let mut fields = vec![
        ("Access", if reach == Reach::Local { "This PC only" } else { "Local network" }),
        ("Browser", if browser { "Opening default browser" } else { "Not opened (--no-browser)" }),
    ];
    if let Some(network) = &network { fields.push(("Network", network)); }
    let mut notes = vec!["Ctrl+C stops the viewer. The Halo server keeps running."];
    if matches!(reach, Reach::Lan(_)) {
        notes.push("Allow Cartographer on private networks if Windows Firewall asks.");
        if lan.is_none() {
            notes.push("No LAN IPv4 detected. Using loopback. Select an adapter with --lan <IPv4>.");
        }
    }
    print!("{}", terminal::panel("Viewer", "Ready", &fields, ("Open viewer", &url), &notes));
    if let Some(root) = &dev.web { println!("Dev: serving the viewer from {} with live reload", root.display()); }
    if let Some(root) = &dev.ui { println!("Dev: serving films-ui from {}, converted per request, with live reload", root.display()); }
    for (part, root) in &dev.data { println!("Dev: serving the {part} data from {}", root.display()); }
    if let Some(replay) = &dev.replay { println!("Dev: replaying {} snapshots in a {:.0}s loop instead of a server", replay.frames.len(), replay.length as f64 / 1000.0); }
    let mut geometry = cartographer::geometry::GeometryStore::open();
    let icons = cartographer::icons::IconStore::open();
    let modes = cartographer::icons::IconSet::modes();
    let teams = cartographer::icons::IconSet::teams();
    let markers = assets::Assets::new("markers");
    let fonts = assets::Assets::new("fonts");
    let objectives = cartographer::objectives::ObjectiveStore::open();
    // The last map variant named from its objectives: its asset id, title and level.
    let mut variant_info: Option<(String, Option<String>, Option<String>)> = None;
    let mut observer: Option<Observer> = None;
    let mut retry_at = Instant::now();
    let mut connection_error = "Waiting for a LAN dedicated server".to_owned();
    if browser {
        if let Err(error) = open_browser(url, |url| open::that(url)) {
            eprintln!("\n  Could not start the browser launcher: {error}\n  The viewer is still running. Open the URL shown above.\n");
        }
    }
    for request in server.incoming_requests() {
        let header = |name| request.headers().iter().find(|header| header.field.equiv(name)).map(|header| header.value.as_str());
        let (status, content_type, body) = if !access.allowed(header("Host"), header("Origin"), header("Sec-Fetch-Site")) {
            (403, "text/plain", b"Same-origin access to this PC's own addresses only".to_vec())
        } else if request.method().as_str() != "GET" {
            (405, "text/plain", b"GET only".to_vec())
        } else {
            match request_path(request.url()) {
                "/api/snapshot" if dev.replay.is_some() => (200, "application/json", dev.replay.as_ref().map(Replay::current).unwrap_or_default().to_vec()),
                "/api/snapshot" => {
                    if observer.is_none() && Instant::now() >= retry_at {
                        retry_at = Instant::now() + Duration::from_secs(1);
                        match pick_pid(pid).and_then(|found| Observer::open(found)
                            .map(|connected| (found, connected))
                            .map_err(|error| format!("LAN server pid {found}: {error}"))) {
                            Ok((found, connected)) => {
                                eprintln!("Attached to LAN server pid {found}");
                                observer = Some(connected);
                            }
                            Err(error) => {
                                if connection_error != error { eprintln!("Cannot attach to LAN server: {error}"); }
                                connection_error = error;
                            }
                        }
                    }
                    let result = if let Some(connected) = observer.as_mut() {
                        let result = connected.snapshot();
                        // A read the world kept changing under stays attached. Anything else lets
                        // the server go and finds it again.
                        if let Some(error) = result.as_ref().err().filter(|error| !observer::is_transient(error)) {
                            if connection_error != *error { eprintln!("Cannot read LAN server: {error}"); }
                            connection_error = error.clone();
                            observer = None;
                            retry_at = Instant::now() + Duration::from_secs(1);
                        }
                        result
                    } else { Err(connection_error.clone()) };
                    match result {
                    Ok(mut snapshot) => {
                        // A Forge map's own plan (by its map variant) wins over its canvas level's.
                        let forge = snapshot.map_variant.as_ref().map(|variant| variant.asset_id.clone())
                            .filter(|id| geometry.get(id).is_ok());
                        if let (Some(id), Some(variant)) = (&forge, snapshot.map_variant.as_mut()) {
                            variant.name = geometry.title(id);
                        }
                        let level = snapshot.map.as_ref().and_then(|map| map.level_id.clone())
                            .filter(|id| geometry.get(id).is_ok());
                        // The lobby's map before the match (no level is loaded yet), and a studio
                        // map's name: film-assets' objectives name the map variant and its level.
                        let asset = snapshot.map_variant.as_ref().map(|variant| variant.asset_id.clone());
                        if asset.is_some() && variant_info.as_ref().map(|info| &info.0) != asset.as_ref() {
                            let found = asset.as_deref().and_then(|asset| objectives.get(asset).ok());
                            variant_info = asset.clone().map(|asset| (asset, found.as_ref().and_then(|f| f.title.clone()), found.and_then(|f| f.level)));
                        }
                        let (title, planned) = variant_info.as_ref().filter(|info| Some(&info.0) == asset.as_ref())
                            .map_or((None, None), |info| (info.1.clone(), info.2.clone()));
                        if let Some(variant) = snapshot.map_variant.as_mut() {
                            if variant.name.is_none() { variant.name = title; }
                        }
                        let planned = planned.filter(|id| geometry.get(id).is_ok());
                        // A studio level's plan for the mode in play, where the mode opens or closes
                        // parts of the level (film-assets playable).
                        let mode = snapshot.match_info.as_ref().and_then(|info| info.game_mode);
                        snapshot.geometry_id = forge.or_else(|| level.or(planned).map(|level| geometry.studio_id(&level, mode)));
                        (200, "application/json", serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?)
                    }
                    Err(error) => (503, "application/json", serde_json::to_vec(&snapshot_failure(&error)).map_err(|error| error.to_string())?),
                    }
                },
                "/api/levels" => (200, "application/json", serde_json::to_vec(&geometry.levels(&objectives.level_names())).map_err(|error| error.to_string())?),
                "/api/icons" => match &icons {
                    Ok(icons) => (200, "application/json", serde_json::to_vec(&icons.index).map_err(|error| error.to_string())?),
                    Err(_) => (200, "application/json", br#"{"source":"unavailable","atlas":null,"icons":[],"items":{}}"#.to_vec()),
                },
                "/api/icons/atlas.png" => match &icons {
                    Ok(icons) => (200, "image/png", icons.atlas.clone()),
                    Err(_) => (404, "text/plain", b"Icon atlas unavailable".to_vec()),
                },
                "/api/modes" => match &modes {
                    Ok(modes) => (200, "application/json", serde_json::to_vec(&serde_json::json!({"icons": modes.icons})).map_err(|error| error.to_string())?),
                    Err(_) => (200, "application/json", br#"{"icons":[]}"#.to_vec()),
                },
                "/api/teams" => match &teams {
                    Ok(teams) => (200, "application/json", serde_json::to_vec(&serde_json::json!({"icons": teams.icons})).map_err(|error| error.to_string())?),
                    Err(_) => (200, "application/json", br#"{"icons":[]}"#.to_vec()),
                },
                path if path.starts_with("/api/teams/") => match teams.as_ref().ok().and_then(|teams| teams.file(&path[11..])) {
                    Some(icon) => (200, "image/png", icon.to_vec()),
                    None => (404, "text/plain", b"Team emblem unavailable".to_vec()),
                },
                path if path.starts_with("/api/markers/") => match markers.read(&path[13..], 1024 * 1024) {
                    Ok(body) => (200, content_type(&path[13..]), body.into_owned()),
                    Err(_) => (404, "text/plain", b"Marker atlas unavailable".to_vec()),
                },
                path if path.starts_with("/api/fonts/") => match fonts.read(&path[11..], 1024 * 1024) {
                    Ok(body) => (200, content_type(&path[11..]), body.into_owned()),
                    Err(_) => (404, "text/plain", b"Font unavailable".to_vec()),
                },
                path if path.starts_with("/api/modes/") => match modes.as_ref().ok().and_then(|modes| modes.file(&path[11..])) {
                    Some(icon) => (200, "image/png", icon.to_vec()),
                    None => (404, "text/plain", b"Mode icon unavailable".to_vec()),
                },
                path if path.starts_with("/api/objectives/") => match objectives.get(&path[16..]) {
                    Ok(found) => (200, "application/json", serde_json::to_vec(&found).map_err(|error| error.to_string())?),
                    Err(error) => (404, "application/json", serde_json::to_vec(&serde_json::json!({"error":error})).map_err(|error| error.to_string())?),
                },
                path if path.starts_with("/api/geometry/") => match geometry.get(&path[14..]) {
                    Ok(plan) => (200, "application/json", serde_json::to_vec(plan).map_err(|error| error.to_string())?),
                    Err(error) => (404, "application/json", serde_json::to_vec(&serde_json::json!({"error":error})).map_err(|error| error.to_string())?),
                },
                // A map's terrain (films-ui floor.ts): its lines, its relief as /api/terrain/<id>.png
                // and its heights as /api/terrain/<id>.height.png.
                path if path.starts_with("/api/terrain/") => {
                    let id = &path[13..];
                    let found = match (id.strip_suffix(".height.png"), id.strip_suffix(".png")) {
                        (Some(id), _) => geometry.height_image(id).map(|image| ("image/png", image)),
                        (None, Some(id)) => geometry.terrain_image(id).map(|image| ("image/png", image)),
                        (None, None) => geometry.terrain(id).map(|lines| ("application/json", lines)),
                    };
                    match found {
                        Ok((kind, body)) => (200, kind, body),
                        Err(error) => (404, "application/json", serde_json::to_vec(&serde_json::json!({"error":error})).map_err(|error| error.to_string())?),
                    }
                }
                // A map's limits for the data view (geometry.rs access), where film-assets has them.
                path if path.starts_with("/api/access/") => match geometry.access(&path[12..]) {
                    Ok(body) => (200, "application/json", body),
                    Err(error) => (404, "application/json", serde_json::to_vec(&serde_json::json!({"error":error})).map_err(|error| error.to_string())?),
                },
                "/__dev/stamp" if dev.live() => (200, "application/json", serde_json::to_vec(&dev.stamps()).map_err(|error| error.to_string())?),
                "/__dev/reload.js" if dev.live() => (200, "text/javascript; charset=utf-8", RELOAD_JS.as_bytes().to_vec()),
                path if path.starts_with("/ui/") => match web_path(&path[3..]).filter(|relative| relative.ends_with(".js")).and_then(|relative| dev.ui_module(relative)) {
                    Some(Ok(body)) => (200, "text/javascript; charset=utf-8", body),
                    Some(Err(error)) => (500, "text/plain; charset=utf-8", error.into_bytes()),
                    None => (404, "text/plain", b"Not found".to_vec()),
                },
                path => match web_path(path).and_then(|relative| dev.asset(relative).map(|body| (relative, body))) {
                    Some((relative, body)) => (200, content_type(relative), body),
                    None if path == "/favicon.ico" => (204, "image/x-icon", Vec::new()),
                    None => (404, "text/plain", b"Not found".to_vec()),
                },
            }
        };
        let mut response = Response::from_data(body).with_status_code(StatusCode(status));
        for (name, value) in [
            ("Content-Type", content_type), ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
            ("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"),
        ] {
            response.add_header(Header::from_bytes(name, value).map_err(|_| "invalid response header")?);
        }
        let _ = request.respond(response);
    }
    Ok(())
}

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.as_slice() == ["--help"] || arguments.as_slice() == ["-h"] {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if arguments.as_slice() == ["--version"] {
        println!("Cartographer {}", cartographer::VERSION);
        return ExitCode::SUCCESS;
    }
    let (pid, mode) = match parse(&arguments) {
        Ok(arguments) => arguments,
        Err(error) => { eprintln!("{error}"); return ExitCode::from(2); }
    };
    let result = (|| {
        if let Mode::Serve(port, reach, browser) = mode { return serve(pid, port, reach, browser); }
        if let Mode::Server(game, dry_run) = mode { return server::run(game.as_deref(), dry_run); }
        let found = pick_pid(pid)?;
        let mut observer = Observer::open(found).map_err(|error| format!("LAN server pid {found}: {error}"))?;
        match mode {
            Mode::Status => {
                let snapshot = observer.snapshot()?;
                println!("pid={} state={:?} in_match={} players={} objects={} pads={} skipped={}",
                    snapshot.pid, snapshot.life_cycle, snapshot.in_match, snapshot.players.len(),
                    snapshot.objects.len(), snapshot.objects.iter().filter(|object| object.dispenser.is_some() || object.stock_spawner.is_some()).count(), snapshot.skipped_entries);
                for warning in snapshot.warnings { println!("note: {warning}"); }
                if !snapshot.in_match {
                    match observer.probe_world() {
                        Ok(probe) => println!("world probe (independent of lifecycle): player_records={} valid_objects={} players_with_units={} elapsed_seconds={:?}",
                            probe.player_records, probe.valid_objects, probe.players_with_units, probe.elapsed_seconds),
                        Err(error) => println!("world probe unavailable: {error}"),
                    }
                }
            }
            Mode::Snapshot => {
                let snapshot = observer.snapshot()?;
                serde_json::to_writer_pretty(io::stdout().lock(), &snapshot).map_err(|error| error.to_string())?;
                println!();
            }
            Mode::Capture(seconds) => { capture(&mut observer, seconds)?; }
            Mode::Navmesh(out, blob) => navmesh(&mut observer, &out, blob.as_deref())?,
            Mode::Serve(..) | Mode::Server(..) => unreachable!(),
        }
        Ok::<_, String>(())
    })();
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => { eprintln!("{error}"); ExitCode::FAILURE }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_help_aligns_its_command_examples() {
        for line in USAGE.lines().skip(1).take_while(|line| !line.is_empty()) {
            assert!(line.strip_prefix("       ").is_some_and(|command| command.starts_with("cartographer ")), "{line:?}");
        }
    }

    #[test]
    fn browser_launch_failure_is_nonfatal_and_uses_the_selected_url() {
        let (sent, received) = std::sync::mpsc::channel();
        let handle = open_browser("http://192.168.1.23:17844/".into(), move |url| {
            sent.send(url.to_owned()).unwrap();
            Err(io::Error::other("no browser handler"))
        }).unwrap();
        assert!(handle.join().is_ok());
        assert_eq!(received.try_recv().unwrap(), "http://192.168.1.23:17844/");
    }

    #[test]
    fn browser_url_matches_the_listener_mode_and_port() {
        let detected = Ipv4Addr::new(192, 168, 1, 23);
        let selected = Ipv4Addr::new(10, 0, 0, 5);
        assert_eq!(viewer_url(17843, Reach::Local, Some(detected)), "http://127.0.0.1:17843/");
        assert_eq!(viewer_url(17844, Reach::Local, None), "http://127.0.0.1:17844/");
        assert_eq!(viewer_url(17843, Reach::Lan(None), Some(detected)), "http://192.168.1.23:17843/");
        assert_eq!(viewer_url(17844, Reach::Lan(Some(selected)), Some(detected)), "http://10.0.0.5:17844/");
        assert_eq!(viewer_url(17844, Reach::Lan(Some(selected)), None), "http://10.0.0.5:17844/");
        for missing in [None, Some(Ipv4Addr::UNSPECIFIED), Some(Ipv4Addr::LOCALHOST)] {
            assert_eq!(viewer_url(17843, Reach::Lan(None), missing), "http://127.0.0.1:17843/");
        }
    }

    #[test]
    fn browser_opens_by_default_and_can_be_disabled_in_any_option_order() {
        let options = |arguments: &[&str]| match parse(&arguments.iter().map(|argument| (*argument).to_owned()).collect::<Vec<_>>()).unwrap().1 {
            Mode::Serve(port, reach, browser) => (port, reach, browser),
            _ => panic!("expected serve"),
        };
        assert_eq!(options(&["serve"]), (17843, Reach::Local, true));
        assert_eq!(options(&["serve", "--lan"]), (17843, Reach::Lan(None), true));
        assert_eq!(options(&["serve", "--no-browser"]), (17843, Reach::Local, false));
        assert_eq!(options(&["serve", "--no-browser", "17844", "--lan"]), (17844, Reach::Lan(None), false));
        assert_eq!(options(&["serve", "--lan", "17844", "--no-browser"]), (17844, Reach::Lan(None), false));
        assert_eq!(options(&["17292", "serve", "--lan", "192.168.1.23", "--no-browser", "17844"]),
            (17844, Reach::Lan(Some(Ipv4Addr::new(192, 168, 1, 23))), false));
        assert!(parse(&["serve", "--no-browser", "--no-browser"].map(str::to_owned)).is_err());
        assert!(parse(&["status", "--no-browser"].map(str::to_owned)).is_err());
    }

    #[test]
    fn standalone_server_cli_requires_explicit_valid_options() {
        let parse_server = |arguments: &[&str]| parse(&arguments.iter().map(|argument| (*argument).to_owned()).collect::<Vec<_>>());
        assert!(matches!(parse_server(&["server"]), Ok((None, Mode::Server(None, false)))));
        assert!(matches!(parse_server(&["server", "--dry-run"]), Ok((None, Mode::Server(None, true)))));
        let arguments = ["server", "--game", r"D:\Steam Library\Halo Infinite", "--dry-run"];
        let (_, Mode::Server(game, true)) = parse_server(&arguments).unwrap() else { panic!("expected a dry-run launch") };
        assert_eq!(game, Some(PathBuf::from(arguments[2])));
        for arguments in [
            vec!["123", "server"], vec!["server", "--game"], vec!["server", "--game", "--dry-run"],
            vec!["server", "--dry-run", "--dry-run"], vec!["server", "--game", "a", "--game", "b"],
            vec!["server", "--lan"], vec!["server", "17843"],
        ] { assert!(parse_server(&arguments).is_err(), "{arguments:?}"); }
    }

    #[test]
    fn navmesh_cli_takes_an_output_and_an_optional_blob() {
        let parse_navmesh = |arguments: &[&str]| parse(&arguments.iter().map(|argument| (*argument).to_owned()).collect::<Vec<_>>());
        let (pid, Mode::Navmesh(out, None)) = parse_navmesh(&["123", "navmesh", "plan.json"]).unwrap() else { panic!("expected navmesh") };
        assert_eq!((pid, out), (Some(123), PathBuf::from("plan.json")));
        let (_, Mode::Navmesh(_, Some(blob))) = parse_navmesh(&["navmesh", "plan.json", "--blob", "navmesh.blob"]).unwrap() else { panic!("expected a blob") };
        assert_eq!(blob, PathBuf::from("navmesh.blob"));
        for arguments in [vec!["navmesh"], vec!["navmesh", "--blob", "x"], vec!["navmesh", "a", "--blob"], vec!["navmesh", "a", "b"], vec!["navmesh", "a", "--blob", "--x"]] {
            assert!(parse_navmesh(&arguments).is_err(), "{arguments:?}");
        }
    }

    #[test]
    fn snapshot_errors_distinguish_absence_transitions_and_refusals() {
        let waiting = snapshot_failure("no DS found (HaloInfinite.exe owning UDP 1343). Pass a PID");
        assert_eq!(waiting["waiting_for_server"], true);
        assert_eq!(waiting["server_error"], false);
        let transient = snapshot_failure("world/pool changed during observation");
        assert_eq!(transient["transient"], true);
        assert_eq!(transient["waiting_for_server"], false);
        assert_eq!(transient["server_error"], false);
        for error in [
            "LAN server pid 123: refused: Windows did not grant PROCESS_VM_READ (granted access 0x1000)",
            "OpenProcess failed: 5",
            "refused: different build",
            "no validated live-world pool set found",
            "several DS candidates [123, 456]. Pass a PID",
        ] {
            let result = snapshot_failure(error);
            assert_eq!(result["error"], error);
            assert_eq!(result["waiting_for_server"], false, "{error}");
            assert_eq!(result["transient"], false, "{error}");
            assert_eq!(result["server_error"], true, "{error}");
        }
    }

    #[test]
    fn cli_rejects_invalid_duration_ports_and_extra_arguments() {
        for arguments in [vec!["capture", "0"], vec!["capture", "3601"], vec!["serve", "0"], vec!["serve", "65536"], vec!["status", "extra"],
            vec!["serve", "1", "2"], vec!["serve", "--lan", "--lan"], vec!["serve", "--lan", "10.0.0.5", "x"]] {
            let arguments: Vec<String> = arguments.into_iter().map(str::to_owned).collect();
            assert!(parse(&arguments).is_err());
        }
        let arguments = ["123", "serve", "17844"].map(str::to_owned);
        let (pid, mode) = parse(&arguments).unwrap();
        assert_eq!(pid, Some(123));
        assert!(matches!(mode, Mode::Serve(17844, Reach::Local, true)));
        let serve = |arguments: &[&str]| match parse(&arguments.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>()).unwrap().1 {
            Mode::Serve(port, reach, _) => (port, reach),
            _ => panic!("not serve"),
        };
        assert_eq!(serve(&["serve", "--lan"]), (17843, Reach::Lan(None)));
        assert_eq!(serve(&["serve", "17844", "--lan"]), (17844, Reach::Lan(None)));
        assert_eq!(serve(&["serve", "--lan", "17844"]), (17844, Reach::Lan(None)));
        assert_eq!(serve(&["serve", "--lan", "192.168.1.23", "17844"]), (17844, Reach::Lan(Some(Ipv4Addr::new(192, 168, 1, 23)))));
    }

    #[test]
    fn http_access_rejects_remote_origins_and_rebound_hostnames() {
        let local = Access { port: 17843, reach: Reach::Local, computer: Some("CASTER-PC".into()), own: |a| a == Ipv4Addr::new(192, 168, 1, 23) };
        assert!(local.allowed(Some("127.0.0.1:17843"), None, Some("same-origin")));
        assert!(local.allowed(Some("localhost:17843"), Some("http://localhost:17843"), None));
        assert!(!local.allowed(Some("attacker.example:17843"), None, None));
        assert!(!local.allowed(Some("127.0.0.1:17843"), Some("https://example.com"), None));
        assert!(!local.allowed(Some("127.0.0.1:17843"), None, Some("cross-site")));
        assert!(!local.allowed(Some("192.168.1.23:17843"), None, None));
        assert!(!local.allowed(Some("caster-pc:17843"), None, None));

        let lan = Access { reach: Reach::Lan(None), ..local };
        assert!(lan.allowed(Some("192.168.1.23:17843"), Some("http://192.168.1.23:17843"), None));
        assert!(lan.allowed(Some("caster-pc:17843"), None, None));
        assert!(lan.allowed(Some("CASTER-PC.local:17843"), None, None));
        assert!(!lan.allowed(Some("192.168.1.99:17843"), None, None));
        assert!(!lan.allowed(Some("192.168.1.23:17844"), None, None));
        assert!(!lan.allowed(Some("caster-pc.attacker.example:17843"), None, None));
        assert!(!lan.allowed(Some("192.168.1.23:17843"), Some("http://attacker.example"), None));

        let one = Access { reach: Reach::Lan(Some(Ipv4Addr::new(10, 0, 0, 5))), ..lan };
        assert!(one.allowed(Some("10.0.0.5:17843"), None, None));
        assert!(!one.allowed(Some("192.168.1.23:17843"), None, None));
    }

    #[test]
    fn broadcast_query_keeps_the_viewer_route() {
        assert_eq!(request_path("/?layout=broadcast"), "/");
        assert_eq!(request_path("/"), "/");
        assert_eq!(request_path("/api/snapshot?cache=off"), "/api/snapshot");
        assert_eq!(request_path("/missing?layout=broadcast"), "/missing");
    }

    #[test]
    fn web_paths_stay_inside_the_web_folder() {
        assert_eq!(web_path("/"), Some("index.html"));
        assert_eq!(web_path("/css/tokens.css"), Some("css/tokens.css"));
        assert_eq!(web_path("/js/main.js"), Some("js/main.js"));
        for path in ["", "css/tokens.css", "/../main.rs", "/css/../../x", "/./index.html", "/css//a.css", "/.env",
            "/css\\a.css", "/%2e%2e/x", "/C:/x", "/a b.css", "/css/"] {
            assert_eq!(web_path(path), None, "{path:?}");
        }
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("js/main.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("css/base.css"), "text/css; charset=utf-8");
        assert_eq!(content_type("LICENSE"), "application/octet-stream");
    }

    #[test]
    fn the_viewer_is_embedded_and_dev_reload_is_appended_to_the_page() {
        assert!(web::WEB_ASSETS.iter().any(|(path, _)| *path == "index.html"));
        assert!(web::WEB_ASSETS.iter().all(|(path, _)| web_path(&format!("/{path}")) == Some(*path)));
        let page = String::from_utf8(with_reload(b"<body><p>x</p></body></html>")).unwrap();
        assert_eq!(page, r#"<body><p>x</p><script type="module" src="/__dev/reload.js"></script></body></html>"#);
        assert!(String::from_utf8(with_reload(b"<p>x</p>")).unwrap().ends_with("</script>"));
    }

    #[test]
    fn replay_loops_at_the_captured_pace() {
        let frames = [(1_000, b"a"), (1_250, b"b"), (1_500, b"c")].map(|(at, body)| (at, body.to_vec())).to_vec();
        let replay = Replay::from_frames(frames).unwrap();
        assert_eq!(replay.length, 750);
        for (elapsed, expected) in [(0, b"a"), (249, b"a"), (250, b"b"), (740, b"c"), (750, b"a"), (1_000, b"b")] {
            assert_eq!(replay.frame_at(elapsed), expected, "{elapsed}");
        }
        assert!(Replay::from_frames(Vec::new()).is_none());
        assert_eq!(Replay::from_frames(vec![(5, b"only".to_vec())]).unwrap().frame_at(10_000), b"only");
    }

    #[test]
    fn replay_skips_the_reads_a_capture_recorded_as_failed() {
        // The error records capture writes among the snapshots, with a time and without one.
        let text = concat!(
            r#"{"schema":"cartographer.snapshot.v1","captured_unix_ms":1000,"players":[]}"#, "\n",
            r#"{"schema":"cartographer.snapshot.error.v1","captured_unix_ms":1100,"error":"world/pool changed"}"#, "\n\n",
            r#"{"schema":"cartographer.snapshot.error.v1","error":"no DS found"}"#, "\n",
            r#"{"schema":"cartographer.snapshot.v1","captured_unix_ms":1250,"players":[]}"#, "\n",
        );
        let replay = Replay::parse(text).unwrap();
        assert_eq!(replay.frames.len(), 2);
        assert_eq!(replay.length, 500);
        assert_eq!(Replay::parse(r#"{"players":[]}"#).err().as_deref(), Some("line 1: no captured_unix_ms"));
        assert_eq!(Replay::parse(r#"{"error":"x"}"#).err().as_deref(), Some("no snapshots"));
    }
}