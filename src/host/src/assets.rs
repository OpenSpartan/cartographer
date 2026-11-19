//! The map data the observer ships with, from film-assets (floor plans, objective placements,
//! icons, the typeface), embedded by build.rs.
//! `CARTOGRAPHER_<PART>_DIR` can point one part of it at a folder on disk instead, for development
//! or refreshed assets.

use std::borrow::Cow;
use std::path::PathBuf;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/data_assets.rs"));
}

/// The parts of the embedded data, each a film-assets folder. `playable` holds the studio levels'
/// plans cut to where players can go, and may be missing from an older checkout.
pub const PARTS: [&str; 9] = ["levels", "playable", "maps", "objectives", "icons", "markers", "modes", "teams", "fonts"];

/// The folder that replaces `part` of the embedded data (`CARTOGRAPHER_ICONS_DIR` for `icons`), if
/// one is set.
pub fn override_dir(part: &str) -> Option<PathBuf> {
    crate::setting(&format!("{}_DIR", part.to_ascii_uppercase())).map(PathBuf::from)
}

/// One folder of the embedded data (`levels`, `maps`, `objectives`, ...), or the folder its
/// `CARTOGRAPHER_<PART>_DIR` names in its place.
pub struct Assets {
    part: &'static str,
    directory: Option<PathBuf>,
}

impl Assets {
    pub fn new(part: &'static str) -> Self {
        Self { part, directory: override_dir(part) }
    }

    /// `part` of the embedded data, whatever the environment says.
    pub fn built_in(part: &'static str) -> Self {
        Self { part, directory: None }
    }

    /// A file by plain name (no folders), refused when it is larger than `maximum` bytes.
    pub fn read(&self, name: &str, maximum: u64) -> Result<Cow<'static, [u8]>, String> {
        if !plain(name) { return Err("invalid asset name".into()); }
        let bytes = match &self.directory {
            Some(directory) => {
                let path = directory.join(name);
                if std::fs::metadata(&path).map_err(|error| format!("{name}: {error}"))?.len() > maximum {
                    return Err(format!("{name} exceeds its size limit"));
                }
                Cow::Owned(std::fs::read(&path).map_err(|error| format!("{name}: {error}"))?)
            }
            None => Cow::Borrowed(self.embedded(name).ok_or_else(|| format!("{name} is not in the built-in {} data", self.part))?),
        };
        if bytes.len() as u64 > maximum { return Err(format!("{name} exceeds its size limit")); }
        Ok(bytes)
    }

    pub fn contains(&self, name: &str) -> bool {
        plain(name) && match &self.directory {
            Some(directory) => directory.join(name).is_file(),
            None => self.embedded(name).is_some(),
        }
    }

    /// The file names in this part, sorted.
    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = match &self.directory {
            Some(directory) => std::fs::read_dir(directory).into_iter().flatten().flatten()
                .filter(|entry| entry.path().is_file())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect(),
            None => embedded::DATA_ASSETS.iter()
                .filter_map(|(path, _)| path.strip_prefix(self.part)?.strip_prefix('/'))
                .filter(|name| !name.contains('/'))
                .map(str::to_string)
                .collect(),
        };
        names.sort();
        names
    }

    fn embedded(&self, name: &str) -> Option<&'static [u8]> {
        embedded::DATA_ASSETS.iter()
            .find(|(path, _)| path.strip_prefix(self.part).and_then(|rest| rest.strip_prefix('/')) == Some(name))
            .map(|(_, bytes)| *bytes)
    }
}

/// A single file name: no folders, no hidden files, no drive or parent references.
fn plain(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', ':'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_single_plain_files() {
        assert!(plain("4c2a2491.json"));
        assert!(!plain("../levels/4c2a2491.json"));
        assert!(!plain("..\\x"));
        assert!(!plain(".hidden"));
        assert!(!plain("C:x"));
        assert!(!plain(""));
    }

    #[test]
    fn the_built_in_data_has_every_part() {
        let part = Assets::built_in;
        assert!(PARTS.iter().filter(|name| **name != "playable").all(|name| !part(name).names().is_empty()), "every part has files");
        assert!(part("levels").contains("4c2a2491.json"), "Bazaar's floor plan");
        assert!(part("icons").contains("icons.json"));
        assert!(part("modes").contains("modes.json"));
        assert!(part("maps").names().iter().any(|name| name == "1a6cfc2e-ec86-48e1-9464-1ce1bff6ed48.json"), "Lattice - Ranked");
        assert!(part("levels").read("../icons/icons.json", 1 << 20).is_err());
        assert!(part("icons").read("icons.json", 16).is_err(), "the size limit applies to built-in data too");
    }
}
