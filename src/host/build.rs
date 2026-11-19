//! Embeds everything `cartographer serve` serves in the binary as `(path, bytes)` tables, so a
//! release needs nothing on disk. The tables hold the web viewer (`web/`), films-ui's sources
//! (converted to JavaScript) from the films-ui checkout beside this repository (`CARTOGRAPHER_UI`
//! names another), and the map data from the private OpenSpartan/film-assets checkout beside it
//! (`CARTOGRAPHER_ASSETS` names another): floor plans, objective placements, icons and the
//! typeface, never committed here, and each plan's limits for the data view, made from its access
//! files (limits.rs). At runtime
//! `CARTOGRAPHER_WEB_DIR`, `CARTOGRAPHER_UI_DIR` and the `CARTOGRAPHER_<PART>_DIR` data variables
//! serve a folder on disk in a table's place (main.rs USAGE).
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[path = "src/typescript.rs"]
mod typescript;
#[path = "src/limits.rs"]
mod limits;

fn walk(directory: &Path, prefix: &str, files: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(directory) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Hidden files and notes (READMEs) stay out of the binary.
        if name.starts_with('.') || name.ends_with(".md") { continue; }
        let path = entry.path();
        if path.is_dir() { walk(&path, &format!("{prefix}{name}/"), files); } else { files.push((format!("{prefix}{name}"), path)); }
    }
}

/// The film-assets folders Cartographer serves (not its sources or tools), as in assets.rs PARTS.
/// A checkout from before `playable` builds without it.
const ASSET_PARTS: [&str; 9] = ["levels", "playable", "maps", "objectives", "icons", "markers", "modes", "teams", "fonts"];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"))
}

/// The film-assets checkout: `CARTOGRAPHER_ASSETS`, else `film-assets` beside this repository.
fn assets_root() -> PathBuf {
    println!("cargo:rerun-if-env-changed=CARTOGRAPHER_ASSETS");
    let root = env::var_os("CARTOGRAPHER_ASSETS").map_or_else(|| manifest_dir().join("../../../film-assets"), PathBuf::from);
    assert!(root.join("README.md").is_file() && ASSET_PARTS.iter().filter(|part| **part != "playable").all(|part| root.join(part).is_dir()),
        "film-assets not found at {}: clone OpenSpartan/film-assets beside this repository, or set CARTOGRAPHER_ASSETS", root.display());
    root
}

/// `parts` of `root` (each as `part/...`), or all of it with no parts, and the files `made` names
/// (`part/name`, from where they were written).
fn embed(root: &Path, parts: &[&str], made: Vec<(String, PathBuf)>, constant: &str, output: &str) {
    let mut files = made;
    if parts.is_empty() {
        println!("cargo:rerun-if-changed={}", root.display());
        walk(root, "", &mut files);
    }
    for part in parts {
        println!("cargo:rerun-if-changed={}", root.join(part).display());
        walk(&root.join(part), &format!("{part}/"), &mut files);
    }
    files.sort();
    let mut source = format!("pub const {constant}: &[(&str, &[u8])] = &[\n");
    for (name, path) in files {
        source += &format!("    ({name:?}, include_bytes!({:?})),\n", path.display().to_string());
    }
    source += "];\n";
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR")).join(output);
    fs::write(out, source).expect("write the embedded asset table");
}

/// The data view's limits (limits.rs), made from `access/` in the film-assets checkout at `root`
/// for every plan of a map with terrain (the view draws them over the terrain's kinds), each named
/// to sit beside its plan: a level's own plan's in `levels`, a mode's own plan's in `playable`, a
/// Forge map's in `maps`. The access files themselves, every move tried and the floor each limiter
/// closes, stay out of the binary. A checkout from before `access` has none.
fn limits(root: &Path) -> Vec<(String, PathBuf)> {
    let access = root.join("access");
    println!("cargo:rerun-if-changed={}", access.display());
    let Ok(entries) = fs::read_dir(&access) else { return Vec::new() };
    let mut ids: Vec<String> = entries.flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| name.strip_suffix(".json").filter(|id| !id.contains('.')).map(str::to_string))
        .collect();
    ids.sort();
    // A map variant's title, from its objective placements.
    let title = |asset: &str| -> Option<String> {
        let bytes = fs::read(root.join("objectives").join(format!("{asset}.json"))).ok()?;
        serde_json::from_slice::<serde_json::Value>(&bytes).ok()?["title"].as_str().map(str::to_string)
    };
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR")).join("limits");
    fs::create_dir_all(&out).expect("make the limits folder");
    let mut files = Vec::new();
    for id in ids {
        let part = if id.len() == 8 { "levels" } else { "maps" };
        if !root.join(part).join(format!("{id}.terrain.json")).is_file() { continue; }
        let bytes = fs::read(access.join(format!("{id}.json"))).expect("read an access file");
        let why = fs::read(access.join(format!("{id}.why.json"))).ok();
        let plans = match &why {
            Some(why) => limits::plans(why).unwrap_or_else(|error| panic!("access/{id}.why.json: {error}")),
            None => vec![id.clone()],
        };
        for plan in plans {
            let text = limits::of_plan(&bytes, why.as_deref(), &plan, &title).unwrap_or_else(|error| panic!("access/{id}: {error}"));
            let name = format!("{plan}.access.json");
            fs::write(out.join(&name), text).expect("write a plan's limits");
            files.push((format!("{}/{name}", if plan.contains('.') { "playable" } else { part }), out.join(&name)));
        }
    }
    files
}

/// The release version: `CARTOGRAPHER_VERSION` (CI sets it from the tag, `1.2.3` or
/// `1.2.3-beta.1`), else the package version marked `-dev`: `0.0.0-dev`, a build that is no
/// release.
fn version() -> String {
    println!("cargo:rerun-if-env-changed=CARTOGRAPHER_VERSION");
    match env::var("CARTOGRAPHER_VERSION") {
        Ok(version) if !version.is_empty() => {
            assert!(numeric(&version).is_some(), "CARTOGRAPHER_VERSION must look like 1.2.3 or 1.2.3-beta.1, not {version:?}");
            version
        }
        _ => format!("{}-dev", env::var("CARGO_PKG_VERSION").expect("cargo sets CARGO_PKG_VERSION")),
    }
}

/// `major.minor.patch` packed for a Windows VERSIONINFO (`major.minor.patch.0`). The suffix after
/// `-` may hold ASCII letters, digits and dots.
fn numeric(version: &str) -> Option<u64> {
    let (core, suffix) = version.split_once('-').unwrap_or((version, ""));
    if !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'.') || version.ends_with('-') { return None; }
    let parts: Vec<u16> = core.split('.').map(|part| part.parse().ok().filter(|_| !part.is_empty())).collect::<Option<_>>()?;
    let [major, minor, patch] = parts[..] else { return None };
    Some((u64::from(major) << 48) | (u64::from(minor) << 32) | (u64::from(patch) << 16))
}

/// The exe's Windows version resource and icon, shown in its Properties.
fn resource(version: &str) {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") { return; }
    let icon = manifest_dir().join("../../assets/icons/cartographer.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    let packed = numeric(version).expect("a checked version");
    let mut resource = winresource::WindowsResource::new();
    resource.set_icon(&icon.display().to_string())
        .set("ProductName", "Cartographer")
        .set("FileDescription", "Cartographer: a live map of Halo Infinite LAN matches")
        .set("ProductVersion", version)
        .set("FileVersion", version)
        .set_version_info(winresource::VersionInfo::PRODUCTVERSION, packed)
        .set_version_info(winresource::VersionInfo::FILEVERSION, packed);
    resource.compile().expect("compile the Windows version resource");
}

/// films-ui's sources (`CARTOGRAPHER_UI`, else the films-ui checkout beside this repository), each
/// `.ts` file converted to JavaScript, as the `UI_ASSETS` table the server serves under `/ui/`.
fn embed_ui() {
    println!("cargo:rerun-if-env-changed=CARTOGRAPHER_UI");
    let checkout = env::var_os("CARTOGRAPHER_UI").map_or_else(|| manifest_dir().join("../../../films-ui"), PathBuf::from);
    let root = checkout.join("src");
    assert!(root.join("index.ts").is_file(),
        "films-ui not found at {}: clone OpenSpartan/films-ui beside this repository, or set CARTOGRAPHER_UI", checkout.display());
    println!("cargo:rerun-if-changed={}", root.display());
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    let mut files = Vec::new();
    walk(&root, "", &mut files);
    files.sort();
    let mut source = String::from("pub const UI_ASSETS: &[(&str, &[u8])] = &[\n");
    for (name, path) in files {
        let Some(stem) = name.strip_suffix(".ts").filter(|stem| !stem.ends_with(".d")) else { continue };
        let text = fs::read_to_string(&path).expect("read a films-ui source");
        let code = typescript::to_javascript(&path, &text).unwrap_or_else(|error| panic!("films-ui: {error}"));
        let target = out.join("ui").join(format!("{stem}.js"));
        fs::create_dir_all(target.parent().expect("a folder")).expect("make the films-ui output folder");
        fs::write(&target, code).expect("write a converted films-ui file");
        source += &format!("    ({:?}, include_bytes!({:?})),\n", format!("{stem}.js"), target.display().to_string());
    }
    source += "];\n";
    fs::write(out.join("ui_assets.rs"), source).expect("write the films-ui table");
}

fn main() {
    embed(&manifest_dir().join("web"), &[], Vec::new(), "WEB_ASSETS", "web_assets.rs");
    embed_ui();
    let assets = assets_root();
    embed(&assets, &ASSET_PARTS, limits(&assets), "DATA_ASSETS", "data_assets.rs");
    let version = version();
    println!("cargo:rustc-env=CARTOGRAPHER_VERSION={version}");
    resource(&version);
}
