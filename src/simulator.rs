use crate::gcode::{arc_points, fmt, step, tokenize, value, Point, ProgramState, SegmentKind};
use crate::profile::Profile;
use std::collections::{BTreeMap, VecDeque};

const PLANNER_SIZE: usize = 15;
const TOOL_RADIUS: f64 = 3.0;
const HOLE_X: f64 = -170.0;
const HOLE_Y: f64 = -150.0;
const HOLE_RADIUS: f64 = 12.5;

#[derive(Clone, Debug)]
enum BlockKind {
    Move,
    Probe { mode: f64, started: bool, hit: bool },
    Dwell { remaining: f64 },
    Pause,
}

#[derive(Clone, Debug)]
struct Block {
    kind: BlockKind,
    to: Point,
    rate: f64,
    rapid: bool,
    jog: bool,
    homing: bool,
    acknowledge: bool,
    power: f64,
}

impl Block {
    fn movement(to: Point, rate: f64) -> Self {
        Self {
            kind: BlockKind::Move,
            to,
            rate,
            rapid: false,
            jog: false,
            homing: false,
            acknowledge: false,
            power: 0.0,
        }
    }
}

#[derive(Clone, Copy)]
struct Overrides {
    feed: i32,
    rapid: i32,
    spindle: i32,
}

pub struct Simulator {
    speedup: f64,
    settings: BTreeMap<u32, String>,
    wcs: [Point; 6],
    g92: Point,
    mpos: Point,
    planned: Point,
    state: ProgramState,
    overrides: Overrides,
    output: Vec<String>,
    input: String,
    rx: VecDeque<String>,
    planner: VecDeque<Block>,
    alarm: bool,
    hold: bool,
    spindle_stop: bool,
    waiting: bool,
    profile: Profile,
    grbl_mode: bool,
    manual_fire: f64,
    laser_scale: f64,
    seek_rate: f64,
}

impl Simulator {
    pub fn new(speedup: f64, profile: Profile) -> Self {
        let defaults = [
            (0, "10"),
            (1, "25"),
            (2, "0"),
            (3, "0"),
            (4, "0"),
            (5, "0"),
            (6, "0"),
            (10, "1"),
            (11, "0.010"),
            (12, "0.002"),
            (13, "0"),
            (20, "0"),
            (21, "0"),
            (22, "1"),
            (23, "0"),
            (24, "25.000"),
            (25, "500.000"),
            (26, "250"),
            (27, "1.000"),
            (30, "24000"),
            (31, "0"),
            (32, "0"),
            (100, "800.000"),
            (101, "800.000"),
            (102, "800.000"),
            (110, "3000.000"),
            (111, "3000.000"),
            (112, "1000.000"),
            (120, "200.000"),
            (121, "200.000"),
            (122, "100.000"),
            (130, "300.000"),
            (131, "300.000"),
            (132, "80.000"),
        ];
        let mut sim = Self {
            speedup,
            settings: defaults.into_iter().map(|(k, v)| (k, v.into())).collect(),
            wcs: [Point::default(); 6],
            g92: Point::default(),
            mpos: Point::default(),
            planned: Point::default(),
            state: ProgramState::default(),
            overrides: Overrides {
                feed: 100,
                rapid: 100,
                spindle: 100,
            },
            output: Vec::new(),
            input: String::new(),
            rx: VecDeque::new(),
            planner: VecDeque::new(),
            alarm: true,
            hold: false,
            spindle_stop: false,
            waiting: false,
            profile,
            grbl_mode: false,
            manual_fire: 0.0,
            laser_scale: 1.0,
            seek_rate: 4000.0,
        };
        if profile == Profile::LaserGrbl {
            sim.settings.insert(30, "1000".into());
            sim.settings.insert(32, "1".into());
        }
        if profile.smoothie() {
            sim.alarm = false;
        }
        sim.power_on(None);
        sim
    }

    fn send(&mut self, line: impl Into<String>) {
        self.output.push(line.into());
    }

    pub fn take_output(&mut self) -> Vec<u8> {
        let mut bytes = Vec::new();
        for line in self.output.drain(..) {
            bytes.extend_from_slice(line.as_bytes());
            bytes.extend_from_slice(b"\r\n");
        }
        bytes
    }

    fn power_on(&mut self, alarm_code: Option<u8>) {
        self.state = ProgramState::default();
        if self.profile.smoothie() {
            self.state.feed = 4000.0;
        }
        self.planner.clear();
        self.rx.clear();
        self.input.clear();
        self.hold = false;
        self.spindle_stop = false;
        self.waiting = false;
        self.planned = self.mpos;
        self.sync_work();
        if let Some(code) = alarm_code {
            self.send(format!("ALARM:{code}"));
        }
        if self.profile.smoothie() {
            self.send("Smoothie");
            self.send("ok");
            return;
        }
        self.send("");
        self.send("Grbl 1.1h ['$' for help]");
        if self.alarm {
            self.send("[MSG:'$H'|'$X' to unlock]");
        }
    }

    pub fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if self.realtime(byte) {
                continue;
            }
            if byte == b'\n' {
                let raw = self.input.trim();
                let line = if self.profile.smoothie()
                    && raw
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_lowercase() || c == '$')
                {
                    raw.to_string()
                } else {
                    raw.chars()
                        .filter(|c| !c.is_whitespace())
                        .collect::<String>()
                        .to_ascii_uppercase()
                };
                self.rx.push_back(line);
                self.input.clear();
            } else if byte != b'\r' {
                self.input.push(char::from(byte));
            }
        }
        self.process_rx();
    }

    fn realtime(&mut self, byte: u8) -> bool {
        if self.profile.smoothie() {
            match byte {
                b'?' => self.send_status(),
                0x18 => {
                    self.planner.clear();
                    self.rx.clear();
                    self.input.clear();
                    self.waiting = false;
                    self.hold = false;
                    self.planned = self.mpos;
                    self.sync_work();
                    self.alarm = true;
                    self.manual_fire = 0.0;
                    self.send(if self.grbl_mode {
                        "ALARM: Abort during cycle"
                    } else {
                        "HALTED, M999 or $X to exit HALT state"
                    });
                }
                0x19 => self.cancel_jog(),
                b'!' if self.grbl_mode => self.hold = true,
                b'~' if self.grbl_mode => self.hold = false,
                _ => return false,
            }
            return true;
        }
        match byte {
            b'?' => self.send_status(),
            b'!' => {
                if self.planner.iter().any(|b| b.jog) {
                    self.cancel_jog();
                } else if !self.planner.is_empty() {
                    self.hold = true;
                }
            }
            b'~' => {
                self.hold = false;
                self.spindle_stop = false;
            }
            0x9e => {
                if self.hold {
                    self.spindle_stop = !self.spindle_stop;
                }
            }
            0x18 => {
                let moving = !self.planner.is_empty() && !self.hold;
                if moving {
                    self.alarm = true;
                }
                self.power_on(if moving { Some(3) } else { None });
            }
            0x85 => self.cancel_jog(),
            0x90 => self.overrides.feed = 100,
            0x91 => self.overrides.feed = (self.overrides.feed + 10).clamp(10, 200),
            0x92 => self.overrides.feed = (self.overrides.feed - 10).clamp(10, 200),
            0x93 => self.overrides.feed = (self.overrides.feed + 1).clamp(10, 200),
            0x94 => self.overrides.feed = (self.overrides.feed - 1).clamp(10, 200),
            0x95 => self.overrides.rapid = 100,
            0x96 => self.overrides.rapid = 50,
            0x97 => self.overrides.rapid = 25,
            0x99 => self.overrides.spindle = 100,
            0x9a => self.overrides.spindle = (self.overrides.spindle + 10).clamp(10, 200),
            0x9b => self.overrides.spindle = (self.overrides.spindle - 10).clamp(10, 200),
            0x9c => self.overrides.spindle = (self.overrides.spindle + 1).clamp(10, 200),
            0x9d => self.overrides.spindle = (self.overrides.spindle - 1).clamp(10, 200),
            _ => return byte >= 0x80,
        }
        true
    }

    fn cancel_jog(&mut self) {
        if !self.planner.iter().any(|b| b.jog) {
            return;
        }
        self.planner.retain(|b| !b.jog);
        self.planned = self.mpos;
        self.sync_work();
    }

    fn machine_state(&self) -> &'static str {
        if self.alarm {
            "Alarm"
        } else if self.hold {
            "Hold:0"
        } else if self.planner.iter().any(|b| b.homing) {
            "Home"
        } else if self.planner.iter().any(|b| b.jog) {
            "Jog"
        } else if !self.planner.is_empty() {
            "Run"
        } else {
            "Idle"
        }
    }

    fn wco(&self) -> Point {
        self.wcs[(self.state.wcs - 54) as usize].add(self.g92)
    }

    fn sync_work(&mut self) {
        self.state.pos = self.planned.sub(self.wco());
    }

    fn send_status(&mut self) {
        let feed = self.planner.front().map_or(0.0, |block| {
            if !self.hold && matches!(block.kind, BlockKind::Move | BlockKind::Probe { .. }) {
                self.rate_of(block).round()
            } else {
                0.0
            }
        });
        if self.profile.smoothie() {
            let current = self.planner.front();
            let moving =
                current.is_some_and(|block| !self.hold && matches!(block.kind, BlockKind::Move));
            let power = if self.manual_fire > 0.0 {
                self.manual_fire
            } else if moving {
                current.map_or(0.0, |block| {
                    if block.rapid {
                        0.0
                    } else {
                        (block.power * 100.0 * self.laser_scale).clamp(0.0, 100.0)
                    }
                })
            } else {
                0.0
            };
            let work = self.mpos.sub(self.wco());
            let state = match self.machine_state() {
                "Hold:0" => "Hold",
                "Jog" => "Run",
                other => other,
            };
            let metrics = if moving {
                format!(
                    "F:{feed},{},{},L:{power},S:{}",
                    self.state.feed, self.overrides.feed, self.state.speed
                )
            } else {
                format!("F:{},{}", self.state.feed, self.overrides.feed)
            };
            self.send(format!(
                "<{state}|MPos:{}|WPos:{}|{}>",
                self.mpos.grbl(),
                work.grbl(),
                metrics.replace(",L:", "|L:").replace(",S:", "|S:")
            ));
            return;
        }
        let spindle_on = [3, 4].contains(&self.state.spindle) && !self.spindle_stop;
        let speed = if spindle_on {
            (self.state.speed * f64::from(self.overrides.spindle) / 100.0).round()
        } else {
            0.0
        };
        let rx_bytes: usize = self.rx.iter().map(|line| line.len() + 1).sum();
        self.send(format!(
            "<{}|MPos:{}|Bf:{},{}|FS:{feed},{speed}|WCO:{}|Ov:{},{},{}>",
            self.machine_state(),
            self.mpos.grbl(),
            PLANNER_SIZE.saturating_sub(self.planner.len()),
            128usize.saturating_sub(rx_bytes),
            self.wco().grbl(),
            self.overrides.feed,
            self.overrides.rapid,
            self.overrides.spindle
        ));
    }

    fn process_rx(&mut self) {
        while let Some(line) = self.rx.front() {
            if self.waiting || self.planner.len() >= PLANNER_SIZE {
                break;
            }
            let words = tokenize(line);
            let needs_idle = if self.profile.smoothie() {
                line.eq_ignore_ascii_case("$H")
            } else {
                (line.starts_with('$') && !line.starts_with("$J="))
                    || words.iter().any(|(letter, v)| {
                        *letter == 'G'
                            && ([10.0, 92.0, 28.0, 30.0, 4.0].contains(v)
                                || (38.0..39.0).contains(v))
                    })
            };
            if needs_idle && !self.planner.is_empty() {
                break;
            }
            let line = self.rx.pop_front().expect("front existed");
            if self.profile.smoothie() && self.smoothie_console(&line) {
                continue;
            }
            if self.profile.smoothie()
                && self.alarm
                && !line.starts_with('$')
                && !line.starts_with("M999")
            {
                self.send("!!");
                continue;
            }
            match self.execute(&line) {
                Ok(false) => self.send("ok"),
                Ok(true) => self.waiting = true,
                Err(code) if self.profile.smoothie() => {
                    self.send(format!("error:G-code invalide ({code})"));
                    self.send("Entering Alarm/Halt state");
                    self.planner.clear();
                    self.rx.clear();
                    self.alarm = true;
                    self.manual_fire = 0.0;
                    self.planned = self.mpos;
                    self.sync_work();
                }
                Err(code) => self.send(format!("error:{code}")),
            }
        }
    }

    fn execute(&mut self, line: &str) -> Result<bool, u8> {
        if line.is_empty() {
            return Ok(false);
        }
        if self.profile.smoothie() {
            let words = tokenize(line);
            let ms: Vec<_> = words
                .iter()
                .filter(|(letter, _)| *letter == 'M')
                .map(|(_, value)| *value as i32)
                .collect();
            if ms.contains(&999) {
                self.alarm = false;
                return Ok(false);
            }
            if ms.contains(&115) {
                self.send(format!(
                    "FIRMWARE_NAME:Smoothieware, FIRMWARE_VERSION:edge-copeau-sim, X-GRBL_MODE:{}",
                    u8::from(self.grbl_mode)
                ));
                return Ok(false);
            }
            if ms.contains(&220) {
                if let Some(value) = value(&words, 'S') {
                    self.overrides.feed = value.clamp(10.0, 200.0) as i32;
                }
                return Ok(false);
            }
            if ms.contains(&221) {
                if let Some(value) = value(&words, 'S') {
                    self.laser_scale = value / 100.0;
                }
                return Ok(false);
            }
            if ms.contains(&400) {
                if self.planner.is_empty() {
                    return Ok(false);
                }
                let mut block = Block::movement(self.mpos, 0.0);
                block.kind = BlockKind::Dwell { remaining: 0.0 };
                block.acknowledge = true;
                self.planner.push_back(block);
                return Ok(true);
            }
            if words
                .iter()
                .any(|(letter, value)| *letter == 'G' && *value == 4.0)
            {
                let seconds = value(&words, 'P').unwrap_or(0.0)
                    / if self.grbl_mode { 1.0 } else { 1000.0 }
                    + value(&words, 'S').unwrap_or(0.0);
                if seconds <= 0.0 {
                    return Ok(false);
                }
                let mut block = Block::movement(self.mpos, 0.0);
                block.kind = BlockKind::Dwell { remaining: seconds };
                block.acknowledge = true;
                self.planner.push_back(block);
                return Ok(true);
            }
        }
        if line.starts_with('$') {
            return self.dollar(line);
        }
        if self.alarm {
            return Err(9);
        }
        self.gcode(line)
    }

    fn smoothie_console(&mut self, line: &str) -> bool {
        if line.eq_ignore_ascii_case("$I") {
            let _ = self.dollar("$G");
            return true;
        }
        if !line.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
            return false;
        }
        let mut words = line.split_whitespace();
        match words.next().unwrap_or("") {
            "fire" => {
                if !self.alarm {
                    let argument = words.next().unwrap_or("");
                    self.manual_fire = if argument == "off" {
                        0.0
                    } else {
                        argument.parse::<f64>().unwrap_or(0.0).clamp(0.0, 100.0)
                    };
                    self.send(if self.manual_fire == 0.0 {
                        "turning laser off and returning to auto mode".to_string()
                    } else {
                        format!("WARNING: Firing laser at {:.2}% power", self.manual_fire)
                    });
                }
            }
            "version" => self.send("Build version: edge-copeau-sim"),
            "config-get" => self.send("sd: default_seek_rate is set to 4000"),
            other => self.send(format!("error:Unsupported command - {other}")),
        }
        true
    }

    fn dollar(&mut self, line: &str) -> Result<bool, u8> {
        match line {
            "$$" => {
                let settings = self.settings.clone();
                for (key, val) in settings {
                    self.send(format!("${key}={val}"));
                }
            }
            "$G" => {
                let s = &self.state;
                self.send(format!(
                    "[GC:G{} G{} G{} G{} G{} G{} M{} M{} T{} F{} S{}]",
                    s.motion,
                    s.wcs,
                    s.plane,
                    s.units,
                    if s.absolute { 90 } else { 91 },
                    s.feed_mode,
                    s.spindle,
                    if s.flood {
                        8
                    } else if s.mist {
                        7
                    } else {
                        9
                    },
                    fmt(s.tool),
                    fmt(s.feed),
                    fmt(s.speed)
                ));
            }
            "$#" => {
                for n in 54..=59 {
                    self.send(format!("[G{n}:{}]", self.wcs[(n - 54) as usize].grbl()));
                }
                self.send("[G28:0.000,0.000,0.000]");
                self.send("[G30:0.000,0.000,0.000]");
                self.send(format!("[G92:{}]", self.g92.grbl()));
                self.send("[TLO:0.000]");
                self.send("[PRB:0.000,0.000,0.000:0]");
            }
            "$I" => {
                self.send("[VER:1.1h.20190825:Copeau-sim]");
                self.send("[OPT:V,15,128]");
            }
            "$X" => {
                if self.alarm {
                    self.alarm = false;
                    self.send("[MSG:Caution: Unlocked]");
                }
            }
            "$H" => {
                self.alarm = false;
                let top = Point {
                    z: 0.0,
                    ..self.mpos
                };
                let mut first = Block::movement(top, 1500.0);
                first.homing = true;
                let mut second = Block::movement(Point::default(), 1500.0);
                second.homing = true;
                let mut last = Block::movement(
                    Point {
                        x: -1.0,
                        y: -1.0,
                        z: -1.0,
                    },
                    500.0,
                );
                last.homing = true;
                last.acknowledge = true;
                self.planner.extend([first, second, last]);
                self.planned = Point {
                    x: -1.0,
                    y: -1.0,
                    z: -1.0,
                };
                self.sync_work();
                return Ok(true);
            }
            "$C" | "$N" | "$SLP" => {}
            _ if line.starts_with("$J=") => return self.jog(&line[3..]),
            _ if line.starts_with('$') && line.contains('=') => {
                let (key, val) = line[1..].split_once('=').ok_or(3)?;
                let key = key.parse::<u32>().map_err(|_| 3)?;
                val.parse::<f64>().map_err(|_| 3)?;
                self.settings.insert(key, val.into());
            }
            _ => return Err(3),
        }
        Ok(false)
    }

    fn jog(&mut self, body: &str) -> Result<bool, u8> {
        if self.alarm {
            return Err(9);
        }
        if !["Idle", "Jog"].contains(&self.machine_state()) {
            return Err(8);
        }
        let words = tokenize(body);
        let gs: Vec<_> = words
            .iter()
            .filter(|(l, _)| *l == 'G')
            .map(|(_, v)| *v)
            .collect();
        let feed = value(&words, 'F').ok_or(22)?;
        if feed <= 0.0 {
            return Err(22);
        }
        let k = if gs.contains(&20.0) { 25.4 } else { 1.0 };
        let relative = gs.contains(&91.0);
        let machine = gs.contains(&53.0);
        let mut to = self.planned;
        let wco = self.wco();
        for (axis, v) in words {
            if !['X', 'Y', 'Z'].contains(&axis) {
                continue;
            }
            let v = v * k;
            to.set(
                axis,
                if machine {
                    v
                } else if relative {
                    to.get(axis) + v
                } else {
                    v + wco.get(axis)
                },
            );
        }
        let mut block = Block::movement(to, feed * k);
        block.jog = true;
        self.planner.push_back(block);
        self.planned = to;
        self.sync_work();
        Ok(false)
    }

    fn gcode(&mut self, line: &str) -> Result<bool, u8> {
        let mut line = line.to_string();
        let mut words = tokenize(&line);
        if words.is_empty() {
            return Err(1);
        }
        let gs: Vec<_> = words
            .iter()
            .filter(|(l, _)| *l == 'G')
            .map(|(_, v)| (v * 10.0).round() / 10.0)
            .collect();
        let ms: Vec<_> = words
            .iter()
            .filter(|(l, _)| *l == 'M')
            .map(|(_, v)| v.round() as i32)
            .collect();
        if self.profile.smoothie() && gs.contains(&0.0) {
            if let Some(feed) = value(&words, 'F') {
                self.seek_rate = feed;
                static FEED: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
                line = FEED
                    .get_or_init(|| {
                        regex::Regex::new(r"F[-+]?(?:\d+\.?\d*|\.\d+)").expect("valid regex")
                    })
                    .replace_all(&line, "")
                    .into_owned();
                words = tokenize(&line);
            }
        }
        let units = if gs.contains(&20.0) {
            20
        } else if gs.contains(&21.0) {
            21
        } else {
            self.state.units
        };
        let k = if units == 20 { 25.4 } else { 1.0 };

        if gs.contains(&10.0) {
            let l = value(&words, 'L');
            let p = value(&words, 'P').unwrap_or(0.0).round() as i32;
            let wcs = if p == 0 {
                i32::from(self.state.wcs)
            } else {
                53 + p
            };
            if !(54..=59).contains(&wcs) {
                return Err(29);
            }
            for axis in ['X', 'Y', 'Z'] {
                if let Some(v) = value(&words, axis) {
                    let offset = if l == Some(2.0) {
                        v * k
                    } else if l == Some(20.0) {
                        self.mpos.get(axis) - self.g92.get(axis) - v * k
                    } else {
                        return Err(20);
                    };
                    self.wcs[(wcs - 54) as usize].set(axis, offset);
                }
            }
            self.sync_work();
            return Ok(false);
        }
        if gs.contains(&92.0) {
            let wcs = self.wcs[(self.state.wcs - 54) as usize];
            for axis in ['X', 'Y', 'Z'] {
                if let Some(v) = value(&words, axis) {
                    self.g92
                        .set(axis, self.mpos.get(axis) - wcs.get(axis) - v * k);
                }
            }
            self.sync_work();
            return Ok(false);
        }
        if gs.contains(&4.0) {
            let seconds = value(&words, 'P').ok_or(28)?;
            if seconds < 0.0 {
                return Err(4);
            }
            let mut block = Block::movement(self.mpos, 0.0);
            block.kind = BlockKind::Dwell { remaining: seconds };
            block.acknowledge = true;
            self.planner.push_back(block);
            return Ok(true);
        }
        if gs.contains(&53.0) {
            let mut to = self.planned;
            for axis in ['X', 'Y', 'Z'] {
                if let Some(v) = value(&words, axis) {
                    to.set(axis, v * k);
                }
            }
            let rapid = !gs.contains(&1.0);
            if gs.contains(&0.0) || gs.contains(&1.0) {
                self.state.motion = if rapid { 0.0 } else { 1.0 };
            }
            if !rapid && self.state.feed <= 0.0 && value(&words, 'F').is_none() {
                return Err(22);
            }
            if let Some(feed) = value(&words, 'F') {
                self.state.feed = feed * k;
            }
            let mut block = Block::movement(to, self.state.feed);
            block.rapid = rapid;
            self.planner.push_back(block);
            self.planned = to;
            self.sync_work();
            return Ok(false);
        }
        let probe = gs.iter().copied().find(|g| (38.2..=38.5).contains(g));
        let before = self.state.pos;
        let segments = step(&mut self.state, &line);
        if self.state.feed <= 0.0
            && (probe.is_some()
                || segments
                    .iter()
                    .any(|s| !matches!(s.kind, SegmentKind::Rapid)))
        {
            return Err(22);
        }
        if let Some(mode) = probe {
            let to = self.state.pos.add(self.wco());
            self.state.pos = before;
            let mut block = Block::movement(to, self.state.feed);
            block.kind = BlockKind::Probe {
                mode,
                started: false,
                hit: false,
            };
            block.acknowledge = true;
            self.planner.push_back(block);
            return Ok(true);
        }
        for segment in segments {
            let wco = self.wco();
            if matches!(segment.kind, SegmentKind::Arc { .. }) {
                for point in arc_points(&segment, 1.0) {
                    let mut block = Block::movement(point.add(wco), segment.feed);
                    block.power = self.state.speed;
                    self.planner.push_back(block);
                }
            } else {
                let mut block = Block::movement(segment.to.add(wco), segment.feed);
                block.rapid = matches!(segment.kind, SegmentKind::Rapid);
                block.power = self.state.speed;
                if self.profile.smoothie() && block.rapid {
                    block.rate = self.seek_rate;
                }
                self.planner.push_back(block);
            }
        }
        self.planned = self.state.pos.add(self.wco());
        if ms.contains(&0) || ms.contains(&1) {
            let mut block = Block::movement(self.planned, 0.0);
            block.kind = BlockKind::Pause;
            self.planner.push_back(block);
        }
        if ms.contains(&2) || ms.contains(&30) {
            self.state.spindle = 5;
            self.state.mist = false;
            self.state.flood = false;
            self.state.absolute = true;
            self.state.wcs = 54;
            self.state.plane = 17;
            self.state.motion = 1.0;
            self.g92 = Point::default();
            self.sync_work();
        }
        Ok(false)
    }

    fn rate_of(&self, block: &Block) -> f64 {
        if block.homing || block.jog {
            block.rate
        } else if self.profile.smoothie() {
            block.rate * f64::from(self.overrides.feed) / 100.0
        } else if block.rapid {
            self.settings
                .get(&110)
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(3000.0)
                * f64::from(self.overrides.rapid)
                / 100.0
        } else {
            block.rate * f64::from(self.overrides.feed) / 100.0
        }
    }

    pub fn tick(&mut self, seconds: f64) {
        let mut budget = seconds * self.speedup;
        while budget > 0.0 && !self.hold && !self.alarm {
            let Some(mut block) = self.planner.pop_front() else {
                break;
            };
            match &mut block.kind {
                BlockKind::Dwell { remaining } => {
                    *remaining -= budget;
                    if *remaining > 0.0 {
                        self.planner.push_front(block);
                        break;
                    }
                    budget = -*remaining;
                    self.finish(block);
                    continue;
                }
                BlockKind::Pause => {
                    self.hold = true;
                    self.finish(block);
                    break;
                }
                BlockKind::Probe { started, hit, .. } if !*started => {
                    *started = true;
                    if solid(self.mpos) {
                        self.fail_probe(4);
                        break;
                    }
                    if let Some(contact) = find_contact(self.mpos, block.to) {
                        block.to = contact;
                        *hit = true;
                    }
                }
                _ => {}
            }
            let speed = self.rate_of(&block) / 60.0;
            let distance = self.mpos.distance(block.to);
            if speed <= 0.0 {
                self.planner.push_front(block);
                break;
            }
            if speed * budget >= distance {
                self.mpos = block.to;
                budget -= distance / speed;
                self.finish(block);
            } else {
                self.mpos = self.mpos.lerp(block.to, speed * budget / distance);
                self.planner.push_front(block);
                break;
            }
        }
        self.process_rx();
    }

    fn finish(&mut self, block: Block) {
        if let BlockKind::Probe { mode, hit, .. } = block.kind {
            self.planned = self.mpos;
            self.sync_work();
            if !hit && (mode == 38.2 || mode == 38.4) {
                self.fail_probe(5);
                return;
            }
            self.send(format!("[PRB:{}:{}]", self.mpos.grbl(), u8::from(hit)));
        }
        if block.acknowledge {
            self.send("ok");
            self.waiting = false;
        }
    }

    fn fail_probe(&mut self, code: u8) {
        self.alarm = true;
        self.planner.clear();
        self.planned = self.mpos;
        self.sync_work();
        self.send(format!("ALARM:{code}"));
        self.send(format!("[PRB:{}:0]", self.mpos.grbl()));
        self.send("ok");
        self.waiting = false;
    }
}

fn solid(p: Point) -> bool {
    let in_box = p.x >= -220.0 - TOOL_RADIUS
        && p.x <= -120.0 + TOOL_RADIUS
        && p.y >= -200.0 - TOOL_RADIUS
        && p.y <= -100.0 + TOOL_RADIUS
        && p.z >= -80.0
        && p.z <= -50.0;
    in_box && (p.x - HOLE_X).hypot(p.y - HOLE_Y) > HOLE_RADIUS - TOOL_RADIUS
}

fn find_contact(from: Point, to: Point) -> Option<Point> {
    let n = ((from.distance(to) / 0.05).ceil() as usize).max(1);
    let mut previous = 0.0;
    for i in 1..=n {
        let t = i as f64 / n as f64;
        if solid(from.lerp(to, t)) {
            let (mut lo, mut hi) = (previous, t);
            for _ in 0..30 {
                let mid = (lo + hi) / 2.0;
                if solid(from.lerp(to, mid)) {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            return Some(from.lerp(to, lo));
        }
        previous = t;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoothie_grbl_mode_holds_and_resumes_a_move() {
        let mut sim = Simulator::new(1.0, Profile::Emblaser2);
        sim.grbl_mode = true;
        sim.write(b"G1X10F60S0.5\n");
        sim.tick(1.0);
        let before = sim.mpos;
        sim.write(b"!");
        sim.tick(2.0);
        assert_eq!(sim.mpos, before);
        sim.write(b"~");
        sim.tick(1.0);
        assert!(sim.mpos.x > before.x);
    }
}
