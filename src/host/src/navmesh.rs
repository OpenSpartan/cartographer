//! Experimental, read only: a floor plan of whatever map the server has loaded, from the
//! navigation mesh its bots path on, in the shape of film-assets' plans (geometry.rs). A Forge
//! map with no plan in film-assets (a community map) gets one this way, when its author baked a
//! navmesh. Used only by the `navmesh` dev command, not by `serve`.
//!
//! The server keeps one AI world per map, made at every map load, and in it a collection of
//! navmesh instances: each the original mesh (its faces, edges and vertices, as a Forge map's
//! `navmesh.blob` holds them), the frame it is placed in and the layer it belongs to.
//!
//! A Forge map's navmesh comes from the `navmesh.blob` among its files, a studio level's from its
//! level data. Both end up as instances in that collection. The original mesh is the baked one:
//! cutting by moving objects happens in the instance, never in it.
//!
//! The plan is libfilmshell's (`filmshell::floor`), the algorithm film-assets' plans are made
//! with: each section's boundary chained through the corners its seams repeat, in world units,
//! crumbs dropped, simplified, a piece wound clockwise turned, each hole started inside its own
//! floor, a section's ring repeated in another kept once, at 0.1 wu. It is the plan of the whole
//! navmesh: film-assets cuts a Forge map's plan to where players may be, by its map variant's kill
//! and safe volumes and spawn points (`NavMesh::rings_within`).
//!
//! Beside the plan it reads where players die or are kept safe: the Forge volumes the game
//! rebuilds each tick (ForgeVolume) and the level's kill trigger volumes (LevelVolume).

use filmshell::floor::{self, Edge, Face, Frame, NavMesh};
use serde::Serialize;

use crate::geometry::FloorRing;
use crate::{get, Ds};

/// The AI world, and what each part of it is, checked before it is read: the world, its
/// collection of instances, an instance and a mesh.
const AI_MANAGER: u64 = 0x4976770;
const MANAGER_WORLD: u64 = 0x454460;
const WORLD_KIND: u64 = 0x39a8638;
const WORLD_COLLECTION: u64 = 0x130;
const COLLECTION_KIND: u64 = 0x39a8618;
const INSTANCE_INFO: usize = 0x110;
const INSTANCE_KIND: u64 = 0x39a85d8;
const NAVMESH_KIND: u64 = 0x39aa158;
/// The map's nav data, kept while the map is loaded. A Forge map's holds the `navmesh.blob` it was
/// made from. A studio level's reads its level data instead.
const FORGE_NAV_DATA: u64 = 0x52385d0;
const FORGE_NAV_DATA_KIND: u64 = 0x3c41500;
const LEVEL_NAV_DATA_KIND: u64 = 0x3686bd8;

const MAX_INSTANCES: usize = 4096;
const MAX_FACES: usize = 1 << 20;
const MAX_EDGES: usize = 1 << 22;
const MAX_VERTICES: usize = 1 << 21;
const MAX_BLOB: usize = 64 << 20;

/// Process memory, or a test's image of it.
pub trait Memory {
    fn bytes(&self, address: u64, length: usize) -> Result<Vec<u8>, String>;
}

impl Memory for Ds {
    fn bytes(&self, address: u64, length: usize) -> Result<Vec<u8>, String> { self.read_abs(address, length) }
}

/// An array's elements, `stride` bytes each and at most `maximum` of them.
fn array(memory: &impl Memory, header: &[u8], offset: usize, stride: usize, maximum: usize, what: &str) -> Result<Vec<u8>, String> {
    let data = get::<u64>(header, offset);
    let size = get::<i32>(header, offset + 8);
    let size = usize::try_from(size).ok().filter(|size| *size <= maximum).ok_or(format!("unexpected {what} count"))?;
    if size == 0 { return Ok(Vec::new()); }
    if data < 0x10000 { return Err(format!("no {what} array")); }
    memory.bytes(data, size * stride)
}

/// The navmesh at `address` (its kind checked by the caller), where it was baked.
pub fn mesh_at(memory: &impl Memory, address: u64) -> Result<NavMesh, String> {
    let header = memory.bytes(address, 0xf0)?;
    let faces = array(memory, &header, 0x18, 12, MAX_FACES, "face")?;
    let edges = array(memory, &header, 0x28, 20, MAX_EDGES, "edge")?;
    let vertices = array(memory, &header, 0x38, 16, MAX_VERTICES, "vertex")?;
    // An index, or none (all ones).
    let index = |bytes: &[u8], offset: usize| match get::<u32>(bytes, offset) { u32::MAX => None, index => Some(index as usize) };
    let mesh = NavMesh {
        vertices: vertices.chunks_exact(16).map(|v| [0, 4, 8].map(|o| f32::from_bits(get(v, o)))).collect(),
        faces: faces.chunks_exact(12).map(|f| Face { first_edge: get::<u32>(f, 0) as usize, edge_count: (get::<u16>(f, 8) as i16).max(0) as usize }).collect(),
        edges: edges.chunks_exact(20).map(|e| Edge {
            start: get::<u32>(e, 0) as usize, end: get::<u32>(e, 4) as usize, opposite_edge: index(e, 8), opposite_face: index(e, 12),
        }).collect(),
        frame: Frame::IDENTITY,
    };
    let (vertices, edges) = (mesh.vertices.len(), mesh.edges.len());
    if mesh.edges.iter().any(|edge| edge.start >= vertices || edge.end >= vertices)
        || mesh.faces.iter().any(|face| face.first_edge.saturating_add(face.edge_count) > edges)
        || mesh.vertices.iter().flatten().any(|value| !value.is_finite() || value.abs() > 1_000_000.0)
    {
        return Err("navmesh indices or vertices out of range".into());
    }
    Ok(mesh)
}

/// An instance's reference frame: its rotation columns and its translation.
fn frame_at(bytes: &[u8]) -> Frame {
    let vector = |offset: usize| [0, 4, 8].map(|o| f32::from_bits(get(bytes, offset + o)));
    Frame { columns: [vector(0), vector(0x10), vector(0x20)], translation: vector(0x30) }
}

/// Engine axes and units to the plans' world units (observer::world_position's frame).
fn to_world(v: [f32; 3]) -> [f32; 3] { [-10.0 * v[1], 10.0 * v[0], 10.0 * v[2]] }

/// 0.1 wu, as the plans print it (and never -0).
fn tenth(value: f32) -> f64 {
    let rounded = (value * 10.0).round() / 10.0;
    format!("{rounded:.1}").parse::<f64>().map_or(f64::NAN, |tenth| tenth + 0.0)
}

/// A libfilmshell ring as a plan's, at 0.1 wu.
pub fn floor_ring(ring: &floor::Ring) -> FloorRing {
    let floor::Ring { z, hole, p } = ring.rounded();
    FloorRing { z, hole, p }
}

/// The meshes' plan (`floor::plan`): each mesh's rings in turn, a ring repeated exactly kept once,
/// each hole starting inside its own floor among them all.
pub fn rings<'a>(meshes: impl IntoIterator<Item = &'a NavMesh>) -> Vec<FloorRing> {
    floor::plan(meshes).iter().map(floor_ring).collect()
}

/// One navmesh instance the server has loaded.
#[derive(Clone, Debug, Serialize)]
pub struct Section {
    pub slot: usize,
    pub section_uid: u32,
    pub runtime_id: i32,
    pub layer: u32,
    pub faces: usize,
    pub edges: usize,
    pub vertices: usize,
    /// Whether the instance sits where it was baked (expected of every static section).
    pub identity_frame: bool,
    pub frame: Frame,
    /// The mesh's bounds in world units: min x, min y, min z, max x, max y, max z.
    pub bounds: [f64; 6],
}

/// Every navmesh in the server's AI world, each in its frame.
pub fn sections(ds: &Ds) -> Result<Vec<(Section, NavMesh)>, String> {
    let manager = ds.u64(AI_MANAGER)?;
    if manager < 0x10000 { return Err("no AI world: the server has no map loaded".into()); }
    let world = ds.at::<u64>(manager + MANAGER_WORLD)?;
    let kind = |address: u64| ds.at::<u64>(address).map(|kind| kind.wrapping_sub(ds.base));
    if world < 0x10000 || kind(world)? != WORLD_KIND { return Err(format!("unexpected AI world at {world:x}")); }
    let collection = ds.at::<u64>(world + WORLD_COLLECTION)?;
    let header = ds.read_abs(collection, 0x48)?;
    if get::<u64>(&header, 0) != ds.va(COLLECTION_KIND) {
        return Err(format!("unexpected navmesh collection at {collection:x} (kind {:x})", get::<u64>(&header, 0).wrapping_sub(ds.base)));
    }
    let infos = array(ds, &header, 0x38, INSTANCE_INFO, MAX_INSTANCES, "navmesh instance")?;
    let mut out = Vec::new();
    for (slot, info) in infos.chunks_exact(INSTANCE_INFO).enumerate() {
        let instance = get::<u64>(info, 0);
        if instance < 0x10000 { continue; }
        let bytes = ds.read_abs(instance, 0x100)?;
        if get::<u64>(&bytes, 0) != ds.va(INSTANCE_KIND) {
            return Err(format!("instance {slot} at {instance:x}: kind {:x}", get::<u64>(&bytes, 0).wrapping_sub(ds.base)));
        }
        let data = ds.read_abs(get::<u64>(&bytes, 0x20), 0x1f0)?;
        let original = get::<u64>(&data, 0x68);
        if original < 0x10000 || kind(original)? != NAVMESH_KIND {
            return Err(format!("instance {slot}: unexpected navmesh at {original:x}"));
        }
        let mut mesh = mesh_at(ds, original)?;
        mesh.frame = frame_at(&bytes[0x60..0xa0]);
        let frame = mesh.frame;
        let world: Vec<[f32; 3]> = mesh.vertices.iter().map(|&v| to_world(frame.apply(v))).collect();
        let bound = |k: usize, pick: fn(f32, f32) -> f32, start: f32| f64::from(world.iter().map(|v| v[k]).fold(start, pick));
        let bounds = if world.is_empty() { [0.0; 6] } else {
            [bound(0, f32::min, f32::MAX), bound(1, f32::min, f32::MAX), bound(2, f32::min, f32::MAX),
             bound(0, f32::max, f32::MIN), bound(1, f32::max, f32::MIN), bound(2, f32::max, f32::MIN)]
        };
        out.push((Section {
            slot, section_uid: get(&data, 0x178), runtime_id: get(&data, 0x17c), layer: get(&data, 0x180),
            faces: mesh.faces.len(), edges: mesh.edges.len(), vertices: mesh.vertices.len(),
            identity_frame: frame == Frame::IDENTITY, frame, bounds,
        }, mesh));
    }
    Ok(out)
}

/// The bytes of the Forge map's `navmesh.blob` as the server read them from the map's files, or
/// None on a studio level or a Forge map with no baked navmesh. They give film-assets' forge-geo
/// the exact same input it reads from a download.
pub fn forge_blob(ds: &Ds) -> Result<Option<Vec<u8>>, String> {
    let data = ds.u64(FORGE_NAV_DATA)?;
    if data < 0x10000 { return Ok(None); }
    let header = ds.read_abs(data, 0x38)?;
    let kind = get::<u64>(&header, 0).wrapping_sub(ds.base);
    if kind == LEVEL_NAV_DATA_KIND { return Ok(None); }
    if kind != FORGE_NAV_DATA_KIND { return Err(format!("unexpected nav data (kind {kind:x})")); }
    let (size, bytes) = (get::<u32>(&header, 8) as usize, get::<u64>(&header, 0x10));
    if size == 0 || bytes < 0x10000 { return Ok(None); }
    if size > MAX_BLOB { return Err("navmesh blob too large".into()); }
    let blob = ds.read_abs(bytes, size)?;
    let be = |offset: usize| u32::from_be_bytes(blob[offset..offset + 4].try_into().unwrap()) as usize;
    if size < 12 || be(0) != 2 || be(4) != size - 12 { return Err("the Forge nav data holds no navmesh blob".into()); }
    Ok(Some(blob))
}

/// A Forge volume as the game tests players against it: one of up to 64 entries that it rebuilds
/// each tick from the objects with volume properties (observer.rs reads them). Each holds its
/// shape (sphere, cylinder or box) and size, its scale, axes and position in engine units, a
/// bounding radius and the handle of its object.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ForgeVolume {
    pub object: String,
    /// kill, soft_kill, safe or soft_safe (from the object's multiplayer properties), or other.
    pub kind: &'static str,
    /// The object's multiplayer properties type: 15 kill, 14 safe.
    pub properties_type: Option<u8>,
    pub soft: Option<bool>,
    pub shape: &'static str,
    /// The volume's centre, world units, the plans' frame.
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Heading of the volume's forward axis, radians from +x toward +y.
    pub yaw: Option<f64>,
    /// [radius or length, width, height above, depth below], world units, as stored (scale not applied).
    pub size: [f64; 4],
    pub scale: f32,
    pub bounding_radius: f64,
}

/// A Forge volume entry's shape, centre and size (the kind comes from its object).
pub fn forge_volume(entry: &[u8]) -> Option<(u32, ForgeVolume)> {
    if entry.len() < 100 { return None; }
    let float = |offset: usize| f32::from_bits(get(entry, offset));
    let shape = match entry[0x10] { 1 => "sphere", 2 => "cylinder", 3 => "box", _ => return None };
    let position = [float(0x3c), float(0x40), float(0x44)];
    let forward = [float(0x18), float(0x1c), float(0x20)];
    let size = [float(0), float(4), float(8), float(0xc).abs()];
    if position.iter().chain(&size).chain(&forward).any(|value| !value.is_finite() || value.abs() > 1_000_000.0) { return None; }
    let world = to_world(position);
    let handle = get::<u32>(entry, 0x60);
    Some((handle, ForgeVolume {
        object: format!("{handle:08x}"), kind: "other", properties_type: None, soft: None, shape,
        x: f64::from(world[0]), y: f64::from(world[1]), z: f64::from(world[2]),
        yaw: crate::observer::world_yaw(forward),
        size: size.map(|value| f64::from(value) * 10.0), scale: float(0x14), bounding_radius: f64::from(float(0x48)) * 10.0,
    }))
}

/// What a Forge volume does, from its object's multiplayer properties type and soft flag.
pub fn volume_kind(properties_type: u8, soft: bool) -> &'static str {
    match (properties_type, soft) {
        (15, false) => "kill",
        (15, true) => "soft_kill",
        (14, false) => "safe",
        (14, true) => "soft_safe",
        _ => "other",
    }
}

/// The loaded level's data, and its trigger volume block: its elements, its definition (which
/// gives the element size) and its count. The game world splits the block among the level's
/// layers, and names it by this offset.
const LEVEL: u64 = 0x4976b60;
const TRIGGER_VOLUMES: u64 = 0x3bc;

/// A level trigger volume the game kills players in: a box or a prism of sectors, placed by yaw,
/// pitch and roll and a position, with its name, whether it is attached to something and the
/// index of its bit in the live world's kill trigger volume state, which is set while a game mode
/// or script turns the volume off.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LevelVolume {
    pub index: usize,
    pub name: Option<String>,
    pub shape: &'static str,
    pub attached: bool,
    pub flags: u8,
    pub kill_index: i16,
    /// None when the live world's state could not be read.
    pub disabled: Option<bool>,
    /// The level layer that holds it, and whether the live world has that layer on.
    pub layer: Option<u32>,
    pub layer_active: Option<bool>,
    /// The footprint from above (the convex hull of the box's or the sectors' bounding corners),
    /// world units, flat x, y pairs like a plan ring.
    pub p: Vec<f64>,
    pub z: [f64; 2],
}

/// A trigger volume element as a kill volume's footprint, or None when it is not a kill volume.
pub fn level_volume(index: usize, element: &[u8]) -> Option<LevelVolume> {
    if element.len() < 0xb2 || element[0x16] != 1 { return None; }
    let float = |offset: usize| f32::from_bits(get(element, offset));
    let (yaw, pitch, roll) = (float(0x38), float(0x3c), float(0x40));
    let origin = [float(0x44), float(0x48), float(0x4c)];
    let shape = match get::<u16>(element, 0x14) { 0 => "box", 1 => "sectors", _ => return None };
    // Forward, left and up from the three angles
    let (cy, sy, cp, sp, cr, sr) = (yaw.cos(), yaw.sin(), pitch.cos(), pitch.sin(), roll.cos(), roll.sin());
    let forward = [cy * cp, sy * cp, sp];
    let left = [-cy * sr * sp - sy * cr, cy * cr - sy * sr * sp, cp * sr];
    let up = [sy * sr - cy * cr * sp, -sy * cr * sp - cy * sr, cp * cr];
    let ranges = if shape == "box" {
        let half = [float(0x58), float(0x5c), float(0x60)];
        [[-half[0], half[0]], [-half[1], half[1]], [-half[2], half[2]]]
    } else {
        [[float(0x94), float(0x98)], [float(0x9c), float(0xa0)], [float(0xa4), float(0xa8)]]
    };
    if ranges.iter().flatten().chain(&origin).chain(&[yaw, pitch, roll]).any(|value| !value.is_finite() || value.abs() > 100_000.0) { return None; }
    let mut corners = Vec::with_capacity(8);
    for a in ranges[0] {
        for b in ranges[1] {
            for c in ranges[2] {
                corners.push(to_world([0, 1, 2].map(|k| origin[k] + forward[k] * a + left[k] * b + up[k] * c)));
            }
        }
    }
    let low = corners.iter().map(|v| v[2]).fold(f32::MAX, f32::min);
    let high = corners.iter().map(|v| v[2]).fold(f32::MIN, f32::max);
    let hull = convex_hull(corners.iter().map(|v| (f64::from(v[0]), f64::from(v[1]))).collect());
    Some(LevelVolume {
        index, name: None, shape, attached: get::<u32>(element, 4) != 0, flags: element[0x17], kill_index: get::<u16>(element, 0xb0) as i16,
        disabled: None, layer: None, layer_active: None, p: hull.iter().flat_map(|&(x, y)| [tenth(x as f32), tenth(y as f32)]).collect(), z: [tenth(low), tenth(high)],
    })
}

/// Counter-clockwise convex hull (monotone chain).
fn convex_hull(mut points: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    points.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    points.dedup();
    if points.len() < 3 { return points; }
    let cross = |o: (f64, f64), a: (f64, f64), b: (f64, f64)| (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0);
    let mut hull: Vec<(f64, f64)> = Vec::new();
    for pass in 0..2 {
        let start = hull.len();
        let ordered: Box<dyn Iterator<Item = &(f64, f64)>> = if pass == 0 { Box::new(points.iter()) } else { Box::new(points.iter().rev()) };
        for &point in ordered {
            while hull.len() >= start + 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], point) <= 0.0 { hull.pop(); }
            hull.push(point);
        }
        hull.pop();
    }
    hull
}

/// The game world: the level data, one content source per layer and a map from a block to its
/// slot in the layers' ranges.
const GAME_WORLD: u64 = 0x4eb5868;
/// The level's layers, each with the range of a block's elements it holds, by slot.
const LAYERS: u64 = 0xa64;
const LAYER: u64 = 0xbc;

/// Which layer holds each trigger volume (a block the game world's map does not name belongs
/// whole to layer 0). A layer is on while the live world has it on (with none set, all are).
pub fn trigger_volume_layers(ds: &Ds, level: u64, count: usize) -> Result<Vec<Option<u32>>, String> {
    let world = ds.u64(GAME_WORLD)?;
    if world < 0x10000 || ds.at::<u64>(world + 8)? != level { return Err("unexpected game world".into()); }
    let head = ds.at::<u64>(world + 0x28)?;
    let (mut node, mut found) = (ds.at::<u64>(head + 8)?, head);
    for _ in 0..64 {
        if node == head || node < 0x10000 || ds.at::<u8>(node + 0x19)? != 0 { break; }
        if ds.at::<u32>(node + 0x1c)? < TRIGGER_VOLUMES as u32 { node = ds.at(node + 0x10)?; } else { found = node; node = ds.at(node)?; }
    }
    let slot = if found != head && ds.at::<u32>(found + 0x1c)? == TRIGGER_VOLUMES as u32 { Some(ds.at::<i32>(found + 0x20)?) } else { None };
    let mut owner = vec![None; count];
    match slot.and_then(|slot| u64::try_from(slot).ok()) {
        Some(slot) => {
            let layers = ds.read_abs(level + LAYERS, 0x14)?;
            let layer_count = u32::try_from(get::<i32>(&layers, 0x10)).ok().filter(|count| *count <= 256).ok_or("unexpected layer count")?;
            for layer in 0..layer_count {
                let ranges = ds.at::<u64>(get::<u64>(&layers, 0) + u64::from(layer) * LAYER + 0xc)?;
                let range = ds.read_abs(ranges + slot * 8, 8)?;
                let (first, end) = (get::<i32>(&range, 0).max(0) as usize, get::<i32>(&range, 4).max(0) as usize);
                owner.iter_mut().take(end.min(count)).skip(first).for_each(|owner| *owner = Some(layer));
            }
        }
        None => owner.fill(Some(0)),
    }
    Ok(owner)
}

/// The loaded level's kill trigger volumes, every layer's (LevelVolume::layer says whose).
pub fn level_kill_volumes(ds: &Ds) -> Result<Vec<LevelVolume>, String> {
    let level = ds.u64(LEVEL)?;
    if level < 0x10000 { return Err("no level loaded".into()); }
    let block = ds.read_abs(level + TRIGGER_VOLUMES, 0x14)?;
    let (elements, definition) = (get::<u64>(&block, 0), get::<u64>(&block, 8));
    let count = usize::try_from(get::<i32>(&block, 0x10)).ok().filter(|count| *count <= 4096).ok_or("unexpected trigger volume count")?;
    if count == 0 { return Ok(Vec::new()); }
    let layout = ds.at::<u64>(definition + 0x18)?;
    let stride = ds.at::<u32>(layout + 0x28)? as usize;
    if !(0xb4..=0x400).contains(&stride) || elements < 0x10000 { return Err(format!("unexpected trigger volume block (element size {stride:#x})")); }
    let bytes = ds.read_abs(elements, count * stride)?;
    let owners = trigger_volume_layers(ds, level, count).unwrap_or_default();
    Ok(bytes.chunks_exact(stride).enumerate().filter_map(|(index, element)| {
        let mut volume = level_volume(index, element)?;
        volume.name = filmshell::game::text(filmshell::StringId(get(element, 0))).map(str::to_owned);
        volume.layer = owners.get(index).copied().flatten();
        Some(volume)
    }).collect())
}

/// The experimental plan, film-assets' shape plus what the read found.
#[derive(Clone, Debug, Serialize)]
pub struct LiveFloor {
    pub level: String,
    #[serde(rename = "levlId")]
    pub level_id: String,
    #[serde(rename = "sbspId")]
    pub structure_id: String,
    pub units: &'static str,
    pub fill: &'static str,
    #[serde(rename = "mapAssetId", skip_serializing_if = "Option::is_none")]
    pub map_asset_id: Option<String>,
    #[serde(rename = "mapVersionId", skip_serializing_if = "Option::is_none")]
    pub map_version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub rings: Vec<FloorRing>,
    pub live: LiveDetails,
}

#[derive(Clone, Debug, Serialize)]
pub struct LiveDetails {
    pub experimental: bool,
    pub source: &'static str,
    pub sections: Vec<Section>,
    /// None when the live world's engine root could not be found.
    pub forge_volumes: Option<Vec<ForgeVolume>>,
    /// The level's kill trigger volumes, None when the block could not be read.
    pub level_kill_volumes: Option<Vec<LevelVolume>>,
    /// The size of the Forge map's navmesh.blob the server holds, when it holds one.
    pub navmesh_blob_bytes: Option<usize>,
    pub warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A memory image: bytes at a base address.
    struct Image { base: u64, bytes: Vec<u8>, reads: RefCell<usize> }

    impl Memory for Image {
        fn bytes(&self, address: u64, length: usize) -> Result<Vec<u8>, String> {
            *self.reads.borrow_mut() += 1;
            let start = address.checked_sub(self.base).ok_or("below the image")? as usize;
            self.bytes.get(start..start + length).map(<[u8]>::to_vec).ok_or("past the image".into())
        }
    }

    /// A mesh laid out as the server holds it: the mesh at the base, then its arrays. Each
    /// edge is (start, end, opposite edge, opposite face).
    fn image(vertices: &[[f32; 3]], faces: &[(u32, i16)], edges: &[(u32, u32, u32, u32)]) -> Image {
        let base = 0x2000_0000u64;
        let mut bytes = vec![0u8; 0x100];
        let put = |offset: usize, data: Vec<u8>, count: usize, bytes: &mut Vec<u8>| {
            let at = bytes.len() as u64;
            bytes.extend(data);
            bytes[offset..offset + 8].copy_from_slice(&(base + at).to_le_bytes());
            bytes[offset + 8..offset + 12].copy_from_slice(&(count as i32).to_le_bytes());
        };
        let faces_bytes = faces.iter().flat_map(|&(first, count)| {
            let mut face = vec![0u8; 12];
            face[0..4].copy_from_slice(&first.to_le_bytes());
            face[8..10].copy_from_slice(&count.to_le_bytes());
            face
        }).collect();
        let edges_bytes = edges.iter().flat_map(|&(a, b, opposite_edge, opposite_face)| {
            let mut edge = vec![0u8; 20];
            for (offset, value) in [(0, a), (4, b), (8, opposite_edge), (12, opposite_face)] {
                edge[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            }
            edge
        }).collect();
        let vertex_bytes = vertices.iter().flat_map(|v| [v[0], v[1], v[2], 0.0].into_iter().flat_map(f32::to_le_bytes)).collect();
        put(0x18, faces_bytes, faces.len(), &mut bytes);
        put(0x28, edges_bytes, edges.len(), &mut bytes);
        put(0x38, vertex_bytes, vertices.len(), &mut bytes);
        Image { base, bytes, reads: RefCell::new(0) }
    }

    const NONE: u32 = u32::MAX;

    /// A 2 x 2 engine-unit square (20 x 20 wu) as two triangles sharing their diagonal.
    fn square() -> Image {
        image(
            &[[0.0, 0.0, 1.0], [2.0, 0.0, 1.0], [2.0, 2.0, 1.5], [0.0, 2.0, 1.0]],
            &[(0, 3), (3, 3)],
            &[(0, 1, NONE, NONE), (1, 2, NONE, NONE), (2, 0, 3, 1), (0, 2, 2, 0), (2, 3, NONE, NONE), (3, 0, NONE, NONE)],
        )
    }

    #[test]
    fn the_mesh_reads_from_its_arrays() {
        let memory = square();
        let mesh = mesh_at(&memory, memory.base).unwrap();
        assert_eq!(mesh.vertices.len(), 4);
        assert_eq!(mesh.faces, vec![Face { first_edge: 0, edge_count: 3 }, Face { first_edge: 3, edge_count: 3 }]);
        assert_eq!(mesh.edges[2], Edge { start: 2, end: 0, opposite_edge: Some(3), opposite_face: Some(1) });
        assert_eq!(mesh.edges[0], Edge { start: 0, end: 1, opposite_edge: None, opposite_face: None });
        assert_eq!(mesh.frame, Frame::IDENTITY);
        assert_eq!(*memory.reads.borrow(), 4);
    }

    #[test]
    fn out_of_range_indices_are_refused() {
        let memory = image(&[[0.0; 3]; 3], &[(0, 3)], &[(0, 1, NONE, NONE), (1, 2, NONE, NONE), (2, 7, NONE, NONE)]);
        assert!(mesh_at(&memory, memory.base).is_err());
        let memory = image(&[[0.0; 3]; 3], &[(1, 3)], &[(0, 1, NONE, NONE), (1, 2, NONE, NONE), (2, 0, NONE, NONE)]);
        assert!(mesh_at(&memory, memory.base).is_err());
    }

    #[test]
    fn the_boundary_is_one_counter_clockwise_ring_in_world_units() {
        let memory = square();
        let mesh = mesh_at(&memory, memory.base).unwrap();
        let rings = rings([&mesh]);
        assert_eq!(rings.len(), 1);
        assert!(!rings[0].hole);
        assert_eq!(rings[0].z, [10.0, 15.0]);
        // engine (x, y) -> world (-10 y, 10 x), starting where the first boundary edge starts
        assert_eq!(rings[0].p, vec![0.0, 0.0, 0.0, 20.0, -20.0, 20.0, -20.0, 0.0]);
        let plan = serde_json::json!({"level": "t", "levlId": "00000000", "sbspId": "00000000", "units": "world", "fill": "nonzero", "rings": rings});
        assert!(crate::geometry::FloorPlan::parse(plan.to_string().as_bytes(), "00000000").is_ok());
        // Two sections holding the same ring draw it once.
        assert_eq!(super::rings([&mesh, &mesh]).len(), 1);
    }

    #[test]
    fn a_seam_that_repeats_its_corners_is_one_ring() {
        // Two squares side by side, the right one repeating the corners they share, a little higher.
        // Only the opposite edges say the corners are one.
        let memory = image(
            &[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.1], [1.0, 1.0, 0.1], [2.0, 0.0, 0.1], [2.0, 1.0, 0.1]],
            &[(0, 4), (4, 4)],
            &[(0, 1, NONE, NONE), (1, 2, 7, 1), (2, 3, NONE, NONE), (3, 0, NONE, NONE), (4, 6, NONE, NONE), (6, 7, NONE, NONE), (7, 5, NONE, NONE), (5, 4, 1, 0)],
        );
        let mesh = mesh_at(&memory, memory.base).unwrap();
        let rings = rings([&mesh]);
        assert_eq!(rings.len(), 1);
        assert_eq!((rings[0].z, &rings[0].p), ([0.0, 1.0], &vec![0.0, 0.0, 0.0, 20.0, -10.0, 20.0, -10.0, 0.0]));
    }

    #[test]
    fn an_instance_frame_reads_its_columns_and_translation() {
        let mut bytes = vec![0u8; 0x40];
        for (offset, value) in [(0x0, 1.0f32), (0x14, 1.0), (0x28, 1.0), (0x30, 5.0)] {
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        assert_eq!(frame_at(&bytes), Frame { translation: [5.0, 0.0, 0.0], ..Frame::IDENTITY });
    }

    #[test]
    fn a_forge_box_volume_reads_in_world_units() {
        let mut entry = vec![0u8; 100];
        let mut put = |offset: usize, value: f32| entry[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        for (offset, value) in [(0x0, 3.0), (0x4, 2.0), (0x8, 1.0), (0xc, -0.5), (0x14, 1.0), (0x18, 0.0), (0x1c, 1.0), (0x3c, 1.0), (0x40, 2.0), (0x44, 0.5), (0x48, 4.0)] {
            put(offset, value);
        }
        entry[0x10] = 3;
        entry[0x60..0x64].copy_from_slice(&0x1234_0002u32.to_le_bytes());
        let (handle, volume) = forge_volume(&entry).unwrap();
        assert_eq!(handle, 0x1234_0002);
        assert_eq!((volume.shape, volume.object.as_str()), ("box", "12340002"));
        assert_eq!((volume.x, volume.y, volume.z), (-20.0, 10.0, 5.0));
        assert_eq!(volume.size, [30.0, 20.0, 10.0, 5.0]);
        assert_eq!(volume.bounding_radius, 40.0);
        // engine +y is world -x: a heading of pi
        assert!((volume.yaw.unwrap().abs() - std::f64::consts::PI).abs() < 1e-6);
        entry[0x10] = 9;
        assert!(forge_volume(&entry).is_none());
        assert_eq!((volume_kind(15, false), volume_kind(15, true), volume_kind(14, true), volume_kind(3, false)), ("kill", "soft_kill", "soft_safe", "other"));
    }

    #[test]
    fn a_level_kill_box_is_its_footprint_from_above() {
        let mut element = vec![0u8; 0xb4];
        let mut put = |offset: usize, value: f32| element[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        // turned a quarter (yaw), at engine (1, 2, 3), half extents 2 x 1 x 0.5
        for (offset, value) in [(0x38, std::f32::consts::FRAC_PI_2), (0x44, 1.0), (0x48, 2.0), (0x4c, 3.0), (0x58, 2.0), (0x5c, 1.0), (0x60, 0.5)] {
            put(offset, value);
        }
        element[0x16] = 1;
        element[0xb0..0xb2].copy_from_slice(&7u16.to_le_bytes());
        let volume = level_volume(3, &element).unwrap();
        assert_eq!((volume.index, volume.shape, volume.kill_index, volume.attached), (3, "box", 7, false));
        assert_eq!(volume.z, [25.0, 35.0]);
        // engine x spans 0..2 and y 0..4 once turned: world x = -10 y spans -40..0, y = 10 x spans 0..20
        let xs: Vec<f64> = volume.p.iter().step_by(2).copied().collect();
        let ys: Vec<f64> = volume.p.iter().skip(1).step_by(2).copied().collect();
        assert_eq!(volume.p.len(), 8);
        assert_eq!((xs.iter().copied().fold(f64::MAX, f64::min), xs.iter().copied().fold(f64::MIN, f64::max)), (-40.0, 0.0));
        assert_eq!((ys.iter().copied().fold(f64::MAX, f64::min), ys.iter().copied().fold(f64::MIN, f64::max)), (0.0, 20.0));
        element[0x16] = 0;
        assert!(level_volume(3, &element).is_none());
    }

    #[test]
    fn the_hull_keeps_only_the_outer_corners_counter_clockwise() {
        let hull = convex_hull(vec![(0.0, 0.0), (2.0, 0.0), (1.0, 1.0), (2.0, 2.0), (0.0, 2.0), (2.0, 0.0)]);
        assert_eq!(hull, vec![(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)]);
    }
}
