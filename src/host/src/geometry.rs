use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::assets::Assets;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FloorRing {
    pub z: [f64; 2],
    #[serde(default)]
    pub hole: bool,
    pub p: Vec<f64>,
}

/// A floor plan from film-assets: a studio level's by its level id, or a Forge map's (from the
/// navmesh in its published files) by its map variant asset id, which adds `mapAssetId` and `title`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FloorPlan {
    pub level: String,
    #[serde(rename = "levlId")]
    pub level_id: String,
    #[serde(rename = "sbspId")]
    pub structure_id: String,
    pub units: String,
    pub fill: String,
    #[serde(rename = "mapAssetId", default, skip_serializing_if = "Option::is_none")]
    pub map_asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub rings: Vec<FloorRing>,
    /// A studio level's box round all its plans, the level's own and each mode's (min x, min y,
    /// max x, max y): served with every one of them, so the map keeps its orientation whichever
    /// mode is in play. Not read from the file.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub frame: Option<[f64; 4]>,
}

impl FloorPlan {
    /// A plan whose level id (studio levels) or map asset id (Forge maps) is `expected_id`.
    pub fn parse(bytes: &[u8], expected_id: &str) -> Result<Self, String> {
        if bytes.len() > 2 * 1024 * 1024 || !(valid_id(expected_id) || valid_asset(expected_id)) {
            return Err("invalid floor-plan size or ID".into());
        }
        let plan: Self = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        let identity = if valid_asset(expected_id) {
            plan.map_asset_id.as_deref().is_some_and(|id| id.eq_ignore_ascii_case(expected_id)) && valid_id(&plan.level_id)
        } else {
            plan.level_id.eq_ignore_ascii_case(expected_id)
        };
        if !identity || plan.units != "world" || plan.fill != "nonzero" || plan.rings.len() > 4096
            || plan.title.as_ref().is_some_and(|title| title.chars().count() > 128)
        {
            return Err("floor plan has an unexpected ID, unit system or fill rule".into());
        }
        let mut points = 0;
        for ring in &plan.rings {
            points += ring.p.len();
            if ring.p.len() < 6 || !ring.p.len().is_multiple_of(2) || points > 500_000
                || ring.z[0] > ring.z[1]
                || ring.z.iter().chain(&ring.p).any(|value| !value.is_finite() || value.abs() > 10_000_000.0)
            {
                return Err("invalid floor-plan ring".into());
            }
        }
        Ok(plan)
    }
}

/// The largest plan file read, bytes.
const MAX_PLAN: u64 = 2 * 1024 * 1024;

fn unavailable(error: String) -> String {
    format!("floor plan unavailable: {error}")
}

/// Whether `bytes` are the terrain of `id` (`<id>.terrain.json`): version 1, its own image, a
/// frame and its lines, every number finite, and its heights where it has them (`height`: their
/// own image, the height of code 0 and the feet a code step).
fn check_terrain(bytes: &[u8], id: &str) -> Result<(), String> {
    let terrain: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let finite = |value: &serde_json::Value| value.as_f64().is_some_and(|value| value.is_finite() && value.abs() < 10_000_000.0);
    let lines = |key: &str| terrain[key].as_array().is_some_and(|lines| lines.iter().all(|line| {
        line.as_array().is_some_and(|points| points.len().is_multiple_of(2) && points.iter().all(finite))
    }));
    let size = |key: &str| terrain[key].as_u64().is_some_and(|value| (1..=8192).contains(&value));
    if terrain["version"].as_u64() != Some(1) || terrain["image"].as_str() != Some(format!("{id}.terrain.png").as_str())
        || !finite(&terrain["x"]) || !finite(&terrain["y"]) || !terrain["res"].as_f64().is_some_and(|res| res > 0.0 && res < 1000.0)
        || !size("w") || !size("h") || !["outline", "edges", "contours"].iter().all(|key| lines(key))
    {
        return Err("terrain has an unexpected version, image, frame or lines".into());
    }
    let height = &terrain["height"];
    if !height.is_null() && (height["image"].as_str() != Some(format!("{id}.height.png").as_str()) || !finite(&height["z0"])
        || !height["step"].as_f64().is_some_and(|step| step > 0.0 && step < 100.0))
    {
        return Err("terrain has unexpected heights".into());
    }
    Ok(())
}

/// The largest terrain lines and relief image served.
const TERRAIN_JSON_LIMIT: u64 = 8 * 1024 * 1024;
const TERRAIN_IMAGE_LIMIT: u64 = 16 * 1024 * 1024;
/// The largest limits file served (`access`).
const ACCESS_LIMIT: u64 = 4 * 1024 * 1024;
/// The largest access file read from `CARTOGRAPHER_ACCESS_DIR` to make one from.
const ACCESS_FILE_LIMIT: u64 = 32 * 1024 * 1024;

fn valid_id(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A lower-case GUID, the form the observer prints asset ids in.
pub fn valid_asset(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
    })
}

#[derive(Debug, Serialize)]
pub struct LevelEntry {
    pub id: String,
    pub name: String,
    pub title: String,
    pub floor_available: bool,
}

/// Plan `plan`'s limits made from the access files of its map (`base`) in `folder`, as build.rs
/// makes the built-in ones. A map variant is named by its objective placements' title.
fn limits_from(folder: &Path, plan: &str, base: &str) -> Result<Vec<u8>, String> {
    let read = |name: String| -> Option<Vec<u8>> {
        let path = folder.join(name);
        (std::fs::metadata(&path).ok()?.len() <= ACCESS_FILE_LIMIT).then(|| std::fs::read(&path).ok()).flatten()
    };
    let access = read(format!("{base}.json")).ok_or_else(|| "no limits for this map".to_string())?;
    let why = read(format!("{base}.why.json"));
    let objectives = Assets::new("objectives");
    let title = |asset: &str| -> Option<String> {
        let bytes = objectives.read(&format!("{asset}.json"), MAX_PLAN).ok()?;
        serde_json::from_slice::<serde_json::Value>(&bytes).ok()?["title"].as_str().map(str::to_string)
    };
    crate::limits::of_plan(&access, why.as_deref(), plan, &title).map(String::into_bytes)
}

/// The name a game mode's plan goes by in film-assets `playable`: the mode's own in its Forge
/// labels (`infection_exclude`). None for the modes no level has a plan of its own for.
pub fn plan_mode(mode: filmshell::GameMode) -> Option<&'static str> {
    use filmshell::GameMode::*;
    Some(match mode {
        Slayer | Escalation => "slayer",
        CaptureTheFlag => "ctf",
        Oddball => "oddball",
        Strongholds => "strongholds",
        KingOfTheHill => "koth",
        Attrition => "elimination",
        Extraction => "extraction",
        Infection => "infection",
        Vip => "vip",
        Stockpile => "stockpile",
        _ => return None,
    })
}

/// A plan id's level and the mode after it: `c7d52145.infection`. None for a malformed one.
fn split_mode(id: &str) -> Option<(&str, Option<&str>)> {
    match id.split_once('.') {
        None => Some((id, None)),
        Some((level, mode)) => (valid_id(level) && !mode.is_empty() && mode.len() <= 16 && mode.bytes().all(|byte| byte.is_ascii_lowercase()))
            .then_some((level, Some(mode))),
    }
}

/// Studio-level plans (film-assets `levels`, by level id), the same cut to where players can go
/// (`playable`, by level id, and by level id and mode where a mode closes or opens more), and
/// Forge map plans (`maps`, by map variant asset id), loaded on first use and kept.
pub struct GeometryStore {
    levels: Assets,
    playable: Assets,
    maps: Assets,
    plans: BTreeMap<String, FloorPlan>,
    /// A folder of film-assets access files to make the limits from (`CARTOGRAPHER_ACCESS_DIR`),
    /// in place of the ones built in.
    access: Option<PathBuf>,
}

impl GeometryStore {
    pub fn open() -> Self {
        Self {
            levels: Assets::new("levels"), playable: Assets::new("playable"), maps: Assets::new("maps"), plans: BTreeMap::new(),
            access: crate::assets::override_dir("access"),
        }
    }

    /// The plan id of a studio level played in `mode`: `<level>.<mode>` when the mode has a plan of
    /// its own, else the level's.
    pub fn studio_id(&self, level: &str, mode: Option<filmshell::GameMode>) -> String {
        let level = level.to_ascii_lowercase();
        match mode.and_then(plan_mode) {
            Some(mode) if self.playable.contains(&format!("{level}.{mode}.json")) => format!("{level}.{mode}"),
            _ => level,
        }
    }

    /// The studio levels, then every Forge map with a plan (by title). A level the game names only
    /// by its file name (`btb_engine`) takes the name its map variants give it (`names`, by level id:
    /// Scarr), when there are any.
    pub fn levels(&mut self, names: &BTreeMap<String, String>) -> Vec<LevelEntry> {
        let mut levels: Vec<_> = filmshell::game::levels().iter().map(|level| {
            let id = format!("{:08x}", level.id.get());
            let floor_available = self.levels.contains(&format!("{id}.json"));
            let title = level.display_name.or_else(|| names.get(&id).map(String::as_str)).unwrap_or(level.name);
            LevelEntry { title: title.into(), id, name: level.name.into(), floor_available }
        }).collect();
        let forge: Vec<String> = self.maps.names().into_iter()
            .filter_map(|name| name.strip_suffix(".json").filter(|id| valid_asset(id)).map(str::to_string))
            .collect();
        let mut maps: Vec<_> = forge.into_iter().filter_map(|id| {
            let title = self.title(&id)?;
            Some(LevelEntry { name: title.clone(), title, id, floor_available: true })
        }).collect();
        maps.sort_by(|a, b| a.title.cmp(&b.title));
        levels.extend(maps);
        levels
    }

    /// A Forge map's title, when its plan is known.
    pub fn title(&mut self, asset: &str) -> Option<String> {
        if !valid_asset(asset) { return None; }
        let plan = self.get(asset).ok()?;
        Some(plan.title.clone().unwrap_or_else(|| plan.level.clone()))
    }

    /// A map's terrain beside its plan (film-assets `<id>.terrain.json`, see films-ui floor.ts),
    /// checked to be one: version 1, its own image, a frame and its lines.
    pub fn terrain(&self, id: &str) -> Result<Vec<u8>, String> {
        let (source, id) = self.source(id)?;
        let bytes = source.read(&format!("{id}.terrain.json"), TERRAIN_JSON_LIMIT)
            .map_err(|error| format!("terrain unavailable: {error}"))?;
        check_terrain(&bytes, &id)?;
        Ok(bytes.into_owned())
    }

    /// A map's terrain relief (`<id>.terrain.png`), when it is a PNG.
    pub fn terrain_image(&self, id: &str) -> Result<Vec<u8>, String> {
        self.terrain_png(id, "terrain")
    }

    /// A map's heights beside its terrain (`<id>.height.png`, the terrain's `height`), when it is
    /// a PNG: each pixel's floor or top in its red and green, and what is there in its blue.
    pub fn height_image(&self, id: &str) -> Result<Vec<u8>, String> {
        self.terrain_png(id, "height")
    }

    /// A plan's limits for the data view (limits.rs: the limiters players can't pass and every
    /// area the plan leaves out, each with its reason), built in beside the plan as
    /// `<id>.access.json` for a map with terrain. A level's mode plan (`c7d52145.infection`) reads
    /// its own beside the playable plans, else the level's there or beside the level's plan. With
    /// `CARTOGRAPHER_ACCESS_DIR` they are made from its access files instead. Checked to be a JSON
    /// object.
    pub fn access(&self, id: &str) -> Result<Vec<u8>, String> {
        let lower = id.to_ascii_lowercase();
        let (source, base) = self.source(&lower)?;
        if let Some(folder) = &self.access {
            return limits_from(folder, &lower, &base);
        }
        let mut tries: Vec<(&Assets, String)> = Vec::new();
        if !valid_asset(&lower) {
            tries.push((&self.playable, format!("{lower}.access.json")));
            tries.push((&self.playable, format!("{base}.access.json")));
        }
        tries.push((source, format!("{base}.access.json")));
        let bytes = tries.into_iter().find_map(|(assets, name)| assets.read(&name, ACCESS_LIMIT).ok())
            .ok_or_else(|| "no limits for this map".to_string())?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if !value.is_object() {
            return Err("limits are not a JSON object".into());
        }
        Ok(bytes.into_owned())
    }

    /// The PNG `<id>.<kind>.png` beside a map's terrain.
    fn terrain_png(&self, id: &str, kind: &str) -> Result<Vec<u8>, String> {
        let (source, id) = self.source(id)?;
        let bytes = source.read(&format!("{id}.{kind}.png"), TERRAIN_IMAGE_LIMIT)
            .map_err(|error| format!("{kind} unavailable: {error}"))?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(format!("{kind} image is not a PNG"));
        }
        Ok(bytes.into_owned())
    }

    /// Where a level's files (by level id) or a Forge map's (by map asset id) are, and the id
    /// in lower case. A level's plan for one mode (`c7d52145.infection`) has the level's terrain.
    fn source(&self, id: &str) -> Result<(&Assets, String), String> {
        let id = id.to_ascii_lowercase();
        if valid_asset(&id) {
            return Ok((&self.maps, id));
        }
        match split_mode(&id) {
            Some((level, _)) if valid_id(level) => Ok((&self.levels, level.to_string())),
            _ => Err("invalid level ID".into()),
        }
    }

    /// The box round every plan of studio level `level` (see `FloorPlan::frame`): its playable
    /// plan and each mode's, or the level's as it is where it has no playable plan of its own.
    fn level_frame(&self, level: &str) -> Option<[f64; 4]> {
        let own = format!("{level}.json");
        let modes = format!("{level}.");
        let mut sources: Vec<(&Assets, String)> = self.playable.names().into_iter()
            .filter(|name| *name == own || name.strip_prefix(&modes).and_then(|rest| rest.strip_suffix(".json"))
                .is_some_and(|mode| split_mode(&format!("{level}.{mode}")).is_some()))
            .map(|name| (&self.playable, name))
            .collect();
        if !self.playable.contains(&own) {
            sources.push((&self.levels, own));
        }
        let mut frame: Option<[f64; 4]> = None;
        for (source, name) in sources {
            let Ok(plan) = source.read(&name, MAX_PLAN).map_err(unavailable).and_then(|bytes| FloorPlan::parse(&bytes, level)) else { continue };
            for ring in plan.rings.iter().filter(|ring| !ring.hole) {
                for point in ring.p.chunks_exact(2) {
                    let f = frame.get_or_insert([point[0], point[1], point[0], point[1]]);
                    *f = [f[0].min(point[0]), f[1].min(point[1]), f[2].max(point[0]), f[3].max(point[1])];
                }
            }
        }
        frame
    }

    /// A plan by id: a Forge map's by its map variant asset id, a studio level's by its level id,
    /// or by level id and mode (`c7d52145.infection`). A studio level's is the playable one where
    /// film-assets has it, else the level's as it is.
    pub fn get(&mut self, id: &str) -> Result<&FloorPlan, String> {
        let id = id.to_ascii_lowercase();
        if !self.plans.contains_key(&id) {
            let plan = if valid_asset(&id) {
                FloorPlan::parse(&self.maps.read(&format!("{id}.json"), MAX_PLAN).map_err(unavailable)?, &id)?
            } else {
                let Some((level, mode)) = split_mode(&id).filter(|(level, _)| valid_id(level)) else {
                    return Err("invalid level ID".into());
                };
                let own = mode.map(|mode| format!("{level}.{mode}.json")).filter(|name| self.playable.contains(name));
                let bytes = match own {
                    Some(name) => self.playable.read(&name, MAX_PLAN),
                    None if self.playable.contains(&format!("{level}.json")) => self.playable.read(&format!("{level}.json"), MAX_PLAN),
                    None => self.levels.read(&format!("{level}.json"), MAX_PLAN),
                }.map_err(unavailable)?;
                let mut plan = FloorPlan::parse(&bytes, level)?;
                plan.frame = self.level_frame(level);
                plan
            };
            self.plans.insert(id.clone(), plan);
        }
        Ok(&self.plans[&id])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_plan_validates_identity_units_and_polygon_shape() {
        let valid = br#"{"level":"test","levlId":"1234abcd","sbspId":"00000001","units":"world","fill":"nonzero","rings":[{"z":[0,10],"p":[0,0,10,0,10,10]}]}"#;
        let plan = FloorPlan::parse(valid, "1234abcd").unwrap();
        assert_eq!(plan.rings.len(), 1);
        assert!(!plan.rings[0].hole);
        assert!(FloorPlan::parse(valid, "87654321").is_err());
        assert!(FloorPlan::parse(valid, "../test").is_err());
        let malformed = String::from_utf8_lossy(valid).replace("0,0,10,0,10,10", "0,0,10");
        assert!(FloorPlan::parse(malformed.as_bytes(), "1234abcd").is_err());
        let wrong_units = String::from_utf8_lossy(valid).replace("world", "engine");
        assert!(FloorPlan::parse(wrong_units.as_bytes(), "1234abcd").is_err());
    }

    #[test]
    fn terrain_is_checked_for_its_image_frame_and_lines() {
        let valid = br#"{"version":1,"image":"1234abcd.terrain.png","x":-10,"y":20,"res":0.5,"w":40,"h":60,"z":[0,9],"contour":1,"outline":[[0,0,10,0,10,10]],"edges":[[1,1,2,2]],"contours":[]}"#;
        assert!(check_terrain(valid, "1234abcd").is_ok());
        assert!(check_terrain(valid, "87654321").is_err());
        let text = String::from_utf8_lossy(valid);
        assert!(check_terrain(text.replace("\"version\":1", "\"version\":2").as_bytes(), "1234abcd").is_err());
        assert!(check_terrain(text.replace("[1,1,2,2]", "[1,1,2]").as_bytes(), "1234abcd").is_err());
        assert!(check_terrain(text.replace("\"res\":0.5", "\"res\":0").as_bytes(), "1234abcd").is_err());
        assert!(check_terrain(text.replace("\"w\":40", "\"w\":0").as_bytes(), "1234abcd").is_err());
        assert!(check_terrain(b"not json", "1234abcd").is_err());

        // Its heights, where it has them, name their own image, the height of code 0 and a step.
        let heights = text.replace("\"contour\":1", "\"contour\":1,\"height\":{\"image\":\"1234abcd.height.png\",\"z0\":-35,\"step\":0.25}");
        assert!(check_terrain(heights.as_bytes(), "1234abcd").is_ok());
        assert!(check_terrain(heights.replace("1234abcd.height.png", "other.height.png").as_bytes(), "1234abcd").is_err());
        assert!(check_terrain(heights.replace("\"step\":0.25", "\"step\":0").as_bytes(), "1234abcd").is_err());
        assert!(check_terrain(heights.replace("\"z0\":-35", "\"z0\":\"x\"").as_bytes(), "1234abcd").is_err());
    }

    #[test]
    fn heights_are_served_beside_the_terrain() {
        // A level's plan for one mode reads the level's heights, in lower case, and nothing but a
        // PNG goes out. Where the built-in data has none yet, the error names the file looked for.
        let store = GeometryStore::open();
        match store.height_image("C7D52145.infection") {
            Ok(bytes) => assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n")),
            Err(error) => assert!(error.contains("c7d52145.height.png"), "{error}"),
        }
        match store.height_image("1bc0e2a7-9d6d-4771-9574-9978e7c9292c") {
            Ok(bytes) => assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n")),
            Err(error) => assert!(error.contains("1bc0e2a7-9d6d-4771-9574-9978e7c9292c.height.png"), "{error}"),
        }
        assert!(store.height_image("../c7d52145").is_err());
        assert!(store.height_image("c7d52145.in fection").is_err());
        assert!(store.terrain_image("c7d52145").is_ok_and(|bytes| bytes.starts_with(b"\x89PNG\r\n\x1a\n")));
    }

    #[test]
    fn limits_are_served_where_a_map_has_them() {
        // The data view asks every map for its limits: one without them is a plain error, and a
        // name that is not an id never reaches the disk.
        let store = GeometryStore::open();
        match store.access("c7d52145.infection") {
            Ok(bytes) => {
                let limits: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(limits["plan"], "c7d52145.infection");
                assert!(limits["limits"].is_array() && limits["removed"].is_array());
            }
            Err(error) => assert!(error.contains("no limits"), "{error}"),
        }
        assert!(store.access("../c7d52145").is_err());
        assert!(store.access("not-an-id").is_err());
    }

    #[test]
    fn forge_plans_are_keyed_by_their_map_asset_id() {
        let asset = "1a6cfc2e-ec86-48e1-9464-1ce1bff6ed48";
        let forge = format!(r#"{{"level":"Lattice - Ranked","levlId":"c4d9cdb7","sbspId":"00000000","units":"world","fill":"nonzero","mapAssetId":"{asset}","mapVersionId":"3a382104-9b89-4e6e-aa18-0affaa98f478","title":"Lattice - Ranked","rings":[{{"z":[0,10],"p":[0,0,10,0,10,10]}}]}}"#);
        let plan = FloorPlan::parse(forge.as_bytes(), asset).unwrap();
        assert_eq!(plan.title.as_deref(), Some("Lattice - Ranked"));
        assert!(FloorPlan::parse(forge.as_bytes(), "d035fc3e-f298-4c14-9487-465be2e1dc1f").is_err());
        assert!(FloorPlan::parse(forge.as_bytes(), "c4d9cdb7").is_ok_and(|plan| plan.level_id == "c4d9cdb7"));
        assert!(!valid_asset("1A6CFC2E-EC86-48E1-9464-1CE1BFF6ED48"));
        assert!(!valid_asset("../../../../etc/passwd/xxxxxxxxxxxxxxxx"));
    }

    #[test]
    fn a_studio_plan_can_name_a_mode() {
        assert_eq!(split_mode("c7d52145"), Some(("c7d52145", None)));
        assert_eq!(split_mode("c7d52145.infection"), Some(("c7d52145", Some("infection"))));
        for bad in ["c7d52145.", "c7d52145.in fection", "c7d52145.Infection", "c7d52145.a.b", "../x.infection"] {
            assert_eq!(split_mode(bad), None, "{bad}");
        }
        assert_eq!(plan_mode(filmshell::GameMode::Infection), Some("infection"));
        assert_eq!(plan_mode(filmshell::GameMode::Attrition), Some("elimination"));
        assert_eq!(plan_mode(filmshell::GameMode::Firefight), None);

        // A mode without a plan of its own draws the level's.
        let mut store = GeometryStore::open();
        let level = store.get("4c2a2491").unwrap().rings.len();
        assert!(store.get("4c2a2491.oddball").is_ok_and(|plan| plan.level_id == "4c2a2491" && plan.rings.len() == level));
        assert_eq!(store.studio_id("4C2A2491", Some(filmshell::GameMode::Oddball)), "4c2a2491");
        assert_eq!(store.studio_id("4c2a2491", None), "4c2a2491");
        assert!(store.get("4c2a2491.in fection").is_err());

        // Every plan of a level has one frame, round them all.
        let frame = store.get("c7d52145").unwrap().frame.unwrap();
        assert_eq!(store.get("c7d52145.infection").unwrap().frame, Some(frame));
        for id in ["c7d52145", "c7d52145.infection"] {
            let plan = store.get(id).unwrap();
            assert!(plan.rings.iter().filter(|ring| !ring.hole).flat_map(|ring| ring.p.chunks_exact(2))
                .all(|point| (frame[0]..=frame[2]).contains(&point[0]) && (frame[1]..=frame[3]).contains(&point[1])), "{id}");
        }
        assert!(store.get("1a6cfc2e-ec86-48e1-9464-1ce1bff6ed48").unwrap().frame.is_none(), "a Forge map is framed by its own plan");

        // A level's plan for one mode has the level's terrain.
        assert!(store.source("C7D52145.infection").is_ok_and(|(_, id)| id == "c7d52145"));
        assert!(store.source("c7d52145.in fection").is_err());
        assert!(store.source("../c7d52145").is_err());
    }
}
