//! Game-mode objective placements per map variant: flag stands and capture plates, KOTH hills (with
//! their place in the rotation), Strongholds, Land Grab, Total Control and Extraction zones, ball
//! stands and bomb sites, from film-assets' `objectives/<mapAssetId>.json` (taken from each map
//! variant's object list). World units, the floor plans' frame.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::assets::Assets;
use crate::geometry::valid_asset;

#[derive(Debug, Deserialize, Serialize)]
pub struct Objectives {
    #[serde(rename = "mapAssetId")]
    pub map_asset_id: String,
    #[serde(rename = "mapVersionId", default, skip_serializing_if = "Option::is_none")]
    pub map_version_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The level the map is built on (its `levl` tag, as hex): its floor plan, when film-assets
    /// has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    pub objects: Vec<Objective>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Objective {
    /// The modes that use it (one capture zone can be a KOTH hill and a Strongholds zone): ctf,
    /// koth, strongholds, landgrab, totalcontrol, extraction, oddball or assault.
    pub modes: Vec<String>,
    /// flag_spawn, flag_plate, zone (a hill or a capture zone), ball_stand, bomb_spawn or bomb_site.
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// The team the object belongs to (a flag stand, a plate), when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<u8>,
    /// The volume: [shape (2 cylinder, 3 box), radius or length, width, height above, depth below].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<[f64; 5]>,
    /// A box's heading, radians in the world frame. Its length runs along it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yaw: Option<f64>,
    /// A KOTH hill's place in the rotation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
}

const MODES: [&str; 8] = ["ctf", "koth", "strongholds", "landgrab", "totalcontrol", "extraction", "oddball", "assault"];
const KINDS: [&str; 6] = ["flag_spawn", "flag_plate", "zone", "ball_stand", "bomb_spawn", "bomb_site"];

impl Objectives {
    pub fn parse(bytes: &[u8], asset: &str) -> Result<Self, String> {
        let objectives: Self = serde_json::from_slice(bytes).map_err(|error| format!("{asset}: {error}"))?;
        if objectives.map_asset_id != asset { return Err(format!("{asset}: the file names another map variant")); }
        for objective in &objectives.objects {
            let numbers = [objective.x, objective.y, objective.z, objective.yaw.unwrap_or(0.0)];
            if objective.modes.is_empty() || !objective.modes.iter().all(|mode| MODES.contains(&mode.as_str()))
                || !KINDS.contains(&objective.kind.as_str())
                || !numbers.iter().chain(objective.b.iter().flatten()).all(|value| value.is_finite())
                || objective.team.is_some_and(|team| team > 7)
            {
                return Err(format!("{asset}: invalid objective"));
            }
        }
        Ok(objectives)
    }
}

pub struct ObjectiveStore {
    assets: Assets,
}

impl ObjectiveStore {
    pub fn open() -> Self {
        Self { assets: Assets::new("objectives") }
    }

    /// The objectives of a map variant, by its asset id.
    pub fn get(&self, asset: &str) -> Result<Objectives, String> {
        if !valid_asset(asset) { return Err("invalid map variant id".into()); }
        Objectives::parse(&self.assets.read(&format!("{asset}.json"), 1024 * 1024)?, asset)
    }

    /// Each level's name as its map variants give it, by level id: the title most of them start
    /// with (Scarr, of Scarr, Scarr Heavies and Scarr Firefight), the shortest of those tied.
    pub fn level_names(&self) -> BTreeMap<String, String> {
        let mut titles: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for name in self.assets.names() {
            let Some(asset) = name.strip_suffix(".json").filter(|asset| valid_asset(asset)) else { continue };
            let Ok(objectives) = self.get(asset) else { continue };
            if let (Some(level), Some(title)) = (objectives.level, objectives.title) {
                titles.entry(level.to_ascii_lowercase()).or_default().push(title);
            }
        }
        titles.into_iter().filter_map(|(level, titles)| Some((level, level_name(&titles)?))).collect()
    }
}

/// The title most of `titles` start with, word for word, the shortest of those tied.
fn level_name(titles: &[String]) -> Option<String> {
    let starts = |title: &String| titles.iter()
        .filter(|other| *other == title || other.strip_prefix(title.as_str()).is_some_and(|rest| rest.starts_with(' ')))
        .count();
    titles.iter()
        .max_by(|a, b| starts(a).cmp(&starts(b)).then(b.len().cmp(&a.len())).then(b.cmp(a)))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "b302eb62-da9a-480b-a409-3c89df8c1a04";

    #[test]
    fn built_in_objectives_parse() {
        let store = ObjectiveStore { assets: Assets::built_in("objectives") };
        let origin = store.get(ORIGIN).unwrap();
        let flags: Vec<_> = origin.objects.iter().filter(|o| o.kind == "flag_spawn").collect();
        assert_eq!(flags.len(), 2);
        assert!(flags.iter().all(|flag| flag.x.abs() < 1.0 && (flag.y.abs() - 160.0).abs() < 1.0));
        let mut hills: Vec<u32> = origin.objects.iter().filter(|o| o.modes.iter().any(|m| m == "koth")).filter_map(|o| o.order).collect();
        hills.sort_unstable();
        assert_eq!(hills, [1, 2, 3, 4, 5, 6, 7]);
        assert!(store.get("../maps/x").is_err());
        // Empyrean's three Strongholds zones are capture zones its KOTH uses too.
        let empyrean = store.get("d035fc3e-f298-4c14-9487-465be2e1dc1f").unwrap();
        let both = empyrean.objects.iter().filter(|o| o.modes.iter().any(|m| m == "koth") && o.modes.iter().any(|m| m == "strongholds")).count();
        assert_eq!(both, 3);
    }

    #[test]
    fn a_level_is_named_as_its_map_variants_are() {
        let names = |titles: &[&str]| level_name(&titles.iter().map(|title| title.to_string()).collect::<Vec<_>>());
        assert_eq!(names(&["Scarr", "Scarr Firefight", "Scarr Heavies", "Scarry"]).as_deref(), Some("Scarr"));
        assert_eq!(names(&["House of Reckoning 2F", "House of Reckoning", "House of Reckoning Infection"]).as_deref(), Some("House of Reckoning"));
        assert_eq!(names(&["Cliffhanger - Ranked", "Cliffhanger Infection", "Cliffhanger"]).as_deref(), Some("Cliffhanger"));
        assert_eq!(names(&["Bazaar Infection"]).as_deref(), Some("Bazaar Infection"));
        assert_eq!(names(&[]), None);
        let store = ObjectiveStore { assets: Assets::built_in("objectives") };
        let levels = store.level_names();
        assert_eq!(levels.get("82285aba").map(String::as_str), Some("House of Reckoning"));
        assert_eq!(levels.get("2faaa022").map(String::as_str), Some("Scarr"));
        assert_eq!(levels.get("7b4ed9e6").map(String::as_str), Some("Prism"));
    }

    #[test]
    fn objectives_are_validated() {
        let good = format!(r#"{{"mapAssetId":"{ORIGIN}","objects":[{{"modes":["koth","strongholds"],"kind":"zone","x":1,"y":2,"z":3,"b":[3,45,26,20,1],"yaw":0.5,"order":2}}]}}"#);
        assert_eq!(Objectives::parse(good.as_bytes(), ORIGIN).unwrap().objects[0].order, Some(2));
        assert!(Objectives::parse(good.replace("koth", "slayer").as_bytes(), ORIGIN).is_err());
        assert!(Objectives::parse(good.replace(r#"["koth","strongholds"]"#, "[]").as_bytes(), ORIGIN).is_err());
        assert!(Objectives::parse(good.as_bytes(), "46a8319c-2c63-46ee-9382-788906dcb049").is_err());
        assert!(Objectives::parse(good.replace(r#""team":"#, "").replace(r#""order":2"#, r#""order":2,"team":9"#).as_bytes(), ORIGIN).is_err());
    }
}
