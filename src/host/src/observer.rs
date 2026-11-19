use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

use filmshell::game::ObjectKind;
use filmshell::navpoint::{self, Clause, StateGroup, ZoneMarks};
use filmshell::{Position, TeamId};
use serde::Serialize;

use crate::{get, navmesh, Ds};

/// The snapshot's `schema`, and a failed read's in a capture.
pub const SCHEMA: &str = "cartographer.snapshot.v1";
pub const ERROR_SCHEMA: &str = "cartographer.snapshot.error.v1";

/// The error of a read the world changed under (a pool moved, the match moved on): taken again
/// at once, it usually succeeds, so it never counts as losing the server.
const CHANGED: &str = "world/pool changed during observation";
/// How many times a read the world changed under is taken again.
const RETRIES: usize = 3;

/// Whether `error` is a read the world changed under, not a lost or unreadable server.
pub fn is_transient(error: &str) -> bool { error.starts_with(CHANGED) }

/// One game's state among the server's games: its variant, which names its mode scripts by path.
const GAME_ENTRY: u64 = 0x1134f0;

const OBJECTS: u64 = 0x4eb5b08;
const PLAYERS: u64 = 0x4eafd00;
const COMPONENTS: u64 = 0x4eafce8;
const DISPENSER_KIND: u64 = 0x371f388;
const INVALID: u32 = u32::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Pools {
    objects: u64,
    players: u64,
    components: u64,
    secondary_components: u64,
}

#[derive(Debug, PartialEq)]
struct Pool {
    address: u64,
    stride: usize,
    limit: usize,
    data: u64,
    entries: Vec<u8>,
}

impl Pool {
    fn read(ds: &Ds, address: u64, stride: usize, maximum: usize) -> Result<Self, String> {
        if address == 0 { return Err("pool is unavailable".into()); }
        let header = ds.read_abs(address, 0x80)?;
        let limit = get::<u32>(&header, 0x6c) as usize;
        let data = get::<u64>(&header, 0x78);
        if get::<u64>(&header, 0x40) != stride as u64 || limit > maximum
            || (limit != 0 && data == 0)
        {
            return Err("unexpected pool stride, count or data pointer".into());
        }
        let length = limit.checked_mul(stride).filter(|length| *length <= 16 * 1024 * 1024)
            .ok_or("pool exceeds read budget")?;
        let entries = if length == 0 { Vec::new() } else { ds.read_abs(data, length)? };
        Ok(Self { address, stride, limit, data, entries })
    }

    fn at(&self, index: usize) -> Option<&[u8]> {
        (index < self.limit).then(|| &self.entries[index * self.stride..(index + 1) * self.stride])
    }

    fn handle(&self, index: usize) -> Option<u32> {
        let salt = get::<u16>(self.at(index)?, 0);
        (salt != 0).then_some((salt as u32) << 16 | (index as u32) << 1)
    }

    fn resolve(&self, handle: u32) -> Option<(usize, &[u8])> {
        if handle == INVALID || handle & 1 != 0 { return None; }
        let index = ((handle >> 1) & 0x7fff) as usize;
        let entry = self.at(index)?;
        (get::<u16>(entry, 0) != 0 && get::<u16>(entry, 0) == (handle >> 16) as u16)
            .then_some((index, entry))
    }

    fn unchanged(&self, ds: &Ds) -> Result<bool, String> {
        let header = ds.read_abs(self.address, 0x80)?;
        Ok(get::<u64>(&header, 0x40) == self.stride as u64
            && get::<u32>(&header, 0x6c) as usize == self.limit
            && get::<u64>(&header, 0x78) == self.data)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PadSlot {
    pub index: usize,
    pub state: &'static str,
    pub item: Option<String>,
    pub seconds_left: f32,
    pub start_seconds: f32,
    pub timer_rate_index: u8,
}

#[derive(Clone, Debug, Serialize)]
pub struct Dispenser {
    pub enabled: bool,
    pub slots: Vec<PadSlot>,
}

#[derive(Clone, Debug, Serialize)]
pub struct EngineTimer {
    pub seconds_left: f32,
    pub start_seconds: f32,
    pub timer_rate_index: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct IncomingTiming {
    pub started_game_seconds: f64,
    pub duration_seconds: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct StockSpawner {
    pub category: &'static str,
    pub item_identifier: u32,
    pub item_name: Option<String>,
    pub item_text_id: Option<u32>,
    pub display_name: Option<String>,
    pub state: &'static str,
    pub spawn_logic: &'static str,
    pub respawn_seconds: f32,
    pub items: Vec<String>,
    pub seconds_left: Option<f64>,
    pub incoming: Option<IncomingTiming>,
}

impl IncomingTiming {
    fn remaining(self, now: f64) -> Option<f64> {
        let elapsed = now - self.started_game_seconds;
        (now.is_finite() && self.started_game_seconds.is_finite() && elapsed >= -0.1
            && self.duration_seconds.is_finite() && (0.0..=36000.0).contains(&self.duration_seconds)
            && elapsed <= f64::from(self.duration_seconds) + 2.0)
            .then(|| (f64::from(self.duration_seconds) - elapsed).clamp(0.0, f64::from(self.duration_seconds)))
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Object {
    pub handle: String,
    pub kind: &'static str,
    /// The object's own definition: a runtime tag handle, not the tag's global id.
    pub definition_handle: u32,
    /// The tag that definition handle stands for: its global id, group and name.
    pub tag: Option<TagRef>,
    pub parent: Option<String>,
    /// Its cached world position, or for an attached object its parent's (place_on_parents).
    pub position: Option<Position>,
    /// A biped's aim (world_yaw of its aiming vector).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facing: Option<f64>,
    pub dispenser: Option<Dispenser>,
    pub stock_spawner: Option<StockSpawner>,
}

/// A tag as the game's files and Films name it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TagRef {
    /// The global tag id, as hex.
    pub id: String,
    /// The tag group: weap, mach, eqip, vehi, bipd, ...
    pub group: String,
    /// The English name, when libfilmshell's catalogue lists the tag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<&'static str>,
    /// The objective it is when carried (libfilmshell's Carried::from_item): flag, skull, ball,
    /// power_seed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub carried: Option<filmshell::Carried>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlayerStats {
    pub kills: Option<i32>,
    pub deaths: Option<i32>,
    pub assists: Option<i32>,
    pub objective_score: Option<i32>,
    /// The match's shots so far, as the server counts them for the post-game report: one per
    /// projectile a weapon the player holds fires (thrown grenades count none), and one per
    /// projectile that damages something on an enemy team. A rise between two snapshots means the
    /// player fired.
    pub shots_fired: Option<u32>,
    pub shots_hit: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Vitality {
    pub health: f32,
    pub shield: Option<f32>,
    pub health_recharging: bool,
    pub shield_recharging: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Player {
    pub handle: String,
    pub slot: usize,
    pub name: Option<String>,
    pub team: Option<TeamId>,
    pub team_name: Option<&'static str>,
    pub observer: bool,
    pub bot_handle: Option<String>,
    pub unit: Option<String>,
    pub position: Option<Position>,
    pub alive: bool,
    pub stats: Option<PlayerStats>,
    pub vitality: Option<Vitality>,
    pub average_life_seconds: Option<f64>,
    /// The objective the player carries (flag, bomb or ball), from the game's per-player
    /// PlayerCarriedObjectiveType property.
    pub carrying: Option<&'static str>,
    /// Where the living player aims, as a map yaw (world_yaw), like libfilmshell's Sample::yaw.
    pub facing: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MapInfo {
    pub engine_path: String,
    pub level_id: Option<String>,
    pub name: Option<&'static str>,
    pub title: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MatchInfo {
    /// The game variant's name, as the variant gives it (a custom one's can be anything).
    pub mode: Option<String>,
    /// The mode it runs, by the scripts the variant names (libfilmshell's GameMode), and its
    /// English name.
    pub game_mode: Option<filmshell::GameMode>,
    pub game_mode_name: Option<&'static str>,
    pub round_index: Option<u16>,
    pub elapsed_seconds: Option<f64>,
    pub round_timer: Option<EngineTimer>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TeamScore {
    pub team: TeamId,
    pub name: Option<&'static str>,
    pub round_score: Option<i32>,
    pub total_score: Option<i32>,
}

/// An asset reference as the game keeps the selected map and game variant: its
/// kind (2 map variant, 6 game variant), asset id and version id. `name` is
/// filled by the server from a known plan, never read from the DS.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AssetRef {
    pub kind: u32,
    pub asset_id: String,
    pub version_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

const ASSET_REF_SIZE: usize = 0x24;
/// The LAN session's playlist parameter: the lobby leader's map and mode
/// selection, which the DS hosts like every session parameter, a map variant
/// ref then a game variant ref.
const SESSION: u64 = 0x4dc3200;
const SESSION_PARAMETERS: u64 = 0x59f78;
const CUSTOM_PLAYLIST: u64 = 0xb4afc8;
const CUSTOM_PLAYLIST_KIND: u64 = 0x3d44d80;
const CUSTOM_PLAYLIST_NAME: u64 = 0x3c8f738;
const CUSTOM_PLAYLIST_ID: u64 = 0xd;
const CUSTOM_PLAYLIST_VALUE: usize = 0xc8;

/// A GUID in Windows layout: Data1 to Data3 little-endian, Data4 in order.
fn guid_text(bytes: &[u8]) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{}",
        get::<u32>(bytes, 0), get::<u16>(bytes, 4), get::<u16>(bytes, 6), bytes[8], bytes[9],
        bytes[10..16].iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    )
}

impl AssetRef {
    /// None for a short read or an empty AssetId.
    fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < ASSET_REF_SIZE || bytes[4..0x14].iter().all(|byte| *byte == 0) { return None; }
        Some(Self { kind: get(bytes, 0), asset_id: guid_text(&bytes[4..0x14]), version_id: guid_text(&bytes[0x14..0x24]), name: None })
    }
}

/// The selected map and game variant from the playlist parameter, after
/// checking the parameter's kind, id, name and owner session. Nothing while
/// there is no session or the parameter holds no valid value.
fn selected_variants(ds: &Ds) -> Result<(Option<AssetRef>, Option<AssetRef>), String> {
    let session = ds.u64(SESSION)?;
    if session < 0x10000 { return Ok((None, None)); }
    let parameters = ds.at::<u64>(session + SESSION_PARAMETERS)?;
    if parameters < 0x10000 { return Ok((None, None)); }
    let bytes = ds.read_abs(parameters + CUSTOM_PLAYLIST, CUSTOM_PLAYLIST_VALUE + 2 * ASSET_REF_SIZE)?;
    if get::<u64>(&bytes, 0) != ds.va(CUSTOM_PLAYLIST_KIND) || get::<u64>(&bytes, 8) != CUSTOM_PLAYLIST_ID
        || get::<u64>(&bytes, 0x10) != ds.va(CUSTOM_PLAYLIST_NAME) || get::<u64>(&bytes, 0x18) != session
    {
        return Err("unexpected playlist parameter".into());
    }
    if bytes[0xc0] & 1 == 0 { return Ok((None, None)); }
    let map = AssetRef::parse(&bytes[CUSTOM_PLAYLIST_VALUE..]).filter(|value| value.kind == 2);
    let game = AssetRef::parse(&bytes[CUSTOM_PLAYLIST_VALUE + ASSET_REF_SIZE..]).filter(|value| value.kind == 6);
    Ok((map, game))
}

fn map_info(path: &str) -> MapInfo {
    let segments: Vec<_> = path.split(['\\', '/']).collect();
    let level = filmshell::game::levels().iter().find(|level| {
        segments.iter().any(|segment| segment.eq_ignore_ascii_case(level.name))
            || path.eq_ignore_ascii_case(level.title())
    });
    MapInfo {
        engine_path: path.into(), level_id: level.map(|level| format!("{:08x}", level.id.get())),
        name: level.map(|level| level.name), title: level.map(|level| level.title()),
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub schema: &'static str,
    pub pid: u32,
    pub captured_unix_ms: u64,
    pub life_cycle: Option<i32>,
    pub in_match: bool,
    pub world: u8,
    /// Positions are in world units, feet (world_position).
    pub units: &'static str,
    pub consistency: &'static str,
    pub map: Option<MapInfo>,
    /// The selected map and game variant (read in every life-cycle state).
    pub map_variant: Option<AssetRef>,
    pub game_variant: Option<AssetRef>,
    /// The floor plan the viewer should load: a Forge map's asset id when its
    /// plan is known, else the level id (set by the server, not the reader).
    pub geometry_id: Option<String>,
    pub match_info: Option<MatchInfo>,
    pub team_scores: Vec<TeamScore>,
    pub players: Vec<Player>,
    pub objects: Vec<Object>,
    /// The game-mode markers the server keeps for players' HUDs (navpoints): flags and their
    /// capture points, carriers, zones and hills, item pads.
    pub navpoints: Vec<Navpoint>,
    /// The session's members and the bots the game variant asks for: there in the lobby,
    /// while loading and in the match.
    pub lobby: Option<Lobby>,
    pub warnings: Vec<String>,
    pub skipped_entries: usize,
    pub game_time_seconds: Option<f64>,
}

fn handle_text(handle: u32) -> String { format!("{handle:08x}") }
fn optional_handle(handle: u32) -> Option<String> { (handle != INVALID).then(|| handle_text(handle)) }
fn float(bytes: &[u8], offset: usize) -> f32 { f32::from_bits(get(bytes, offset)) }

fn player_name(entry: &[u8]) -> Option<String> {
    let offset = if get::<u16>(entry, 0x1200) == 0 { 0x1154 } else { 0x1200 };
    let units: Vec<u16> = entry.get(offset..offset + 0x20)?.chunks_exact(2).map(|unit| get(unit, 0)).collect();
    let end = units.iter().position(|unit| *unit == 0)?;
    let name = String::from_utf16(&units[..end]).ok()?;
    (!name.trim().is_empty() && !name.chars().any(char::is_control)).then_some(name)
}

fn image_ascii(ds: &Ds, pointer: u64, maximum: usize) -> Result<Option<String>, String> {
    let Some(offset) = pointer.checked_sub(ds.base).filter(|offset| *offset < u64::from(crate::IMAGESIZE)) else { return Ok(None); };
    let bytes = ds.read_abs(pointer, maximum.min(crate::IMAGESIZE as usize - offset as usize))?;
    let Some(end) = bytes.iter().position(|byte| *byte == 0) else { return Ok(None); };
    if end == 0 || !bytes[..end].iter().all(|byte| (0x20..=0x7e).contains(byte)) { return Ok(None); }
    Ok(Some(String::from_utf8_lossy(&bytes[..end]).into_owned()))
}

fn item_name(ds: &Ds, type_id: u16, identifier: u32) -> Result<Option<String>, String> {
    let expected = match type_id { 0x7b => "mp_weapon_identifier", 0x7d => "mp_equipment_identifier", _ => return Ok(None) };
    let descriptor = ds.read_abs(ds.va(0x45bcd78 + u64::from(type_id) * 0x58), 0x20)?;
    if image_ascii(ds, get(&descriptor, 0), 64)?.as_deref() != Some(expected) { return Err("unexpected item enum descriptor".into()); }
    let count = get::<u64>(&descriptor, 0x10);
    if count > 512 || u64::from(identifier) >= count { return Ok(None); }
    let names = get::<u64>(&descriptor, 0x18);
    if names.checked_sub(ds.base).is_none_or(|offset| offset + count * 8 > u64::from(crate::IMAGESIZE)) {
        return Err("item enum names are outside the verified image".into());
    }
    image_ascii(ds, ds.at::<u64>(names + u64::from(identifier) * 8)?, 96)
}

/// The English name of the item a pad's identifier stands for, from the game's placement tables
/// (libfilmshell's `mp_item`), named as the icon atlas names it: the item's name, else its tag's.
/// Weapon 13 is the BR75 Battle Rifle. Weapon 10, an `Unused` slot the game later gave an item, is
/// the Bandit Evo.
fn mp_item_name(kind: ObjectKind, identifier: u32) -> Option<&'static str> {
    let info = filmshell::game::mp_item(kind, identifier)?.tag.info()?;
    info.item.map(|item| item.name()).or(info.name)
}

fn script_field(ds: &Ds, table: u64, name: &str) -> Result<Option<(u8, u64)>, String> {
    if table < 0x10000 { return Err("script table is unavailable".into()); }
    let header = ds.read_abs(table, 0x28)?;
    let mask = get::<u32>(&header, 0x1c);
    let data = get::<u64>(&header, 0x20);
    if data == 0 { return Ok(None); }
    let count = mask.checked_add(1).filter(|count| count.is_power_of_two() && *count <= 65536)
        .ok_or("script table exceeds read budget")? as usize;
    let nodes = ds.read_abs(data, count * 0x20)?;
    let mut found = None;
    for (index, node) in nodes.chunks_exact(0x20).enumerate() {
        if node[0] & 15 != 4 || node[0x10] & 15 == 0 { continue; }
        let string = get::<u64>(node, 8);
        if string < 0x10000 { continue; }
        let length = ds.at::<u64>(string + 8)? & 0x3fffffffffffffff;
        if length != name.len() as u64 { continue; }
        if ds.read_abs(string + 0x14, name.len())? != name.as_bytes() { continue; }
        if ds.read_abs(data + index as u64 * 0x20, 0x20)? != node {
            return Err("script field changed during observation".into());
        }
        found = Some((node[0x10] & 15, get(node, 0x18)));
        break;
    }
    if ds.read_abs(table, 0x28)?[0x18..0x28] != header[0x18..0x28] {
        return Err("script table changed during observation".into());
    }
    Ok(found)
}

fn script_lookup(ds: &Ds, mut table: u64, name: &str) -> Result<Option<(u8, u64)>, String> {
    let mut visited = BTreeSet::new();
    for _ in 0..8 {
        if !visited.insert(table) { return Err("cyclic script table inheritance".into()); }
        if let Some(value) = script_field(ds, table, name)? { return Ok(Some(value)); }
        let metatable = ds.at::<u64>(table + 0x10)?;
        if metatable < 0x10000 || metatable & 1 != 0 { return Ok(None); }
        match script_field(ds, metatable, "__index")? {
            Some((5, parent)) => table = parent,
            _ => return Ok(None),
        }
    }
    Err("script table inheritance exceeds read budget".into())
}

fn script_values(ds: &Ds, table: u64, maximum: usize) -> Result<Vec<(u8, u64)>, String> {
    let header = ds.read_abs(table, 0x34)?;
    let array_count = get::<u32>(&header, 0x30) as usize;
    let array = get::<u64>(&header, 0x28);
    let nodes = get::<u64>(&header, 0x20);
    let node_count = if nodes == 0 { 0 } else {
        get::<u32>(&header, 0x1c).checked_add(1).filter(|count| count.is_power_of_two())
            .ok_or("invalid script hash capacity")? as usize
    };
    if array_count > maximum || node_count > maximum { return Err("script list exceeds read budget".into()); }
    let mut values = Vec::new();
    for (pointer, count, stride, offset) in [(array, array_count, 0x10, 0), (nodes, node_count, 0x20, 0x10)] {
        if count == 0 { continue; }
        for entry in ds.read_abs(pointer, count * stride)?.chunks_exact(stride) {
            let kind = entry[offset] & 15;
            if kind != 0 { values.push((kind, get(entry, offset + 8))); }
        }
    }
    if values.len() > maximum || ds.read_abs(table, 0x34)?[0x18..0x34] != header[0x18..0x34] {
        return Err("script list changed or exceeds read budget".into());
    }
    Ok(values)
}

fn script_time_point(ds: &Ds, value: u64) -> Result<Option<f64>, String> {
    let metatable = ds.at::<u64>(value + 0x18)?;
    if metatable == 0 || metatable & 1 != 0 { return Ok(None); }
    let Some((10, elapsed)) = script_field(ds, metatable, "ElapsedTime")? else { return Ok(None); };
    if ds.at::<u64>(elapsed + 0x10)? != ds.va(0x29d61cc) { return Ok(None); }
    let seconds = f64::from_bits(ds.at::<u64>(value + 0x20)?);
    if !seconds.is_finite() { return Err("non-finite game timestamp".into()); }
    Ok(Some(seconds))
}

fn script_handle(value: Option<(u8, u64)>, type_id: u16) -> Option<u32> {
    value.filter(|(kind, value)| *kind == 11 && *value >> 32 == u64::from(type_id) << 16)
        .map(|(_, value)| value as u32).filter(|handle| *handle != INVALID)
}

fn script_number(ds: &Ds, table: u64, name: &str) -> Result<Option<f32>, String> {
    let Some((3, value)) = script_lookup(ds, table, name)? else { return Ok(None); };
    let number = f32::from_bits(value as u32);
    if !number.is_finite() { return Err(format!("non-finite script field {name}")); }
    Ok(Some(number))
}

fn script_index(ds: &Ds, table: u64, index: u32) -> Result<Option<(u8, u64)>, String> {
    let header = ds.read_abs(table, 0x34)?;
    let array_count = get::<u32>(&header, 0x30);
    if array_count > 131072 { return Err("script registry exceeds read budget".into()); }
    let mut found = None;
    if index != 0 && index <= array_count {
        let value = ds.read_abs(get::<u64>(&header, 0x28) + u64::from(index - 1) * 0x10, 0x10)?;
        if value[0] & 15 != 0 { found = Some((value[0] & 15, get(&value, 8))); }
    } else {
        let data = get::<u64>(&header, 0x20);
        if data != 0 {
            let count = get::<u32>(&header, 0x1c).checked_add(1)
                .filter(|count| count.is_power_of_two() && *count <= 65536).ok_or("script registry hash exceeds read budget")?;
            for entry in ds.read_abs(data, count as usize * 0x20)?.chunks_exact(0x20) {
                if entry[0] & 15 == 3 && float(entry, 8) == index as f32 && entry[0x10] & 15 != 0 {
                    found = Some((entry[0x10] & 15, get(entry, 0x18)));
                    break;
                }
            }
        }
    }
    if ds.read_abs(table, 0x34)?[0x18..0x34] != header[0x18..0x34] {
        return Err("script registry changed during observation".into());
    }
    Ok(found)
}

fn incoming_frame(ds: &Ds, owner: u64, spawner: u64, thread: u32, function: u64, duration: f32) -> Result<Option<IncomingTiming>, String> {
    let pool = Pool::read(ds, ds.at(owner + 0x68)?, 0x58, 16384)?;
    let Some(entry) = pool.at((thread & 0xffff) as usize) else { return Ok(None); };
    if get::<u16>(entry, 0) != (thread >> 16) as u16 { return Ok(None); }
    let main_state = ds.at::<u64>(owner + 0x40)?;
    let shared = ds.at::<u64>(main_state + 0x10)?;
    let registry = ds.read_abs(shared + 0x1c8, 0x10)?;
    if registry[0] & 15 != 5 { return Err("unexpected gameplay registry type".into()); }
    for offset in [0xc, 0x10] {
        let reference = get::<u32>(entry, offset);
        if reference == INVALID { continue; }
        let Some((8, candidate)) = script_index(ds, get(&registry, 8), reference)? else { continue; };
        if ds.at::<u64>(candidate + 0x10).ok() != Some(shared) { continue; }
        let header = ds.read_abs(candidate, 0x90)?;
        let bottom = get::<u64>(&header, 0x60);
        let top = get::<u64>(&header, 0x48);
        let base = get::<u64>(&header, 0x50);
        let end = get::<u64>(&header, 0x58);
        if bottom < 0x10000 || bottom > base || base > top || top > end
            || top - bottom > 1024 * 1024 || !(top - bottom).is_multiple_of(16)
        {
            return Err("invalid incoming coroutine stack bounds".into());
        }
        let values = ds.read_abs(bottom, (top - bottom) as usize)?;
        for (index, value) in values.chunks_exact(16).enumerate() {
            if value[0] & 15 != 9 || get::<u64>(value, 8) != function { continue; }
            let after = &values[(index + 1) * 16..];
            let Some(timestamp) = incoming_frame_timestamp(after, spawner, duration) else { continue; };
            let Some(started_game_seconds) = script_time_point(ds, timestamp)? else { continue; };
            let current_entry = ds.read_abs(pool.data + u64::from(thread & 0xffff) * 0x58, 0x18)?;
            if ds.read_abs(candidate + 0x48, 0x20)? != header[0x48..0x68]
                || current_entry != entry[..0x18] || !pool.unchanged(ds)?
                || ds.read_abs(bottom + (index + 1) as u64 * 16, 0x40)? != after[..0x40]
            {
                return Err("incoming coroutine changed during observation".into());
            }
            return Ok(Some(IncomingTiming { started_game_seconds, duration_seconds: duration }));
        }
    }
    Ok(None)
}

fn incoming_frame_timestamp(values: &[u8], spawner: u64, duration: f32) -> Option<u64> {
    if values.len() < 0x40 || values[0] & 15 != 5 || get::<u64>(values, 8) != spawner
        || values[0x10] & 15 != 7 || values[0x30] & 15 != 3
        || !duration.is_finite() || !(0.0..=36000.0).contains(&duration)
        || (float(values, 0x38) - duration).abs() > 0.01 || !float(values, 0x38).is_finite()
    {
        return None;
    }
    Some(get(values, 0x18))
}

fn script_owner(ds: &Ds) -> Result<(u64, u64), String> {
    let manager = ds.u64(0x4eb5af8)?;
    if manager < 0x10000 { return Err("gameplay context map is unavailable".into()); }
    let head = ds.at::<u64>(manager + 0x10)?;
    let count = ds.at::<u64>(manager + 0x18)?;
    if head < 0x10000 || count > 128 { return Err("invalid gameplay context map".into()); }
    let mut node = ds.at::<u64>(head)?;
    let mut owner = None;
    let mut visited = BTreeSet::new();
    for _ in 0..count {
        if node == head || !visited.insert(node) { return Err("gameplay context map changed".into()); }
        let entry = ds.read_abs(node, 0x38)?;
        if get::<u64>(&entry, 0x20) == 6 && get::<u64>(&entry, 0x28) == 15 && &entry[0x10..0x16] == b"global" {
            let context = get::<u64>(&entry, 0x30);
            let server_context = ds.at::<u64>(context + 0x20)?;
            if server_context != 0 { owner = Some(server_context); }
        }
        node = get(&entry, 0);
    }
    if node != head || ds.at::<u64>(manager + 0x10)? != head || ds.at::<u64>(manager + 0x18)? != count {
        return Err("gameplay context map changed during observation".into());
    }
    let owner = owner.ok_or("global gameplay context is unavailable")?;
    if ds.at::<u64>(owner)? != ds.va(0x3691590) { return Err("unexpected gameplay context type".into()); }
    let state = ds.at::<u64>(owner + 0x40)?;
    let globals = ds.read_abs(state + 0x70, 0x10)?;
    if globals[0] & 15 != 5 { return Err("unexpected script globals type".into()); }
    Ok((owner, get(&globals, 8)))
}

fn spawner_threads(ds: &Ds, spawner: u64) -> Result<BTreeSet<u32>, String> {
    let mut threads = BTreeSet::new();
    if let Some(thread) = script_handle(script_lookup(ds, spawner, "resetThread")?, 0xe) { threads.insert(thread); }
    if let Some((5, table)) = script_lookup(ds, spawner, "threads")? {
        for value in script_values(ds, table, 128)? {
            if let Some(thread) = script_handle(Some(value), 0xe) { threads.insert(thread); }
        }
        let header = ds.read_abs(table, 0x28)?;
        let data = get::<u64>(&header, 0x20);
        if data != 0 {
            let count = get::<u32>(&header, 0x1c).checked_add(1)
                .filter(|count| count.is_power_of_two() && *count <= 128).ok_or("pad threads exceed read budget")?;
            for node in ds.read_abs(data, count as usize * 0x20)?.chunks_exact(0x20) {
                if node[0x10] & 15 == 0 { continue; }
                if let Some(thread) = script_handle(Some((node[0] & 15, get(node, 8))), 0xe) { threads.insert(thread); }
            }
        }
        if ds.read_abs(table, 0x28)?[0x18..0x28] != header[0x18..0x28] {
            return Err("pad thread table changed during observation".into());
        }
    }
    Ok(threads)
}

/// The stock spawners (pads) and how many failed to read this time.
fn stock_spawners(ds: &Ds) -> Result<(Vec<(u32, StockSpawner)>, usize), String> {
    let (owner, table) = script_owner(ds)?;
    let mut spawners = Vec::new();
    let mut seen = BTreeSet::new();
    let Some((5, deployment)) = script_lookup(ds, table, "DeploymentState")? else { return Ok((spawners, 0)); };
    let mut states = BTreeMap::new();
    for (name, label) in [("Dormant", "dormant"), ("Incoming", "incoming"), ("Spawning", "spawning"), ("Spawned", "ready"), ("Restricted", "restricted")] {
        if let Some(value) = script_number(ds, deployment, name)? { states.insert(value as u32, label); }
    }
    let incoming = match script_lookup(ds, table, "MPItemPlacement")? {
        Some((5, class)) => script_lookup(ds, class, "StartIncomingStateBase")?.filter(|(kind, _)| *kind == 9).map(|(_, function)| function),
        _ => None,
    };
    // One spawner's script state, or Ok(None) when it is not a live pad.
    let read = |spawner: u64, category: &'static str, item_type: u16, item_kind: ObjectKind| -> Result<Option<(u32, StockSpawner)>, String> {
        let Some(handle) = script_handle(script_lookup(ds, spawner, "containerObject")?, 0x126) else { return Ok(None); };
        let Some(item_identifier) = script_handle(script_lookup(ds, spawner, "itemIdentifier")?, item_type) else { return Ok(None); };
        let item_text_id = match script_lookup(ds, spawner, "itemStringId")? {
            Some((11, value)) => Some(value as u32),
            Some((4, value)) => {
                let length = ds.at::<u64>(value + 8)? & 0x3fffffffffffffff;
                if length > 256 { return Err("item localization key exceeds read budget".into()); }
                let bytes = ds.read_abs(value + 0x14, length as usize)?;
                std::str::from_utf8(&bytes).ok().map(|key| filmshell::game::murmur3(key.as_bytes()))
            }
            _ => None,
        };
        let native_name = item_name(ds, item_type, item_identifier)?;
        let display_name = item_text_id.and_then(|identifier| filmshell::game::text(filmshell::StringId(identifier)))
            .or_else(|| mp_item_name(item_kind, item_identifier)).map(str::to_owned);
        let Some((5, config)) = script_lookup(ds, spawner, "CONFIG")? else { return Ok(None); };
        let Some(respawn_seconds) = script_number(ds, config, "respawnTime")?.filter(|seconds| (0.0..=36000.0).contains(seconds)) else { return Ok(None); };
        let Some(state_id) = script_number(ds, spawner, "deploymentState")? else { return Ok(None); };
        if state_id.fract() != 0.0 || !(0.0..=16.0).contains(&state_id) { return Ok(None); }
        let state = states.get(&(state_id as u32)).copied().unwrap_or("unknown");
        let logic = script_handle(script_lookup(ds, config, "spawnLogic")?, 0x76);
        let spawn_logic = match logic { Some(0) => "kit", Some(1) => "on_pickup", Some(2) => "on_expire", Some(3) => "fixed_interval", Some(4) => "external_trigger", _ => "unknown" };
        let mut items = BTreeSet::new();
        if let Some(item) = script_handle(script_lookup(ds, spawner, "spawnedItemObject")?, 0x126) { items.insert(handle_text(item)); }
        if let Some((5, list)) = script_lookup(ds, spawner, "spawnedItemList")? {
            for value in script_values(ds, list, 32)? {
                if let Some(item) = script_handle(Some(value), 0x126) { items.insert(handle_text(item)); }
            }
        }
        let mut timing = None;
        if state == "incoming" {
            if let (Some(function), Some(duration)) = (incoming, script_number(ds, spawner, "incomingDuration")?) {
                let mut ambiguous = false;
                for thread in spawner_threads(ds, spawner)? {
                    if let Ok(Some(frame)) = incoming_frame(ds, owner, spawner, thread, function, duration) {
                        if timing.is_some_and(|previous| previous != frame) { ambiguous = true; break; }
                        timing = Some(frame);
                    }
                }
                if ambiguous { timing = None; }
            }
        }
        if script_handle(script_lookup(ds, spawner, "containerObject")?, 0x126) != Some(handle)
            || script_number(ds, spawner, "deploymentState")? != Some(state_id)
        {
            return Ok(None);
        }
        Ok(Some((handle, StockSpawner {
            category, item_identifier, item_name: native_name, item_text_id, display_name,
            state, spawn_logic, respawn_seconds, items: items.into_iter().collect(),
            seconds_left: None, incoming: timing,
        })))
    };
    let mut skipped = 0;
    for (name, category, item_type, item_kind) in [
        ("MPWeaponManagerInstance", "weapon", 0x7b, ObjectKind::Weapon),
        ("MPEquipmentManagerInstance", "equipment", 0x7d, ObjectKind::Equipment),
    ] {
        let Some((5, manager)) = script_lookup(ds, table, name)? else { continue; };
        let Some((5, classes)) = script_lookup(ds, manager, "perClassPlacements")? else { continue; };
        for (kind, class) in script_values(ds, classes, 64)? {
            if kind != 5 { continue; }
            for (kind, spawner) in script_values(ds, class, 512)? {
                if kind != 5 || !seen.insert(spawner) { continue; }
                if seen.len() > 512 { return Err("stock spawner count exceeds read budget".into()); }
                // One pad caught mid-update costs only that pad, not every pad in the snapshot.
                match read(spawner, category, item_type, item_kind) {
                    Ok(Some(found)) => spawners.push(found),
                    Ok(None) => {}
                    Err(_) => skipped += 1,
                }
            }
        }
    }
    if script_owner(ds)? != (owner, table) { return Err("gameplay VM changed during observation".into()); }
    Ok((spawners, skipped))
}

pub fn world_position(raw: [f32; 3]) -> Option<Position> {
    if raw.iter().any(|value| !value.is_finite() || value.abs() > 1_000_000.0) { return None; }
    let mut position = Position::new(-10.0 * f64::from(raw[1]), 10.0 * f64::from(raw[0]));
    position.z = Some(10.0 * f64::from(raw[2]));
    Some(position)
}

/// A direction in engine axes as a map yaw: radians from the map's +x toward +y (world_position's
/// axes), as Films draws aim. None when it is not a unit vector or points straight up or down.
pub fn world_yaw(raw: [f32; 3]) -> Option<f64> {
    let [x, y, z] = raw.map(f64::from);
    let length = (x * x + y * y + z * z).sqrt();
    if !length.is_finite() || !(0.95..=1.05).contains(&length) || x.hypot(y) < 0.01 { return None; }
    Some(x.atan2(-y))
}

fn kind_name(kind: u8) -> &'static str {
    match kind {
        0 => "biped", 1 => "vehicle", 2 => "weapon", 3 => "equipment", 4 => "terminal",
        5 => "projectile", 6 => "scenery", 7 => "machine", 8 => "control", 9 => "dispenser",
        _ => "other",
    }
}

fn managed_timers(bytes: &[u8]) -> Result<BTreeMap<usize, EngineTimer>, String> {
    if bytes.len() < 0x628 { return Err("incomplete managed timer store".into()); }
    let mask = get::<u64>(bytes, 0x20);
    let mut timers = BTreeMap::new();
    for index in 0..64 {
        if mask & (1u64 << index) == 0 { continue; }
        let offset = 0x28 + index * 0x18;
        if bytes[offset + 0x14] != 2 { continue; }
        let seconds_left = float(bytes, offset + 4);
        let start_seconds = float(bytes, offset + 8);
        let timer_rate_index = bytes[offset + 0xf];
        if !seconds_left.is_finite() || !start_seconds.is_finite()
            || !(0.0..=36000.0).contains(&seconds_left) || !(0.0..=36000.0).contains(&start_seconds)
            || timer_rate_index > 31
        {
            return Err("invalid managed timer payload".into());
        }
        timers.insert(index, EngineTimer { seconds_left, start_seconds, timer_rate_index });
    }
    Ok(timers)
}

fn dispenser(bytes: &[u8]) -> Result<Dispenser, String> {
    if bytes.len() < 0x5b || bytes[0x5a] > 1 { return Err("invalid dispenser layout".into()); }
    let mut slots = Vec::new();
    for index in 0..2 {
        let offset = 0x10 + index * 0x24;
        let state = match bytes[offset + 8] {
            0 => "none", 1 => "incoming", 2 => "constructing", 3 => "ready", 4 => "respawning",
            _ => return Err("invalid dispenser state".into()),
        };
        let seconds_left = float(bytes, offset + 0x10);
        let start_seconds = float(bytes, offset + 0x14);
        if !seconds_left.is_finite() || !start_seconds.is_finite()
            || !(0.0..=36000.0).contains(&seconds_left) || !(0.0..=36000.0).contains(&start_seconds)
        {
            return Err("invalid dispenser timer".into());
        }
        slots.push(PadSlot {
            index, state, item: optional_handle(get(bytes, offset)), seconds_left, start_seconds,
            timer_rate_index: bytes[offset + 0x1b],
        });
    }
    Ok(Dispenser { enabled: bytes[0x5a] != 0, slots })
}

fn object(ds: &Ds, pool: &Pool, index: usize, entry: &[u8]) -> Result<Option<(u32, Object)>, String> {
    let Some(handle) = pool.handle(index) else { return Ok(None); };
    let pointer = get::<u64>(entry, 0x10);
    if pointer < 0x10000 { return Ok(None); }
    // A biped reads on to its aiming vector: it tilts with the view and turns with the player
    // before the body does.
    let biped = entry[6] == 0;
    let bytes = ds.read_abs(pointer, if biped { 0x354 } else { 0x22c })?;
    if ds.at::<u32>(pointer - 0xc)? != handle { return Ok(None); }
    let current = ds.read_abs(pool.data + index as u64 * 0x18, 0x18)?;
    if get::<u16>(&current, 0) != (handle >> 16) as u16 || current[6] != entry[6]
        || get::<u64>(&current, 0x10) != pointer
    {
        return Ok(None);
    }
    let raw = [float(&bytes, 0x210), float(&bytes, 0x214), float(&bytes, 0x218)];
    let parent = get::<u32>(&bytes, 0x18);
    // An attached object's position is relative to its parent: place_on_parents fills it in.
    let position = (parent == INVALID).then(|| world_position(raw)).flatten();
    let facing = biped.then(|| world_yaw([float(&bytes, 0x348), float(&bytes, 0x34c), float(&bytes, 0x350)])).flatten();
    Ok(Some((handle, Object {
        handle: handle_text(handle), kind: kind_name(entry[6]), definition_handle: get(&bytes, 0x2c), tag: None,
        parent: optional_handle(parent), position, facing, dispenser: None, stock_spawner: None,
    })))
}

/// The game's table of loaded tags: a runtime tag handle names its entry, which holds the
/// handle, the tag's global id, its group and whether it is unloading. A map load frees its tags
/// and reuses the entries, so a handle is only checked against the entry it names.
const TAG_INSTANCES: u64 = 0x494a908;

/// The live world's Forge volumes (navmesh::forge_volume): up to 64 entries, the count after them.
const FORGE_VOLUMES: u64 = 0x1cb08;
const FORGE_VOLUME: usize = 100;
const FORGE_VOLUME_SLOTS: usize = 64;

/// The tags behind runtime definition handles, one read each (plus one per new group).
fn tag_refs(ds: &Ds, handles: &BTreeSet<u32>) -> Result<BTreeMap<u32, TagRef>, String> {
    let manager = ds.u64(TAG_INSTANCES)?;
    if manager < 0x10000 { return Err("tag instances unavailable".into()); }
    let header = ds.read_abs(manager, 0x80)?;
    if &header[..13] != b"tag instances" || get::<u64>(&header, 0x40) != 0x34 {
        return Err("tag instances layout changed".into());
    }
    let count = u32::try_from(get::<i32>(&header, 0x6c)).unwrap_or(0);
    let table = get::<u64>(&header, 0x78);
    let mut groups: BTreeMap<u64, String> = BTreeMap::new();
    let mut found = BTreeMap::new();
    for &handle in handles {
        let index = handle >> 13;
        if handle as u16 == 0 || index >= count { continue; }
        let entry = ds.read_abs(table + u64::from(index) * 0x34, 0x34)?;
        let definition = get::<u64>(&entry, 8);
        if get::<u32>(&entry, 0) != handle || definition < 0x10000 || get::<u16>(&entry, 0x2a) & 0x4000 != 0 { continue; }
        let group = match groups.get(&definition) {
            Some(group) => group.clone(),
            None => {
                let code = ds.at::<u32>(definition + 0xc)?.to_be_bytes();
                let group = if code.iter().all(|byte| byte.is_ascii_graphic() || *byte == b' ') {
                    String::from_utf8_lossy(&code).trim_end().to_owned()
                } else { format!("{:08x}", u32::from_be_bytes(code)) };
                groups.insert(definition, group.clone());
                group
            }
        };
        let id = get::<u32>(&entry, 4);
        let name = filmshell::game::tag_info(filmshell::TagId(id)).and_then(|info| info.name);
        let carried = filmshell::Carried::from_item(filmshell::TagId(id));
        found.insert(handle, TagRef { id: format!("{id:08x}"), group, name, carried });
    }
    Ok(found)
}

/// An object attached to another (a held weapon or flag, a flag on its stand, a player in a vehicle)
/// has only a position relative to its parent. It is put at its parent's place, which is what a map
/// needs. Chains (a weapon held by a player in a vehicle) resolve a few links deep.
fn place_on_parents(found: &mut BTreeMap<u32, Object>) {
    for _ in 0..4 {
        let placed: Vec<(u32, Position)> = found.iter()
            .filter(|(_, object)| object.position.is_none())
            .filter_map(|(handle, object)| {
                let parent = object.parent.as_deref().and_then(|text| u32::from_str_radix(text, 16).ok())?;
                Some((*handle, found.get(&parent)?.position?))
            })
            .collect();
        if placed.is_empty() { return; }
        for (handle, position) in placed {
            if let Some(object) = found.get_mut(&handle) { object.position = Some(position); }
        }
    }
}

// ── Lobby ──────────────────────────────────────────────────────────────────

/// The session's membership, which points back at the session: the player count, which slots
/// are valid, then 32 players.
const MEMBERSHIP: u64 = 0x60;
const MEMBER_PLAYERS: u64 = 0x18b0;
const MEMBER_STRIDE: u64 = 0x1470;
/// The session's state: members are valid from 4 to 7.
const SESSION_STATE: u64 = 0x5a078;
/// The LAN host's XUID, one of the session parameters.
const LAN_HOST: u64 = 0xb4ba60;
/// The custom game options a LAN host set per game variant: for each variant's asset id, its
/// options by lower-case path.
const VARIANT_OPTIONS: u64 = 0x4e39908;

#[derive(Clone, Debug, Serialize)]
pub struct Lobby {
    pub members: Vec<LobbyMember>,
    /// Bots per team (Eagle first) and in free-for-all, as the host set them for the selected
    /// game variant, or None when the host kept the variant's own (not read).
    pub bots: Option<LobbyBots>,
}

#[derive(Clone, Debug, Serialize)]
pub struct LobbyMember {
    /// The member's slot (0..31), stable while they stay.
    pub slot: usize,
    pub xuid: String,
    pub name: Option<String>,
    /// The team the host assigned (in free-for-all the game puts a player index here instead).
    pub team: Option<TeamId>,
    pub team_name: Option<&'static str>,
    pub observer: bool,
    pub host: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct LobbyBots {
    pub per_team: [i32; 8],
    pub ffa: i32,
}

/// UTF-16 text of up to `units` code units at `offset`, to the first NUL.
fn utf16(bytes: &[u8], offset: usize, units: usize) -> Option<String> {
    let codes: Vec<u16> = (0..units).map(|unit| get::<u16>(bytes, offset + unit * 2)).take_while(|code| *code != 0).collect();
    (!codes.is_empty()).then(|| String::from_utf16(&codes).ok()).flatten()
}

fn lobby(ds: &Ds) -> Result<Option<Lobby>, String> {
    if ds.u8(0x4dc3180)? == 0 { return Ok(None); }
    let session = ds.u64(SESSION)?;
    if session < 0x10000 || !(4..=7).contains(&ds.at::<u32>(session + SESSION_STATE)?) { return Ok(None); }
    let header = ds.read_abs(session + MEMBERSHIP, (MEMBER_PLAYERS - MEMBERSHIP) as usize)?;
    if get::<u64>(&header, 0) != session { return Err("the membership does not point back at its session".into()); }
    let mask = get::<u32>(&header, (0x18ac - MEMBERSHIP) as usize);
    let parameters = ds.at::<u64>(session + SESSION_PARAMETERS)?;
    let host = if parameters >= 0x10000 {
        let value = ds.read_abs(parameters + LAN_HOST + 0xc0, 0x10)?;
        (value[0] & 1 != 0).then(|| get::<u64>(&value, 8))
    } else { None };
    let mut members = Vec::new();
    for slot in (0..32usize).filter(|slot| mask >> slot & 1 != 0) {
        let entry = ds.read_abs(session + MEMBER_PLAYERS + slot as u64 * MEMBER_STRIDE, MEMBER_STRIDE as usize)?;
        let xuid = get::<u64>(&entry, 8);
        let assigned = entry[0x1445] as i8;
        let team = (0..8).contains(&assigned).then_some(TeamId(assigned as u8));
        members.push(LobbyMember {
            slot, xuid: format!("{xuid:016x}"),
            // The name after the host made it unique, else the one the client sent.
            name: utf16(&entry, 0x1420, 16).or_else(|| utf16(&entry, 0xc34, 16)),
            team, team_name: team.and_then(TeamId::name), observer: assigned == 31,
            host: host == Some(xuid),
        });
    }
    let bots = if parameters >= 0x10000 { variant_bots(ds, parameters)? } else { None };
    Ok(Some(Lobby { members, bots }))
}

/// The nodes of an ordered map in key order, from its head node, at most `limit`.
fn tree(ds: &Ds, head: u64, limit: usize) -> Result<Vec<Vec<u8>>, String> {
    let mut out = Vec::new();
    let mut stack = Vec::new();
    let mut node = ds.at::<u64>(head + 8)?;
    loop {
        while node >= 0x10000 && node != head && stack.len() < 48 {
            let bytes = ds.read_abs(node, 0x48)?;
            if bytes[0x19] != 0 { break; }
            node = get::<u64>(&bytes, 0);
            stack.push(bytes);
        }
        let Some(bytes) = stack.pop() else { return Ok(out); };
        node = get::<u64>(&bytes, 0x10);
        out.push(bytes);
        if out.len() >= limit { return Ok(out); }
    }
}

/// A string at `offset` of a node, held in the node itself when it is short.
fn std_string(ds: &Ds, node: &[u8], offset: usize) -> Result<Option<String>, String> {
    let (size, capacity) = (get::<u64>(node, offset + 0x10) as usize, get::<u64>(node, offset + 0x18));
    if size > 256 { return Ok(None); }
    let bytes = if capacity < 16 { node[offset..offset + size.min(16)].to_vec() } else { ds.read_abs(get::<u64>(node, offset), size)? };
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// The bots the host set for the selected game variant, from its custom options.
fn variant_bots(ds: &Ds, parameters: u64) -> Result<Option<LobbyBots>, String> {
    let selected = ds.read_abs(parameters + CUSTOM_PLAYLIST + 0xc0, 0x40)?;
    if selected[0] & 1 == 0 || get::<u32>(&selected, 0x2c) != 6 { return Ok(None); }
    let variant = &selected[0x30..0x40];
    let head = ds.u64(VARIANT_OPTIONS)?;
    if head < 0x10000 { return Ok(None); }
    let Some(node) = tree(ds, head, 64)?.into_iter().find(|node| &node[0x20..0x30] == variant) else { return Ok(None); };
    let (options, count) = (get::<u64>(&node, 0x30), get::<u64>(&node, 0x38));
    if options < 0x10000 || count == 0 || count > 512 { return Ok(None); }
    let mut bots = LobbyBots { per_team: [0; 8], ffa: 0 };
    for option in tree(ds, options, 512)? {
        let Some(path) = std_string(ds, &option, 0x20)? else { continue; };
        let value = get::<i32>(&option, 0x40);
        if let Some(team) = path.strip_prefix("miscellaneousoptions.numbotsteam").and_then(|n| n.parse::<usize>().ok()) {
            if (1..=8).contains(&team) { bots.per_team[team - 1] = value; }
        } else if path == "miscellaneousoptions.numbotsffa" {
            bots.ffa = value;
        }
    }
    Ok(Some(bots))
}

// ── Navpoints ──────────────────────────────────────────────────────────────

/// What a navpoint marks, its visual state groups and their states: lower-case murmur3 string
/// ids, named here (the subtypes, groups and states the multiplayer modes use).
const NAVPOINT_NAMES: &[&str] = &[
    "mp_deliver_object", "mp_delivery_destination", "mp_object_carrier", "mp_control_area", "mp_ball", "mp_sportsball",
    "mp_forge_objective", "mp_objective", "mp_object_boundary", "item_pad", "ownership_state", "has_progress", "has_text",
    "control_point", "object_type", "objective_type", "objective_affiliation", "type_group", "tier_group", "priority",
    "available", "hint_text", "name", "player_spotted", "friendly", "enemy", "neutral", "contested", "incoming", "flag",
    "bomb", "ball", "skull", "deliver", "intercept", "defend", "attack", "capture", "weapon", "equipment", "power",
    "overshield", "general", "normal", "high", "low", "yes", "no", "on", "off", "none", "timer", "pickup",
    "returning", "secure", "capturing", "flag_away",
    "a", "b", "c", "d", "e", "f", "g", "h",
];

fn navpoint_name(id: u32) -> Option<String> {
    if id == 0 || id == INVALID { return None; }
    Some(NAVPOINT_NAMES.iter().find(|name| filmshell::game::murmur3(name.as_bytes()) == id)
        .map_or_else(|| format!("{id:08x}"), |name| (*name).to_owned()))
}

#[derive(Clone, Debug, Serialize)]
pub struct Navpoint {
    pub handle: String,
    /// What it marks, its subtype: mp_deliver_object (a flag, ball or bomb: `states.object_type`
    /// says which), mp_delivery_destination (a capture point), mp_object_carrier, mp_control_area
    /// (a zone or hill), item_pad, ..., or else the string id as hex.
    pub kind: Option<String>,
    pub enabled: bool,
    /// The object it is attached to, and the object whose navpoint it is (a zone's own).
    pub object: Option<String>,
    pub owner_object: Option<String>,
    pub position: Option<Position>,
    /// The owner: the team its first visual state group is filtered to.
    pub team: Option<u8>,
    /// Each visual state group's state: ownership_state, has_progress (contested), has_text
    /// (incoming), control_point (the zone's letter), object_type, ...
    pub states: BTreeMap<String, String>,
    /// The team its progress belongs to (has_progress's team), and the radial progress, -1..1.
    pub capturing_team: Option<u8>,
    pub progress: f32,
    /// The players (slots) its docking filter names: inside a zone, at a flag.
    pub inside: Vec<usize>,
    /// Its first timer, seconds left.
    pub timer_seconds: Option<f32>,
    /// A zone's (mp_control_area's) owner, capture, contest, countdown and letter, read from its
    /// state groups as libfilmshell reads a film's (navpoint::ZoneMarks).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone: Option<ZoneMarks>,
}

/// A navpoint filter set's clauses at `offset`: up to four, each negated or not, with a value and
/// its kind (2 a player mask with bit p for slot p, 3 a team as a signed byte with -1 for none).
/// As libfilmshell's navpoint module takes them: a team as its id plus one, as films carry it.
fn clauses(bytes: &[u8], offset: usize) -> Vec<Clause> {
    let used = get::<u32>(bytes, offset + 0xc);
    (0..4).filter(|clause| used >> clause & 1 != 0).map(|clause| {
        let at = offset + 0x10 + clause * 0x40;
        let kind = u32::from(bytes[at + 0x38]);
        let value = if kind == 3 { (i32::from(bytes[at + 0x10] as i8) + 1).max(0) as u32 } else { get::<u32>(bytes, at + 0x10) };
        Clause { kind, negated: bytes[at + 8] & 1 != 0, value }
    }).collect()
}

impl Observer {
    /// The live world's navpoint, managed object and networked property pools, agreed on by every
    /// live-world thread.
    fn marker_pools(&self, pools: Pools, blocks: &[u64]) -> Result<(u64, u64, u64), String> {
        let mut found = BTreeSet::new();
        for &block in blocks {
            if self.server.at::<u8>(block + 0xc8).unwrap_or(0) == 0
                || self.server.at::<u64>(block + 0x4acc0).unwrap_or(0) != pools.objects
            {
                continue;
            }
            let navpoints = self.server.at::<u64>(block + 0x2c0)?;
            if navpoints >= 0x10000 && self.server.at::<u64>(navpoints + 0x40)? == 0x1288 {
                found.insert((navpoints, self.server.at::<u64>(block + 0x3c0)?, self.server.at::<u64>(block + 0x398)?));
            }
        }
        match found.len() {
            1 => Ok(*found.first().unwrap()),
            0 => Err("no live-world navpoint pool".into()),
            _ => Err("ambiguous live-world navpoint pools".into()),
        }
    }

    /// The navpoints, and what each player (by slot) carries, from the marker_pools.
    fn markers(&self, (navpoint_pool, managed_pool, property_pool): (u64, u64, u64), objects: &BTreeMap<u32, Object>,
        timers: &BTreeMap<usize, EngineTimer>) -> Result<(Vec<Navpoint>, Vec<Option<&'static str>>), String>
    {
        // The object whose navpoint each one is: managed objects hold an owner object and up to
        // 16 navpoint handles.
        let managed = Pool::read(&self.server, managed_pool, 0x1b8, 512)?;
        let mut owners = BTreeMap::new();
        for entry in managed.entries.chunks_exact(0x1b8) {
            if get::<u16>(entry, 0) == 0 { continue; }
            let used = get::<u32>(entry, 0xc);
            for slot in (0..16).filter(|slot| used >> slot & 1 != 0) {
                owners.insert(get::<u32>(entry, 0x10 + slot * 4), get::<u32>(entry, 4));
            }
        }
        let pool = Pool::read(&self.server, navpoint_pool, 0x1288, 128)?;
        let mut navpoints = Vec::new();
        for (index, entry) in pool.entries.chunks_exact(0x1288).enumerate() {
            let salt = get::<u16>(entry, 0);
            if salt == 0 { continue; }
            let handle = u32::from(salt) << 16 | index as u32;
            let flags = get::<u32>(entry, 0xa0);
            let references = get::<i32>(entry, 0x10).clamp(0, 16) as usize;
            let object = (references > 0).then(|| get::<u32>(entry, 0x18));
            let position = if flags & 2 != 0 {
                world_position([float(entry, 0x7e4), float(entry, 0x7e8), float(entry, 0x7ec)])
            } else {
                object.and_then(|handle| objects.get(&handle)).and_then(|object| object.position)
            };
            // Its visual state groups, each a filter, a state and the group's name. They are read
            // in order into libfilmshell's ZoneMarks, as a film's are.
            let mut states = BTreeMap::new();
            let mut marks = ZoneMarks::default();
            let active = get::<u32>(entry, 0x828);
            for (index, slot) in (0..8).filter(|slot| active >> slot & 1 != 0).enumerate() {
                let at = 0x830 + slot * 0x140;
                let (name, state) = (get::<u32>(entry, at + 0x138), get::<u32>(entry, at + 0x11c));
                marks.read(index == 0, &StateGroup { name, state, clauses: &clauses(entry, at) });
                if let (Some(name), Some(state)) = (navpoint_name(name), navpoint_name(state)) { states.insert(name, state); }
            }
            // Its docking filter: who is inside a zone, at a flag.
            let docked = navpoint::players(&clauses(entry, 0x6d0));
            let kind = navpoint_name(get::<u32>(entry, 8));
            let timer = get::<u32>(entry, 0x98);
            navpoints.push(Navpoint {
                handle: handle_text(handle), enabled: flags & 1 == 0,
                object: object.map(handle_text), owner_object: owners.get(&handle).copied().map(handle_text),
                position, team: marks.owner, states, capturing_team: marks.capturing, progress: float(entry, 0x7f4),
                inside: (0..32).filter(|slot| docked >> slot & 1 != 0).collect(),
                timer_seconds: (timer != INVALID).then(|| timers.get(&(timer as usize)).map(|timer| timer.seconds_left)).flatten(),
                zone: (kind.as_deref() == Some("mp_control_area")).then_some(marks),
                kind,
            });
        }
        // What each player carries: the networked property for the carried objective, found by
        // its key, holds a value per player slot.
        let key = self.server.u32(0x48745d0)?;
        let properties = Pool::read(&self.server, property_pool, 0xd8, 64)?;
        let mut carried = vec![None; 32];
        if let Some(entry) = properties.entries.chunks_exact(0xd8)
            .find(|entry| get::<u16>(entry, 0) != 0 && get::<u32>(entry, 8) == key && entry[0x8c] == 8)
        {
            for (slot, carrying) in carried.iter_mut().enumerate() {
                *carrying = match get::<u32>(entry, 0xc + slot * 4) { 1 => Some("flag"), 2 => Some("bomb"), 3 => Some("ball"), _ => None };
            }
        }
        Ok((navpoints, carried))
    }
}

fn stat_rows(ds: &Ds) -> Result<BTreeMap<u32, u32>, String> {
    let head = ds.u64(0x5122348)?;
    let count = ds.u64(0x5122350)?;
    if head < 0x10000 || count > 256 { return Err("invalid stat row registry".into()); }
    let mut node = ds.at::<u64>(head)?;
    let mut rows = BTreeMap::new();
    let mut visited = BTreeSet::new();
    for _ in 0..count {
        if node == head || !visited.insert(node) { return Err("player stat index changed".into()); }
        let entry = ds.read_abs(node, 0x18)?;
        let index = get::<u32>(&entry, 0x14);
        if index < 128 { rows.insert(get::<u32>(&entry, 0x10), index); }
        node = get(&entry, 0);
    }
    if node != head || ds.u64(0x5122348)? != head || ds.u64(0x5122350)? != count {
        return Err("player stat index changed during observation".into());
    }
    Ok(rows)
}

/// The stats a snapshot reads, by key: kills 4, deaths 5, assists 6, objective score 0, then the
/// counters shots fired 13 and shots hit 14.
const STAT_KEYS: [u64; 6] = [4, 5, 6, 0, 13, 14];
const STAT_COUNTERS: usize = 4;
/// Whether the server counts shots, a setting on by default: it counts them only while it is set.
const HIGH_FREQUENCY_STATS: u64 = 0x51222c8;

/// A stat's definition among the mode's (its name, its value type, the rows it is kept for, 1
/// teams and 2 players, and its decimal places): its index and decimal places. A counter has to be
/// the whole number type 0 with no decimal places, as the server's own counting requires, or it
/// is not the counter the key names.
fn stat_definition(entries: &[u8], name: u32, required_flag: u8, counter: bool) -> Option<(usize, u8)> {
    if name == 0 { return None; }
    let (index, definition) = entries.chunks_exact(0xc0).enumerate().find(|(_, entry)| get::<u32>(entry, 0) == name)?;
    if definition[0x1c] & required_flag == 0 || definition[0xbc] > 31 { return None; }
    if counter && (get::<u32>(definition, 4) != 0 || definition[0xbc] != 0) { return None; }
    Some((index, definition[0xbc]))
}

fn stats_for_row(ds: &Ds, row: u32, required_flag: u8, round: Option<u16>) -> Result<Option<PlayerStats>, String> {
    if row >= 128 || round.is_some_and(|round| round >= 32) { return Ok(None); }
    let game_array = ds.u64(0x5121d28)?;
    let game_index = ds.u32(0x45c5838)? & 0xffff;
    let stats = ds.u64(0x4ebd098)?;
    if game_array == 0 || game_index >= 3 || stats == 0 { return Ok(None); }
    let definitions = game_array + u64::from(game_index) * GAME_ENTRY + 0x28 + 0xdf77c;
    let count = ds.at::<u32>(definitions)?;
    if count > 56 { return Err("mode stat definitions exceed read budget".into()); }
    let entries = ds.read_abs(definitions + 8, count as usize * 0xc0)?;
    // Counters the server is not keeping read as unknown, not as no shots.
    let counting = ds.u8(HIGH_FREQUENCY_STATS)? != 0;
    let mut values = [None; STAT_KEYS.len()];
    for (output, stat) in STAT_KEYS.into_iter().enumerate() {
        if output >= STAT_COUNTERS && !counting { continue; }
        let name = ds.u32(0x4c42d20 + stat * 4)?;
        let Some((index, decimals)) = stat_definition(&entries, name, required_flag, output >= STAT_COUNTERS) else { continue; };
        let scale = f32::from_bits(ds.u32(0x3ce70a8 + u64::from(decimals) * 4)?);
        if !scale.is_finite() || !(0.0..=1_000_000.0).contains(&scale) { continue; }
        let offset = round.map_or(0xbc, |round| 0x38 + u64::from(round) * 4);
        let value = ds.at::<i32>(stats + u64::from(row) * 0x1df0 + index as u64 * 0x88 + offset)?;
        values[output] = Some(if scale == 1.0 { value } else { (value as f32 * scale) as i32 });
    }
    if ds.at::<u32>(definitions)? != count || ds.u64(0x4ebd098)? != stats { return Err("mode stats changed during observation".into()); }
    // A count below zero is no count.
    let count = |value: Option<i32>| value.and_then(|value| u32::try_from(value).ok());
    Ok(Some(PlayerStats {
        kills: values[0], deaths: values[1], assists: values[2], objective_score: values[3],
        shots_fired: count(values[4]), shots_hit: count(values[5]),
    }))
}

fn player_vitality(ds: &Ds, objects: &Pool, components: &Pool, unit: u32) -> Result<Option<Vitality>, String> {
    let Some((object_index, object_entry)) = objects.resolve(unit) else { return Ok(None); };
    if object_entry[6] != 0 { return Ok(None); }
    let object = get::<u64>(object_entry, 0x10);
    let reference = ds.read_abs(object + 0x268, 0x68)?;
    let slot = (u16::from_be_bytes([reference[5], reference[6]]) >> 6) & 31;
    if slot >= 16 { return Ok(None); }
    let handle = get::<u32>(&reference, 0x28 + usize::from(slot) * 4);
    let Some((component_index, component_entry)) = components.resolve(handle) else { return Ok(None); };
    let pointer = get::<u64>(component_entry, 0x10);
    let header = ds.read_abs(pointer, 0x20)?;
    if get::<u32>(&header, 8) != unit { return Ok(None); }
    let offset = get::<u32>(&header, 0x10);
    let shield_index = get::<i32>(&header, 0x1c);
    if offset > 0x2000 || !(-1..128).contains(&shield_index) { return Err("invalid vitality component layout".into()); }
    let health = f32::from_bits(ds.at::<u32>(pointer + u64::from(offset) + 0x30)?);
    let shield = if shield_index >= 0 {
        let address = pointer + u64::from(offset) + shield_index as u64 * 0x34;
        if ds.at::<u16>(address + 0x2e)? != u16::MAX {
            Some(f32::from_bits(ds.at::<u32>(address + 0x30)?))
        } else { None }
    } else { None };
    if !health.is_finite() || !(0.0..=16.0).contains(&health)
        || shield.is_some_and(|value| !value.is_finite() || !(0.0..=16.0).contains(&value))
    {
        return Err("invalid vitality values".into());
    }
    if ds.at::<u32>(object - 0xc)? != unit || ds.read_abs(objects.data + object_index as u64 * 0x18, 0x18)? != object_entry
        || ds.read_abs(components.data + component_index as u64 * 0x18, 0x18)? != component_entry
    {
        return Ok(None);
    }
    let flags = ds.at::<u32>(object + 0x138)?;
    Ok(Some(Vitality { health, shield, health_recharging: flags & (1 << 8) != 0, shield_recharging: flags & (1 << 11) != 0 }))
}

const LIFE_PLAYER_LIMIT: usize = 128;
const LIFE_SAMPLE_GAP_MS: u64 = 1000;

#[derive(Default)]
enum LifePhase {
    #[default]
    Unknown,
    Dead { unit: Option<String> },
    Alive { unit: String, started: Option<f64> },
}

#[derive(Default)]
struct ObservedLives {
    handle: String,
    name: Option<String>,
    bot_handle: Option<String>,
    team: Option<TeamId>,
    phase: LifePhase,
    completed: u32,
    mean: Option<f64>,
}

impl ObservedLives {
    fn update(&mut self, player: &Player, now: f64) -> Option<f64> {
        if self.handle != player.handle || self.name != player.name
            || self.bot_handle != player.bot_handle || self.team != player.team
        {
            *self = Self {
                handle: player.handle.clone(), name: player.name.clone(),
                bot_handle: player.bot_handle.clone(), team: player.team, ..Self::default()
            };
        }
        let health = player.vitality.as_ref().map(|vitality| vitality.health).filter(|health| health.is_finite());
        if let Some(unit) = player.unit.as_ref().filter(|_| player.alive && health.is_some_and(|health| health > 0.0)) {
            let started = match &self.phase {
                LifePhase::Dead { unit: previous } if previous.as_ref() != Some(unit) => Some(now),
                LifePhase::Alive { unit: previous, started } if previous == unit => *started,
                _ => None,
            };
            self.phase = LifePhase::Alive { unit: unit.clone(), started };
        } else if !player.alive && ((player.unit.is_none() && player.vitality.is_none())
            || (player.unit.is_some() && health.is_some_and(|health| health <= 0.0)))
        {
            if let LifePhase::Alive { unit, started: Some(started) } = &self.phase {
                let duration = now - started;
                if player.unit.as_ref().is_none_or(|current| current == unit)
                    && duration > 0.0 && duration <= 36000.0
                {
                    if let Some(completed) = self.completed.checked_add(1) {
                        let mean = self.mean.unwrap_or(0.0);
                        self.mean = Some(mean + (duration - mean) / f64::from(completed));
                        self.completed = completed;
                    }
                }
            }
            self.phase = LifePhase::Dead { unit: player.unit.clone() };
        } else {
            self.phase = LifePhase::Unknown;
            return None;
        }
        self.mean
    }
}

#[derive(PartialEq)]
struct LifeEpoch {
    pid: u32,
    world: u8,
    life_cycle: Option<i32>,
    map: Option<String>,
    map_variant: Option<String>,
    mode: Option<String>,
    round: Option<u16>,
}

struct LifeClock {
    epoch: LifeEpoch,
    captured_ms: u64,
    game_seconds: f64,
    elapsed_seconds: Option<f64>,
}

#[derive(Default)]
struct LifeTracker {
    clock: Option<LifeClock>,
    players: BTreeMap<usize, ObservedLives>,
}

impl LifeTracker {
    fn record(&mut self, mut result: Result<Snapshot, String>) -> Result<Snapshot, String> {
        match &mut result {
            Ok(snapshot) => self.update(snapshot),
            // A read the world changed under loses nothing: the lives go on.
            Err(error) if is_transient(error) => {}
            Err(_) => *self = Self::default(),
        }
        result
    }

    fn update(&mut self, snapshot: &mut Snapshot) {
        for player in &mut snapshot.players { player.average_life_seconds = None; }
        let Some(now) = snapshot.game_time_seconds.filter(|now| now.is_finite() && *now >= 0.0 && snapshot.in_match) else {
            *self = Self::default();
            return;
        };
        let info = snapshot.match_info.as_ref();
        let clock = LifeClock {
            epoch: LifeEpoch {
                pid: snapshot.pid, world: snapshot.world, life_cycle: snapshot.life_cycle,
                map: snapshot.map.as_ref().map(|map| map.engine_path.clone()),
                map_variant: snapshot.map_variant.as_ref().map(|variant| variant.asset_id.clone()),
                mode: info.and_then(|info| info.mode.clone()), round: info.and_then(|info| info.round_index),
            },
            captured_ms: snapshot.captured_unix_ms, game_seconds: now,
            elapsed_seconds: info.and_then(|info| info.elapsed_seconds).filter(|elapsed| elapsed.is_finite() && *elapsed >= 0.0),
        };
        if self.clock.as_ref().is_some_and(|previous| {
            previous.epoch != clock.epoch
                || clock.captured_ms.checked_sub(previous.captured_ms).is_none_or(|gap| gap > LIFE_SAMPLE_GAP_MS)
                || now < previous.game_seconds || now - previous.game_seconds > LIFE_SAMPLE_GAP_MS as f64 / 1000.0
                || clock.elapsed_seconds.zip(previous.elapsed_seconds).is_some_and(|(now, before)| now < before)
        }) {
            self.players.clear();
        }
        self.clock = Some(clock);
        let present: BTreeSet<_> = snapshot.players.iter().filter(|player| !player.observer && player.slot < LIFE_PLAYER_LIMIT)
            .map(|player| player.slot).collect();
        self.players.retain(|slot, _| present.contains(slot));
        for player in &mut snapshot.players {
            if player.observer || player.slot >= LIFE_PLAYER_LIMIT { continue; }
            player.average_life_seconds = self.players.entry(player.slot).or_default().update(player, now);
        }
    }
}

pub struct Observer {
    server: Ds,
    pools: Option<Pools>,
    lives: LifeTracker,
    /// The mode the current game runs, by its game entry, variant version and name id.
    mode: Option<((u64, String, u32), filmshell::GameMode)>,
    /// The server threads' thread-local blocks, listed once a match: listing them walks every
    /// thread on the PC (about 80 ms live), and the live world's threads outlast the match.
    blocks: Option<Vec<u64>>,
}

#[derive(Debug)]
pub struct WorldProbe {
    pub player_records: usize,
    pub valid_objects: usize,
    pub players_with_units: usize,
    pub elapsed_seconds: Option<f64>,
}

impl Observer {
    pub fn open(pid: u32) -> Result<Self, String> {
        let server = Ds::open(pid)?;
        if server.u8(0x4eadd40)? == 0 || server.u8(0x4eadd4d)? == 0 {
            return Err("refused: observer requires a LAN dedicated server".into());
        }
        Ok(Self { server, pools: None, lives: LifeTracker::default(), mode: None, blocks: None })
    }

    /// The thread-local blocks as listed this match, or listed afresh when `fresh`.
    fn blocks(&mut self, fresh: bool) -> Result<Vec<u64>, String> {
        if fresh || self.blocks.is_none() { self.blocks = Some(self.server.thread_local_blocks()?); }
        Ok(self.blocks.clone().unwrap_or_default())
    }

    /// The mode the current game runs, by the scripts its variant names (libfilmshell's
    /// GameMode::from_script_paths, as it reads a film's), read once per game variant.
    fn game_mode(&mut self, variant: Option<&AssetRef>) -> Option<filmshell::GameMode> {
        let game_array = self.server.u64(0x5121d28).ok()?;
        let index = self.server.u32(0x45c5838).ok()? & 0xffff;
        if game_array == 0 || index >= 3 { return None; }
        let entry = game_array + u64::from(index) * GAME_ENTRY;
        let name = self.server.at::<u32>(entry + 0x28 + 0x14c).ok()?;
        let key = (entry, variant.map(|variant| variant.version_id.clone()).unwrap_or_default(), name);
        if let Some((cached, mode)) = &self.mode {
            if *cached == key { return Some(*mode); }
        }
        let mode = filmshell::GameMode::from_script_paths(&self.server.read_abs(entry, GAME_ENTRY as usize).ok()?)?;
        self.mode = Some((key, mode));
        Some(mode)
    }

    fn discover(&self, blocks: &[u64]) -> Result<Pools, String> {
        let global = Pools {
            objects: self.server.u64(OBJECTS)?, players: self.server.u64(PLAYERS)?,
            components: self.server.u64(COMPONENTS)?,
            secondary_components: self.server.u64(COMPONENTS + 8)?,
        };
        let overrides = [self.server.u64(0x4ec8bf0)?, self.server.u64(0x4ec3368)?, self.server.u64(0x4ec64c0)?, self.server.u64(0x4ec64c8)?];
        if overrides == [0; 4] { return Ok(global); }
        let mut candidates = BTreeSet::new();
        for &block in blocks {
            let candidate = (|| {
                if self.server.at::<u8>(block + 0xc8)? == 0 { return Ok::<_, String>(None); }
                let pools = Pools {
                    objects: if overrides[0] == 0 { global.objects } else { self.server.at(block + 0x4acc0)? },
                    players: if overrides[1] == 0 { global.players } else { self.server.at(block + 0x4ab20)? },
                    components: if overrides[2] == 0 { global.components } else { self.server.at(block + 0x4aaf0)? },
                    secondary_components: if overrides[3] == 0 { global.secondary_components } else { self.server.at(block + 0x4aaf8)? },
                };
                for (address, stride) in [(pools.objects, 0x18u64), (pools.players, 0x1f40), (pools.components, 0x18)] {
                    if address == 0 || self.server.at::<u64>(address + 0x40)? != stride { return Ok(None); }
                }
                Ok(Some(pools))
            })();
            if let Ok(Some(pools)) = candidate { candidates.insert(pools); }
        }
        match candidates.len() {
            1 => Ok(*candidates.first().unwrap()),
            0 => Err("no validated live-world pool set found".into()),
            _ => Err("ambiguous live-world pools. Refusing to choose a thread arbitrarily".into()),
        }
    }

    /// The live world's engine root, game clock slot and time bank, agreed on by every
    /// live-world thread.
    fn live_clock(&self, pools: Pools, blocks: &[u64]) -> Result<(u64, u64, u64), String> {
        let mut roots = BTreeSet::new();
        let mut clocks = BTreeSet::new();
        let mut time_banks = BTreeSet::new();
        for &block in blocks {
            if self.server.at::<u8>(block + 0xc8).unwrap_or(0) == 0
                || self.server.at::<u64>(block + 0x4acc0).unwrap_or(0) != pools.objects
            {
                continue;
            }
            let root = self.server.at::<u64>(block + 0x220)?;
            if root >= 0x10000 { roots.insert(root); }
            let times = self.server.at::<u64>(block + 0x6c0)?;
            let index = self.server.at::<i32>(block + 0x710)?;
            let world = self.server.at::<u8>(block + 0x810)?;
            if times >= 0x10000 && (0..=1).contains(&index) && world == 0 {
                clocks.insert(times + index as u64 * 0x10);
                time_banks.insert(times);
            }
        }
        if roots.len() != 1 { return Err("no unambiguous live-world timer store".into()); }
        if clocks.len() != 1 || time_banks.len() != 1 { return Err("no unambiguous live-world game clock".into()); }
        Ok((*roots.first().unwrap(), *clocks.first().unwrap(), *time_banks.first().unwrap()))
    }

    fn read_managed_timers(&mut self, pools: Pools) -> Result<(BTreeMap<usize, EngineTimer>, f64, MatchInfo), String> {
        // Threads flip between the two clock slots during a tick, so one scan can catch them
        // disagreeing (about 1 read in 6 live). The same scan, taken again, settles. Without it
        // the snapshot loses the clock, the round (so round scores) and every pad countdown. The
        // third scan lists the threads afresh, in case one the list holds has gone.
        let mut agreed = Err(String::new());
        for attempt in 0..4 {
            let blocks = self.blocks(attempt == 2)?;
            agreed = self.live_clock(pools, &blocks);
            if agreed.is_ok() { break; }
        }
        let (engine, clock, time_bank) = agreed?;
        let seconds = f64::from_bits(self.server.at::<u64>(clock)?);
        if !seconds.is_finite() { return Err("invalid live-world game timestamp".into()); }
        let address = engine + 0x308;
        let bytes = self.server.read_abs(address, 0x628)?;
        if self.server.at::<u64>(address + 0x20)? != get::<u64>(&bytes, 0x20) {
            return Err("managed timer allocation changed during observation".into());
        }
        let time = self.server.read_abs(time_bank, 0x92)?;
        let ticks = get::<i32>(&time, 0x40);
        let rate = get::<u16>(&time, 0x8c);
        let elapsed_seconds = (time[0x91] != 0 && ticks >= 0 && (1..=240).contains(&rate))
            .then(|| f64::from(ticks) / f64::from(rate));
        let round = self.server.at::<u16>(engine + 0x266)?;
        let timer = self.server.read_abs(engine + 0x2d8, 0x10)?;
        let remaining = float(&timer, 4);
        let initial = float(&timer, 8);
        let round_timer = (remaining.is_finite() && initial.is_finite() && (0.0..=36000.0).contains(&remaining)
            && (0.0..=36000.0).contains(&initial) && timer[0xf] <= 31)
            .then_some(EngineTimer { seconds_left: remaining, start_seconds: initial, timer_rate_index: timer[0xf] });
        let game_array = self.server.u64(0x5121d28)?;
        let game_index = self.server.u32(0x45c5838)? & 0xffff;
        let mode = if game_array != 0 && game_index < 3 {
            let variant = game_array + u64::from(game_index) * GAME_ENTRY + 0x28;
            let identifier = self.server.at::<u32>(variant + 0x14c)?;
            match filmshell::game::text(filmshell::StringId(identifier)) {
                Some(name) => Some(name.to_owned()),
                None => {
                    let name = self.server.read_abs(variant + 0x11c, 0x30)?;
                    name.iter().position(|byte| *byte == 0).filter(|end| *end > 0 && name[..*end].iter().all(|byte| (0x20..=0x7e).contains(byte)))
                        .map(|end| String::from_utf8_lossy(&name[..end]).into_owned())
                }
            }
        } else { None };
        Ok((managed_timers(&bytes)?, seconds, MatchInfo { mode, game_mode: None, game_mode_name: None, round_index: (round < 32).then_some(round), elapsed_seconds, round_timer }))
    }

    pub fn probe_world(&mut self) -> Result<WorldProbe, String> {
        let blocks = self.blocks(true)?;
        let pools = self.discover(&blocks)?;
        let objects = Pool::read(&self.server, pools.objects, 0x18, 32768)?;
        let players = Pool::read(&self.server, pools.players, 0x1f40, 128)?;
        let mut valid = BTreeSet::new();
        for (index, entry) in objects.entries.chunks_exact(0x18).enumerate() {
            let Some(handle) = objects.handle(index) else { continue; };
            let pointer = get::<u64>(entry, 0x10);
            if pointer >= 0x10000 && self.server.at::<u32>(pointer - 0xc).ok() == Some(handle) {
                valid.insert(handle);
            }
        }
        let mut player_records = 0;
        let mut players_with_units = 0;
        for (index, entry) in players.entries.chunks_exact(0x1f40).enumerate() {
            if players.handle(index).is_none() { continue; }
            player_records += 1;
            if valid.contains(&get::<u32>(entry, 0x1f30)) { players_with_units += 1; }
        }
        let elapsed_seconds = self.read_managed_timers(pools).ok().and_then(|(_, _, info)| info.elapsed_seconds);
        if !objects.unchanged(&self.server)? || !players.unchanged(&self.server)? {
            return Err("world changed during diagnostic read".into());
        }
        Ok(WorldProbe { player_records, valid_objects: valid.len(), players_with_units, elapsed_seconds })
    }

    /// Experimental (the `navmesh` dev command): the loaded map's floor plan from the server's
    /// navigation mesh, named like film-assets' plans, with the Forge volumes the game tests
    /// players against, and the Forge map's navmesh.blob when the server holds one.
    pub fn live_floor(&mut self) -> Result<(navmesh::LiveFloor, Option<Vec<u8>>), String> {
        let snapshot = self.snapshot()?;
        if !snapshot.in_match { return Err("no match is running: the server loads a map's navmesh with the map".into()); }
        let sections = navmesh::sections(&self.server)?;
        if sections.is_empty() { return Err("the server's AI world holds no navmesh (a Forge map nobody baked one for)".into()); }
        let rings = navmesh::rings(sections.iter().map(|(_, mesh)| mesh));
        let mut warnings = snapshot.warnings.clone();
        let blob = navmesh::forge_blob(&self.server).unwrap_or_else(|error| {
            warnings.push(format!("Forge navmesh blob: {error}"));
            None
        });
        let forge_volumes = match self.pools.map(|pools| self.forge_volumes(pools)) {
            Some(Ok(volumes)) => Some(volumes),
            Some(Err(error)) => { warnings.push(format!("Forge volumes: {error}")); None }
            None => None,
        };
        let level_kill_volumes = match navmesh::level_kill_volumes(&self.server) {
            Ok(mut volumes) => {
                let set = |bits: &[u8], bit: usize| bits.get(bit / 8).map(|byte| byte >> (bit % 8) & 1 != 0);
                match self.pools.map(|pools| self.kill_volume_state(pools)) {
                    Some(Ok((state, layers))) => for volume in &mut volumes {
                        volume.disabled = usize::try_from(volume.kill_index).ok().and_then(|bit| set(&state, bit));
                        volume.layer_active = volume.layer.and_then(|layer| match &layers {
                            Some(layers) => set(layers, layer as usize),
                            None => Some(true),
                        });
                    },
                    Some(Err(error)) => warnings.push(format!("Kill volume state: {error}")),
                    None => {}
                }
                Some(volumes)
            }
            Err(error) => { warnings.push(format!("Level kill volumes: {error}")); None }
        };
        let map = snapshot.map.as_ref();
        let level_id = map.and_then(|map| map.level_id.clone()).unwrap_or_else(|| "00000000".into());
        let title = map.and_then(|map| map.title).map(str::to_owned);
        let level = title.clone().or_else(|| map.map(|map| map.engine_path.clone())).unwrap_or_else(|| level_id.clone());
        let variant = snapshot.map_variant.as_ref();
        let floor = navmesh::LiveFloor {
            level, level_id, structure_id: "00000000".into(), units: "world", fill: "nonzero",
            map_asset_id: variant.map(|variant| variant.asset_id.clone()),
            map_version_id: variant.map(|variant| variant.version_id.clone()), title, rings,
            live: navmesh::LiveDetails {
                experimental: true, source: "server navmesh", sections: sections.into_iter().map(|(section, _)| section).collect(),
                forge_volumes, level_kill_volumes, navmesh_blob_bytes: blob.as_ref().map(Vec::len), warnings,
            },
        };
        Ok((floor, blob))
    }

    /// The kill trigger volume state the live world's threads share: one bit per kill index, set
    /// while the volume is off. And the level layers they have on (one bit per layer, none: all on).
    fn kill_volume_state(&mut self, pools: Pools) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
        let mut states = BTreeSet::new();
        let mut layers = BTreeSet::new();
        for block in self.blocks(false)? {
            if self.server.at::<u8>(block + 0xc8).unwrap_or(0) == 0
                || self.server.at::<u64>(block + 0x4acc0).unwrap_or(0) != pools.objects
            {
                continue;
            }
            let state = self.server.at::<u64>(block + 0x3e0)?;
            if state >= 0x10000 { states.insert(state); }
            layers.insert(self.server.at::<u64>(block + 0x768)?);
        }
        if states.len() != 1 || layers.len() != 1 { return Err("no unambiguous live-world kill volume state".into()); }
        let layers = match *layers.first().unwrap() {
            0 => None,
            set => Some(self.server.read_abs(set, 0x20)?),
        };
        Ok((self.server.read_abs(*states.first().unwrap(), 0x400)?, layers))
    }

    /// The Forge volumes the game tests players against (navmesh::ForgeVolume), each named by its
    /// object's multiplayer properties: their type and whether they are soft.
    fn forge_volumes(&mut self, pools: Pools) -> Result<Vec<navmesh::ForgeVolume>, String> {
        let mut agreed = Err(String::new());
        for attempt in 0..4 {
            let blocks = self.blocks(attempt == 2)?;
            agreed = self.live_clock(pools, &blocks);
            if agreed.is_ok() { break; }
        }
        let (engine, _, _) = agreed?;
        let table = self.server.read_abs(engine + FORGE_VOLUMES, FORGE_VOLUME_SLOTS * FORGE_VOLUME + 4)?;
        let count = usize::try_from(get::<i32>(&table, FORGE_VOLUME_SLOTS * FORGE_VOLUME)).ok()
            .filter(|count| *count <= FORGE_VOLUME_SLOTS).ok_or("unexpected Forge volume count")?;
        let objects = Pool::read(&self.server, pools.objects, 0x18, 32768)?;
        let mut volumes = Vec::new();
        for entry in table[..count * FORGE_VOLUME].chunks_exact(FORGE_VOLUME) {
            let Some((handle, mut volume)) = navmesh::forge_volume(entry) else { continue; };
            let pointer = objects.resolve(handle).map(|(_, slot)| get::<u64>(slot, 0x10)).filter(|pointer| *pointer >= 0x10000);
            if let Some(pointer) = pointer {
                let header = self.server.read_abs(pointer + 0x1ae, 4)?;
                if get::<u16>(&header, 0) != 0 {
                    let properties = self.server.read_abs(pointer + 0x1ae + u64::from(get::<u16>(&header, 2)), 0xc8)?;
                    let (kind, soft) = (properties[0xc4], properties[0x74] & 1 != 0);
                    (volume.properties_type, volume.soft, volume.kind) = (Some(kind), Some(soft), navmesh::volume_kind(kind, soft));
                }
            }
            volumes.push(volume);
        }
        Ok(volumes)
    }

    pub fn snapshot(&mut self) -> Result<Snapshot, String> {
        // The world changes under a live read now and then, more often in a busy match (an Oddball
        // game caught 15% of reads so): the read is taken again before it counts as failed.
        let mut result = self.read_snapshot();
        for _ in 0..RETRIES {
            if !matches!(&result, Err(error) if is_transient(error)) { break; }
            result = self.read_snapshot();
        }
        self.lives.record(result)
    }

    fn read_snapshot(&mut self) -> Result<Snapshot, String> {
        let state = if self.server.u8(0x4dc3180)? != 0 { Some(self.server.i32(0x4dc3188)?) } else { None };
        let in_match = matches!(state, Some(9 | 10));
        let mut snapshot = Snapshot {
            schema: SCHEMA, pid: self.server.pid,
            captured_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis() as u64,
            life_cycle: state, in_match, world: 0, units: "world_units_feet", consistency: "best_effort_live_reads",
            map: None, map_variant: None, game_variant: None, geometry_id: None, match_info: None, team_scores: Vec::new(),
            players: Vec::new(), objects: Vec::new(), navpoints: Vec::new(), lobby: None, warnings: Vec::new(), skipped_entries: 0,
            game_time_seconds: None,
        };
        match selected_variants(&self.server) {
            Ok((map, game)) => (snapshot.map_variant, snapshot.game_variant) = (map, game),
            Err(error) => snapshot.warnings.push(format!("Selected variants: {error}")),
        }
        match lobby(&self.server) {
            Ok(found) => snapshot.lobby = found,
            Err(error) => snapshot.warnings.push(format!("Lobby: {error}")),
        }
        if !in_match {
            self.pools = None;
            self.blocks = None;
            return Ok(snapshot);
        }
        let game_array = self.server.u64(0x5121d28)?;
        let game_index = self.server.u32(0x45c5838)? & 0xffff;
        if game_array != 0 && game_index < 3 {
            let path = self.server.read_abs(game_array + game_index as u64 * GAME_ENTRY + 0xea810, 256)?;
            let end = path.iter().position(|byte| *byte == 0).unwrap_or(path.len());
            if end != 0 && path[..end].is_ascii() {
                snapshot.map = Some(map_info(&String::from_utf8_lossy(&path[..end])));
            }
        }
        let pools = match self.pools {
            Some(pools) => pools,
            None => {
                // From the threads listed this match, or listed afresh when those find no pools.
                let pools = self.blocks(false).and_then(|blocks| self.discover(&blocks))
                    .or_else(|_| self.blocks(true).and_then(|blocks| self.discover(&blocks)))?;
                self.pools = Some(pools);
                pools
            }
        };
        // The engine's managed timers: the navpoints' countdowns.
        let mut timers = BTreeMap::new();
        match self.read_managed_timers(pools) {
            Ok((read, seconds, match_info)) => {
                timers = read; snapshot.game_time_seconds = Some(seconds); snapshot.match_info = Some(match_info);
            }
            Err(error) => snapshot.warnings.push(format!("Managed timers: {error}")),
        }
        if let Some(info) = snapshot.match_info.as_mut() {
            info.game_mode = self.game_mode(snapshot.game_variant.as_ref());
            info.game_mode_name = info.game_mode.map(filmshell::GameMode::name);
        }
        let objects = Pool::read(&self.server, pools.objects, 0x18, 32768)?;
        let players = Pool::read(&self.server, pools.players, 0x1f40, 128)?;
        let components = Pool::read(&self.server, pools.components, 0x18, 32768)?;
        let mut found = BTreeMap::new();
        for (index, entry) in objects.entries.chunks_exact(0x18).enumerate() {
            match object(&self.server, &objects, index, entry) {
                Ok(Some((handle, object))) => { found.insert(handle, object); }
                Ok(None) => {}
                Err(_) => snapshot.skipped_entries += 1,
            }
        }
        place_on_parents(&mut found);
        let definitions: BTreeSet<u32> = found.values().map(|object| object.definition_handle).collect();
        match tag_refs(&self.server, &definitions) {
            Ok(tags) => for object in found.values_mut() { object.tag = tags.get(&object.definition_handle).cloned(); },
            Err(error) => snapshot.warnings.push(format!("Object tags: {error}")),
        }
        // Dispensers: the components of the dispenser kind, on a live object.
        for (index, entry) in components.entries.chunks_exact(0x18).enumerate() {
            let pointer = get::<u64>(entry, 0x10);
            if pointer == 0 { continue; }
            let result = (|| {
                let bytes = self.server.read_abs(pointer, 0x5c)?;
                if get::<u64>(&bytes, 0) != self.server.va(DISPENSER_KIND) { return Ok::<_, String>(None); }
                let owner = get::<u32>(&bytes, 8);
                if objects.resolve(owner).is_none() { return Ok(None); }
                let current = self.server.read_abs(components.data + index as u64 * 0x18, 0x18)?;
                if get::<u16>(&current, 0) != get::<u16>(entry, 0) || get::<u64>(&current, 0x10) != pointer {
                    return Ok(None);
                }
                Ok(Some((owner, dispenser(&bytes)?)))
            })();
            match result {
                Ok(Some((owner, pad))) => {
                    if let Some(object) = found.get_mut(&owner) { object.dispenser = Some(pad); }
                }
                Ok(None) => {}
                Err(_) => snapshot.skipped_entries += 1,
            }
        }
        // The gameplay script keeps changing the tables (more often with bots in the match): a
        // read that catches them mid-update is taken again rather than losing every pad.
        let mut spawners = stock_spawners(&self.server);
        for _ in 0..3 {
            if spawners.is_ok() { break; }
            spawners = stock_spawners(&self.server);
        }
        match spawners {
            Ok((spawners, skipped)) => {
                snapshot.skipped_entries += skipped;
                for (handle, mut spawner) in spawners {
                    if objects.resolve(handle).is_none() { continue; }
                    let Some(object) = found.get_mut(&handle) else { continue; };
                    if let (Some(timing), Some(now)) = (spawner.incoming, snapshot.game_time_seconds) {
                        spawner.seconds_left = timing.remaining(now);
                    }
                    object.stock_spawner = Some(spawner);
                }
            }
            Err(error) => snapshot.warnings.push(format!("Stock spawners: {error}")),
        }
        let rows = match stat_rows(&self.server) {
            Ok(rows) => rows,
            Err(error) => { snapshot.warnings.push(format!("Stat registry: {error}")); BTreeMap::new() }
        };
        for team in 0..8u8 {
            let Some(row) = rows.get(&(0xffff0000 | u32::from(team))) else { continue; };
            let round = snapshot.match_info.as_ref().and_then(|info| info.round_index);
            let total_score = stats_for_row(&self.server, *row, 1, None).ok().flatten().and_then(|stats| stats.objective_score);
            let round_score = round.and_then(|round| stats_for_row(&self.server, *row, 1, Some(round)).ok().flatten()).and_then(|stats| stats.objective_score);
            if total_score.is_some() || round_score.is_some() {
                snapshot.team_scores.push(TeamScore { team: TeamId(team), name: TeamId(team).name(), round_score, total_score });
            }
        }
        for (index, entry) in players.entries.chunks_exact(0x1f40).enumerate() {
            let Some(handle) = players.handle(index) else { continue; };
            if self.server.at::<u16>(players.data + index as u64 * 0x1f40)? != (handle >> 16) as u16 {
                snapshot.skipped_entries += 1;
                continue;
            }
            let team = entry[0x285] ^ 0x9e;
            let unit = get::<u32>(entry, 0x1f30);
            let position = found.get(&unit).and_then(|object| object.position);
            let stats = match rows.get(&((index as u32) << 16 | u32::from(team))) {
                Some(row) => match stats_for_row(&self.server, *row, 2, None) {
                    Ok(stats) => stats,
                    Err(error) => { snapshot.warnings.push(format!("Player stats: {error}")); None }
                },
                None => None,
            };
            let vitality = match player_vitality(&self.server, &objects, &components, unit) {
                Ok(vitality) => vitality,
                Err(error) => { snapshot.warnings.push(format!("Player vitality: {error}")); None }
            };
            let team = (team < 8).then_some(TeamId(team));
            let alive = unit != INVALID && found.contains_key(&unit) && vitality.as_ref().is_none_or(|value| value.health > 0.0);
            let facing = alive.then(|| found.get(&unit).and_then(|object| object.facing)).flatten();
            snapshot.players.push(Player {
                handle: handle_text(handle), slot: index, name: player_name(entry), team, team_name: team.and_then(TeamId::name),
                observer: entry[0x285] ^ 0x9e == 31,
                bot_handle: optional_handle(get(entry, 0x53c)), unit: optional_handle(unit),
                position, alive, stats, vitality, average_life_seconds: None, carrying: None, facing,
            });
        }
        let marker_pools = self.blocks(false).and_then(|blocks| self.marker_pools(pools, &blocks))
            .or_else(|_| self.blocks(true).and_then(|blocks| self.marker_pools(pools, &blocks)));
        match marker_pools.and_then(|marker_pools| self.markers(marker_pools, &found, &timers)) {
            Ok((navpoints, carried)) => {
                snapshot.navpoints = navpoints;
                for player in &mut snapshot.players {
                    player.carrying = carried.get(player.slot).copied().flatten();
                }
            }
            Err(error) => snapshot.warnings.push(format!("Navpoints: {error}")),
        }
        let changed = if !objects.unchanged(&self.server)? { Some("objects") }
            else if !players.unchanged(&self.server)? { Some("players") }
            else if !components.unchanged(&self.server)? { Some("components") }
            else if self.server.i32(0x4dc3188)? != state.unwrap() { Some("life cycle") }
            else { None };
        if let Some(what) = changed {
            self.pools = None;
            return Err(format!("{CHANGED} ({what}). Retry the snapshot"));
        }
        snapshot.objects = found.into_values().collect();
        if snapshot.skipped_entries != 0 {
            snapshot.warnings.push("Some entries changed, disappeared or failed validation during the live read.".into());
        }
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attached(parent: Option<u32>, position: Option<Position>) -> Object {
        Object {
            handle: String::new(), kind: "weapon", definition_handle: 0, tag: None, parent: parent.map(handle_text), position,
            facing: None, dispenser: None, stock_spawner: None,
        }
    }

    #[test]
    fn attached_objects_take_their_parents_place() {
        // A flag on its stand, a weapon held by a player in a vehicle, and one whose parent is gone.
        let stand = Position::new(0.0, 160.0);
        let vehicle = Position::new(12.0, -4.0);
        let mut found = BTreeMap::from([
            (1, attached(None, Some(stand))), (2, attached(Some(1), None)),
            (3, attached(None, Some(vehicle))), (4, attached(Some(3), None)), (5, attached(Some(4), None)),
            (6, attached(Some(99), None)),
        ]);
        place_on_parents(&mut found);
        assert_eq!(found[&2].position, Some(stand));
        assert_eq!(found[&5].position, Some(vehicle));
        assert_eq!(found[&6].position, None);
    }

    #[test]
    fn asset_refs_read_kind_and_windows_layout_guids() {
        // Solitude's map variant: AssetId f1cc3b4e-471c-4ec5-b855-1db7d9e6ce42,
        // VersionId cc6dfb16-7782-4995-a74a-98e86051fcdf.
        let mut bytes = vec![2, 0, 0, 0];
        bytes.extend([0x4e, 0x3b, 0xcc, 0xf1, 0x1c, 0x47, 0xc5, 0x4e, 0xb8, 0x55, 0x1d, 0xb7, 0xd9, 0xe6, 0xce, 0x42]);
        bytes.extend([0x16, 0xfb, 0x6d, 0xcc, 0x82, 0x77, 0x95, 0x49, 0xa7, 0x4a, 0x98, 0xe8, 0x60, 0x51, 0xfc, 0xdf]);
        assert_eq!(AssetRef::parse(&bytes), Some(AssetRef {
            kind: 2,
            asset_id: "f1cc3b4e-471c-4ec5-b855-1db7d9e6ce42".into(),
            version_id: "cc6dfb16-7782-4995-a74a-98e86051fcdf".into(),
            name: None,
        }));
        assert_eq!(AssetRef::parse(&bytes[..0x20]), None);
        let mut empty = bytes.clone();
        empty[4..0x14].fill(0);
        assert_eq!(AssetRef::parse(&empty), None);
    }

    /// A mode stat definition as the variant keeps it.
    fn stat(entries: &mut [u8], index: usize, name: u32, kind: u32, rows: u8, decimals: u8) {
        let at = index * 0xc0;
        entries[at..at + 4].copy_from_slice(&name.to_le_bytes());
        entries[at + 4..at + 8].copy_from_slice(&kind.to_le_bytes());
        entries[at + 0x1c] = rows;
        entries[at + 0xbc] = decimals;
    }

    #[test]
    fn stat_definitions_take_counters_only_as_whole_numbers_for_their_rows() {
        let mut entries = vec![0u8; 5 * 0xc0];
        stat(&mut entries, 0, 0x1111, 0, 3, 0);
        stat(&mut entries, 1, 0x2222, 0, 2, 0);
        // A percentage (type 3) and a counter kept with decimals, neither a count.
        stat(&mut entries, 2, 0x3333, 3, 3, 2);
        stat(&mut entries, 3, 0x4444, 0, 2, 1);
        stat(&mut entries, 4, 0x5555, 0, 2, 32);
        assert_eq!(stat_definition(&entries, 0x1111, 2, true), Some((0, 0)));
        assert_eq!(stat_definition(&entries, 0x1111, 1, true), Some((0, 0)));
        assert_eq!(stat_definition(&entries, 0x2222, 2, true), Some((1, 0)));
        assert_eq!(stat_definition(&entries, 0x2222, 1, true), None);
        assert_eq!(stat_definition(&entries, 0x3333, 2, false), Some((2, 2)));
        assert_eq!(stat_definition(&entries, 0x3333, 2, true), None);
        assert_eq!(stat_definition(&entries, 0x4444, 2, true), None);
        assert_eq!(stat_definition(&entries, 0x5555, 2, false), None);
        assert_eq!(stat_definition(&entries, 0x6666, 2, false), None);
        // An empty name id matches nothing, not the first unnamed definition.
        stat(&mut entries, 0, 0, 0, 3, 0);
        assert_eq!(stat_definition(&entries, 0, 2, true), None);
        assert_eq!(stat_definition(&entries[..0xbf], 0x1111, 2, true), None);
    }

    #[test]
    fn player_stats_read_shot_counters_beside_kills() {
        use windows_sys::Win32::System::Threading::{PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

        // The image from the scale table to the shot counting flag.
        let mut image = vec![0u8; 0x51222d0 - 0x3ce70a8];
        let base = image.as_ptr() as u64 - 0x3ce70a8;
        let at = |offset: usize| offset - 0x3ce70a8;
        let mut game = vec![0u8; 0x28 + 0xdf77c + 8 + 4 * 0xc0];
        let mut storage = vec![0u8; 3 * 0x1df0 + 8];
        let names = [(4, 0x1111u32), (0, 0x2222), (13, 0x3333), (14, 0x4444)];
        for (key, name) in names { image[at(0x4c42d20 + key * 4)..][..4].copy_from_slice(&name.to_le_bytes()); }
        for (index, scale) in [1.0f32, 0.1].into_iter().enumerate() {
            image[at(0x3ce70a8) + index * 4..][..4].copy_from_slice(&scale.to_le_bytes());
        }
        image[at(0x4ebd098)..][..8].copy_from_slice(&(storage.as_ptr() as u64).to_le_bytes());
        image[at(0x5121d28)..][..8].copy_from_slice(&(game.as_ptr() as u64).to_le_bytes());
        image[at(0x51222c8)] = 1;
        let definitions = 0x28 + 0xdf77c;
        game[definitions..definitions + 4].copy_from_slice(&4u32.to_le_bytes());
        let entries = &mut game[definitions + 8..];
        stat(entries, 0, 0x1111, 0, 3, 0);
        stat(entries, 1, 0x3333, 0, 2, 0);
        stat(entries, 2, 0x4444, 0, 2, 0);
        stat(entries, 3, 0x2222, 0, 3, 1);
        // Row 2's totals and its round 1 values.
        let mut value = |index: usize, offset: usize, value: i32| {
            storage[2 * 0x1df0 + index * 0x88 + offset..][..4].copy_from_slice(&value.to_le_bytes());
        };
        value(0, 0xbc, 7);
        value(1, 0xbc, 120);
        value(2, 0xbc, 45);
        value(3, 0xbc, 250);
        value(1, 0x3c, 30);
        let pid = std::process::id();
        let process = Ds { h: crate::open_raw(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ).unwrap(), pid, base };
        let stats = stats_for_row(&process, 2, 2, None).unwrap().unwrap();
        assert_eq!((stats.kills, stats.objective_score, stats.deaths), (Some(7), Some(25), None));
        assert_eq!((stats.shots_fired, stats.shots_hit), (Some(120), Some(45)));
        assert_eq!(stats_for_row(&process, 2, 2, Some(1)).unwrap().unwrap().shots_fired, Some(30));
        // Team rows keep neither counter here.
        let team = stats_for_row(&process, 2, 1, None).unwrap().unwrap();
        assert_eq!((team.kills, team.shots_fired, team.shots_hit), (Some(7), None, None));
        // With shot counting off the server counts no shots.
        image[at(0x51222c8)] = 0;
        std::hint::black_box(&image);
        let stats = stats_for_row(&process, 2, 2, None).unwrap().unwrap();
        assert_eq!((stats.kills, stats.shots_fired, stats.shots_hit), (Some(7), None, None));
        image[at(0x51222c8)] = 1;
        // A negative count, or a counter the mode keeps as a percentage, gives nothing.
        storage[2 * 0x1df0 + 0x88 + 0xbc..][..4].copy_from_slice(&(-1i32).to_le_bytes());
        stat(&mut game[definitions + 8..], 2, 0x4444, 3, 2, 0);
        std::hint::black_box((&storage, &game));
        let stats = stats_for_row(&process, 2, 2, None).unwrap().unwrap();
        assert_eq!((stats.kills, stats.shots_fired, stats.shots_hit), (Some(7), None, None));
        assert!(stats_for_row(&process, 128, 2, None).unwrap().is_none());
        image[at(0x45c5838)] = 3;
        std::hint::black_box(&image);
        assert!(stats_for_row(&process, 2, 2, None).unwrap().is_none());
    }

    #[test]
    fn navpoint_filters_names_and_member_text() {
        // A filter set with a negated team clause, a team clause (Cobra) and a player mask.
        let mut bytes = vec![0u8; 0x200];
        bytes[0xc] = 0b111;
        let clause = |bytes: &mut Vec<u8>, at: usize, kind: u8, negated: bool, value: u32| {
            bytes[at + 8] = u8::from(negated);
            bytes[at + 0x10..at + 0x14].copy_from_slice(&value.to_le_bytes());
            bytes[at + 0x38] = kind;
        };
        clause(&mut bytes, 0x10, 3, true, 0);
        clause(&mut bytes, 0x50, 3, false, 1);
        clause(&mut bytes, 0x90, 2, false, 0b1001);
        // As films carry them: a team as its id plus one.
        assert_eq!(clauses(&bytes, 0), [
            Clause { kind: 3, negated: true, value: 1 }, Clause { kind: 3, negated: false, value: 2 },
            Clause { kind: 2, negated: false, value: 0b1001 },
        ]);
        let mut marks = ZoneMarks::default();
        marks.read(true, &StateGroup { name: 0, state: 0, clauses: &clauses(&bytes, 0) });
        assert_eq!(marks.owner, Some(1));
        assert_eq!(navpoint::players(&clauses(&bytes, 0)), 0b1001);
        // A team of -1 (none) is no team.
        bytes[0xc] = 0b001;
        clause(&mut bytes, 0x10, 3, false, 0xff);
        marks.read(true, &StateGroup { name: 0, state: 0, clauses: &clauses(&bytes, 0) });
        assert_eq!(marks.owner, None);

        assert_eq!(navpoint_name(filmshell::game::murmur3(b"mp_deliver_object")).as_deref(), Some("mp_deliver_object"));
        assert_eq!(navpoint_name(filmshell::game::murmur3(b"a")).as_deref(), Some("a"));
        assert_eq!(navpoint_name(0x12345678).as_deref(), Some("12345678"));
        assert_eq!(navpoint_name(0), None);

        let mut text = vec![0u8; 40];
        for (unit, code) in "Spartan".encode_utf16().enumerate() { text[4 + unit * 2..6 + unit * 2].copy_from_slice(&code.to_le_bytes()); }
        assert_eq!(utf16(&text, 4, 16).as_deref(), Some("Spartan"));
        assert_eq!(utf16(&text, 30, 4), None);
    }

    fn life_snapshot(seconds: f64, alive: bool) -> Snapshot {
        Snapshot {
            schema: SCHEMA, pid: 42, captured_unix_ms: 1_000_000 + (seconds * 1000.0) as u64,
            life_cycle: Some(9), in_match: true, world: 0, units: "world_units_feet", consistency: "synthetic_fixture",
            map: Some(map_info("Bazaar")), map_variant: None, game_variant: None, geometry_id: None,
            match_info: Some(MatchInfo { mode: Some("Slayer".into()), game_mode: None, game_mode_name: None, round_index: Some(0), elapsed_seconds: Some(seconds), round_timer: None }),
            team_scores: Vec::new(), players: vec![Player {
                handle: "e1500000".into(), slot: 0, name: Some("Synthetic player".into()), team: Some(TeamId(0)),
                team_name: Some("Eagle"), observer: false, bot_handle: None,
                unit: alive.then(|| "e5a00240".into()), position: None, alive, stats: None,
                vitality: alive.then_some(Vitality { health: 1.0, shield: Some(1.0), health_recharging: false, shield_recharging: false }),
                average_life_seconds: None, carrying: None, facing: None,
            }],
            objects: Vec::new(), navpoints: Vec::new(), lobby: None, warnings: Vec::new(), skipped_entries: 0,
            game_time_seconds: Some(4294967296.0 + seconds),
        }
    }

    fn life_sample(tracker: &mut LifeTracker, seconds: f64, alive: bool) -> Option<f64> {
        tracker.record(Ok(life_snapshot(seconds, alive))).unwrap().players[0].average_life_seconds
    }

    fn complete_life(tracker: &mut LifeTracker) {
        assert_eq!(life_sample(tracker, 0.0, false), None);
        assert_eq!(life_sample(tracker, 0.25, true), None);
        assert_eq!(life_sample(tracker, 0.5, true), None);
        assert_eq!(life_sample(tracker, 0.75, false), Some(0.5));
    }

    #[test]
    fn average_life_excludes_startup_midlife_and_unobserved_spawn() {
        let mut tracker = LifeTracker::default();
        assert_eq!(life_sample(&mut tracker, 0.0, true), None);
        assert_eq!(life_sample(&mut tracker, 0.25, true), None);
        assert_eq!(life_sample(&mut tracker, 0.5, false), None);
        assert_eq!(life_sample(&mut tracker, 0.75, true), None);
        assert_eq!(life_sample(&mut tracker, 1.0, true), None);
        assert_eq!(life_sample(&mut tracker, 1.25, false), Some(0.5));
    }

    #[test]
    fn average_life_counts_only_completed_lives_not_wait_or_current_life() {
        let mut tracker = LifeTracker::default();
        complete_life(&mut tracker);
        for tick in 4..=20 { assert_eq!(life_sample(&mut tracker, f64::from(tick) / 4.0, false), Some(0.5)); }
        for tick in 21..=26 { assert_eq!(life_sample(&mut tracker, f64::from(tick) / 4.0, true), Some(0.5)); }
        assert_eq!(life_sample(&mut tracker, 6.75, false), Some(1.0));
        assert_eq!(tracker.players[&0].completed, 2);
    }

    #[test]
    fn average_life_uses_game_time_not_wall_time_or_stat_deltas() {
        let mut tracker = LifeTracker::default();
        for tick in 0..=8 {
            let mut snapshot = life_snapshot(f64::from(tick) / 4.0, tick > 0 && tick < 8);
            snapshot.game_time_seconds = Some(100.0 + f64::from(tick) / 8.0);
            snapshot.players[0].stats = Some(PlayerStats {
                kills: Some(tick * 2), deaths: Some(tick), assists: None, objective_score: None, shots_fired: None, shots_hit: None,
            });
            tracker.update(&mut snapshot);
            assert_eq!(snapshot.players[0].average_life_seconds, (tick == 8).then_some(0.875));
        }
        assert_eq!(tracker.players[&0].completed, 1);
    }

    #[test]
    fn average_life_resets_on_reconnect_and_reader_error() {
        let mut tracker = LifeTracker::default();
        complete_life(&mut tracker);
        assert!(tracker.record(Err("synthetic disconnect".into())).is_err());
        assert_eq!(life_sample(&mut tracker, 1.0, true), None);
        assert_eq!(life_sample(&mut tracker, 1.25, false), None);
        assert_eq!(life_sample(&mut LifeTracker::default(), 1.5, false), None);
    }

    #[test]
    fn average_life_survives_a_read_the_world_changed_under() {
        let mut tracker = LifeTracker::default();
        complete_life(&mut tracker);
        let error = format!("{CHANGED} (objects). Retry the snapshot");
        assert!(is_transient(&error) && !is_transient("synthetic disconnect"));
        assert!(tracker.record(Err(error)).is_err());
        assert_eq!(life_sample(&mut tracker, 1.0, false), Some(0.5));
    }

    #[test]
    fn average_life_resets_on_server_world_match_round_and_clock_changes() {
        for boundary in ["pid", "world", "map", "mode", "round", "lobby", "clock", "elapsed", "wall_clock", "phase"] {
            let mut tracker = LifeTracker::default();
            complete_life(&mut tracker);
            let mut snapshot = life_snapshot(1.0, true);
            match boundary {
                "pid" => snapshot.pid += 1,
                "world" => snapshot.world = 1,
                "map" => snapshot.map = Some(map_info("Live Fire")),
                "mode" => snapshot.match_info.as_mut().unwrap().mode = Some("Oddball".into()),
                "round" => snapshot.match_info.as_mut().unwrap().round_index = Some(1),
                "lobby" => { snapshot.in_match = false; snapshot.life_cycle = Some(8); },
                "clock" => snapshot.game_time_seconds = Some(0.0),
                "elapsed" => snapshot.match_info.as_mut().unwrap().elapsed_seconds = Some(0.0),
                "wall_clock" => snapshot.captured_unix_ms = 1,
                "phase" => snapshot.life_cycle = Some(10),
                _ => unreachable!(),
            }
            tracker.update(&mut snapshot);
            assert_eq!(snapshot.players[0].average_life_seconds, None, "{boundary}");
        }
    }

    #[test]
    fn average_life_resets_on_missing_clock_and_long_sample_gaps() {
        for boundary in ["missing", "nan", "negative", "wall_gap", "game_gap"] {
            let mut tracker = LifeTracker::default();
            complete_life(&mut tracker);
            let mut snapshot = life_snapshot(1.0, true);
            match boundary {
                "missing" => snapshot.game_time_seconds = None,
                "nan" => snapshot.game_time_seconds = Some(f64::NAN),
                "negative" => snapshot.game_time_seconds = Some(-1.0),
                "wall_gap" => snapshot.captured_unix_ms += 2000,
                "game_gap" => snapshot.game_time_seconds = snapshot.game_time_seconds.map(|now| now + 2.0),
                _ => unreachable!(),
            }
            tracker.update(&mut snapshot);
            assert_eq!(snapshot.players[0].average_life_seconds, None, "{boundary}");
        }
    }

    #[test]
    fn average_life_resets_on_player_slot_reuse_or_identity_change() {
        for boundary in ["handle", "name", "bot", "team", "observer", "missing"] {
            let mut tracker = LifeTracker::default();
            complete_life(&mut tracker);
            let mut snapshot = life_snapshot(1.0, true);
            match boundary {
                "handle" => snapshot.players[0].handle = "e1510000".into(),
                "name" => snapshot.players[0].name = Some("Replacement".into()),
                "bot" => snapshot.players[0].bot_handle = Some("12340000".into()),
                "team" => snapshot.players[0].team = Some(TeamId(1)),
                "observer" => snapshot.players[0].observer = true,
                "missing" => snapshot.players.clear(),
                _ => unreachable!(),
            }
            tracker.update(&mut snapshot);
            assert!(snapshot.players.iter().all(|player| player.average_life_seconds.is_none()), "{boundary}");
            assert_eq!(life_sample(&mut tracker, 1.25, true), None, "{boundary}");
        }
    }

    #[test]
    fn average_life_does_not_treat_unreadable_unit_or_vitality_as_a_death() {
        for unreadable_alive in [false, true] {
            let mut tracker = LifeTracker::default();
            life_sample(&mut tracker, 0.0, false);
            life_sample(&mut tracker, 0.25, true);
            let mut snapshot = life_snapshot(0.5, true);
            snapshot.players[0].alive = unreadable_alive;
            snapshot.players[0].vitality = None;
            tracker.update(&mut snapshot);
            assert_eq!(snapshot.players[0].average_life_seconds, None);
            assert_eq!(life_sample(&mut tracker, 0.75, true), None);
            assert_eq!(life_sample(&mut tracker, 1.0, false), None);
            assert_eq!(tracker.players[&0].completed, 0);
        }
    }

    #[test]
    fn average_life_rejects_unobserved_unit_replacement_and_corpse_revival() {
        let mut tracker = LifeTracker::default();
        life_sample(&mut tracker, 0.0, false);
        life_sample(&mut tracker, 0.25, true);
        let mut snapshot = life_snapshot(0.5, true);
        snapshot.players[0].unit = Some("e5b00240".into());
        tracker.update(&mut snapshot);
        assert_eq!(life_sample(&mut tracker, 0.75, false), None);
        let mut corpse = life_snapshot(1.0, true);
        corpse.players[0].alive = false;
        corpse.players[0].vitality.as_mut().unwrap().health = 0.0;
        tracker.update(&mut corpse);
        assert_eq!(life_sample(&mut tracker, 1.25, true), None);
        assert_eq!(life_sample(&mut tracker, 1.5, false), None);
    }

    #[test]
    fn average_life_accepts_observed_zero_health_death_once() {
        let mut tracker = LifeTracker::default();
        life_sample(&mut tracker, 0.0, false);
        life_sample(&mut tracker, 0.25, true);
        let mut corpse = life_snapshot(0.5, true);
        corpse.players[0].alive = false;
        corpse.players[0].vitality.as_mut().unwrap().health = 0.0;
        tracker.update(&mut corpse);
        assert_eq!(corpse.players[0].average_life_seconds, Some(0.25));
        tracker.update(&mut corpse);
        assert_eq!(life_sample(&mut tracker, 0.75, false), Some(0.25));
        assert_eq!(tracker.players[&0].completed, 1);
    }

    #[test]
    fn average_life_storage_is_bounded_and_unavailable_serializes_as_null() {
        let mut tracker = LifeTracker::default();
        let mut snapshot = life_snapshot(0.0, false);
        let player = snapshot.players[0].clone();
        snapshot.players = (0..=LIFE_PLAYER_LIMIT).map(|slot| Player { slot, ..player.clone() }).collect();
        tracker.update(&mut snapshot);
        assert_eq!(tracker.players.len(), LIFE_PLAYER_LIMIT);
        assert!(serde_json::to_value(&snapshot).unwrap()["players"][0]["average_life_seconds"].is_null());
        snapshot.players.clear();
        tracker.update(&mut snapshot);
        assert!(tracker.players.is_empty());
    }

    #[test]
    fn engine_coordinates_match_filmshell_axes_and_units() {
        let position = world_position([2.0, 3.0, 4.0]).unwrap();
        assert_eq!((position.x, position.y, position.z), (-30.0, 20.0, Some(40.0)));
        assert!(world_position([f32::NAN, 0.0, 0.0]).is_none());
        assert!(world_position([0.0, f32::INFINITY, 0.0]).is_none());
        assert!(world_position([2_000_000.0, 0.0, 0.0]).is_none());
        // Engine +x is map +y and engine +y is map -x, so the yaws turn with the positions.
        let yaw = |raw| world_yaw(raw).unwrap();
        assert!((yaw([1.0, 0.0, 0.0]) - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
        assert!((yaw([0.0, -1.0, 0.0])).abs() < 1e-9);
        assert!((yaw([0.0, 0.6, 0.8]).abs() - std::f64::consts::PI).abs() < 1e-9);
        assert!(world_yaw([0.0, 0.0, 1.0]).is_none());
        assert!(world_yaw([3.0, 0.0, 0.0]).is_none());
        assert!(world_yaw([f32::NAN, 0.0, 0.0]).is_none());
    }

    #[test]
    fn salted_handles_reject_reused_slots_and_other_worlds() {
        let mut entries = vec![0u8; 0x30];
        entries[0x18..0x1a].copy_from_slice(&0x1234u16.to_le_bytes());
        let pool = Pool { address: 0, stride: 0x18, limit: 2, data: 0, entries };
        assert_eq!(pool.handle(0), None);
        assert_eq!(pool.handle(1), Some(0x12340002));
        assert!(pool.resolve(0x12340002).is_some());
        assert!(pool.resolve(0x12350002).is_none());
        assert!(pool.resolve(0x12340003).is_none());
        assert!(pool.resolve(INVALID).is_none());
    }

    #[test]
    fn dispenser_states_and_timers_are_decoded_without_writing() {
        let mut bytes = vec![0u8; 0x5c];
        bytes[0x5a] = 1;
        bytes[0x10..0x14].copy_from_slice(&INVALID.to_le_bytes());
        bytes[0x18] = 4;
        bytes[0x20..0x24].copy_from_slice(&12.5f32.to_le_bytes());
        bytes[0x24..0x28].copy_from_slice(&30.0f32.to_le_bytes());
        let pad = dispenser(&bytes).unwrap();
        assert!(pad.enabled);
        assert_eq!(pad.slots[0].state, "respawning");
        assert_eq!(pad.slots[0].seconds_left, 12.5);
        assert_eq!(pad.slots[0].item, None);
        bytes[0x18] = 7;
        assert!(dispenser(&bytes).is_err());
        bytes[0x18] = 4;
        bytes[0x20..0x24].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(dispenser(&bytes).is_err());
    }

    #[test]
    fn map_path_matches_complete_catalogue_segments() {
        let map = map_info(r"levels\multi\ctf_aquarius\ctf_aquarius");
        assert_eq!(map.name, Some("ctf_aquarius"));
        assert_eq!(map.level_id.as_deref(), Some("a0bf5c4a"));
        assert_eq!(map_info("Bazaar").level_id.as_deref(), Some("4c2a2491"));
        assert_eq!(map_info("LIVE FIRE").level_id.as_deref(), Some("4ab52f9b"));
        assert!(map_info("ctf_aquarius_other").level_id.is_none());
    }

    #[test]
    fn incoming_countdown_uses_game_clock_and_full_interval() {
        let timing = IncomingTiming { started_game_seconds: 4294968944.262029, duration_seconds: 47.73771 };
        assert!((timing.remaining(4294968945.262029).unwrap() - 46.73771).abs() < 0.001);
        assert_eq!(timing.remaining(4294968992.63771), Some(0.0));
        assert_eq!(timing.remaining(4294968995.0), None);
        assert_eq!(timing.remaining(f64::NAN), None);
        assert_eq!(timing.remaining(4294968943.0), None);
        let mut values = [0u8; 0x40];
        values[0] = 5;
        values[8..0x10].copy_from_slice(&0x12345678u64.to_le_bytes());
        values[0x10] = 7;
        values[0x18..0x20].copy_from_slice(&0x87654320u64.to_le_bytes());
        values[0x20] = 3;
        values[0x28..0x2c].copy_from_slice(&10.0f32.to_le_bytes());
        values[0x30] = 3;
        values[0x38..0x3c].copy_from_slice(&47.73771f32.to_le_bytes());
        assert_eq!(incoming_frame_timestamp(&values, 0x12345678, 47.73771), Some(0x87654320));
        assert_eq!(incoming_frame_timestamp(&values, 0x12345679, 47.73771), None);
        assert_eq!(incoming_frame_timestamp(&values, 0x12345678, 10.0), None);
        assert_eq!(incoming_frame_timestamp(&values[..0x30], 0x12345678, 47.73771), None);
        values[0x38..0x3c].copy_from_slice(&f32::NAN.to_le_bytes());
        assert_eq!(incoming_frame_timestamp(&values, 0x12345678, 47.73771), None);
    }

    #[test]
    fn script_handles_require_the_expected_native_type() {
        assert_eq!(script_handle(Some((11, 0x01260000e3530208)), 0x126), Some(0xe3530208));
        assert_eq!(script_handle(Some((11, 0x000e0000e3530208)), 0x126), None);
        assert_eq!(script_handle(Some((3, 0x01260000e3530208)), 0x126), None);
        assert_eq!(script_handle(Some((11, 0x01260000ffffffff)), 0x126), None);
        assert_eq!(script_handle(Some((11, 0x01260001e3530208)), 0x126), None);
        assert_eq!(script_handle(None, 0x126), None);
    }

    /// The weapon and equipment ids a pad can hold, less None, CustomPowerup* and the Unused*
    /// slots no item has been seen in: each with its enum name and the name the page shows.
    const PAD_ITEMS: [(ObjectKind, u32, &str, &str); 43] = {
        use ObjectKind::{Equipment as E, Weapon as W};
        [
            (W, 1, "Disruptor", "Disruptor"), (W, 2, "PlasmaPistol", "Plasma Pistol"), (W, 3, "Mangler", "Mangler"),
            (W, 4, "SideKick", "Mk50 Sidekick"), (W, 8, "AssaultRifle", "MA40 Assault Rifle"),
            (W, 9, "PulseCarbine", "Pulse Carbine"), (W, 10, "UnusedAssault1", "Bandit Evo"),
            (W, 13, "BattleRifle", "BR75 Battle Rifle"), (W, 14, "CommandoRifle", "VK78 Commando Rifle"),
            (W, 18, "Needler", "Needler"), (W, 19, "SentinelBeam", "Sentinel Beam"), (W, 23, "Bulldog", "CQS48 Bulldog"),
            (W, 24, "Heatwave", "Heatwave"), (W, 28, "SniperRifle", "S7 Sniper Rifle"), (W, 29, "ShockRifle", "Shock Rifle"),
            (W, 30, "Skewer", "Skewer"), (W, 31, "StalkerRifle", "Stalker Rifle"), (W, 35, "Hydra", "MLRS-2 Hydra"),
            (W, 36, "Ravager", "Ravager"), (W, 37, "Cindershot", "Cindershot"), (W, 38, "RocketLauncher", "M41 Rocket Launcher"),
            (W, 42, "EnergySword", "Energy Sword"), (W, 43, "GravityHammer", "Gravity Hammer"), (W, 47, "Bandit", "M392 Bandit"),
            (W, 48, "Mutilator", "Mutilator"), (W, 49, "MA5K", "MA5K Avenger"),
            (W, 50, "FuelRodCannonOlympus", "Fuel Rod SPNKr"), (W, 51, "OlympusCarbine", "Vestige Carbine"),
            (E, 1, "Evade", "Thruster"), (E, 2, "Grapple", "Grappleshot"), (E, 3, "Knockback", "Repulsor"),
            (E, 4, "LocSensor", "Threat Sensor"), (E, 5, "Wall", "Drop Wall"), (E, 9, "FragGrenade", "M9 Frag Grenade"),
            (E, 10, "DynamoGrenade", "Dynamo Grenade"), (E, 11, "PlasmaGrenade", "Plasma Grenade"),
            (E, 12, "SpikeGrenade", "Spike Grenade"), (E, 16, "Camo", "Active Camo"), (E, 17, "OverShield", "Overshield"),
            (E, 21, "ShroudScreen", "Shroud Screen"), (E, 22, "QuantumTranslocator", "Quantum Translocator"),
            (E, 23, "ThreatSeeker", "Threat Seeker"), (E, 25, "RepairField", "Repair Field"),
        ]
    };

    #[test]
    fn every_pad_identifier_names_its_item() {
        for (kind, identifier, native, name) in PAD_ITEMS {
            // libfilmshell numbers the items as the DS's enums do.
            assert_eq!(filmshell::game::mp_item(kind, identifier).map(|item| item.name), Some(native), "{kind:?} {identifier}");
            assert_eq!(mp_item_name(kind, identifier), Some(name), "{native}");
        }
        // An Unused slot with no item, and an identifier of the other kind's.
        assert_eq!(mp_item_name(ObjectKind::Weapon, 5), None);
        assert_eq!(mp_item_name(ObjectKind::Equipment, 13), None);
        assert_eq!(mp_item_name(ObjectKind::Weapon, 1000), None);
    }

    #[test]
    fn every_pad_item_has_an_icon() {
        let store = crate::icons::IconStore::load(&crate::assets::Assets::built_in("icons")).unwrap();
        for (_, _, native, name) in PAD_ITEMS {
            assert!(store.index.items.contains_key(name), "{native} ({name}) has no icon");
        }
    }

    #[test]
    fn player_names_use_preferred_utf16_and_bounded_fallback() {
        let mut entry = vec![0u8; 0x1f40];
        for (index, unit) in "Fallback".encode_utf16().enumerate() {
            entry[0x1154 + index * 2..0x1156 + index * 2].copy_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(player_name(&entry).as_deref(), Some("Fallback"));
        for (index, unit) in "Pilot\u{00e9}".encode_utf16().enumerate() {
            entry[0x1200 + index * 2..0x1202 + index * 2].copy_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(player_name(&entry).as_deref(), Some("Pilot\u{00e9}"));
        entry[0x1200..0x1202].copy_from_slice(&0xd800u16.to_le_bytes());
        assert_eq!(player_name(&entry), None);
        entry[0x1200..0x1220].fill(0x41);
        assert_eq!(player_name(&entry), None);
        entry[0x1200..0x1220].fill(0);
        entry[0x1200..0x1202].copy_from_slice(&10u16.to_le_bytes());
        assert_eq!(player_name(&entry), None);
    }

    #[test]
    fn managed_timer_store_rejects_invalid_and_unallocated_entries() {
        let mut bytes = vec![0u8; 0x628];
        let offset = 0x28 + 3 * 0x18;
        bytes[offset + 0x14] = 2;
        bytes[offset + 4..offset + 8].copy_from_slice(&12.5f32.to_le_bytes());
        bytes[offset + 8..offset + 12].copy_from_slice(&30.0f32.to_le_bytes());
        bytes[offset + 0xf] = 6;
        assert!(managed_timers(&bytes).unwrap().is_empty());
        bytes[0x20..0x28].copy_from_slice(&(1u64 << 3).to_le_bytes());
        let timers = managed_timers(&bytes).unwrap();
        assert_eq!(timers.len(), 1);
        assert_eq!(timers[&3].seconds_left, 12.5);
        assert_eq!(timers[&3].timer_rate_index, 6);
        bytes[offset + 4..offset + 8].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(managed_timers(&bytes).is_err());
        assert!(managed_timers(&bytes[..100]).is_err());
    }

    #[test]
    fn vitality_requires_live_owner_and_component_generation() {
        use windows_sys::Win32::System::Threading::{PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

        let pid = std::process::id();
        let process = Ds { h: crate::open_raw(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ).unwrap(), pid, base: 0 };
        let unit = 0x12340000u32;
        let component_handle = 0x23450000u32;
        let mut object = vec![0u8; 0x500];
        object[..4].copy_from_slice(&unit.to_le_bytes());
        object[0xc + 0x268 + 0x28..0xc + 0x268 + 0x2c].copy_from_slice(&component_handle.to_le_bytes());
        object[0xc + 0x138..0xc + 0x13c].copy_from_slice(&(1u32 << 8).to_le_bytes());
        let mut component = vec![0u8; 0x100];
        component[8..12].copy_from_slice(&unit.to_le_bytes());
        component[0x10..0x14].copy_from_slice(&0x20u32.to_le_bytes());
        component[0x1c..0x20].copy_from_slice(&1i32.to_le_bytes());
        component[0x50..0x54].copy_from_slice(&0.75f32.to_le_bytes());
        component[0x84..0x88].copy_from_slice(&0.5f32.to_le_bytes());
        let mut objects = Pool { address: 0, stride: 0x18, limit: 1, data: 0, entries: vec![0u8; 0x18] };
        objects.entries[..2].copy_from_slice(&0x1234u16.to_le_bytes());
        objects.entries[0x10..0x18].copy_from_slice(&(object.as_ptr() as u64 + 0xc).to_le_bytes());
        objects.data = objects.entries.as_ptr() as u64;
        let mut components = Pool { address: 0, stride: 0x18, limit: 1, data: 0, entries: vec![0u8; 0x18] };
        components.entries[..2].copy_from_slice(&0x2345u16.to_le_bytes());
        components.entries[0x10..0x18].copy_from_slice(&(component.as_ptr() as u64).to_le_bytes());
        components.data = components.entries.as_ptr() as u64;
        let vitality = player_vitality(&process, &objects, &components, unit).unwrap().unwrap();
        assert_eq!(vitality.health, 0.75);
        assert_eq!(vitality.shield, Some(0.5));
        assert!(vitality.health_recharging);
        assert!(!vitality.shield_recharging);
        component[8..12].copy_from_slice(&0x12350000u32.to_le_bytes());
        std::hint::black_box(&component);
        assert!(player_vitality(&process, &objects, &components, unit).unwrap().is_none());
        component[8..12].copy_from_slice(&unit.to_le_bytes());
        components.entries[..2].copy_from_slice(&0x2346u16.to_le_bytes());
        assert!(player_vitality(&process, &objects, &components, unit).unwrap().is_none());
        assert!(player_vitality(&process, &objects, &components, INVALID).unwrap().is_none());
    }

    #[test]
    fn script_fields_respect_types_string_flags_and_table_bounds() {
        use windows_sys::Win32::System::Threading::{PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

        let pid = std::process::id();
        let process = Ds {
            h: crate::open_raw(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ).unwrap(),
            pid, base: 0,
        };
        let name = "MPWeaponManagerInstance";
        let mut string = vec![0u8; 0x15 + name.len()];
        string[8..0x10].copy_from_slice(&(name.len() as u64 | (3 << 62)).to_le_bytes());
        string[0x14..0x14 + name.len()].copy_from_slice(name.as_bytes());
        let mut nodes = [0u8; 0x40];
        nodes[0] = 4;
        nodes[8..0x10].copy_from_slice(&(string.as_ptr() as u64).to_le_bytes());
        nodes[0x10] = 5;
        nodes[0x18..0x20].copy_from_slice(&0x12345678u64.to_le_bytes());
        let mut table = [0u8; 0x28];
        table[0x1c..0x20].copy_from_slice(&1u32.to_le_bytes());
        table[0x20..0x28].copy_from_slice(&(nodes.as_ptr() as u64).to_le_bytes());
        let address = table.as_ptr() as u64;
        assert_eq!(script_field(&process, address, name).unwrap(), Some((5, 0x12345678)));
        assert_eq!(script_lookup(&process, address, name).unwrap(), Some((5, 0x12345678)));
        assert_eq!(script_field(&process, address, "MPEquipmentManagerInstance").unwrap(), None);
        nodes[0x10] = 0;
        std::hint::black_box(&nodes);
        assert_eq!(script_field(&process, address, name).unwrap(), None);
        table[0x1c..0x20].copy_from_slice(&u32::MAX.to_le_bytes());
        std::hint::black_box(&table);
        assert!(script_field(&process, address, name).is_err());
        table[0x1c..0x20].copy_from_slice(&2u32.to_le_bytes());
        std::hint::black_box(&table);
        assert!(script_field(&process, address, name).is_err());
        assert!(script_field(&process, 0, name).is_err());
    }
}