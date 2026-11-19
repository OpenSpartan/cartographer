use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

use serde::{Deserialize, Serialize};

use crate::assets::Assets;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IconCell {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    build: String,
    atlas: String,
    icons: Vec<IconCell>,
    tags: BTreeMap<String, usize>,
}

#[derive(Debug, Serialize)]
pub struct IconIndex {
    pub source: &'static str,
    pub atlas: &'static str,
    pub width: u32,
    pub height: u32,
    pub icons: Vec<IconCell>,
    pub items: BTreeMap<String, usize>,
}

pub struct IconStore {
    pub index: IconIndex,
    pub atlas: Vec<u8>,
}

fn valid_atlas_name(name: &str) -> bool {
    name.strip_prefix("icons.").and_then(|name| name.strip_suffix(".png"))
        .is_some_and(|hash| hash.len() == 8 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    if bytes.len() > 2 * 1024 * 1024 { return Err("icon manifest exceeds size limit".into()); }
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if manifest.schema_version != 1 || !manifest.build.starts_with("269225.26.04.08.1618 ")
        || !valid_atlas_name(&manifest.atlas) || manifest.icons.is_empty() || manifest.icons.len() > 512
        || manifest.tags.len() > 10000
    {
        return Err("unsupported icon manifest".into());
    }
    for (tag, index) in &manifest.tags {
        if tag.len() != 8 || !tag.bytes().all(|byte| byte.is_ascii_hexdigit()) || *index >= manifest.icons.len() {
            return Err("invalid icon tag mapping".into());
        }
    }
    Ok(manifest)
}

fn validate_cells(cells: &[IconCell], width: u32, height: u32) -> Result<(), String> {
    for cell in cells {
        if cell.w == 0 || cell.h == 0 || cell.w > 1024 || cell.h > 1024
            || cell.x.checked_add(cell.w).is_none_or(|edge| edge > width)
            || cell.y.checked_add(cell.h).is_none_or(|edge| edge > height)
        {
            return Err("icon cell is outside the atlas".into());
        }
    }
    Ok(())
}

fn unambiguous_items(candidates: BTreeMap<String, BTreeSet<usize>>) -> BTreeMap<String, usize> {
    candidates.into_iter().filter_map(|(name, indices)| {
        (indices.len() == 1).then(|| (name, *indices.first().unwrap()))
    }).collect()
}

fn standard_item_icons(items: &mut BTreeMap<String, usize>, tags: &BTreeMap<String, usize>) {
    for (tag, names) in [
        ("430dda48", &["Thruster", "Evade"][..]),
        ("00007ee8", &["Needler"][..]),
        // The Repulsor's burst (cell 44). Six of its tags point at the Drop Wall's panel (cell
        // 42) in the source manifest, which the atlas images contradict.
        ("1e79ebda", &["Repulsor", "Knockback"][..]),
        // The base energy_sword tag and its children (a standalone variant has another cell),
        // and the heatwave tags (the hotrod variant has another).
        ("0000ae3c", &["Energy Sword", "EnergySword"][..]),
        ("5b580dc2", &["Heatwave"][..]),
    ] {
        if let Some(index) = tags.get(tag) {
            for name in names { items.entry((*name).to_owned()).or_insert(*index); }
        }
    }
}

impl IconStore {
    /// The HUD weapon, equipment and grenade icons (film-assets `icons`): the atlas and its index.
    pub fn open() -> Result<Self, String> {
        Self::load(&Assets::new("icons"))
    }

    pub fn load(source: &Assets) -> Result<Self, String> {
        let manifest = parse_manifest(&source.read("icons.json", 2 * 1024 * 1024)?)?;
        let atlas = source.read(&manifest.atlas, 8 * 1024 * 1024)?.into_owned();
        let decoder = png::Decoder::new_with_limits(Cursor::new(&atlas), png::Limits { bytes: 32 * 1024 * 1024 });
        let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
        let (width, height) = (reader.info().width, reader.info().height);
        if width == 0 || height == 0 || width > 4096 || height > 4096 || reader.output_buffer_size() > 32 * 1024 * 1024 {
            return Err("icon atlas dimensions exceed limits".into());
        }
        let mut pixels = vec![0u8; reader.output_buffer_size()];
        reader.next_frame(&mut pixels).map_err(|error| error.to_string())?;
        validate_cells(&manifest.icons, width, height)?;
        let mut candidates: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
        for tag in filmshell::game::tags() {
            let Some(index) = manifest.tags.get(&format!("{:08x}", tag.tag.get())) else { continue; };
            let Some(name) = tag.item.map(|item| item.name()).or(tag.name) else { continue; };
            candidates.entry(name.to_owned()).or_default().insert(*index);
        }
        let mut items = unambiguous_items(candidates);
        standard_item_icons(&mut items, &manifest.tags);
        Ok(Self { index: IconIndex { source: "game_hud_atlas", atlas: "/api/icons/atlas.png", width, height, icons: manifest.icons, items }, atlas })
    }
}

#[derive(Deserialize)]
struct IconSetManifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    build: String,
    #[serde(alias = "teams")]
    icons: Vec<IconSetFile>,
}

#[derive(Deserialize)]
struct IconSetFile {
    index: u32,
    file: String,
}

#[derive(Debug, Serialize)]
pub struct IndexedIcon {
    pub index: u32,
    pub url: String,
}

/// White-on-transparent PNGs by index: the game mode icons (film-assets `modes`, by variant icon
/// index) and the team emblems (`teams`, by team id, where 8 is the observers').
pub struct IconSet {
    pub icons: Vec<IndexedIcon>,
    files: BTreeMap<String, Vec<u8>>,
}

fn valid_icon_file(prefix: &str, index: u32, name: &str) -> bool {
    name.strip_prefix(&format!("{prefix}{index}.")).and_then(|name| name.strip_suffix(".png"))
        .is_some_and(|hash| hash.len() == 8 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

impl IconSet {
    /// The game mode icons, served under /api/modes.
    pub fn modes() -> Result<Self, String> {
        Self::load(&Assets::new("modes"), "mode", "/api/modes")
    }

    /// The team emblems, served under /api/teams.
    pub fn teams() -> Result<Self, String> {
        Self::load(&Assets::new("teams"), "team", "/api/teams")
    }

    /// `<prefix>s.json` and its `<prefix><index>.<hash>.png` files, each served at `route`.
    pub fn load(source: &Assets, prefix: &str, route: &str) -> Result<Self, String> {
        let manifest: IconSetManifest = serde_json::from_slice(&source.read(&format!("{prefix}s.json"), 64 * 1024)?)
            .map_err(|error| error.to_string())?;
        if manifest.schema_version != 1 || !manifest.build.starts_with("269225.26.04.08.1618 ") || manifest.icons.len() > 64 {
            return Err(format!("unsupported {prefix} icon manifest"));
        }
        let (mut icons, mut files) = (Vec::new(), BTreeMap::new());
        for icon in manifest.icons {
            if icon.index >= 64 || !valid_icon_file(prefix, icon.index, &icon.file) { return Err(format!("invalid {prefix} icon entry")); }
            let bytes = source.read(&icon.file, 256 * 1024)?.into_owned();
            if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err(format!("{prefix} icon is not a PNG")); }
            icons.push(IndexedIcon { index: icon.index, url: format!("{route}/{}", icon.file) });
            files.insert(icon.file, bytes);
        }
        Ok(Self { icons, files })
    }

    pub fn file(&self, name: &str) -> Option<&[u8]> { self.files.get(name).map(Vec::as_slice) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_icon_files_must_match_their_index_and_a_hash() {
        assert!(valid_icon_file("mode", 0, "mode0.b2c31060.png"));
        assert!(valid_icon_file("mode", 19, "mode19.f8fdc5e0.png"));
        assert!(valid_icon_file("team", 1, "team1.3b90e443.png"));
        assert!(!valid_icon_file("mode", 1, "mode0.b2c31060.png"));
        assert!(!valid_icon_file("team", 0, "mode0.b2c31060.png"));
        assert!(!valid_icon_file("mode", 0, "mode0.b2c3106.png"));
        assert!(!valid_icon_file("mode", 0, "../mode0.b2c31060.png"));
        assert!(!valid_icon_file("mode", 0, "mode0.b2c31060.png/x"));
    }

    #[test]
    fn built_in_team_emblems_load() {
        let teams = IconSet::load(&Assets::built_in("teams"), "team", "/api/teams").unwrap();
        assert_eq!(teams.icons.len(), 9);
        assert!(teams.icons.iter().all(|icon| icon.url.starts_with("/api/teams/team") && teams.file(&icon.url[11..]).is_some()));
    }

    #[test]
    fn icon_manifest_rejects_foreign_build_paths_and_indices() {
        let valid = br#"{"schemaVersion":1,"build":"269225.26.04.08.1618 HI_1_13_0","atlas":"icons.1234abcd.png","icons":[{"x":0,"y":0,"w":10,"h":10}],"tags":{"12345678":0}}"#;
        assert!(parse_manifest(valid).is_ok());
        let text = std::str::from_utf8(valid).unwrap();
        assert!(parse_manifest(text.replace("icons.1234abcd.png", "../private.png").as_bytes()).is_err());
        assert!(parse_manifest(text.replace("269225.26.04.08.1618", "another-build").as_bytes()).is_err());
        assert!(parse_manifest(text.replace("\"12345678\":0", "\"12345678\":1").as_bytes()).is_err());
        assert!(!valid_atlas_name("icons.1234abcd.png/extra"));
    }

    #[test]
    fn icon_cells_reject_empty_overflowing_and_outside_regions() {
        assert!(validate_cells(&[IconCell { x: 2, y: 3, w: 10, h: 12 }], 20, 20).is_ok());
        assert!(validate_cells(&[IconCell { x: 0, y: 0, w: 0, h: 12 }], 20, 20).is_err());
        assert!(validate_cells(&[IconCell { x: 15, y: 0, w: 10, h: 12 }], 20, 20).is_err());
        assert!(validate_cells(&[IconCell { x: u32::MAX, y: 0, w: 10, h: 12 }], 20, 20).is_err());
    }

    #[test]
    fn ambiguous_item_art_is_not_guessed() {
        let candidates = BTreeMap::from([
            ("Grappleshot".into(), BTreeSet::from([41])),
            ("Thruster".into(), BTreeSet::from([40, 57])),
            ("Missing".into(), BTreeSet::new()),
        ]);
        let items = unambiguous_items(candidates);
        assert_eq!(items.len(), 1);
        assert_eq!(items["Grappleshot"], 41);
        assert!(!items.contains_key("Thruster"));
    }

    #[test]
    fn standard_item_art_uses_verified_tags_not_arbitrary_variant_cells() {
        let mut items = BTreeMap::new();
        standard_item_icons(&mut items, &BTreeMap::from([("430dda48".into(), 40), ("b9c61530".into(), 57), ("00007ee8".into(), 9)]));
        assert_eq!(items["Thruster"], 40);
        assert_eq!(items["Evade"], 40);
        assert_eq!(items["Needler"], 9);
        let mut missing = BTreeMap::new();
        standard_item_icons(&mut missing, &BTreeMap::from([("b9c61530".into(), 57)]));
        assert!(missing.is_empty());
    }
}