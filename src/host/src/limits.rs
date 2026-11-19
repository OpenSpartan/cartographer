//! A floor plan's limits for the data view (`/api/access/<id>`, web/js/dataview.js), from
//! film-assets' access files: `access/<id>.json` (tools/access: what stops players and how they
//! move) and `access/<id>.why.json` (tools/playable and tools/forge-geo: what each plan leaves out,
//! and why). Those are large, every move tried and the floor each limiter closes, so a plan's
//! limits keep only what the view draws: each limiter's outline seen from above, what it is and
//! where it comes from, and each area the plan leaves out with its reason, to a tenth of a world
//! unit.
//!
//! build.rs makes them for every plan of a map with terrain (the view draws them over the
//! terrain's kinds) and embeds each beside its plan as `<plan>.access.json`. With
//! `CARTOGRAPHER_ACCESS_DIR` naming a folder of access files, geometry.rs makes them from it as
//! they are asked for instead. Both compile this file, so it needs only std and serde_json.
//!
//! ```text
//! {"version": 1, "plan", "modes": [...], "movement": {"clamber", "jump", "step", "crouch"},
//!  "limits": [{"what", "from", "variant"?, "labels"?, "z": [lo, hi], "p": [x0, y0, ...]}, ...],
//!  "removed": [{"rule", "limit" | "what" and "from", "z": [lo, hi], "p": [[x0, y0, ...], ...]}, ...]}
//! ```
//!
//! `limits` are the limiters of the plan's modes: a level's invisible walls, and the blockers of
//! the map variants played in one of them that spawn there. A map variant is named by its title
//! (`variant`, and in place of its asset id in a reason). `removed` follows the why file, without
//! a row whose rule and rings an earlier one has, and a `limit` row names its limiter by index.

use serde_json::Value;

/// The modes a plan can be for (tools/playable MODES): a plan that names none serves them all.
const MODES: [&str; 13] = [
    "slayer", "ctf", "oddball", "strongholds", "koth", "landgrab", "totalcontrol", "extraction", "elimination",
    "stockpile", "assault", "vip", "infection",
];

/// The plans a why file names, in its order.
pub fn plans(why: &[u8]) -> Result<Vec<String>, String> {
    let why: Value = serde_json::from_slice(why).map_err(|error| error.to_string())?;
    Ok(why["plans"].as_array().into_iter().flatten().filter_map(|plan| plan["plan"].as_str().map(str::to_string)).collect())
}

/// The limits of `plan` (`<levlId>`, `<levlId>.<mode>` or a Forge map's asset id), from its map's
/// access file and why file (none where the map's plans leave nothing out). `title` names a map
/// variant by its asset id.
pub fn of_plan(access: &[u8], why: Option<&[u8]>, plan: &str, title: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    let access: Value = serde_json::from_slice(access).map_err(|error| error.to_string())?;
    let why: Option<Value> = why.map(serde_json::from_slice).transpose().map_err(|error| error.to_string())?;
    let id = access["id"].as_str().ok_or("an access file without its id")?;
    if access["version"].as_u64() != Some(1) || !plan.split('.').next().is_some_and(|base| base.eq_ignore_ascii_case(id)) {
        return Err(format!("{plan}: not the access file's plan"));
    }
    let forge = access["kind"].as_str() == Some("forge");
    let entry = why.as_ref().and_then(|why| why["plans"].as_array()?.iter().find(|entry| entry["plan"].as_str() == Some(plan)));
    if entry.is_none() && plan.contains('.') {
        return Err(format!("{plan}: no such plan in the why file"));
    }
    let modes: Vec<&str> = entry.and_then(|entry| entry["modes"].as_array()).into_iter().flatten().filter_map(Value::as_str).collect();
    let modes: &[&str] = if modes.is_empty() { &MODES } else { &modes };
    let named = |asset: &str| title(asset).unwrap_or_else(|| asset.to_string());

    let mut limits = Vec::new();
    let mut kept: Vec<(&str, &str)> = Vec::new();
    for limit in access["limits"].as_array().into_iter().flatten() {
        let labels: Vec<&str> = limit["labels"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let variant = limit["map"].as_str().filter(|asset| !asset.eq_ignore_ascii_case(id));
        // A level's map variant counts for the modes tools/playable plays it in: never Firefight's,
        // and an Infection variant for Infection only. A Forge map is its own variant.
        let counts = |mode: &str| match variant.map(named) {
            Some(name) if !forge => !name.contains("Firefight") && (mode == "infection" || !name.contains("Infection")),
            _ => true,
        };
        if !modes.iter().any(|mode| counts(mode) && spawns(&labels, mode)) { continue; }
        let Some(outline) = limit["outline"].as_array().and_then(|points| ring(points)) else { continue };
        let (what, from) = (limit["what"].as_str().unwrap_or_default(), limit["from"].as_str().unwrap_or_default());
        let mut row = format!("{{\"what\":{},\"from\":{}", json(what), json(from));
        if let Some(asset) = variant { row += &format!(",\"variant\":{}", json(&named(asset))); }
        if !labels.is_empty() { row += &format!(",\"labels\":[{}]", labels.iter().map(|label| json(label)).collect::<Vec<_>>().join(",")); }
        row += &format!(",\"z\":{},\"p\":{outline}}}", heights(&limit["solid"]));
        limits.push(row);
        kept.push((what, from));
    }

    let mut removed = Vec::new();
    let mut seen: Vec<(String, String)> = Vec::new();
    for area in entry.and_then(|entry| entry["removed"].as_array()).into_iter().flatten() {
        let rule = area["rule"].as_str().unwrap_or_default();
        let rings: Vec<String> = area["p"].as_array().into_iter().flatten().filter_map(|points| ring(points.as_array()?)).collect();
        if rule.is_empty() || rings.is_empty() { continue; }
        let p = format!("[{}]", rings.join(","));
        if seen.iter().any(|(r, q)| r == rule && *q == p) { continue; }
        let (what, from) = (area["what"].as_str().unwrap_or_default(), area["from"].as_str().unwrap_or_default());
        let index = (rule == "limit").then(|| kept.iter().position(|limit| *limit == (what, from))).flatten();
        let source = match index {
            Some(index) => format!("\"limit\":{index}"),
            None => format!("\"what\":{},\"from\":{}", json(what), json(&titled(from, &named))),
        };
        removed.push(format!("{{\"rule\":{},{source},\"z\":{},\"p\":{p}}}", json(rule), heights(&area["z"])));
        seen.push((rule.to_string(), p));
    }

    let movement = &access["movement"];
    let number = |key: &str| movement[key].as_f64().filter(|value| value.is_finite()).map_or_else(|| "null".into(), tenth);
    Ok(format!(
        "{{\"version\":1,\"plan\":{},\"modes\":[{}],\"movement\":{{\"clamber\":{},\"jump\":{},\"step\":{},\"crouch\":{}}},\"limits\":[{}],\"removed\":[{}]}}\n",
        json(plan),
        modes.iter().map(|mode| json(mode)).collect::<Vec<_>>().join(","),
        number("clamber"), number("jump"), number("step"), number("crouch"),
        limits.join(",\n"),
        removed.join(",\n"),
    ))
}

/// Whether an object with Forge `labels` spawns in `mode`: not excluded from it, and included in
/// it when it names the modes it is included in (tools/playable Labels).
fn spawns(labels: &[&str], mode: &str) -> bool {
    let named = |suffix: &str| labels.contains(&format!("{mode}_{suffix}").as_str());
    !named("exclude") && (!labels.iter().any(|label| label.ends_with("_include")) || named("include"))
}

/// A reason's source with each map variant's asset id in it (`slayer on <asset>, objects 20, 21`)
/// replaced by its title.
fn titled(from: &str, named: &dyn Fn(&str) -> String) -> String {
    from.split(' ').map(|word| {
        let (asset, rest) = word.split_at(word.find(',').unwrap_or(word.len()));
        if is_asset(asset) { format!("{}{rest}", named(asset)) } else { word.to_string() }
    }).collect::<Vec<_>>().join(" ")
}

fn is_asset(word: &str) -> bool {
    word.len() == 36 && word.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

/// A ring of flat points `[x0, y0, x1, y1, ...]` to a tenth, without a point repeated or one on a
/// straight line between its neighbours. None when fewer than three points are left.
fn ring(values: &[Value]) -> Option<String> {
    let tenths: Vec<i64> = values.iter().map(|value| value.as_f64().filter(|value| value.is_finite()).map(|value| (value * 10.0).round() as i64)).collect::<Option<_>>()?;
    let mut points: Vec<(i64, i64)> = Vec::new();
    for point in tenths.chunks_exact(2).map(|pair| (pair[0], pair[1])) {
        if points.last() == Some(&point) { continue; }
        // The point before goes when it lies on the line from the one before it to this one.
        while points.len() >= 2 && straight(points[points.len() - 2], points[points.len() - 1], point) { points.pop(); }
        points.push(point);
    }
    while points.len() >= 2 && points.first() == points.last() { points.pop(); }
    while points.len() >= 3 && straight(points[points.len() - 2], points[points.len() - 1], points[0]) { points.pop(); }
    while points.len() >= 3 && straight(points[points.len() - 1], points[0], points[1]) { points.remove(0); }
    (points.len() >= 3).then(|| format!("[{}]", points.iter().map(|&(x, y)| format!("{},{}", tenth_of(x), tenth_of(y))).collect::<Vec<_>>().join(",")))
}

/// Whether `b` lies on the straight line through `a` and `c`.
fn straight(a: (i64, i64), b: (i64, i64), c: (i64, i64)) -> bool {
    (b.0 - a.0) * (c.1 - b.1) - (b.1 - a.1) * (c.0 - b.0) == 0
}

/// `[lo, hi]` to a tenth, or `null`.
fn heights(value: &Value) -> String {
    match value.as_array().map(|pair| pair.iter().filter_map(Value::as_f64).filter(|value| value.is_finite()).collect::<Vec<_>>()) {
        Some(pair) if pair.len() == 2 => format!("[{},{}]", tenth(pair[0]), tenth(pair[1])),
        _ => "null".into(),
    }
}

/// A number to a tenth, without a trailing `.0` or a `-0`, as film-assets writes them.
fn tenth(value: f64) -> String {
    tenth_of((value * 10.0).round() as i64)
}

fn tenth_of(tenths: i64) -> String {
    let sign = if tenths < 0 { "-" } else { "" };
    let (whole, part) = (tenths.unsigned_abs() / 10, tenths.unsigned_abs() % 10);
    if part == 0 { format!("{sign}{whole}") } else { format!("{sign}{whole}.{part}") }
}

fn json(text: &str) -> String {
    Value::from(text).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCESS: &[u8] = br#"{"version":1,"id":"1234abcd","kind":"level","movement":{"clamber":9,"jump":28,"step":1.5,"crouch":4.5},
        "limits":[
          {"what":"invisible wall","layer":"environment_invisible_wall","from":"structure BSP 1 instance 2","outline":[0,0,10,0,10,0.04,10,10,5,10,0,10],"p":[[0,0,1,0,1,1]],"z":[0,1],"solid":[-1.04,30]},
          {"what":"Player Blocker 16x2x8","layer":"forge_blocker_player","from":"object 7, Player Blocker 16x2x8","map":"9c7b0b0f-e933-4c2d-9d4a-3e4500d0de99","object":7,"labels":["infection_exclude"],"outline":[0,0,1,0,1,1],"p":[],"z":[0,1],"solid":[0,8]},
          {"what":"Player Blocker 16x2x8","layer":"forge_blocker_player","from":"object 9, Player Blocker 16x2x8","map":"33dfff37-a320-433b-beb1-4a39dc330be4","object":9,"outline":[0,0,1,0,1,1],"p":[],"z":[0,1],"solid":[0,8]}],
        "links":{"w":[1,2,3,4,5,6]},"rejected":[["h",0,0,0,0,0,0,9]]}"#;
    const WHY: &[u8] = br#"{"level":"test","levlId":"1234abcd","plans":[
        {"plan":"1234abcd","modes":["slayer","ctf"],"removed":[
          {"rule":"limit","what":"invisible wall","from":"structure BSP 1 instance 2","z":[0,1],"p":[[0,0,1,0,1,0,1,1]]},
          {"rule":"barrier","what":"Gate","from":"slayer on 9c7b0b0f-e933-4c2d-9d4a-3e4500d0de99, objects 3, 4","z":[0,1],"p":[[0,0,2,0,2,2]]},
          {"rule":"barrier","what":"Gate","from":"slayer on 33dfff37-a320-433b-beb1-4a39dc330be4, objects 5","z":[0,1],"p":[[0,0,2,0,2,2]]},
          {"rule":"footprint","what":"","from":"3 square world units","z":[0,1],"p":[[0,0,0.5,0]]}]},
        {"plan":"1234abcd.infection","modes":["infection"],"removed":[]}]}"#;

    fn title(asset: &str) -> Option<String> {
        match asset {
            "9c7b0b0f-e933-4c2d-9d4a-3e4500d0de99" => Some("Streets".into()),
            "33dfff37-a320-433b-beb1-4a39dc330be4" => Some("Streets Infection".into()),
            _ => None,
        }
    }

    #[test]
    fn a_plan_keeps_its_modes_limiters_and_what_it_leaves_out() {
        assert_eq!(plans(WHY).unwrap(), ["1234abcd", "1234abcd.infection"]);
        let plan: Value = serde_json::from_str(&of_plan(ACCESS, Some(WHY), "1234abcd", &title).unwrap()).unwrap();
        // The wall, and Streets' blocker, which spawns outside Infection. Streets Infection's
        // blocker is Infection's alone.
        let limits = plan["limits"].as_array().unwrap();
        assert_eq!(limits.len(), 2);
        assert_eq!(limits[0]["p"], serde_json::json!([0, 0, 10, 0, 10, 10, 0, 10]), "to a tenth, no straight runs");
        assert_eq!(limits[0]["z"], serde_json::json!([-1, 30]));
        assert_eq!(limits[1]["variant"], "Streets");
        assert_eq!(limits[1]["labels"], serde_json::json!(["infection_exclude"]));
        // The wall's floor names it by index, the second barrier repeats the first's rings, and
        // a ring of two points is no area.
        let removed = plan["removed"].as_array().unwrap();
        assert_eq!(removed.len(), 2);
        assert_eq!(removed[0]["limit"], 0);
        assert!(removed[0].get("what").is_none());
        assert_eq!(removed[1]["from"], "slayer on Streets, objects 3, 4");
        assert_eq!(plan["movement"]["step"], 1.5);
        assert!(plan.get("links").is_none() && plan.get("rejected").is_none());

        let infection: Value = serde_json::from_str(&of_plan(ACCESS, Some(WHY), "1234abcd.infection", &title).unwrap()).unwrap();
        let limits = infection["limits"].as_array().unwrap();
        assert_eq!(limits.len(), 2);
        assert_eq!(limits[1]["variant"], "Streets Infection");
        assert!(of_plan(ACCESS, Some(WHY), "1234abcd.koth", &title).is_err());
        assert!(of_plan(ACCESS, Some(WHY), "87654321", &title).is_err());
    }

    #[test]
    fn labels_say_which_modes_an_object_spawns_in() {
        assert!(spawns(&[], "slayer"));
        assert!(!spawns(&["infection_exclude"], "infection"));
        assert!(spawns(&["infection_exclude"], "ctf"));
        assert!(!spawns(&["firefight_include"], "slayer"));
        assert!(spawns(&["oddball_include"], "oddball"));
    }

    #[test]
    fn numbers_are_written_to_a_tenth() {
        assert_eq!(tenth(-0.04), "0");
        assert_eq!(tenth(-12.36), "-12.4");
        assert_eq!(tenth(7.0), "7");
        assert_eq!(tenth(0.26), "0.3");
    }
}
