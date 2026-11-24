use crate::profile::Profile;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Point {
    pub fn get(self, axis: char) -> f64 {
        match axis {
            'X' => self.x,
            'Y' => self.y,
            'Z' => self.z,
            _ => unreachable!("invalid axis"),
        }
    }

    pub fn set(&mut self, axis: char, value: f64) {
        match axis {
            'X' => self.x = value,
            'Y' => self.y = value,
            'Z' => self.z = value,
            _ => unreachable!("invalid axis"),
        }
    }

    pub fn add(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
            z: self.z + other.z,
        }
    }

    pub fn sub(self, other: Self) -> Self {
        Self {
            x: self.x - other.x,
            y: self.y - other.y,
            z: self.z - other.z,
        }
    }

    pub fn distance(self, other: Self) -> f64 {
        (self.x - other.x)
            .hypot(self.y - other.y)
            .hypot(self.z - other.z)
    }

    pub fn lerp(self, other: Self, t: f64) -> Self {
        Self {
            x: self.x + (other.x - self.x) * t,
            y: self.y + (other.y - self.y) * t,
            z: self.z + (other.z - self.z) * t,
        }
    }

    pub fn grbl(self) -> String {
        format!("{:.3},{:.3},{:.3}", self.x, self.y, self.z)
    }
}

pub fn clean(raw: &str) -> String {
    static COMMENTS: OnceLock<Regex> = OnceLock::new();
    let comments = COMMENTS.get_or_init(|| Regex::new(r"\(.*?\)").expect("valid regex"));
    let without_comments = comments.replace_all(raw, "");
    let without_suffix = without_comments.split(';').next().unwrap_or("");
    let result: String = without_suffix
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect();
    if result == "%" {
        String::new()
    } else {
        result
    }
}

pub fn split_program(text: &str) -> Vec<String> {
    text.lines()
        .map(clean)
        .filter(|line| !line.is_empty())
        .collect()
}

pub fn tokenize(line: &str) -> Vec<(char, f64)> {
    static WORD: OnceLock<Regex> = OnceLock::new();
    let word =
        WORD.get_or_init(|| Regex::new(r"([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))").expect("valid regex"));
    word.captures_iter(line)
        .filter_map(|m| {
            let value = m[2].parse::<f64>().ok()?;
            if !value.is_finite() {
                return None;
            }
            Some((m[1].chars().next()?, value))
        })
        .collect()
}

pub fn value(words: &[(char, f64)], letter: char) -> Option<f64> {
    words
        .iter()
        .find(|(key, _)| *key == letter)
        .map(|(_, v)| *v)
}

pub fn fmt(n: f64) -> String {
    let n = (n * 1000.0 + 0.5).floor() / 1000.0;
    if n == 0.0 {
        return "0".into();
    }
    let mut s = format!("{n:.3}");
    while s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    s
}

#[derive(Clone, Debug)]
pub struct ProgramState {
    pub motion: f64,
    pub units: u8,
    pub absolute: bool,
    pub plane: u8,
    pub wcs: u8,
    pub feed_mode: u8,
    pub feed: f64,
    pub spindle: u8,
    pub speed: f64,
    pub mist: bool,
    pub flood: bool,
    pub tool: f64,
    pub pos: Point,
}

impl Default for ProgramState {
    fn default() -> Self {
        Self {
            motion: 0.0,
            units: 21,
            absolute: true,
            plane: 17,
            wcs: 54,
            feed_mode: 94,
            feed: 0.0,
            spindle: 5,
            speed: 0.0,
            mist: false,
            flood: false,
            tool: 0.0,
            pos: Point::default(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Segment {
    pub kind: SegmentKind,
    pub from: Point,
    pub to: Point,
    pub feed: f64,
}

#[derive(Clone, Debug)]
pub enum SegmentKind {
    Rapid,
    Feed,
    Arc { center: Point, cw: bool, plane: u8 },
}

fn plane_axes(plane: u8) -> (char, char, char, char, char) {
    match plane {
        18 => ('Z', 'X', 'Y', 'K', 'I'),
        19 => ('Y', 'Z', 'X', 'J', 'K'),
        _ => ('X', 'Y', 'Z', 'I', 'J'),
    }
}

pub fn step(state: &mut ProgramState, line: &str) -> Vec<Segment> {
    if line.is_empty() || line.starts_with('$') {
        return Vec::new();
    }
    let words = tokenize(line);
    let mut params = Vec::new();
    let mut non_modal_axes = false;
    let mut g53 = false;

    for &(letter, value) in &words {
        match letter {
            'G' => {
                let v = (value * 10.0).round() / 10.0;
                if [0.0, 1.0, 2.0, 3.0].contains(&v) || (38.2..=38.5).contains(&v) {
                    state.motion = v;
                } else if v == 80.0 {
                    state.motion = 80.0;
                } else if v == 90.0 {
                    state.absolute = true;
                } else if v == 91.0 {
                    state.absolute = false;
                } else if v == 20.0 || v == 21.0 {
                    state.units = v as u8;
                } else if [17.0, 18.0, 19.0].contains(&v) {
                    state.plane = v as u8;
                } else if (54.0..=59.0).contains(&v) {
                    state.wcs = v as u8;
                } else if v == 93.0 || v == 94.0 {
                    state.feed_mode = v as u8;
                } else if v == 53.0 {
                    g53 = true;
                } else if [10.0, 28.0, 30.0, 92.0, 4.0].contains(&v) {
                    non_modal_axes = true;
                }
            }
            'M' => match value.round() as i32 {
                3..=5 => state.spindle = value.round() as u8,
                7 => state.mist = true,
                8 => state.flood = true,
                9 => {
                    state.mist = false;
                    state.flood = false;
                }
                _ => {}
            },
            'F' => state.feed = value * if state.units == 20 { 25.4 } else { 1.0 },
            'S' => state.speed = value,
            'T' => state.tool = value,
            _ => params.push((letter, value)),
        }
    }

    if non_modal_axes
        || state.motion == 80.0
        || !['X', 'Y', 'Z'].iter().any(|a| value(&params, *a).is_some())
    {
        return Vec::new();
    }
    let k = if state.units == 20 { 25.4 } else { 1.0 };
    let from = state.pos;
    let mut to = from;
    for axis in ['X', 'Y', 'Z'] {
        if let Some(v) = value(&params, axis) {
            to.set(
                axis,
                if state.absolute || g53 {
                    v * k
                } else {
                    from.get(axis) + v * k
                },
            );
        }
    }
    if g53 {
        return Vec::new();
    }

    let kind = if state.motion == 0.0 {
        Some(SegmentKind::Rapid)
    } else if state.motion == 1.0 {
        Some(SegmentKind::Feed)
    } else if state.motion == 2.0 || state.motion == 3.0 {
        let (a, b, _, i, j) = plane_axes(state.plane);
        let (ci, cj) = if let Some(r) = value(&params, 'R') {
            let r = r * k;
            let x = to.get(a) - from.get(a);
            let y = to.get(b) - from.get(b);
            let d = x.hypot(y);
            let mut h = if d > 0.0 {
                -((4.0 * r * r - d * d).max(0.0)).sqrt() / d
            } else {
                0.0
            };
            if state.motion == 3.0 {
                h = -h;
            }
            if r < 0.0 {
                h = -h;
            }
            (0.5 * (x - y * h), 0.5 * (y + x * h))
        } else {
            (
                value(&params, i).unwrap_or(0.0) * k,
                value(&params, j).unwrap_or(0.0) * k,
            )
        };
        let mut center = Point::default();
        center.set(a, from.get(a) + ci);
        center.set(b, from.get(b) + cj);
        Some(SegmentKind::Arc {
            center,
            cw: state.motion == 2.0,
            plane: state.plane,
        })
    } else {
        None
    };
    state.pos = to;
    kind.map(|kind| {
        vec![Segment {
            kind,
            from,
            to,
            feed: state.feed,
        }]
    })
    .unwrap_or_default()
}

pub fn arc_points(segment: &Segment, max_length: f64) -> Vec<Point> {
    let SegmentKind::Arc { center, cw, plane } = segment.kind else {
        return vec![segment.to];
    };
    let (a, b, c, _, _) = plane_axes(plane);
    let a0 = (segment.from.get(b) - center.get(b)).atan2(segment.from.get(a) - center.get(a));
    let a1 = (segment.to.get(b) - center.get(b)).atan2(segment.to.get(a) - center.get(a));
    let radius = (segment.from.get(a) - center.get(a)).hypot(segment.from.get(b) - center.get(b));
    let mut sweep = a1 - a0;
    if cw && sweep >= -1e-9 {
        sweep -= std::f64::consts::TAU;
    } else if !cw && sweep <= 1e-9 {
        sweep += std::f64::consts::TAU;
    }
    let count = ((sweep.abs() * radius / max_length).ceil() as usize).max(1);
    let mut points = Vec::with_capacity(count);
    for i in 1..=count {
        let t = i as f64 / count as f64;
        let angle = a0 + sweep * t;
        let mut p = Point::default();
        p.set(a, center.get(a) + radius * angle.cos());
        p.set(b, center.get(b) + radius * angle.sin());
        p.set(
            c,
            segment.from.get(c) + (segment.to.get(c) - segment.from.get(c)) * t,
        );
        points.push(p);
    }
    if let Some(last) = points.last_mut() {
        *last = segment.to;
    }
    points
}

pub fn build_resume(
    lines: &[String],
    from: usize,
    spin_up: f64,
    min_safe_z: f64,
    profile: Profile,
) -> Vec<String> {
    let mut state = ProgramState::default();
    let mut max_z = f64::NEG_INFINITY;
    for line in lines.iter().take(from) {
        for segment in step(&mut state, line) {
            max_z = max_z.max(segment.from.z).max(segment.to.z);
        }
    }
    let mut out = vec![
        "G21".into(),
        "G90".into(),
        format!("G{}", state.wcs),
        format!("G{}", state.plane),
        format!("G{}", state.feed_mode),
    ];
    if profile.laser() {
        let z_set = lines.iter().take(from).any(|line| {
            let words = tokenize(line);
            value(&words, 'Z').is_some()
                && !words.iter().any(|(letter, n)| *letter == 'G' && *n == 53.0)
        });
        if !profile.smoothie() {
            out.push("M5".into());
        }
        out.push(format!("G0X{}Y{}", fmt(state.pos.x), fmt(state.pos.y)));
        if z_set {
            out.push(format!("G0Z{}", fmt(state.pos.z)));
        }
        let feed = if state.feed > 0.0 { state.feed } else { 1000.0 };
        if profile.smoothie() {
            out.push(format!("G1F{}S{}", fmt(feed), fmt(state.speed)));
        } else {
            if state.spindle == 3 || state.spindle == 4 {
                out.push(format!("M{}S{}", state.spindle, fmt(state.speed)));
            }
            out.push(format!("G1F{}", fmt(feed)));
        }
        if state.motion == 0.0 {
            out.push("G0".into());
        }
        if state.mist {
            out.push("M7".into());
        }
        if state.flood {
            out.push("M8".into());
        }
        if state.units == 20 {
            out.push("G20".into());
        }
        if !state.absolute {
            out.push("G91".into());
        }
        return out;
    }
    let safe_z = max_z.max(state.pos.z).max(min_safe_z);
    out.push(format!("G0Z{}", fmt(safe_z)));
    if state.spindle == 3 || state.spindle == 4 {
        out.push(format!("M{}S{}", state.spindle, fmt(state.speed)));
        if spin_up > 0.0 {
            out.push(format!("G4P{}", fmt(spin_up)));
        }
    }
    if state.mist {
        out.push("M7".into());
    }
    if state.flood {
        out.push("M8".into());
    }
    out.push(format!("G0X{}Y{}", fmt(state.pos.x), fmt(state.pos.y)));
    let feed = if state.feed > 0.0 { state.feed } else { 300.0 };
    out.push(format!("G1Z{}F{}", fmt(state.pos.z), fmt(feed.min(300.0))));
    if state.motion == 0.0 || state.motion == 1.0 {
        out.push(format!("G{}F{}", state.motion, fmt(feed)));
    } else {
        out.push(format!("F{}", fmt(feed)));
    }
    if state.units == 20 {
        out.push("G20".into());
    }
    if !state.absolute {
        out.push("G91".into());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_matches_the_frontend() {
        let lines =
            split_program("G21G90G55\nM3S12000\nG0Z5\nG0X10Y10\nG1Z-2F300\nG1X20F800\nG1Y20\n");
        assert_eq!(
            build_resume(&lines, 6, 3.0, 5.0, Profile::Cnc),
            [
                "G21",
                "G90",
                "G55",
                "G17",
                "G94",
                "G0Z5",
                "M3S12000",
                "G4P3",
                "G0X20Y10",
                "G1Z-2F300",
                "G1F800"
            ]
        );
    }

    #[test]
    fn resume_respects_the_configured_safety_height() {
        let lines = split_program(
            "G21G90\nG53G0Z0\nG0X10Y10\nG1Z-2F300\nG1X50F800\nG53G0Z0\nG0X10Y30\nG1Z-2F300",
        );
        assert!(build_resume(&lines, 7, 0.0, 5.0, Profile::Cnc).contains(&"G0Z5".into()));
        assert!(build_resume(&lines, 7, 0.0, 12.0, Profile::Cnc).contains(&"G0Z12".into()));
        let higher = split_program("G21G90\nG0Z25\nG1Z-2F300\nG1X10F500");
        assert!(build_resume(&higher, 3, 0.0, 12.0, Profile::Cnc).contains(&"G0Z25".into()));
    }

    #[test]
    fn laser_resumes_with_the_beam_off_during_positioning() {
        let grbl =
            split_program("G21G90\nM4S0\nG0X10Y10\nG1X20S600F1500\nG1X30S300\nG0X0Y20\nG1X40S700");
        assert_eq!(
            build_resume(&grbl, 5, 3.0, 5.0, Profile::LaserGrbl),
            ["G21", "G90", "G54", "G17", "G94", "M5", "G0X30Y10", "M4S300", "G1F1500"]
        );
        let smoothie = split_program("G21G90\nG0X10Y10F6000\nG1X20S0.6F1500\nG1X30S0.3\nG0X0Y20");
        assert_eq!(
            build_resume(&smoothie, 4, 3.0, 5.0, Profile::Emblaser2),
            ["G21", "G90", "G54", "G17", "G94", "G0X30Y10", "G1F1500S0.3"]
        );
        let focus = split_program("G21G90\nG0Z3.5\nG0X10Y10\nM4S0\nG1X20S500F1500\nG1X30");
        assert!(build_resume(&focus, 5, 0.0, 5.0, Profile::LaserGrbl).contains(&"G0Z3.5".into()));
    }

    #[test]
    fn formatting_matches_javascript_at_negative_half_steps() {
        assert_eq!(fmt(-1.2345), "-1.234");
        assert_eq!(fmt(1.2345), "1.235");
        assert_eq!(fmt(-0.0004), "0");
    }

    #[test]
    fn program_lines_and_arcs_match_the_frontend() {
        let lines = split_program(
            "G21 G90 (commentaire)\nG0 X0 Y0\nG1 Z-1 F100 ; plongée\nG2 X10 Y0 I5 J0\n%",
        );
        assert_eq!(lines, ["G21G90", "G0X0Y0", "G1Z-1F100", "G2X10Y0I5J0"]);
        let mut state = ProgramState::default();
        let mut segments = Vec::new();
        for line in &lines {
            segments.extend(step(&mut state, line));
        }
        let arc = segments.last().expect("arc");
        let points = arc_points(arc, 0.5);
        assert!(points.iter().all(|p| p.y >= -1e-9));
        assert_eq!(
            points.last(),
            Some(&Point {
                x: 10.0,
                y: 0.0,
                z: -1.0
            })
        );
    }
}
