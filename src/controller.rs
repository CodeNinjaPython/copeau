use crate::gcode::{build_resume, fmt, split_program, tokenize, Point};
use crate::profile::Profile;
use crate::simulator::Simulator;
use crate::tcp::{parse_host, TelnetDecoder};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc as thread_mpsc, Arc, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

const RX_BUFFER: usize = 127;
type Result<T> = std::result::Result<T, String>;
type Completion = oneshot::Sender<Result<()>>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub sub_state: Option<String>,
    pub mpos: Point,
    pub wpos: Point,
    pub wco: Point,
    pub feed: f64,
    pub speed: f64,
    pub laser_power: f64,
    pub ov: Overrides,
    pub pins: String,
    pub buffer: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Overrides {
    pub feed: f64,
    pub rapid: f64,
    pub spindle: f64,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            state: "Déconnecté".into(),
            sub_state: None,
            mpos: Point::default(),
            wpos: Point::default(),
            wco: Point::default(),
            feed: 0.0,
            speed: 0.0,
            laser_power: 0.0,
            ov: Overrides {
                feed: 100.0,
                rapid: 100.0,
                spindle: 100.0,
            },
            pins: String::new(),
            buffer: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Modal {
    pub wcs: String,
    pub units: String,
    pub distance: String,
    pub spindle: String,
    pub coolant: String,
    pub tool: f64,
    pub feed: f64,
    pub speed: f64,
}

impl Default for Modal {
    fn default() -> Self {
        Self {
            wcs: "G54".into(),
            units: "G21".into(),
            distance: "G90".into(),
            spindle: "M5".into(),
            coolant: "M9".into(),
            tool: 0.0,
            feed: 0.0,
            speed: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProbeReading {
    pub position: Point,
    pub ok: bool,
}

#[derive(Clone)]
pub struct View {
    pub connected: bool,
    pub ready: bool,
    pub jog_active: bool,
    pub restoring_modes: bool,
    pub status: Status,
    pub modal: Modal,
    pub settings: BTreeMap<String, String>,
    pub last_probe: Option<ProbeReading>,
    pub job_state: Option<String>,
    pub profile: Profile,
    pub can_hold: bool,
    pub seek_rate: Option<f64>,
    pub pointer_on: bool,
    pub recovering: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Source {
    User,
    Jog,
    Probe,
    Macro,
    Sync,
    Init,
    Job,
    ToolChange,
    JogMode,
    Laser,
    Override,
}

enum PendingKind {
    Normal,
    Job(usize),
    Prelude,
    ToolChange(Value),
    Restore,
    RestoreFinal,
}

struct Command {
    line: String,
    source: Source,
    kind: PendingKind,
    completion: Option<Completion>,
    bytes: usize,
}

struct Job {
    name: String,
    text: String,
    lines: Vec<String>,
    next: usize,
    acked: usize,
    start_index: usize,
    prelude: VecDeque<String>,
    state: String,
    error: Option<String>,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    spin_up_until: Option<u64>,
    tool: Option<Value>,
    tool_change: bool,
    waiting_tool: bool,
    resume_from: Option<usize>,
    lost_at: Option<Point>,
}

struct ModeRestore {
    units: String,
    distance: String,
    started: bool,
    failed: bool,
}

impl Job {
    fn active(&self) -> bool {
        [
            "running",
            "paused",
            "spinup",
            "toolchange",
            "finishing",
            "stopping",
        ]
        .contains(&self.state.as_str())
    }
}

enum TransportMessage {
    Write(Vec<u8>),
    Flush(oneshot::Sender<Result<()>>),
    Close,
}

struct Transport {
    sender: thread_mpsc::Sender<TransportMessage>,
    closed: Arc<AtomicBool>,
}

type Operation = Box<dyn FnOnce(&mut Core) + Send>;

enum Action {
    Operation(Operation),
    Data(u64, Vec<u8>),
    Closed(u64, String),
}

#[derive(Clone)]
pub struct Controller {
    sender: mpsc::UnboundedSender<Action>,
    pub events: broadcast::Sender<Value>,
    pointer_lock: Arc<Mutex<()>>,
    jog_lock: Arc<Mutex<()>>,
}

struct Core {
    sender: mpsc::UnboundedSender<Action>,
    events: broadcast::Sender<Value>,
    transport: Option<Transport>,
    generation: u64,
    port: Option<String>,
    last_disconnect: Option<String>,
    profile: Profile,
    ready: bool,
    has_status: bool,
    version: Option<String>,
    queue: VecDeque<Command>,
    inflight: VecDeque<Command>,
    inflight_bytes: usize,
    rx: Vec<u8>,
    status: Status,
    modal: Modal,
    offsets: BTreeMap<String, Value>,
    settings: BTreeMap<String, String>,
    last_probe: Option<ProbeReading>,
    status_inflight: Option<Vec<oneshot::Sender<Result<Status>>>>,
    status_queued: Vec<oneshot::Sender<Result<Status>>>,
    spindle_held: bool,
    jog_active: bool,
    mode_restore: Option<ModeRestore>,
    job: Option<Job>,
    grbl_mode: Option<bool>,
    feed_hold: bool,
    seek_rate: Option<f64>,
    skip_ok: bool,
    connected_at: Instant,
    status_since_jog: u8,
    pointer: Option<Pointer>,
    pointer_generation: u64,
    smoothie_jog_preparing: bool,
    recovering: bool,
    expect_halt: bool,
    resume_requested: bool,
    pointer_lock: Arc<Mutex<()>>,
    jog_lock: Arc<Mutex<()>>,
    logs: VecDeque<Value>,
    shutting_down: bool,
    last_poll: Instant,
}

struct Pointer {
    owner: u64,
    generation: u64,
    power: f64,
    closed: Arc<AtomicBool>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Controller {
    pub fn spawn() -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(2048);
        let handle = Self {
            sender: sender.clone(),
            events: events.clone(),
            pointer_lock: Arc::new(Mutex::new(())),
            jog_lock: Arc::new(Mutex::new(())),
        };
        let pointer_lock = handle.pointer_lock.clone();
        let jog_lock = handle.jog_lock.clone();
        tokio::spawn(async move {
            let mut core = Core::new(sender, events);
            core.pointer_lock = pointer_lock;
            core.jog_lock = jog_lock;
            let mut timer = tokio::time::interval(Duration::from_millis(50));
            loop {
                tokio::select! {
                    _ = timer.tick() => core.tick(),
                    action = receiver.recv() => match action {
                        Some(Action::Operation(f)) => f(&mut core),
                        Some(Action::Data(generation, bytes)) if generation == core.generation => core.on_data(&bytes),
                        Some(Action::Closed(generation, error)) if generation == core.generation => core.detach(&error),
                        Some(_) => {},
                        None => break,
                    }
                }
            }
        });
        handle
    }

    async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Core) -> T + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(Action::Operation(Box::new(move |core| {
                let _ = tx.send(f(core));
            })))
            .map_err(|_| "Contrôleur arrêté".to_string())?;
        rx.await.map_err(|_| "Contrôleur arrêté".to_string())
    }

    pub async fn connect(
        &self,
        port: String,
        baud: u32,
        profile: Profile,
        host: String,
    ) -> Result<()> {
        self.connect_at_speed(port, baud, profile, host, 1.0).await
    }

    async fn connect_at_speed(
        &self,
        port: String,
        baud: u32,
        profile: Profile,
        host: String,
        speedup: f64,
    ) -> Result<()> {
        let mut events = self.events.subscribe();
        self.call(move |core| core.connect(port, baud, profile, host, speedup))
            .await??;
        let result = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let view = self.view().await?;
                if view.ready {
                    return Ok(());
                }
                if !view.connected {
                    let reason = self.call(|core| core.last_disconnect.clone()).await?;
                    return Err(reason.unwrap_or_else(|| "Connexion interrompue".into()));
                }
                match events.recv().await {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err("Contrôleur arrêté".into())
                    }
                }
            }
        })
        .await;
        match result {
            Ok(result) => result,
            Err(_) => {
                self.disconnect("Délai de connexion dépassé").await?;
                Err("Délai de connexion dépassé : aucun état de la machine reçu".into())
            }
        }
    }

    #[cfg(test)]
    pub async fn connect_simulator(&self, speedup: f64) -> Result<()> {
        self.connect_at_speed(
            "simulateur".into(),
            115200,
            Profile::Cnc,
            String::new(),
            speedup,
        )
        .await
    }

    pub async fn disconnect(&self, reason: &str) -> Result<()> {
        let reason = reason.to_string();
        self.call(move |core| core.detach(&reason)).await
    }

    pub async fn begin_shutdown(&self) -> Result<()> {
        self.call(|core| {
            core.shutting_down = true;
            for source in [
                Source::User,
                Source::Macro,
                Source::Probe,
                Source::Jog,
                Source::JogMode,
            ] {
                core.drop_queued(source);
            }
        })
        .await
    }

    pub async fn flush(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(Action::Operation(Box::new(move |core| {
                match &core.transport {
                    Some(transport) => {
                        if let Err(error) = transport.sender.send(TransportMessage::Flush(tx)) {
                            if let TransportMessage::Flush(tx) = error.0 {
                                let _ = tx.send(Err("Port série fermé".into()));
                            }
                        }
                    }
                    None => {
                        let _ = tx.send(Err("Non connecté".into()));
                    }
                }
            })))
            .map_err(|_| "Contrôleur arrêté".to_string())?;
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .map_err(|_| "Écriture série non confirmée".to_string())?
            .map_err(|_| "Port série fermé".to_string())?
    }

    pub async fn command(&self, line: String, source: Source) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(Action::Operation(Box::new(move |core| {
                core.enqueue(line, source, PendingKind::Normal, Some(tx));
            })))
            .map_err(|_| "Contrôleur arrêté".to_string())?;
        rx.await.map_err(|_| "Contrôleur arrêté".to_string())?
    }

    async fn smoothie_jog(
        &self,
        line: String,
        generation: Arc<AtomicU64>,
        expected: u64,
    ) -> Result<()> {
        let _guard = self.jog_lock.lock().await;
        let words = tokenize(&line);
        let relative = words
            .iter()
            .any(|(letter, value)| *letter == 'G' && *value == 91.0);
        let mut move_line = String::from("G0");
        for (letter, value) in &words {
            if ['X', 'Y', 'Z'].contains(letter) {
                move_line.push_str(&format!("{letter}{value:.3}"));
            }
        }
        if move_line == "G0" {
            return Err("Aucun déplacement valide".into());
        }
        let feed = words
            .iter()
            .find(|(letter, _)| *letter == 'F')
            .map(|(_, value)| *value)
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or("Vitesse de jog invalide")?;
        let generation_check = generation.clone();
        let (units, distance, seek_rate) = self
            .call(move |core| -> Result<_> {
                if generation_check.load(Ordering::SeqCst) != expected {
                    return Err("Annulé".into());
                }
                if !core.ready
                    || !core.has_status
                    || core.shutting_down
                    || core.smoothie_jog_preparing
                {
                    return Err("Machine non prête pour le jog".into());
                }
                core.validate_manual_line(&line, Source::Jog)?;
                if !(["Idle", "Jog"].contains(&core.status.state.as_str())
                    || core.jog_active && core.status.state == "Run")
                {
                    return Err(format!("Jog indisponible : machine {}", core.status.state));
                }
                core.smoothie_jog_preparing = true;
                core.jog_active = true;
                Ok((
                    core.modal.units.clone(),
                    core.modal.distance.clone(),
                    core.seek_rate,
                ))
            })
            .await??;
        if seek_rate.is_some() {
            move_line.push_str(&format!("F{feed}"));
        }
        let target_distance = if relative { "G91" } else { "G90" };
        let mut changed_units = false;
        let mut changed_distance = false;
        let result = async {
            if units != "G21" {
                self.command("G21".into(), Source::JogMode).await?;
                changed_units = true;
            }
            if distance != target_distance {
                self.command(target_distance.into(), Source::JogMode)
                    .await?;
                changed_distance = true;
            }
            if generation.load(Ordering::SeqCst) != expected {
                return Err("Annulé".into());
            }
            self.command(move_line, Source::Jog).await
        }
        .await;
        let mut restore_error = None;
        let view = self.view().await?;
        if view.ready && view.status.state != "Alarm" {
            let mut restore = Vec::new();
            if changed_distance {
                restore.push(distance.clone());
            }
            if changed_units {
                restore.push(units.clone());
            }
            if let Some(rate) = seek_rate {
                restore.push(format!("G0F{rate}"));
            }
            for mode in restore {
                if let Err(error) = self.command(mode, Source::JogMode).await {
                    restore_error = Some(error);
                    break;
                }
            }
        } else if result.is_err() && view.connected {
            if let Err(error) = self.defer_mode_restore("G21".into(), "G90".into()).await {
                restore_error = Some(error);
            }
        }
        self.call(|core| {
            core.smoothie_jog_preparing = false;
            core.pump();
        })
        .await?;
        if let Some(error) = restore_error {
            return Err(format!("Modes non rétablis après le jog : {error}"));
        }
        result
    }

    pub async fn validate_manual_lines(&self, lines: Vec<String>, source: Source) -> Result<()> {
        self.call(move |core| {
            for line in &lines {
                core.validate_manual_line(line, source)?;
            }
            Ok(())
        })
        .await?
    }

    pub async fn defer_mode_restore(&self, units: String, distance: String) -> Result<()> {
        self.call(move |core| -> Result<()> {
            if !core.ready || core.shutting_down {
                return Err("Restauration impossible : machine non prête".into());
            }
            core.mode_restore = Some(ModeRestore {
                units,
                distance,
                started: false,
                failed: false,
            });
            if core.status.state == "Idle" {
                core.start_mode_restore();
            }
            Ok(())
        })
        .await?
    }

    pub async fn jog_command(
        &self,
        line: String,
        generation: Arc<AtomicU64>,
        expected: u64,
    ) -> Result<()> {
        if self.view().await?.profile.smoothie() {
            return self.smoothie_jog(line, generation, expected).await;
        }
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(Action::Operation(Box::new(move |core| {
                if generation.load(Ordering::SeqCst) != expected {
                    let _ = tx.send(Err("Annulé".into()));
                } else {
                    core.enqueue(line, Source::Jog, PendingKind::Normal, Some(tx));
                }
            })))
            .map_err(|_| "Contrôleur arrêté".to_string())?;
        rx.await.map_err(|_| "Contrôleur arrêté".to_string())?
    }

    pub async fn realtime(&self, name: &str) -> Result<()> {
        let name = name.to_string();
        self.call(move |core| core.realtime(&name)).await?
    }

    pub async fn smoothie_override(&self, name: &str) -> Result<()> {
        let name = name.to_string();
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(Action::Operation(Box::new(move |core| {
                if !core.profile.smoothie() || !core.ready || !core.has_status || core.recovering {
                    let _ = tx.send(Err("Machine Smoothieware non prête".into()));
                    return;
                }
                let (code, current, delta) = match name.as_str() {
                    "feed100" => ("M220", core.status.ov.feed, None),
                    "feedPlus10" => ("M220", core.status.ov.feed, Some(10.0)),
                    "feedMinus10" => ("M220", core.status.ov.feed, Some(-10.0)),
                    "feedPlus1" => ("M220", core.status.ov.feed, Some(1.0)),
                    "feedMinus1" => ("M220", core.status.ov.feed, Some(-1.0)),
                    "spindle100" => ("M221", core.status.ov.spindle, None),
                    "spindlePlus10" => ("M221", core.status.ov.spindle, Some(10.0)),
                    "spindleMinus10" => ("M221", core.status.ov.spindle, Some(-10.0)),
                    "spindlePlus1" => ("M221", core.status.ov.spindle, Some(1.0)),
                    "spindleMinus1" => ("M221", core.status.ov.spindle, Some(-1.0)),
                    _ => {
                        let _ = tx.send(Err(format!(
                            "Correction « {name} » indisponible avec Smoothieware"
                        )));
                        return;
                    }
                };
                let value = delta
                    .map_or(100.0, |delta| current + delta)
                    .round()
                    .clamp(10.0, 200.0);
                if code == "M220" {
                    core.status.ov.feed = value;
                } else {
                    core.status.ov.spindle = value;
                }
                core.enqueue(
                    format!("{code}S{}", fmt(value)),
                    Source::Override,
                    PendingKind::Normal,
                    Some(tx),
                );
                core.emit_state();
            })))
            .map_err(|_| "Contrôleur arrêté".to_string())?;
        rx.await.map_err(|_| "Contrôleur arrêté".to_string())?
    }

    pub async fn pointer_on(
        &self,
        owner: u64,
        closed: Arc<AtomicBool>,
        power: f64,
        s_max: f64,
    ) -> Result<()> {
        self.pointer_on_for(owner, closed, power, s_max, Duration::from_secs(60))
            .await
    }

    async fn pointer_on_for(
        &self,
        owner: u64,
        closed: Arc<AtomicBool>,
        power: f64,
        s_max: f64,
        maximum: Duration,
    ) -> Result<()> {
        if !power.is_finite() || !s_max.is_finite() || s_max <= 0.0 {
            return Err("Puissance laser invalide".into());
        }
        let _guard = self.pointer_lock.lock().await;
        let power = power.clamp(0.1, 100.0);
        let token = self
            .call(move |core| -> Result<u64> {
                if closed.load(Ordering::SeqCst) {
                    return Err("Écran déconnecté".into());
                }
                if !core.profile.laser() {
                    return Err("Profil laser non choisi".into());
                }
                if !core.ready
                    || !core.has_status
                    || core.shutting_down
                    || core.status.state != "Idle"
                {
                    return Err("La machine doit être prête et à l'arrêt".into());
                }
                if core.job.as_ref().is_some_and(Job::active)
                    || core.has_pending_manual_motion()
                    || core.mode_restore.is_some()
                    || core.recovering
                {
                    return Err("Mouvement ou usinage en cours".into());
                }
                if core.pointer.is_some() {
                    return Err("Le tir de repérage est déjà allumé".into());
                }
                if core.profile == Profile::LaserGrbl
                    && core.settings.get("32").is_none_or(|value| value != "1")
                {
                    return Err("Activez le mode laser Grbl ($32=1) avant le repérage".into());
                }
                core.pointer_generation = core.pointer_generation.wrapping_add(1);
                let token = core.pointer_generation;
                core.pointer = Some(Pointer {
                    owner,
                    generation: token,
                    power,
                    closed,
                });
                core.emit_state();
                Ok(token)
            })
            .await??;
        let timeout_controller = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(maximum).await;
            if let Err(error) = timeout_controller
                .pointer_off_matching(Some((owner, token)))
                .await
            {
                let _ = timeout_controller
                    .log("err", format!("Extinction automatique du laser : {error}"))
                    .await;
            }
        });
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            let profile = self.view().await?.profile;
            if profile.smoothie() {
                self.pointer_command(owner, token, format!("fire {}", fmt(power)), true)
                    .await?;
            } else {
                self.pointer_command(owner, token, "G1F1000".into(), true)
                    .await?;
                self.pointer_command(
                    owner,
                    token,
                    format!("M3S{}", fmt(power * s_max / 100.0)),
                    true,
                )
                .await?;
            }
            self.flush().await
        })
        .await
        .unwrap_or_else(|_| Err("Allumage du repérage non confirmé".into()));
        if let Err(error) = result {
            let off = self.pointer_off_locked(Some((owner, token))).await;
            return Err(match off {
                Ok(()) => error,
                Err(off_error) => format!("{error} ; extinction : {off_error}"),
            });
        }
        self.log("info", format!("Tir de repérage à {} %", fmt(power)))
            .await?;
        Ok(())
    }

    async fn pointer_command(
        &self,
        owner: u64,
        token: u64,
        line: String,
        require_open: bool,
    ) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(Action::Operation(Box::new(move |core| {
                let valid = core.pointer.as_ref().is_some_and(|pointer| {
                    pointer.owner == owner
                        && pointer.generation == token
                        && (!require_open || !pointer.closed.load(Ordering::SeqCst))
                });
                if valid {
                    core.enqueue(line, Source::Laser, PendingKind::Normal, Some(tx));
                } else {
                    let _ = tx.send(Err("Tir de repérage annulé".into()));
                }
            })))
            .map_err(|_| "Contrôleur arrêté".to_string())?;
        rx.await.map_err(|_| "Contrôleur arrêté".to_string())?
    }

    pub async fn pointer_off(&self) -> Result<()> {
        self.pointer_off_matching(None).await
    }

    pub async fn pointer_off_owner(&self, owner: u64) -> Result<()> {
        let token = self
            .call(move |core| {
                core.pointer
                    .as_ref()
                    .filter(|pointer| pointer.owner == owner)
                    .map(|pointer| pointer.generation)
            })
            .await?;
        if let Some(token) = token {
            self.pointer_off_matching(Some((owner, token))).await?;
        }
        Ok(())
    }

    async fn pointer_off_matching(&self, expected: Option<(u64, u64)>) -> Result<()> {
        let _guard = self.pointer_lock.lock().await;
        self.pointer_off_locked(expected).await
    }

    async fn pointer_off_locked(&self, expected: Option<(u64, u64)>) -> Result<()> {
        let pointer = self
            .call(move |core| {
                core.pointer.as_ref().and_then(|pointer| {
                    let identity = (pointer.owner, pointer.generation);
                    if expected.is_none_or(|expected| expected == identity) {
                        Some((identity, core.profile))
                    } else {
                        None
                    }
                })
            })
            .await?;
        let Some(((owner, token), profile)) = pointer else {
            return Ok(());
        };
        let result = tokio::time::timeout(Duration::from_millis(1500), async {
            if profile.smoothie() {
                self.pointer_command(owner, token, "fire off".into(), false)
                    .await?;
            } else {
                self.pointer_command(owner, token, "M5".into(), false)
                    .await?;
                self.pointer_command(owner, token, "G0".into(), false)
                    .await?;
            }
            self.flush().await
        })
        .await
        .unwrap_or_else(|_| Err("Extinction du laser non confirmée".into()));
        if let Err(error) = result {
            let (still_on, connected) = self
                .call(move |core| {
                    (
                        core.pointer
                            .as_ref()
                            .is_some_and(|p| p.owner == owner && p.generation == token),
                        core.transport.is_some(),
                    )
                })
                .await?;
            if !still_on {
                return if connected {
                    Ok(())
                } else {
                    Err(format!(
                        "{error} ; liaison perdue, coupez le laser avec sa commande matérielle"
                    ))
                };
            }
            let reset = self.realtime("reset").await;
            let flushed = if reset.is_ok() {
                self.flush().await
            } else {
                reset
            };
            return Err(match flushed {
                Ok(()) => format!("{error} ; reset envoyé, vérifiez l'extinction du laser"),
                Err(reset_error) => {
                    format!("{error} ; reset impossible : {reset_error}. Coupez le laser")
                }
            });
        }
        self.call(move |core| {
            if core
                .pointer
                .as_ref()
                .is_some_and(|p| p.owner == owner && p.generation == token)
            {
                core.pointer = None;
                core.log("info", "Tir de repérage éteint".into());
                core.emit_state();
            }
        })
        .await?;
        Ok(())
    }

    pub async fn view(&self) -> Result<View> {
        self.call(|core| core.view()).await
    }

    pub async fn initial_messages(&self) -> Result<Vec<Value>> {
        self.call(|core| {
            let mut messages = vec![
                json!({"t":"state","s":core.snapshot()}),
                json!({"t":"settings","s":core.settings}),
                json!({"t":"logs","list":core.logs}),
            ];
            if let Some(job) = &core.job {
                messages.push(json!({"t":"job-text","name":job.name,"text":job.text}));
            }
            messages.push(json!({"t":"job","j":core.job_snapshot()}));
            messages
        })
        .await
    }

    pub async fn next_status(&self) -> Result<Status> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(Action::Operation(Box::new(move |core| {
                if core.transport.is_none() {
                    let _ = tx.send(Err("Non connecté".into()));
                    return;
                }
                core.status_queued.push(tx);
                let _ = core.request_status();
            })))
            .map_err(|_| "Contrôleur arrêté".to_string())?;
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .map_err(|_| "Pas de rapport d'état".to_string())?
            .map_err(|_| "Contrôleur arrêté".to_string())?
    }

    pub async fn clear_probe(&self) -> Result<()> {
        self.call(|core| core.last_probe = None).await
    }

    pub async fn log(&self, direction: &str, text: String) -> Result<()> {
        let direction = direction.to_string();
        self.call(move |core| core.log(&direction, text)).await
    }

    pub async fn load_job(&self, name: String, text: String) -> Result<()> {
        self.call(move |core| core.load_job(name, text)).await?
    }

    pub async fn run_job(
        &self,
        from: usize,
        tool_change: bool,
        spin_up: f64,
        min_safe_z: f64,
    ) -> Result<()> {
        self.call(move |core| core.run_job(from, tool_change, spin_up, min_safe_z))
            .await?
    }

    pub async fn tool_done(&self) -> Result<()> {
        let view = self.view().await?;
        if view.job_state.as_deref() != Some("toolchange") {
            return Err("Pas de changement d'outil en attente".into());
        }
        let sync = if view.profile.smoothie() {
            "M400"
        } else {
            "G4P0.01"
        };
        tokio::time::timeout(
            Duration::from_secs(30),
            self.command(sync.into(), Source::Sync),
        )
        .await
        .map_err(|_| "Fin du déplacement non confirmée".to_string())??;
        self.next_status().await?;
        self.call(|core| core.tool_done()).await?
    }

    pub async fn jog_stop(&self) -> Result<()> {
        self.jog_stop_with(false).await
    }

    pub async fn jog_stop_with(&self, gentle: bool) -> Result<()> {
        let view = self.view().await?;
        if view.profile.smoothie() {
            self.call(|core| core.drop_queued(Source::Jog)).await?;
            if view.ready && view.jog_active && !gentle {
                return self.halt_smoothie().await;
            }
            if view.ready {
                tokio::time::timeout(
                    Duration::from_secs(3),
                    self.command("M400".into(), Source::Sync),
                )
                .await
                .map_err(|_| "Synchronisation après arrêt non confirmée".to_string())??;
            }
            return Ok(());
        }
        let ready = self
            .call(|core| -> Result<bool> {
                core.drop_queued(Source::Jog);
                if core.ready {
                    core.realtime("jogCancel")?;
                    Ok(true)
                } else {
                    Ok(false)
                }
            })
            .await??;
        if ready {
            self.command("G4P0".into(), Source::Sync).await?;
        }
        Ok(())
    }

    pub async fn hold_and_reset(&self) -> Result<()> {
        if self.view().await?.profile.smoothie() {
            return self.halt_smoothie().await;
        }
        self.realtime("hold").await?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if Instant::now() >= deadline {
                return Err("Arrêt non confirmé : reset non envoyé".into());
            }
            let status = self.next_status().await?;
            if status.state == "Alarm" {
                return Ok(());
            }
            if status.state == "Idle"
                || (status.state == "Hold" && status.sub_state.as_deref() == Some("0"))
            {
                self.realtime("reset").await?;
                return self.flush().await;
            }
        }
    }

    pub async fn pause(&self, stop_spindle: bool) -> Result<()> {
        let (paused, laser) = self
            .call(|core| -> Result<(bool, bool)> {
                if core.job.as_ref().is_none_or(|j| j.state != "running") {
                    return Ok((false, core.profile.laser()));
                }
                if !core.profile.smoothie() || core.feed_hold {
                    core.realtime("hold")?;
                } else {
                    core.log(
                        "info",
                        "Pause : la carte termine les mouvements déjà reçus".into(),
                    );
                }
                core.resume_requested = false;
                core.job.as_mut().expect("job").state = "paused".into();
                core.emit_job();
                Ok((true, core.profile.laser()))
            })
            .await??;
        if paused && stop_spindle && !laser {
            self.stop_spindle_inner(true).await?;
        }
        Ok(())
    }

    pub async fn stop_spindle(&self) -> Result<()> {
        self.stop_spindle_inner(false).await
    }

    async fn stop_spindle_inner(&self, automatic: bool) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let result = self
                .call(move |core| -> Result<bool> {
                    if core.profile.laser() {
                        return Err("Laser : la coupure de broche n'est pas disponible".into());
                    }
                    if core.resume_requested {
                        return if automatic {
                            Ok(true)
                        } else {
                            Err("Reprise en cours : coupure de broche refusée".into())
                        };
                    }
                    if automatic && core.job.as_ref().is_none_or(|job| job.state != "paused") {
                        return Ok(true);
                    }
                    if core.spindle_held {
                        return Ok(true);
                    }
                    if core.status.state == "Hold" && core.status.sub_state.as_deref() == Some("0")
                    {
                        core.realtime("spindleStop")?;
                        core.spindle_held = true;
                        core.log("info", "Broche coupée pendant la pause".into());
                        core.emit_state();
                        core.emit_job();
                        return Ok(true);
                    }
                    if !["Hold", "Run"].contains(&core.status.state.as_str()) {
                        return Err(
                            "Broche non coupée : la machine doit être en pause complète".into()
                        );
                    }
                    Ok(false)
                })
                .await??;
            if result {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Broche non coupée : la machine n'a pas confirmé la pause".into());
            }
            self.next_status().await?;
        }
    }

    pub async fn resume(&self, spin_up: f64) -> Result<()> {
        if !spin_up.is_finite() {
            return Err("Durée de démarrage invalide".into());
        }
        let spin_up = spin_up.clamp(0.0, 30.0);
        let (should_resume, needs_spinup, expected_state, is_smoothie) = self
            .call(move |core| -> Result<(bool, bool, String, bool)> {
                let program_pause = core.job.as_ref().is_some_and(|j| j.state == "running")
                    && ["Hold", "Door"].contains(&core.status.state.as_str());
                if !program_pause && core.job.as_ref().is_none_or(|j| j.state != "paused") {
                    return Ok((false, false, String::new(), core.profile.smoothie()));
                }
                core.resume_requested = true;
                if core.spindle_held {
                    core.realtime("spindleStop")?;
                    core.spindle_held = false;
                    let job = core.job.as_mut().expect("job");
                    job.state = "spinup".into();
                    job.spin_up_until = Some(now_ms() + (spin_up * 1000.0) as u64);
                    core.log("info", format!("Broche rallumée, reprise dans {spin_up} s"));
                    core.emit_state();
                    core.emit_job();
                    Ok((true, true, "spinup".into(), core.profile.smoothie()))
                } else {
                    Ok((
                        true,
                        false,
                        core.job.as_ref().expect("job").state.clone(),
                        core.profile.smoothie(),
                    ))
                }
            })
            .await??;
        if !should_resume {
            return Ok(());
        }
        if needs_spinup {
            tokio::time::sleep(Duration::from_secs_f64(spin_up)).await;
        }
        if !is_smoothie && expected_state != "running" {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let view = self.view().await?;
                if !view.ready || view.job_state.as_deref() != Some(expected_state.as_str()) {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    self.call(|core| core.resume_requested = false).await?;
                    return Err("Reprise impossible : arrêt complet non confirmé".into());
                }
                let status = self.next_status().await?;
                if status.state != "Run"
                    && (status.state != "Hold" || status.sub_state.as_deref() == Some("0"))
                {
                    break;
                }
            }
        }
        self.call(move |core| -> Result<()> {
            if core.ready
                && core
                    .job
                    .as_ref()
                    .is_some_and(|job| job.state == expected_state)
            {
                core.resume_running()?;
            }
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        let stopping = self
            .call(|core| -> Result<u8> {
                if core.recovering {
                    return Ok(2);
                }
                if core.job.as_ref().is_none_or(|j| !j.active()) {
                    return Ok(0);
                }
                if core.job.as_ref().is_some_and(|j| j.state == "stopping") {
                    return Ok(2);
                }
                if !core.profile.smoothie() || core.feed_hold {
                    core.realtime("hold")?;
                }
                core.job.as_mut().expect("job").state = "stopping".into();
                core.emit_job();
                Ok(if core.profile.smoothie() { 3 } else { 1 })
            })
            .await??;
        if stopping == 0 {
            return Ok(());
        }
        if stopping == 3 {
            self.halt_smoothie().await?;
            self.call(|core| {
                if let Some(job) = &mut core.job {
                    job.state = "stopped".into();
                }
                core.log("info", "Job arrêté".into());
                core.emit_job();
            })
            .await?;
            return Ok(());
        }
        if stopping == 2 {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                let view = self.view().await?;
                if view.recovering && Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    continue;
                }
                match view.job_state.as_deref() {
                    Some("stopping") if Instant::now() < deadline => {
                        tokio::time::sleep(Duration::from_millis(20)).await
                    }
                    Some("stopped") if view.connected && !view.restoring_modes => {
                        return self.flush().await
                    }
                    _ => return Err("Arrêt de la machine non confirmé".into()),
                }
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let stopped = loop {
            if Instant::now() >= deadline {
                break false;
            }
            match self.next_status().await {
                Ok(status)
                    if status.state == "Idle"
                        || status.state == "Alarm"
                        || (status.state == "Hold" && status.sub_state.as_deref() == Some("0")) =>
                {
                    break true
                }
                Ok(_) => {}
                Err(_) if !self.view().await?.connected => break false,
                Err(_) => {}
            }
        };
        self.call(move |core| {
            if !stopped {
                let error = "Arrêt non confirmé : reset non envoyé".to_string();
                if let Some(job) = &mut core.job {
                    if job.state == "stopping" {
                        job.state = "paused".into();
                        job.error = Some(error.clone());
                    }
                }
                core.log("err", error.clone());
                core.emit_job();
                return Err(error);
            }
            if core.job.as_ref().is_some_and(|j| j.state == "stopping") {
                core.realtime("reset")?;
                if let Some(job) = &mut core.job {
                    job.state = "stopped".into();
                }
                core.log("info", "Job arrêté".into());
                core.emit_job();
            }
            Ok(())
        })
        .await??;
        self.flush().await
    }

    async fn halt_smoothie(&self) -> Result<()> {
        let view = self
            .call(|core| -> Result<View> {
                let view = core.view();
                if !view.ready || core.recovering {
                    return Err(
                        "Arrêt impossible : machine non prête ou déjà en cours d'arrêt".into(),
                    );
                }
                core.recovering = true;
                Ok(view)
            })
            .await??;
        let result = self.halt_smoothie_inner(&view).await;
        let failure = result.as_ref().err().cloned();
        self.call(move |core| {
            core.recovering = false;
            if let Some(error) = failure {
                if core.transport.is_some() {
                    core.mode_restore = Some(ModeRestore {
                        units: "G21".into(),
                        distance: "G90".into(),
                        started: false,
                        failed: false,
                    });
                    core.log("err", format!("Arrêt Smoothieware non confirmé : {error}"));
                    core.emit_state();
                }
            } else if core.status.state == "Idle" {
                core.start_mode_restore();
            }
        })
        .await?;
        result
    }

    async fn halt_smoothie_inner(&self, view: &View) -> Result<()> {
        if view.can_hold && ["Run", "Jog", "Hold"].contains(&view.status.state.as_str()) {
            self.realtime("hold").await?;
            let deadline = Instant::now() + Duration::from_secs(4);
            let mut previous = None;
            loop {
                if Instant::now() >= deadline {
                    return Err("Arrêt non confirmé : reset non envoyé".into());
                }
                let status = self.next_status().await?;
                if status.state == "Idle"
                    || (status.state == "Hold" && previous == Some(status.mpos))
                {
                    break;
                }
                previous = Some(status.mpos);
            }
        }
        self.realtime("reset").await?;
        self.flush().await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut lines = vec!["M999".to_string(), "G90".into(), "G21".into()];
        if let Some(rate) = view.seek_rate {
            lines.push(format!("G0F{rate}"));
        }
        for line in lines {
            tokio::time::timeout(Duration::from_secs(3), self.command(line, Source::Sync))
                .await
                .map_err(|_| "Arrêt Smoothieware non confirmé".to_string())??;
        }
        tokio::time::timeout(
            Duration::from_secs(3),
            self.command("M400".into(), Source::Sync),
        )
        .await
        .map_err(|_| "Synchronisation après arrêt non confirmée".to_string())??;
        self.next_status().await?;
        Ok(())
    }
}

impl Core {
    fn new(sender: mpsc::UnboundedSender<Action>, events: broadcast::Sender<Value>) -> Self {
        Self {
            sender,
            events,
            transport: None,
            generation: 0,
            port: None,
            last_disconnect: None,
            profile: Profile::Cnc,
            ready: false,
            has_status: false,
            version: None,
            queue: VecDeque::new(),
            inflight: VecDeque::new(),
            inflight_bytes: 0,
            rx: Vec::new(),
            status: Status::default(),
            modal: Modal::default(),
            offsets: BTreeMap::new(),
            settings: BTreeMap::new(),
            last_probe: None,
            status_inflight: None,
            status_queued: Vec::new(),
            spindle_held: false,
            jog_active: false,
            mode_restore: None,
            job: None,
            grbl_mode: None,
            feed_hold: false,
            seek_rate: None,
            skip_ok: false,
            connected_at: Instant::now(),
            status_since_jog: 2,
            pointer: None,
            pointer_generation: 0,
            smoothie_jog_preparing: false,
            recovering: false,
            expect_halt: false,
            resume_requested: false,
            pointer_lock: Arc::new(Mutex::new(())),
            jog_lock: Arc::new(Mutex::new(())),
            logs: VecDeque::new(),
            shutting_down: false,
            last_poll: Instant::now(),
        }
    }

    fn reset_machine(&mut self) {
        self.ready = false;
        self.has_status = false;
        self.version = None;
        self.rx.clear();
        self.status = Status::default();
        self.modal = Modal::default();
        self.offsets.clear();
        self.settings.clear();
        self.last_probe = None;
        self.spindle_held = false;
        self.jog_active = false;
        self.mode_restore = None;
        self.grbl_mode = None;
        self.feed_hold = false;
        self.seek_rate = None;
        self.skip_ok = false;
        self.status_since_jog = 2;
        self.pointer = None;
        self.smoothie_jog_preparing = false;
        self.recovering = false;
        self.expect_halt = false;
        self.resume_requested = false;
    }

    fn connect(
        &mut self,
        port: String,
        baud: u32,
        profile: Profile,
        host: String,
        speedup: f64,
    ) -> Result<()> {
        if self.shutting_down {
            return Err("Application en cours de fermeture".into());
        }
        if port.trim().is_empty() || baud == 0 {
            return Err("Port ou vitesse série invalide".into());
        }
        let network_address = if port == "reseau" {
            Some(parse_host(&host)?)
        } else {
            None
        };
        if self.transport.is_some() {
            self.detach("Changement de port");
        }
        self.generation = self.generation.wrapping_add(1);
        let transport = if port == "simulateur" {
            simulator_transport(self.sender.clone(), self.generation, speedup, profile)
        } else if let Some((hostname, network_port)) = network_address {
            tcp_transport(hostname, network_port, self.sender.clone(), self.generation)
        } else {
            serial_transport(&port, baud, self.sender.clone(), self.generation)?
        };
        self.reset_machine();
        self.profile = profile;
        self.last_disconnect = None;
        self.transport = Some(transport);
        self.port = Some(port);
        self.status.state = "Connexion".into();
        self.connected_at = Instant::now();
        self.last_poll = Instant::now();
        self.emit_state();
        Ok(())
    }

    fn detach(&mut self, reason: &str) {
        let Some(transport) = self.transport.take() else {
            return;
        };
        let pointer_was_on = self.pointer.is_some();
        transport.closed.store(true, Ordering::SeqCst);
        let _ = transport.sender.send(TransportMessage::Close);
        self.generation = self.generation.wrapping_add(1);
        self.fail_pending(reason);
        if let Some(job) = &mut self.job {
            if job.active() {
                job.state = "stopped".into();
                job.error = Some(reason.to_string());
            }
        }
        self.port = None;
        self.reset_machine();
        self.last_disconnect = Some(reason.to_string());
        if pointer_was_on {
            self.log("err", "Liaison perdue pendant le tir de repérage : coupez le laser avec sa commande matérielle.".into());
        }
        self.log("info", reason.to_string());
        self.emit_job();
        self.emit_state();
    }

    fn tick(&mut self) {
        if let Some(waiters) = &mut self.status_inflight {
            waiters.retain(|waiter| !waiter.is_closed());
        }
        self.status_queued.retain(|waiter| !waiter.is_closed());
        if self.transport.is_none() {
            return;
        }
        if self.profile.smoothie()
            && !self.ready
            && self.connected_at.elapsed() >= Duration::from_millis(700)
        {
            self.smoothie_ready();
        }
        if self.last_poll.elapsed() >= Duration::from_millis(200) {
            let _ = self.request_status();
        }
    }

    fn request_status(&mut self) -> Result<()> {
        if self.status_inflight.is_some() {
            return Ok(());
        }
        if let Err(error) = self.write_raw(vec![b'?']) {
            self.detach(&error);
            return Err(error);
        }
        self.last_poll = Instant::now();
        self.status_inflight = Some(std::mem::take(&mut self.status_queued));
        Ok(())
    }

    fn write_raw(&self, bytes: Vec<u8>) -> Result<()> {
        self.transport
            .as_ref()
            .ok_or_else(|| "Non connecté".to_string())?
            .sender
            .send(TransportMessage::Write(bytes))
            .map_err(|_| "Port série fermé".to_string())
    }

    fn realtime(&mut self, name: &str) -> Result<()> {
        if self.shutting_down && name == "start" {
            return Err("Application en cours de fermeture".into());
        }
        if name == "status" {
            return self.request_status();
        }
        if self.profile.smoothie()
            && !matches!(name, "reset")
            && !(matches!(name, "hold" | "start") && self.feed_hold)
        {
            return Err(format!(
                "Commande « {name} » indisponible avec Smoothieware"
            ));
        }
        let byte = match name {
            "hold" => 0x21,
            "start" => 0x7e,
            "reset" => 0x18,
            "jogCancel" => 0x85,
            "feed100" => 0x90,
            "feedPlus10" => 0x91,
            "feedMinus10" => 0x92,
            "feedPlus1" => 0x93,
            "feedMinus1" => 0x94,
            "rapid100" => 0x95,
            "rapid50" => 0x96,
            "rapid25" => 0x97,
            "spindle100" => 0x99,
            "spindlePlus10" => 0x9a,
            "spindleMinus10" => 0x9b,
            "spindlePlus1" => 0x9c,
            "spindleMinus1" => 0x9d,
            "spindleStop" => 0x9e,
            "flood" => 0xa0,
            "mist" => 0xa1,
            _ => return Err(format!("Commande temps réel inconnue : {name}")),
        };
        if let Err(error) = self.write_raw(vec![byte]) {
            self.detach(&error);
            return Err(error);
        }
        if name == "reset" {
            if !self.profile.smoothie() {
                self.ready = false;
                self.has_status = false;
            }
            self.fail_pending("Reset");
            self.mode_restore = None;
            self.pointer = None;
            if self.profile.smoothie() {
                self.expect_halt = true;
                self.status.state = "Alarm".into();
            }
            if let Some(job) = &mut self.job {
                if job.active() && job.state != "stopping" {
                    job.state = "stopped".into();
                    self.emit_job();
                }
            }
            self.emit_state();
        }
        Ok(())
    }

    fn fail_pending(&mut self, reason: &str) {
        for mut command in self.queue.drain(..).chain(self.inflight.drain(..)) {
            if let Some(tx) = command.completion.take() {
                let _ = tx.send(Err(reason.to_string()));
            }
        }
        self.inflight_bytes = 0;
        let mut waiters = self.status_inflight.take().unwrap_or_default();
        waiters.append(&mut self.status_queued);
        for waiter in waiters {
            let _ = waiter.send(Err(reason.to_string()));
        }
    }

    fn is_read_only_line(line: &str) -> bool {
        ["$G", "$#", "$I", "$$"]
            .iter()
            .any(|allowed| line.trim().eq_ignore_ascii_case(allowed))
    }

    fn has_pending_manual_motion(&self) -> bool {
        self.smoothie_jog_preparing
            || self.jog_active
            || self.queue.iter().chain(&self.inflight).any(|item| {
                matches!(
                    item.source,
                    Source::User | Source::Macro | Source::Jog | Source::JogMode
                ) && !Self::is_read_only_line(&item.line)
            })
    }

    fn validate_manual_line(&self, line: &str, source: Source) -> Result<()> {
        if !matches!(
            source,
            Source::User | Source::Macro | Source::Jog | Source::JogMode
        ) {
            return Ok(());
        }
        let line = line.trim();
        let read_only = Self::is_read_only_line(line);
        if self.recovering && !read_only {
            return Err("Arrêt en cours : commande refusée".into());
        }
        if self
            .job
            .as_ref()
            .is_some_and(|job| job.active() && job.state != "toolchange")
            && !read_only
        {
            return Err(
                "Usinage en cours : commande refusée. Utilisez Pause, Arrêter ou les corrections en direct."
                    .into(),
            );
        }
        let unlock = source == Source::User
            && ["$X", "$H"]
                .iter()
                .any(|allowed| line.eq_ignore_ascii_case(allowed));
        if self.mode_restore.is_some() && !read_only && !unlock {
            return Err("Rétablissement des modes après palpage : commande refusée".into());
        }
        Ok(())
    }

    fn enqueue(
        &mut self,
        line: String,
        source: Source,
        kind: PendingKind,
        completion: Option<Completion>,
    ) {
        let line = if self.profile.smoothie() && line.trim().eq_ignore_ascii_case("$X") {
            "M999".to_string()
        } else {
            line.trim().to_string()
        };
        let error = if self.transport.is_none() {
            Some("Non connecté".to_string())
        } else if self.shutting_down
            && matches!(
                source,
                Source::User | Source::Macro | Source::Probe | Source::Jog
            )
        {
            Some("Application en cours de fermeture".to_string())
        } else if matches!(
            source,
            Source::User
                | Source::Macro
                | Source::Probe
                | Source::Jog
                | Source::JogMode
                | Source::Laser
        ) && (!self.ready || !self.has_status)
        {
            Some("Machine non prête".to_string())
        } else if let Err(error) = self.validate_manual_line(&line, source) {
            Some(error)
        } else if line.is_empty() {
            Some("Commande vide".to_string())
        } else if line.len() + 1 > RX_BUFFER {
            Some(format!(
                "Ligne trop longue pour le tampon Grbl ({} octets)",
                line.len() + 1
            ))
        } else if line.contains(['\n', '\r']) {
            Some("Une commande ne peut contenir plusieurs lignes".to_string())
        } else {
            None
        };
        if let Some(error) = error {
            if let Some(tx) = completion {
                let _ = tx.send(Err(error.clone()));
            }
            self.log("err", error);
            return;
        }
        if self.profile.smoothie()
            && (line.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                || line.eq_ignore_ascii_case("$I")
                || line.to_ascii_uppercase().starts_with("$S"))
        {
            let result = self.write_raw(format!("{line}\n").into_bytes());
            if matches!(source, Source::User | Source::Laser) {
                self.log("tx", line);
            }
            if let Some(tx) = completion {
                let _ = tx.send(result);
            }
            return;
        }
        let bytes = line.len() + 1;
        if source == Source::Jog {
            self.jog_active = true;
        }
        let command = Command {
            line,
            source,
            kind,
            completion,
            bytes,
        };
        if self.profile.smoothie()
            && self.smoothie_jog_preparing
            && matches!(source, Source::Jog | Source::JogMode)
        {
            self.queue.push_front(command);
        } else {
            self.queue.push_back(command);
        }
        self.pump();
    }

    fn drop_queued(&mut self, source: Source) {
        let mut kept = VecDeque::new();
        while let Some(mut item) = self.queue.pop_front() {
            if item.source == source {
                if let Some(tx) = item.completion.take() {
                    let _ = tx.send(Err("Annulé".into()));
                }
            } else {
                kept.push_back(item);
            }
        }
        self.queue = kept;
    }

    fn start_mode_restore(&mut self) {
        let Some(restore) = self.mode_restore.as_mut() else {
            return;
        };
        if restore.started || self.shutting_down || self.recovering {
            return;
        }
        restore.started = true;
        let lines = [restore.units.clone(), restore.distance.clone()];
        self.log("info", "Rétablissement des modes après palpage".into());
        for line in lines {
            self.enqueue(line, Source::Probe, PendingKind::Restore, None);
        }
        self.enqueue("$G".into(), Source::Probe, PendingKind::RestoreFinal, None);
    }

    fn job_candidate(&mut self) -> Option<Command> {
        if self.shutting_down {
            return None;
        }
        let job = self.job.as_mut()?;
        if job.state != "running" || job.waiting_tool {
            return None;
        }
        if let Some(line) = job.prelude.front() {
            return Some(Command {
                line: line.clone(),
                source: Source::Job,
                kind: PendingKind::Prelude,
                completion: None,
                bytes: line.len() + 1,
            });
        }
        let line = job.lines.get(job.next)?.clone();
        if job.tool_change && is_tool_change(&line) {
            job.waiting_tool = true;
            let tool = tool_number(&line).unwrap_or_else(|| json!(self.modal.tool));
            return Some(Command {
                line: if self.profile.smoothie() {
                    "M400"
                } else {
                    "G4P0.01"
                }
                .into(),
                source: Source::ToolChange,
                kind: PendingKind::ToolChange(tool),
                completion: None,
                bytes: if self.profile.smoothie() { 5 } else { 8 },
            });
        }
        Some(Command {
            bytes: line.len() + 1,
            line,
            source: Source::Job,
            kind: PendingKind::Job(job.next),
            completion: None,
        })
    }

    fn pump(&mut self) {
        while self.transport.is_some() && self.ready {
            let from_queue = !self.queue.is_empty();
            let Some(mut item) = (if from_queue {
                self.queue.pop_front()
            } else {
                self.job_candidate()
            }) else {
                break;
            };
            if from_queue {
                if let Err(error) = self.validate_manual_line(&item.line, item.source) {
                    if let Some(tx) = item.completion.take() {
                        let _ = tx.send(Err(error.clone()));
                    }
                    self.log("err", error);
                    continue;
                }
            }
            let waiting_for_jog = !self.profile.smoothie()
                && !item.line.starts_with('$')
                && (self.status.state == "Jog"
                    || self
                        .inflight
                        .iter()
                        .any(|entry| entry.source == Source::Jog)
                    || self.status_since_jog < 2);
            let preparing_jog = self.profile.smoothie()
                && self.smoothie_jog_preparing
                && matches!(
                    item.source,
                    Source::User | Source::Macro | Source::Probe | Source::Job
                );
            if waiting_for_jog || preparing_jog {
                if from_queue {
                    self.queue.push_front(item);
                } else if matches!(item.kind, PendingKind::ToolChange(_)) {
                    if let Some(job) = &mut self.job {
                        job.waiting_tool = false;
                    }
                }
                break;
            }
            if item.bytes > RX_BUFFER {
                let error = format!(
                    "Ligne trop longue pour le tampon Grbl ({} octets)",
                    item.bytes
                );
                if let Some(tx) = item.completion.take() {
                    let _ = tx.send(Err(error.clone()));
                }
                if let Some(job) = &mut self.job {
                    if item.source == Source::Job {
                        job.state = "paused".into();
                        job.error = Some(error.clone());
                    }
                }
                self.log("err", error);
                self.emit_job();
                continue;
            }
            if !self.inflight.is_empty() && self.inflight_bytes + item.bytes > RX_BUFFER {
                if from_queue {
                    self.queue.push_front(item);
                } else if matches!(item.kind, PendingKind::ToolChange(_)) {
                    if let Some(job) = &mut self.job {
                        job.waiting_tool = false;
                    }
                }
                break;
            }
            if !from_queue {
                if let Some(job) = &mut self.job {
                    match item.kind {
                        PendingKind::Job(_) => job.next += 1,
                        PendingKind::Prelude => {
                            job.prelude.pop_front();
                        }
                        _ => {}
                    }
                }
            }
            let mut bytes = item.line.as_bytes().to_vec();
            bytes.push(b'\n');
            if self.profile.smoothie() && !matches!(item.source, Source::Jog | Source::JogMode) {
                for (letter, value) in tokenize(&item.line) {
                    if letter == 'G' {
                        match value {
                            20.0 => self.modal.units = "G20".into(),
                            21.0 => self.modal.units = "G21".into(),
                            90.0 => self.modal.distance = "G90".into(),
                            91.0 => self.modal.distance = "G91".into(),
                            _ => {}
                        }
                    }
                }
            }
            if matches!(item.source, Source::User | Source::Macro | Source::Probe) {
                self.log("tx", item.line.clone());
            }
            self.inflight_bytes += item.bytes;
            self.inflight.push_back(item);
            if let Err(error) = self.write_raw(bytes) {
                self.detach(&error);
                break;
            }
        }
    }

    fn ack(&mut self, code: Option<u32>) {
        let error = code.map(|code| (Some(code), format!("error:{code} {}", error_text(code))));
        self.ack_result(error);
    }

    fn ack_result(&mut self, machine_error: Option<(Option<u32>, String)>) {
        let Some(mut item) = self.inflight.pop_front() else {
            return;
        };
        self.inflight_bytes = self.inflight_bytes.saturating_sub(item.bytes);
        if item.source == Source::Jog {
            self.status_since_jog = 0;
        }
        let code = machine_error.as_ref().and_then(|(code, _)| *code);
        let error = machine_error.map(|(_, message)| format!("{message} ({})", item.line));
        let mut abort_error9 = None;
        if let Some(error) = &error {
            if item.source != Source::Sync {
                self.log("err", error.clone());
            }
            if matches!(
                item.kind,
                PendingKind::Job(_) | PendingKind::Prelude | PendingKind::ToolChange(_)
            ) {
                if let Some(job) = &mut self.job {
                    if job.state == "running" {
                        let prefix = match item.kind {
                            PendingKind::Job(index) => format!("Ligne {} : ", index + 1),
                            _ => String::new(),
                        };
                        let index = match item.kind {
                            PendingKind::Job(index) => Some(index),
                            _ => None,
                        };
                        if self.profile.smoothie() {
                            job.state = "stopped".into();
                            job.resume_from = index;
                            job.error = Some(format!(
                                "{prefix}{error} · Déverrouillez puis utilisez l'onglet Reprise."
                            ));
                        } else {
                            job.state = "paused".into();
                            job.error = Some(format!("{prefix}{error}"));
                            if code == Some(9) {
                                job.resume_from = index;
                                if let Some(index) = index {
                                    let message = format!("{prefix}{error} · Ligne non exécutée : reprenez à la ligne {} dans l'onglet Reprise.", index + 1);
                                    job.error = Some(message.clone());
                                    abort_error9 = Some((index, job.started_at, message));
                                }
                            }
                            if let Err(err) = self.realtime("hold") {
                                self.log("err", err);
                            }
                        }
                        self.emit_job();
                    }
                }
            }
        }
        if let Some(tx) = item.completion.take() {
            let _ = tx.send(error.clone().map_or(Ok(()), Err));
        }
        if error.is_none() && !self.profile.smoothie() {
            if let Some((key, value)) = item
                .line
                .strip_prefix('$')
                .and_then(|line| line.split_once('='))
            {
                if key.parse::<u32>().is_ok() {
                    self.settings.insert(key.into(), value.trim().into());
                    self.emit(json!({"t":"settings","s":self.settings}));
                }
            }
        }
        if matches!(item.kind, PendingKind::Restore | PendingKind::RestoreFinal) {
            if let Some(restore) = &mut self.mode_restore {
                restore.failed |= error.is_some();
            }
            if matches!(item.kind, PendingKind::RestoreFinal) {
                if self
                    .mode_restore
                    .as_ref()
                    .is_some_and(|restore| restore.failed)
                {
                    self.log(
                        "err",
                        "Modes non rétablis : effectuez un reset et vérifiez $G avant tout mouvement".into(),
                    );
                } else {
                    self.mode_restore = None;
                    self.log("info", "Modes rétablis après palpage".into());
                }
            }
        }
        match item.kind {
            PendingKind::Job(index) => {
                if let Some(job) = &mut self.job {
                    job.acked = job.acked.max(index + 1);
                    if job.state == "running"
                        && job.acked >= job.lines.len()
                        && job.prelude.is_empty()
                    {
                        job.state = "finishing".into();
                    }
                    self.emit_job();
                }
            }
            PendingKind::ToolChange(tool) => {
                if let Some(job) = &mut self.job {
                    job.waiting_tool = false;
                    if error.is_none() && job.state == "running" {
                        job.state = "toolchange".into();
                        job.tool = Some(tool.clone());
                        let label = tool
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| tool.to_string());
                        self.log("info", format!("Changement d'outil demandé : T{label}"));
                        self.emit_job();
                    }
                }
            }
            _ => {}
        }
        if let Some((index, started_at, message)) = abort_error9 {
            let controller = Controller {
                sender: self.sender.clone(),
                events: self.events.clone(),
                pointer_lock: self.pointer_lock.clone(),
                jog_lock: self.jog_lock.clone(),
            };
            tokio::spawn(async move {
                if let Err(error) = controller.stop().await {
                    let _ = controller
                        .call(move |core| {
                            if let Some(job) = &mut core.job {
                                if job.started_at == started_at && job.resume_from == Some(index) {
                                    job.error =
                                        Some(format!("{message} · Arrêt non confirmé : {error}"));
                                    core.emit_job();
                                }
                            }
                        })
                        .await;
                }
            });
        }
        self.pump();
    }

    fn on_data(&mut self, bytes: &[u8]) {
        self.rx.extend_from_slice(bytes);
        while let Some(end) = self.rx.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.rx.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line).trim().to_string();
            if !line.is_empty() {
                self.handle_line(&line);
            }
        }
        if self.rx.len() > 1024 * 1024 {
            self.detach("Réponse série trop longue");
        }
    }

    fn smoothie_ready(&mut self) {
        if self.ready {
            return;
        }
        self.ready = true;
        self.version = Some("Smoothieware".into());
        self.log("info", "Connecté : Smoothieware".into());
        for query in ["M115", "$G", "$#"] {
            self.enqueue(query.into(), Source::Init, PendingKind::Normal, None);
        }
        self.enqueue(
            "config-get sd default_seek_rate".into(),
            Source::Init,
            PendingKind::Normal,
            None,
        );
        self.emit_state();
    }

    fn on_alarm(&mut self, message: String) {
        let expected = std::mem::take(&mut self.expect_halt);
        self.log(if expected { "info" } else { "err" }, message.clone());
        self.status.state = "Alarm".into();
        self.pointer = None;
        self.resume_requested = false;
        if let Some(job) = &mut self.job {
            if job.active() && !(expected && job.state == "stopping") {
                job.state = "stopped".into();
                job.error = Some(match job.error.take() {
                    Some(previous) => format!("{previous} · {message}"),
                    None => message,
                });
                self.emit_job();
            }
        }
        if self.profile.smoothie() {
            self.fail_pending("Machine arrêtée (HALT)");
        }
        self.emit_state();
    }

    fn handle_line(&mut self, line: &str) {
        let line = line.trim_start_matches(|c: char| c == '>' || c.is_whitespace());
        if line.is_empty() {
            return;
        }
        if line.starts_with('<') && line.ends_with('>') {
            self.on_status(line);
            return;
        }
        if line == "Smoothie" {
            if !self.profile.smoothie() {
                self.detach("La carte répond Smoothieware : sélectionnez le profil Emblaser 2");
                return;
            }
            self.skip_ok = true;
            self.smoothie_ready();
            return;
        }
        if self.profile.smoothie() {
            if line == "ok" || line.starts_with("ok ") {
                if self.skip_ok {
                    self.skip_ok = false;
                } else {
                    self.ack(None);
                }
                return;
            }
            self.skip_ok = false;
            if line == "!!" {
                self.ack_result(Some((None, "Machine arrêtée (HALT)".into())));
                self.on_alarm("Machine arrêtée (HALT), déverrouillez-la".into());
                return;
            }
            if let Some(error) = line.strip_prefix("error:") {
                let error = error.trim();
                if [
                    "Unsupported command",
                    "bad axis",
                    "illegal option",
                    "no delta jog",
                    "axis out of range",
                    "unknown option",
                    "Not enough memory",
                ]
                .iter()
                .any(|prefix| error.starts_with(prefix))
                {
                    self.log("err", format!("Carte : {line}"));
                } else {
                    self.ack_result(Some((None, format!("Erreur de la carte : {error}"))));
                }
                return;
            }
            if line.starts_with("HALTED")
                || line.starts_with("ALARM:")
                || line.contains("Entering Alarm/Halt state")
            {
                self.on_alarm(format!("Alarme Smoothieware : {line}"));
                return;
            }
            if line.starts_with("FIRMWARE_NAME:") {
                let field = |key: &str| {
                    line.split(',')
                        .find_map(|part| part.trim().strip_prefix(key))
                        .map(str::trim)
                };
                if !field("FIRMWARE_NAME:")
                    .is_some_and(|name| name.to_ascii_lowercase().contains("smoothie"))
                {
                    self.detach("La carte ne s'identifie pas comme Smoothieware");
                    return;
                }
                if let Some(version) = field("FIRMWARE_VERSION:") {
                    self.version = Some(version.into());
                }
                self.grbl_mode = field("X-GRBL_MODE:").map(|mode| mode == "1");
                self.feed_hold = self.grbl_mode == Some(true);
                self.log(
                    "info",
                    if self.feed_hold {
                        "Smoothieware : pause immédiate disponible"
                    } else {
                        "Smoothieware : la pause attend les mouvements déjà envoyés"
                    }
                    .into(),
                );
                self.emit_state();
                return;
            }
            if let Some(value) = line.split_once("default_seek_rate is set to") {
                self.seek_rate = value
                    .1
                    .split_whitespace()
                    .next()
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| value.is_finite() && *value > 0.0);
            } else if line.contains("default_seek_rate is not in config") {
                self.seek_rate = Some(100.0);
            }
        }
        if line == "ok" {
            self.ack(None);
            return;
        }
        if let Some(code) = line
            .strip_prefix("error:")
            .and_then(|v| v.split_whitespace().next())
            .and_then(|v| v.parse().ok())
        {
            self.ack(Some(code));
            return;
        }
        self.log("rx", line.to_string());
        if let Some(code) = line
            .strip_prefix("ALARM:")
            .and_then(|v| v.parse::<u32>().ok())
        {
            let message = format!("Alarme {code} : {}", alarm_text(code));
            self.log("err", message.clone());
            self.status.state = "Alarm".into();
            if let Some(job) = &mut self.job {
                if job.active() {
                    job.state = "stopped".into();
                    job.error = Some(message);
                    self.emit_job();
                }
            }
            self.emit_state();
        } else if let Some(version) = grbl_banner_version(line) {
            if self.profile.smoothie() {
                self.detach("La carte répond Grbl : sélectionnez un profil Grbl");
                return;
            }
            if self.ready {
                if let Some(job) = &mut self.job {
                    if job.active() {
                        job.lost_at = Some(self.status.wpos);
                        job.state = "stopped".into();
                        job.error = Some("La carte a redémarré pendant l'usinage. Position perdue : faites l'origine, vérifiez le zéro puis utilisez l'onglet Reprise.".into());
                        self.emit_job();
                    }
                }
            }
            self.pointer = None;
            self.resume_requested = false;
            self.fail_pending("Reset");
            self.mode_restore = None;
            if let Some(job) = &mut self.job {
                if job.active() {
                    job.state = "stopped".into();
                    job.error = Some("Le contrôleur a redémarré".into());
                    self.emit_job();
                }
            }
            self.ready = true;
            self.has_status = false;
            self.status.state = "Connexion".into();
            self.version = Some(version.to_string());
            self.log("info", format!("Connecté : {line}"));
            self.settings.clear();
            if self.request_status().is_err() {
                return;
            }
            for query in ["$$", "$G", "$#"] {
                self.enqueue(query.into(), Source::Init, PendingKind::Normal, None);
            }
            self.emit_state();
        } else if let Some(text) = line.strip_prefix("[GC:").and_then(|s| s.strip_suffix(']')) {
            self.on_modal(text);
        } else if let Some(text) = line.strip_prefix("[PRB:").and_then(|s| s.strip_suffix(']')) {
            if let Some((coords, ok)) = text.rsplit_once(':') {
                if let Some(position) = parse_point(coords) {
                    self.last_probe = Some(ProbeReading {
                        position,
                        ok: ok == "1",
                    });
                }
            }
        } else if line.starts_with('[') && line.ends_with(']') {
            if let Some((key, val)) = line[1..line.len() - 1].split_once(':') {
                if [
                    "G54", "G55", "G56", "G57", "G58", "G59", "G28", "G30", "G92",
                ]
                .contains(&key)
                {
                    if let Some(point) = parse_point(val) {
                        self.offsets.insert(key.into(), json!(point));
                        self.emit_state();
                    }
                } else if key == "TLO" {
                    if let Ok(value) = val.parse::<f64>() {
                        self.offsets.insert(key.into(), json!(value));
                        self.emit_state();
                    }
                }
            }
        } else if let Some((key, value)) = line.strip_prefix('$').and_then(|s| s.split_once('=')) {
            if key.parse::<u32>().is_ok() {
                self.settings.insert(key.into(), value.trim().into());
                if key == "13" && value.trim() == "1" {
                    self.log("err", "La carte rapporte les positions en pouces ($13=1) : Copeau attend des mm. Envoyez $13=0.".into());
                }
                if key == "32" && self.profile == Profile::LaserGrbl && value.trim() != "1" {
                    self.log(
                        "err",
                        "Mode laser désactivé ($32=0) : activez $32=1 avant de graver.".into(),
                    );
                }
                self.emit(json!({"t":"settings","s":self.settings}));
            }
        }
    }

    fn on_modal(&mut self, text: &str) {
        for word in text.split_whitespace() {
            match word {
                "G54" | "G55" | "G56" | "G57" | "G58" | "G59" => self.modal.wcs = word.into(),
                "G20" | "G21" => self.modal.units = word.into(),
                "G90" | "G91" => self.modal.distance = word.into(),
                "M3" | "M4" | "M5" => self.modal.spindle = word.into(),
                "M7" | "M8" | "M9" => self.modal.coolant = word.into(),
                _ => {
                    let val = word.get(1..).and_then(|v| v.parse::<f64>().ok());
                    match (word.chars().next(), val) {
                        (Some('T'), Some(v)) => self.modal.tool = v,
                        (Some('F'), Some(v)) => self.modal.feed = v,
                        (Some('S'), Some(v)) => self.modal.speed = v,
                        _ => {}
                    }
                }
            }
        }
        self.emit_state();
    }

    fn on_status(&mut self, line: &str) {
        self.has_status = true;
        let body = &line[1..line.len() - 1];
        static LEGACY_FIELDS: OnceLock<Regex> = OnceLock::new();
        let body = if body.contains('|') {
            std::borrow::Cow::Borrowed(body)
        } else {
            LEGACY_FIELDS
                .get_or_init(|| Regex::new(r",([A-Za-z]+:)").expect("valid regex"))
                .replace_all(body, "|$1")
        };
        let mut fields = body.split('|');
        let state = fields.next().unwrap_or("");
        let (mut name, sub) = state
            .split_once(':')
            .map_or((state, None), |(n, s)| (n, Some(s.to_string())));
        if self.profile.smoothie()
            && name == "Run"
            && self.jog_active
            && self.job.as_ref().is_none_or(|job| !job.active())
        {
            name = "Jog";
        }
        self.status.state = name.into();
        self.status.sub_state = sub;
        self.status.pins.clear();
        if self.profile.smoothie() {
            self.status.laser_power = 0.0;
        }
        let (mut mpos, mut wpos) = (None, None);
        for field in fields {
            let Some((key, value)) = field.split_once(':') else {
                continue;
            };
            match key {
                "MPos" => mpos = parse_point(value),
                "WPos" => wpos = parse_point(value),
                "WCO" => {
                    if let Some(point) = parse_point(value) {
                        self.status.wco = point;
                    }
                }
                "F" if self.profile.smoothie() => {
                    let values: Vec<_> = value
                        .split(',')
                        .filter_map(|s| s.parse::<f64>().ok())
                        .collect();
                    self.status.feed = if name == "Idle" {
                        0.0
                    } else {
                        values.first().copied().unwrap_or(0.0)
                    };
                    if values.len() >= 2 {
                        self.status.ov.feed = values[values.len() - 1];
                    }
                }
                "L" if self.profile.smoothie() => {
                    self.status.laser_power = value.parse::<f64>().unwrap_or(0.0);
                }
                "S" if self.profile.smoothie() => {
                    self.status.speed = value.parse::<f64>().unwrap_or(0.0);
                }
                "FS" | "F" => {
                    let mut values = value.split(',').filter_map(|s| s.parse::<f64>().ok());
                    if let Some(feed) = values.next() {
                        self.status.feed = feed;
                    }
                    self.status.speed = values.next().unwrap_or(0.0);
                }
                "Ov" => {
                    let values: Vec<_> = value
                        .split(',')
                        .filter_map(|s| s.parse::<f64>().ok())
                        .collect();
                    if values.len() == 3 {
                        self.status.ov = Overrides {
                            feed: values[0],
                            rapid: values[1],
                            spindle: values[2],
                        };
                    }
                }
                "Pn" => self.status.pins = value.into(),
                "Bf" => {
                    let values: Vec<_> = value
                        .split(',')
                        .filter_map(|s| s.parse::<u32>().ok())
                        .collect();
                    if values.len() == 2 {
                        self.status.buffer = Some(json!({"blocks":values[0],"bytes":values[1]}));
                    }
                }
                _ => {}
            }
        }
        if let (Some(mpos), Some(wpos)) = (mpos, wpos) {
            self.status.mpos = mpos;
            self.status.wpos = wpos;
            let wco = mpos.sub(wpos);
            if (wco.x - self.status.wco.x).abs() > 0.002
                || (wco.y - self.status.wco.y).abs() > 0.002
                || (wco.z - self.status.wco.z).abs() > 0.002
            {
                self.status.wco = Point {
                    x: (wco.x * 1000.0).round() / 1000.0,
                    y: (wco.y * 1000.0).round() / 1000.0,
                    z: (wco.z * 1000.0).round() / 1000.0,
                };
            }
        } else if let Some(mpos) = mpos {
            self.status.mpos = mpos;
            self.status.wpos = mpos.sub(self.status.wco);
        } else if let Some(wpos) = wpos {
            self.status.wpos = wpos;
            self.status.mpos = wpos.add(self.status.wco);
        }
        if name == "Idle" {
            self.start_mode_restore();
        }
        if self.spindle_held && name != "Hold" {
            self.spindle_held = false;
        }
        self.status_since_jog = self.status_since_jog.saturating_add(1).min(2);
        if name == "Idle"
            && !self.queue.iter().any(|item| item.source == Source::Jog)
            && !self.inflight.iter().any(|item| item.source == Source::Jog)
        {
            self.jog_active = false;
        }
        if self.job.as_ref().is_some_and(|j| j.state == "finishing")
            && name == "Idle"
            && self.inflight.is_empty()
        {
            let job = self.job.as_mut().expect("job");
            job.state = "done".into();
            job.finished_at = Some(now_ms());
            let name = job.name.clone();
            self.log("info", format!("Job terminé : {name}"));
            self.emit_job();
        }
        if let Some(waiters) = self.status_inflight.take() {
            for waiter in waiters {
                let _ = waiter.send(Ok(self.status.clone()));
            }
        }
        if !self.status_queued.is_empty() {
            let _ = self.request_status();
        }
        if !self.ready {
            if self.profile.smoothie() {
                self.smoothie_ready();
            } else {
                self.ready = true;
                self.log("info", "Connecté : état Grbl reçu".into());
                for query in ["$$", "$G", "$#"] {
                    self.enqueue(query.into(), Source::Init, PendingKind::Normal, None);
                }
            }
        }
        self.pump();
        self.emit_state();
    }

    fn load_job(&mut self, name: String, text: String) -> Result<()> {
        if self.job.as_ref().is_some_and(Job::active) {
            return Err("Un job est en cours".into());
        }
        let lines = split_program(&text);
        self.job = Some(Job {
            name,
            text,
            lines,
            next: 0,
            acked: 0,
            start_index: 0,
            prelude: VecDeque::new(),
            state: "loaded".into(),
            error: None,
            started_at: None,
            finished_at: None,
            spin_up_until: None,
            tool: None,
            tool_change: true,
            waiting_tool: false,
            resume_from: None,
            lost_at: None,
        });
        let job = self.job.as_ref().expect("job");
        self.emit(json!({"t":"job-text","name":job.name,"text":job.text}));
        self.emit_job();
        Ok(())
    }

    fn run_job(
        &mut self,
        from: usize,
        tool_change: bool,
        spin_up: f64,
        min_safe_z: f64,
    ) -> Result<()> {
        if self.shutting_down {
            return Err("Application en cours de fermeture".into());
        }
        if self.mode_restore.is_some() {
            return Err("Rétablissement des modes après palpage : job refusé".into());
        }
        if self.recovering {
            return Err("Arrêt en cours : job refusé".into());
        }
        if self.pointer.is_some() {
            return Err("Éteignez le tir de repérage avant de démarrer le job".into());
        }
        if self.profile == Profile::LaserGrbl
            && self.settings.get("32").is_none_or(|value| value != "1")
        {
            return Err("Activez le mode laser Grbl ($32=1) avant de démarrer".into());
        }
        if self.has_pending_manual_motion() {
            return Err("Attendez la fin des commandes manuelles avant de démarrer le job".into());
        }
        let job = self.job.as_ref().ok_or("Aucun job chargé")?;
        if !self.ready {
            return Err("Machine non prête".into());
        }
        if job.active() {
            return Err("Job déjà en cours".into());
        }
        if self.status.state != "Idle" {
            return Err(format!(
                "La machine doit être Idle (état : {})",
                self.status.state
            ));
        }
        if job.lines.is_empty() {
            return Err("Programme vide".into());
        }
        if !spin_up.is_finite() || !min_safe_z.is_finite() {
            return Err("Durée de démarrage ou hauteur de sécurité invalide".into());
        }
        let from = from.min(job.lines.len() - 1);
        let prelude = if from > 0 {
            build_resume(
                &job.lines,
                from,
                spin_up.clamp(0.0, 30.0),
                min_safe_z,
                self.profile,
            )
        } else {
            Vec::new()
        };
        if from > 0 {
            self.log(
                "info",
                format!("Reprise à la ligne {} : {}", from + 1, prelude.join(" | ")),
            );
        }
        let job = self.job.as_mut().expect("job");
        job.prelude = prelude.into();
        job.next = from;
        job.acked = from;
        job.start_index = from;
        job.state = "running".into();
        job.error = None;
        job.tool = None;
        job.tool_change = tool_change;
        job.waiting_tool = false;
        job.started_at = Some(now_ms());
        job.finished_at = None;
        job.spin_up_until = None;
        job.resume_from = None;
        job.lost_at = None;
        self.resume_requested = false;
        self.emit_job();
        self.pump();
        Ok(())
    }

    fn tool_done(&mut self) -> Result<()> {
        if self.shutting_down {
            return Err("Application en cours de fermeture".into());
        }
        if self.mode_restore.is_some() || self.has_pending_manual_motion() {
            return Err("Attendez la fin des commandes manuelles avant de reprendre le job".into());
        }
        if self.status.state != "Idle" {
            return Err(format!(
                "La machine doit être Idle (état : {})",
                self.status.state
            ));
        }
        let job = self
            .job
            .as_mut()
            .ok_or("Pas de changement d'outil en attente")?;
        if job.state != "toolchange" {
            return Err("Pas de changement d'outil en attente".into());
        }
        job.next += 1;
        job.acked = job.acked.max(job.next);
        job.state = if job.next >= job.lines.len() {
            "finishing"
        } else {
            "running"
        }
        .into();
        self.emit_job();
        self.pump();
        Ok(())
    }

    fn resume_running(&mut self) -> Result<()> {
        if !self.profile.smoothie() || self.feed_hold {
            self.realtime("start")?;
        }
        let job = self.job.as_mut().ok_or("Aucun job chargé")?;
        self.resume_requested = false;
        job.state = if job.next >= job.lines.len()
            && job.acked >= job.lines.len()
            && job.prelude.is_empty()
        {
            "finishing"
        } else {
            "running"
        }
        .into();
        job.error = None;
        job.spin_up_until = None;
        self.emit_job();
        self.pump();
        Ok(())
    }

    fn view(&self) -> View {
        View {
            connected: self.transport.is_some(),
            ready: self.ready && self.has_status,
            jog_active: self.jog_active,
            restoring_modes: self.mode_restore.is_some(),
            status: self.status.clone(),
            modal: self.modal.clone(),
            settings: self.settings.clone(),
            last_probe: self.last_probe.clone(),
            job_state: self.job.as_ref().map(|j| j.state.clone()),
            profile: self.profile,
            can_hold: !self.profile.smoothie() || self.feed_hold,
            seek_rate: self.seek_rate,
            pointer_on: self.pointer.is_some(),
            recovering: self.recovering,
        }
    }

    fn snapshot(&self) -> Value {
        json!({
            "connected":self.transport.is_some(), "port":self.port, "ready":self.ready && self.has_status,
            "version":self.version, "status":self.status, "modal":self.modal, "offsets":self.offsets,
            "queue":self.queue.len(), "inflight":self.inflight.len(), "spindleHeld":self.spindle_held,
            "profile":self.profile.id(), "firmware":self.profile.firmware(), "laser":self.profile.laser(),
            "canHold":!self.profile.smoothie() || self.feed_hold, "grblMode":self.grbl_mode,
            "pointer":self.pointer.as_ref().map(|pointer| json!({"power":pointer.power}))
        })
    }

    fn job_snapshot(&self) -> Value {
        self.job.as_ref().map_or(Value::Null, |job| json!({
            "name":job.name, "total":job.lines.len(), "acked":job.acked, "sent":job.next,
            "startIndex":job.start_index, "state":job.state, "error":job.error, "tool":job.tool,
            "startedAt":job.started_at, "finishedAt":job.finished_at, "spinUpUntil":job.spin_up_until,
            "spindleHeld":self.spindle_held, "resumeFrom":job.resume_from, "lostAt":job.lost_at
        }))
    }

    fn emit(&self, event: Value) {
        let _ = self.events.send(event);
    }

    fn emit_state(&self) {
        self.emit(json!({"t":"state","s":self.snapshot()}));
    }
    fn emit_job(&self) {
        self.emit(json!({"t":"job","j":self.job_snapshot()}));
    }

    fn log(&mut self, direction: &str, text: String) {
        let entry = json!({"dir":direction,"text":text,"at":now_ms()});
        self.logs.push_back(entry.clone());
        if self.logs.len() > 500 {
            self.logs.pop_front();
        }
        self.emit(json!({"t":"log","entry":entry}));
    }
}

fn parse_point(text: &str) -> Option<Point> {
    let values: Vec<_> = text
        .split(',')
        .map(str::parse::<f64>)
        .collect::<std::result::Result<_, _>>()
        .ok()?;
    if values.len() < 3 || values.iter().take(3).any(|v| !v.is_finite()) {
        return None;
    }
    Some(Point {
        x: values[0],
        y: values[1],
        z: values[2],
    })
}

fn grbl_banner_version(line: &str) -> Option<&str> {
    let (name, rest) = line.split_once(char::is_whitespace)?;
    if !name.eq_ignore_ascii_case("grbl") && !name.eq_ignore_ascii_case("grblhal") {
        return None;
    }
    rest.split_whitespace().next()
}

fn is_tool_change(line: &str) -> bool {
    static TOOL_CHANGE: OnceLock<Regex> = OnceLock::new();
    TOOL_CHANGE
        .get_or_init(|| Regex::new(r"M0*6(?:\D|$)").expect("valid regex"))
        .is_match(line)
}

fn tool_number(line: &str) -> Option<Value> {
    static TOOL: OnceLock<Regex> = OnceLock::new();
    TOOL.get_or_init(|| Regex::new(r"T(\d+)").expect("valid regex"))
        .captures(line)
        .map(|capture| json!(&capture[1]))
}

fn error_text(code: u32) -> &'static str {
    match code {
        1 => "Commande G-code sans lettre",
        2 => "Valeur numérique manquante ou invalide",
        3 => "Commande $ non reconnue",
        4 => "Valeur négative non autorisée",
        5 => "Prise d'origine non activée ($22)",
        6 => "Durée d'impulsion trop courte (min 3 µs)",
        7 => "Lecture EEPROM échouée, réglages par défaut restaurés",
        8 => "Commande $ refusée hors état Idle",
        9 => "G-code bloqué pendant une alarme ou un jog (déverrouillez, ou attendez la fin du déplacement)",
        10 => "Limites logicielles impossibles sans prise d'origine",
        11 => "Ligne trop longue",
        12 => "Pas de moteur trop rapide pour la fréquence max",
        13 => "Porte de sécurité ouverte",
        14 => "Ligne de démarrage trop longue",
        15 => "Jog hors des limites machine",
        16 => "Commande de jog invalide",
        17 => "Mode laser nécessite une sortie PWM",
        20 => "Commande G-code non supportée",
        21 => "Plusieurs commandes du même groupe modal",
        22 => "Vitesse d'avance non définie",
        23 => "La commande exige une valeur entière",
        24 => "Plusieurs commandes utilisent des axes",
        25 => "Mot G-code répété",
        26 => "Aucun axe pour une commande qui en exige",
        27 => "Numéro de ligne invalide",
        28 => "Valeur obligatoire manquante",
        29 => "G59.x non supporté",
        30 => "G53 exige G0 ou G1",
        31 => "Axes inutilisés dans la ligne",
        32 => "Arc G2/G3 sans axe dans le plan",
        33 => "Cible de mouvement invalide",
        34 => "Géométrie d'arc invalide (rayon)",
        35 => "Arc G2/G3 sans décalage I/J/K",
        36 => "Mots G-code inutilisés",
        37 => "Correction d'outil G43.1 sur un axe non configuré",
        38 => "Numéro d'outil trop grand",
        _ => "Erreur inconnue",
    }
}

fn alarm_text(code: u32) -> &'static str {
    match code {
        1 => "Fin de course matérielle déclenchée, position perdue",
        2 => "Mouvement hors des limites logicielles",
        3 => "Reset pendant un mouvement, position perdue",
        4 => "Sonde déjà en contact avant le palpage",
        5 => "Palpage sans contact dans la course demandée",
        6 => "Prise d'origine interrompue par un reset",
        7 => "Porte ouverte pendant la prise d'origine",
        8 => "Dégagement de fin de course impossible",
        9 => "Fin de course introuvable pendant la prise d'origine",
        10 => "Fin de course déclenchée pendant le dégagement",
        _ => "Alarme inconnue",
    }
}

fn simulator_transport(
    sender: mpsc::UnboundedSender<Action>,
    generation: u64,
    speedup: f64,
    profile: Profile,
) -> Transport {
    let (tx, rx) = thread_mpsc::channel();
    let closed = Arc::new(AtomicBool::new(false));
    let thread_closed = closed.clone();
    thread::spawn(move || {
        let mut sim = Simulator::new(speedup, profile);
        let initial = sim.take_output();
        let _ = sender.send(Action::Data(generation, initial));
        let mut last_tick = Instant::now();
        while !thread_closed.load(Ordering::SeqCst) {
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(TransportMessage::Write(bytes)) => sim.write(&bytes),
                Ok(TransportMessage::Flush(reply)) => {
                    let _ = reply.send(Ok(()));
                }
                Ok(TransportMessage::Close) | Err(thread_mpsc::RecvTimeoutError::Disconnected) => {
                    break
                }
                Err(thread_mpsc::RecvTimeoutError::Timeout) => {}
            }
            let elapsed = last_tick.elapsed().as_secs_f64();
            last_tick = Instant::now();
            sim.tick(elapsed);
            let output = sim.take_output();
            if !output.is_empty() && sender.send(Action::Data(generation, output)).is_err() {
                break;
            }
        }
    });
    Transport { sender: tx, closed }
}

fn serial_transport(
    port: &str,
    baud: u32,
    sender: mpsc::UnboundedSender<Action>,
    generation: u64,
) -> Result<Transport> {
    let mut serial = serialport::new(port, baud)
        .timeout(Duration::from_millis(20))
        .open()
        .map_err(|e| format!("Impossible d'ouvrir {port} : {e}"))?;
    let (tx, rx) = thread_mpsc::channel();
    let closed = Arc::new(AtomicBool::new(false));
    let thread_closed = closed.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while !thread_closed.load(Ordering::SeqCst) {
            loop {
                match rx.try_recv() {
                    Ok(TransportMessage::Write(bytes)) => {
                        if thread_closed.load(Ordering::SeqCst) {
                            return;
                        }
                        if let Err(error) = serial.write_all(&bytes) {
                            let _ = sender
                                .send(Action::Closed(generation, format!("Port série : {error}")));
                            return;
                        }
                    }
                    Ok(TransportMessage::Flush(reply)) => {
                        let result = serial
                            .flush()
                            .map_err(|error| format!("Port série : {error}"));
                        let _ = reply.send(result);
                    }
                    Ok(TransportMessage::Close) | Err(thread_mpsc::TryRecvError::Disconnected) => {
                        return
                    }
                    Err(thread_mpsc::TryRecvError::Empty) => break,
                }
            }
            match serial.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    if sender
                        .send(Action::Data(generation, buf[..n].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
                Err(error) => {
                    let _ =
                        sender.send(Action::Closed(generation, format!("Port série : {error}")));
                    return;
                }
            }
        }
    });
    Ok(Transport { sender: tx, closed })
}

fn tcp_transport(
    host: String,
    port: u16,
    sender: mpsc::UnboundedSender<Action>,
    generation: u64,
) -> Transport {
    let (tx, rx) = thread_mpsc::channel();
    let closed = Arc::new(AtomicBool::new(false));
    let thread_closed = closed.clone();
    thread::spawn(move || {
        let open = || -> Result<TcpStream> {
            let addresses = (host.as_str(), port)
                .to_socket_addrs()
                .map_err(|error| format!("Adresse {host}:{port} : {error}"))?;
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut last_error = "aucune adresse trouvée".to_string();
            for address in addresses {
                let Some(timeout) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                match TcpStream::connect_timeout(&address, timeout) {
                    Ok(stream) => return Ok(stream),
                    Err(error) => last_error = error.to_string(),
                }
            }
            Err(format!(
                "Connexion à {host}:{port} impossible : {last_error}"
            ))
        };
        let mut stream = match open() {
            Ok(stream) => stream,
            Err(error) => {
                let _ = sender.send(Action::Closed(generation, error));
                return;
            }
        };
        if let Err(error) = stream
            .set_read_timeout(Some(Duration::from_millis(20)))
            .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(2))))
            .and_then(|_| stream.set_nodelay(true))
        {
            let _ = sender.send(Action::Closed(generation, format!("Réseau : {error}")));
            return;
        }
        let mut decoder = TelnetDecoder::default();
        let mut buffer = [0u8; 4096];
        while !thread_closed.load(Ordering::SeqCst) {
            loop {
                match rx.try_recv() {
                    Ok(TransportMessage::Write(bytes)) => {
                        if let Err(error) = stream.write_all(&bytes) {
                            let _ = sender
                                .send(Action::Closed(generation, format!("Réseau : {error}")));
                            return;
                        }
                    }
                    Ok(TransportMessage::Flush(reply)) => {
                        let _ =
                            reply.send(stream.flush().map_err(|error| format!("Réseau : {error}")));
                    }
                    Ok(TransportMessage::Close) | Err(thread_mpsc::TryRecvError::Disconnected) => {
                        return
                    }
                    Err(thread_mpsc::TryRecvError::Empty) => break,
                }
            }
            match stream.read(&mut buffer) {
                Ok(0) => {
                    let _ =
                        sender.send(Action::Closed(generation, "Connexion réseau fermée".into()));
                    return;
                }
                Ok(count) => {
                    let decoded = decoder.decode(&buffer[..count]);
                    if !decoded.is_empty()
                        && sender.send(Action::Data(generation, decoded)).is_err()
                    {
                        return;
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) => {}
                Err(error) => {
                    let _ = sender.send(Action::Closed(generation, format!("Réseau : {error}")));
                    return;
                }
            }
        }
    });
    Transport { sender: tx, closed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe;

    async fn wait_until(mut predicate: impl FnMut() -> bool, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while !predicate() {
            assert!(Instant::now() < deadline, "Délai dépassé");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_for_state(controller: &Controller, state: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if controller.view().await.unwrap().job_state.as_deref() == Some(state) {
                return;
            }
            assert!(Instant::now() < deadline, "Job jamais passé à {state}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn setup() -> Controller {
        let controller = Controller::spawn();
        controller.connect_simulator(40.0).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !controller.view().await.unwrap().ready {
            assert!(Instant::now() < deadline, "Simulateur non prêt");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        controller.command("$X".into(), Source::User).await.unwrap();
        controller.next_status().await.unwrap();
        controller
    }

    async fn sync(controller: &Controller) {
        controller
            .command("G4P0.01".into(), Source::Sync)
            .await
            .unwrap();
        controller.next_status().await.unwrap();
    }

    async fn setup_smoothie() -> Controller {
        let controller = Controller::spawn();
        controller
            .connect_at_speed(
                "simulateur".into(),
                115200,
                Profile::Emblaser2,
                String::new(),
                40.0,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let view = controller.view().await.unwrap();
                if view.ready && view.seek_rate == Some(4000.0) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        controller
    }

    #[tokio::test]
    async fn smoothie_console_does_not_shift_acknowledgements_and_jog_restores_modes() {
        let controller = setup_smoothie().await;
        assert!(!controller.view().await.unwrap().can_hold);
        assert!(controller
            .realtime("jogCancel")
            .await
            .unwrap_err()
            .contains("Smoothieware"));
        for line in ["version", "$I", "$X", "$G", "G21G91"] {
            controller.command(line.into(), Source::User).await.unwrap();
        }
        let generation = Arc::new(AtomicU64::new(0));
        controller
            .jog_command("$J=G90G21X5Y2F1500".into(), generation, 0)
            .await
            .unwrap();
        controller
            .command("M400".into(), Source::Sync)
            .await
            .unwrap();
        let status = controller.next_status().await.unwrap();
        near(status.wpos.x, 5.0, 0.01);
        near(status.wpos.y, 2.0, 0.01);
        controller.command("$G".into(), Source::User).await.unwrap();
        assert_eq!(controller.view().await.unwrap().modal.distance, "G91");
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn smoothie_job_pauses_without_unsupported_realtime_and_resumes() {
        let controller = setup_smoothie().await;
        let mut lines = vec!["G21G90".to_string()];
        lines
            .extend((0..40).map(|i| format!("G1X{}Y{i}F600S0.4", if i % 2 == 0 { 20 } else { 0 })));
        controller
            .load_job("laser.nc".into(), lines.join("\n"))
            .await
            .unwrap();
        controller.run_job(0, false, 3.0, 5.0).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if controller.next_status().await.unwrap().state == "Run" {
                    break;
                }
            }
        })
        .await
        .unwrap();
        controller.pause(true).await.unwrap();
        assert_eq!(
            controller.view().await.unwrap().job_state.as_deref(),
            Some("paused")
        );
        controller.resume(0.0).await.unwrap();
        wait_for_state(&controller, "done").await;
        near(controller.view().await.unwrap().status.wpos.y, 39.0, 0.01);
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn smoothie_stop_clears_halt_and_bad_gcode_requires_restart() {
        let controller = setup_smoothie().await;
        controller
            .load_job(
                "long.nc".into(),
                "G21G90\nG1X1000F60S0.4\nG1X0F60S0.4".into(),
            )
            .await
            .unwrap();
        controller.run_job(0, false, 0.0, 0.0).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while controller.next_status().await.unwrap().state != "Run" {}
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(8), controller.stop())
            .await
            .expect("arrêt Smoothieware")
            .unwrap();
        assert_eq!(
            controller.view().await.unwrap().job_state.as_deref(),
            Some("stopped")
        );
        assert_eq!(controller.next_status().await.unwrap().state, "Idle");
        controller
            .load_job("err.nc".into(), "G21G90\nG0X1\nG10L2P9X0\nG0X2".into())
            .await
            .unwrap();
        controller.run_job(0, false, 0.0, 0.0).await.unwrap();
        wait_for_state(&controller, "stopped").await;
        let messages = controller.initial_messages().await.unwrap();
        let job = &messages
            .iter()
            .find(|message| message["t"] == "job")
            .unwrap()["j"];
        assert!(job["error"].as_str().unwrap().contains("Reprise"));
        assert_eq!(job["resumeFrom"], 2);
        tokio::time::timeout(
            Duration::from_secs(4),
            controller.command("$X".into(), Source::User),
        )
        .await
        .expect("déverrouillage Smoothieware")
        .unwrap();
        assert_eq!(controller.next_status().await.unwrap().state, "Idle");
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn smoothie_stop_reports_an_unacknowledged_sync() {
        let controller = Controller::spawn();
        let (wire, rx) = thread_mpsc::channel();
        controller
            .call(move |core| {
                core.transport = Some(Transport {
                    sender: wire,
                    closed: Arc::new(AtomicBool::new(false)),
                });
                core.profile = Profile::Emblaser2;
                core.ready = true;
                core.has_status = true;
                core.status.state = "Idle".into();
            })
            .await
            .unwrap();
        let stopping = tokio::spawn({
            let controller = controller.clone();
            async move { controller.halt_smoothie().await }
        });
        let mut saw_sync = false;
        wait_until(
            || {
                while let Ok(message) = rx.try_recv() {
                    match message {
                        TransportMessage::Write(bytes) if bytes == b"M400\n" => saw_sync = true,
                        TransportMessage::Write(bytes)
                            if [b"M999\n".as_slice(), b"G90\n", b"G21\n"]
                                .contains(&bytes.as_slice()) =>
                        {
                            controller
                                .sender
                                .send(Action::Data(0, b"ok\n".to_vec()))
                                .unwrap();
                        }
                        TransportMessage::Flush(reply) => {
                            let _ = reply.send(Ok(()));
                        }
                        _ => {}
                    }
                }
                saw_sync
            },
            Duration::from_secs(3),
        )
        .await;
        let error = tokio::time::timeout(Duration::from_secs(5), stopping)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.contains("Synchronisation"));
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn error_nine_stops_the_job_and_preserves_the_refused_line() {
        let controller = setup().await;
        let lines = std::iter::once("G21G90".to_string())
            .chain((0..100).map(|i| format!("G1X{}Y{i}F60", if i % 2 == 0 { 20 } else { 0 })))
            .collect::<Vec<_>>()
            .join("\n");
        controller
            .load_job("error9.nc".into(), lines)
            .await
            .unwrap();
        controller.run_job(0, false, 0.0, 5.0).await.unwrap();
        let index = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(index) = controller
                    .call(|core| {
                        if let Some(Command {
                            kind: PendingKind::Job(index),
                            ..
                        }) = core.inflight.front()
                        {
                            let index = *index;
                            core.ack(Some(9));
                            Some(index)
                        } else {
                            None
                        }
                    })
                    .await
                    .unwrap()
                {
                    break index;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        wait_for_state(&controller, "stopped").await;
        let messages = controller.initial_messages().await.unwrap();
        let job = &messages
            .iter()
            .find(|message| message["t"] == "job")
            .unwrap()["j"];
        assert_eq!(job["resumeFrom"], index);
        assert!(job["error"]
            .as_str()
            .unwrap()
            .contains("reprenez à la ligne"));
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn resume_waits_for_hold_zero_before_sending_start() {
        let controller = Controller::spawn();
        let (wire, rx) = thread_mpsc::channel();
        controller
            .call(move |core| {
                core.transport = Some(Transport {
                    sender: wire,
                    closed: Arc::new(AtomicBool::new(false)),
                });
                core.ready = true;
                core.has_status = true;
                core.last_poll = Instant::now();
                core.status.state = "Hold".into();
                core.status.sub_state = Some("1".into());
                core.load_job("brake.nc".into(), "G1X5F10".into()).unwrap();
                core.job.as_mut().unwrap().state = "paused".into();
            })
            .await
            .unwrap();
        let task = tokio::spawn({
            let controller = controller.clone();
            async move { controller.resume(0.0).await }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes == b"?") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        controller
            .sender
            .send(Action::Data(0, b"<Hold:1|MPos:0,0,0>\n".to_vec()))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match rx.try_recv() {
                    Ok(TransportMessage::Write(bytes)) if bytes == b"?" => break,
                    Ok(TransportMessage::Write(bytes)) => assert_ne!(bytes, b"~"),
                    _ => tokio::time::sleep(Duration::from_millis(5)).await,
                }
            }
        })
        .await
        .unwrap();
        controller
            .sender
            .send(Action::Data(0, b"<Hold:0|MPos:0,0,0>\n".to_vec()))
            .unwrap();
        task.await.unwrap().unwrap();
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes == b"~"));
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn laser_pointer_blocks_jobs_and_turns_off_on_timeout_or_owner_close() {
        let controller = setup_smoothie().await;
        controller
            .load_job("laser.nc".into(), "G0X1".into())
            .await
            .unwrap();
        let closed = Arc::new(AtomicBool::new(false));
        controller
            .pointer_on_for(7, closed.clone(), 1.5, 1.0, Duration::from_millis(700))
            .await
            .unwrap();
        assert!(controller.view().await.unwrap().pointer_on);
        assert!(controller
            .run_job(0, false, 0.0, 0.0)
            .await
            .unwrap_err()
            .contains("repérage"));
        controller.pointer_off_owner(8).await.unwrap();
        assert!(controller.view().await.unwrap().pointer_on);
        tokio::time::timeout(Duration::from_secs(3), async {
            while controller.view().await.unwrap().pointer_on {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        controller
            .pointer_on(7, closed.clone(), 1.0, 1.0)
            .await
            .unwrap();
        closed.store(true, Ordering::SeqCst);
        controller.pointer_off_owner(7).await.unwrap();
        assert!(!controller.view().await.unwrap().pointer_on);
        assert!(controller.pointer_on(7, closed, 1.0, 1.0).await.is_err());
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn laser_pointer_reports_a_lost_connection_during_extinction() {
        let controller = Controller::spawn();
        let (wire, rx) = thread_mpsc::channel();
        controller
            .call(move |core| {
                core.transport = Some(Transport {
                    sender: wire,
                    closed: Arc::new(AtomicBool::new(false)),
                });
                core.port = Some("test".into());
                core.profile = Profile::LaserGrbl;
                core.ready = true;
                core.has_status = true;
                core.pointer = Some(Pointer {
                    owner: 7,
                    generation: 1,
                    power: 1.0,
                    closed: Arc::new(AtomicBool::new(false)),
                });
            })
            .await
            .unwrap();
        let stopping = tokio::spawn({
            let controller = controller.clone();
            async move { controller.pointer_off().await }
        });
        let mut sent_off = false;
        wait_until(
            || {
                while let Ok(message) = rx.try_recv() {
                    if matches!(message, TransportMessage::Write(bytes) if bytes == b"M5\n") {
                        sent_off = true;
                    }
                }
                sent_off
            },
            Duration::from_secs(2),
        )
        .await;
        controller.disconnect("Liaison perdue").await.unwrap();
        let error = stopping.await.unwrap().unwrap_err();
        assert!(error.contains("coupez le laser"));
    }

    #[tokio::test]
    async fn laser_grbl_requires_laser_mode_and_reset_clears_the_pointer() {
        let controller = Controller::spawn();
        controller
            .connect_at_speed(
                "simulateur".into(),
                115200,
                Profile::LaserGrbl,
                String::new(),
                40.0,
            )
            .await
            .unwrap();
        controller.command("$X".into(), Source::User).await.unwrap();
        controller.next_status().await.unwrap();
        controller
            .command("$32=0".into(), Source::User)
            .await
            .unwrap();
        controller
            .load_job("laser.nc".into(), "G1X1F100".into())
            .await
            .unwrap();
        assert!(controller
            .run_job(0, false, 0.0, 0.0)
            .await
            .unwrap_err()
            .contains("$32"));
        controller
            .command("$32=1".into(), Source::User)
            .await
            .unwrap();
        let closed = Arc::new(AtomicBool::new(false));
        controller.pointer_on(9, closed, 1.0, 1000.0).await.unwrap();
        assert!(controller.view().await.unwrap().pointer_on);
        controller.realtime("reset").await.unwrap();
        assert!(!controller.view().await.unwrap().pointer_on);
        controller.disconnect("fin").await.unwrap();
    }

    #[test]
    fn unexpected_restart_records_the_last_known_work_position() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let (wire, _rx) = thread_mpsc::channel();
        let mut core = Core::new(sender, events);
        core.transport = Some(Transport {
            sender: wire,
            closed: Arc::new(AtomicBool::new(false)),
        });
        core.ready = true;
        core.has_status = true;
        core.status.wpos = Point {
            x: 12.0,
            y: 3.0,
            z: -1.0,
        };
        core.load_job("restart.nc".into(), "G1X5F10".into())
            .unwrap();
        core.job.as_mut().unwrap().state = "spinup".into();
        core.handle_line("Grbl 1.1h ['$' for help]");
        let snapshot = core.job_snapshot();
        assert_eq!(snapshot["state"], "stopped");
        assert_eq!(snapshot["lostAt"], json!({"X":12.0,"Y":3.0,"Z":-1.0}));
        assert!(snapshot["error"].as_str().unwrap().contains("redémarré"));
    }

    #[test]
    fn smoothie_legacy_status_computes_the_work_offset() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let mut core = Core::new(sender, events);
        core.profile = Profile::Emblaser2;
        core.ready = true;
        core.on_status("<Run,MPos:12.5000,3.0000,0.0000,WPos:2.5000,1.0000,0.0000>");
        near(core.status.wpos.x, 2.5, 0.001);
        near(core.status.wco.x, 10.0, 0.001);
        near(core.status.wco.y, 2.0, 0.001);
    }

    #[test]
    fn smoothie_finishes_a_paused_job_when_all_lines_were_already_acknowledged() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let (wire, _rx) = thread_mpsc::channel();
        let mut core = Core::new(sender, events);
        core.profile = Profile::Emblaser2;
        core.transport = Some(Transport {
            sender: wire,
            closed: Arc::new(AtomicBool::new(false)),
        });
        core.ready = true;
        core.has_status = true;
        core.status.state = "Idle".into();
        core.load_job("pause.nc".into(), "G1X1F10".into()).unwrap();
        let job = core.job.as_mut().unwrap();
        job.state = "paused".into();
        job.next = job.lines.len();
        job.acked = job.lines.len();
        core.resume_running().unwrap();
        assert_eq!(core.job.as_ref().unwrap().state, "finishing");
        core.on_status("<Idle|MPos:1,0,0|WPos:1,0,0>");
        assert_eq!(core.job.as_ref().unwrap().state, "done");
    }

    #[test]
    fn smoothie_feed_hold_is_enabled_only_when_reported_by_firmware() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let (wire, rx) = thread_mpsc::channel();
        let mut core = Core::new(sender, events);
        core.profile = Profile::Emblaser2;
        core.transport = Some(Transport {
            sender: wire,
            closed: Arc::new(AtomicBool::new(false)),
        });
        assert!(core.realtime("hold").is_err());
        core.handle_line("FIRMWARE_NAME:Smoothieware, FIRMWARE_VERSION:test, X-GRBL_MODE:1");
        assert!(core.view().can_hold);
        core.realtime("hold").unwrap();
        core.realtime("start").unwrap();
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes == b"!"));
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes == b"~"));
    }

    #[tokio::test]
    async fn network_smoothie_connection_filters_fragmented_telnet_and_runs_a_job() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let machine = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(20)))
                .unwrap();
            stream.write_all(&[0xff, 0xfb]).unwrap();
            thread::sleep(Duration::from_millis(10));
            stream.write_all(&[1]).unwrap();
            let mut sim = Simulator::new(40.0, Profile::Emblaser2);
            stream.write_all(&sim.take_output()).unwrap();
            let mut buffer = [0u8; 1024];
            let mut last_tick = Instant::now();
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => sim.write(&buffer[..count]),
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                        ) => {}
                    Err(error) => panic!("test TCP : {error}"),
                }
                sim.tick(last_tick.elapsed().as_secs_f64());
                last_tick = Instant::now();
                let output = sim.take_output();
                if !output.is_empty() && stream.write_all(&output).is_err() {
                    break;
                }
            }
        });
        let controller = Controller::spawn();
        controller
            .connect(
                "reseau".into(),
                115200,
                Profile::Emblaser2,
                address.to_string(),
            )
            .await
            .unwrap();
        controller
            .load_job("network.nc".into(), "G21G90\nG1X2F6000S0.2".into())
            .await
            .unwrap();
        controller.run_job(0, false, 0.0, 0.0).await.unwrap();
        wait_for_state(&controller, "done").await;
        near(controller.view().await.unwrap().status.wpos.x, 2.0, 0.01);
        controller.disconnect("fin").await.unwrap();
        machine.join().unwrap();
    }

    fn near(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{actual} ≉ {expected}"
        );
    }

    #[test]
    fn respects_the_grbl_receive_buffer_and_sends_realtime_as_one_byte() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let (wire, rx) = thread_mpsc::channel();
        let mut core = Core::new(sender, events);
        core.transport = Some(Transport {
            sender: wire,
            closed: Arc::new(AtomicBool::new(false)),
        });
        core.ready = true;
        core.has_status = true;
        let line = format!("G1X{}", "1".repeat(60));
        core.enqueue(line.clone(), Source::User, PendingKind::Normal, None);
        core.enqueue(line, Source::User, PendingKind::Normal, None);
        assert_eq!(core.inflight_bytes, 64);
        assert_eq!(core.queue.len(), 1);
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes.len() == 64));
        assert!(rx.try_recv().is_err());
        core.ack(None);
        assert_eq!(core.inflight_bytes, 64);
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes.len() == 64));
        core.realtime("jogCancel").unwrap();
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes == [0x85]));
    }

    #[test]
    fn connects_without_a_banner_and_never_resets_a_running_machine() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let (wire, rx) = thread_mpsc::channel();
        let mut core = Core::new(sender, events);
        core.transport = Some(Transport {
            sender: wire,
            closed: Arc::new(AtomicBool::new(false)),
        });
        core.last_poll = Instant::now() - Duration::from_secs(3);
        core.tick();
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes == b"?"));
        core.handle_line("<Run|MPos:0,0,0>");
        assert!(core.view().ready);
        assert_eq!(core.status.state, "Run");
        while let Ok(TransportMessage::Write(bytes)) = rx.try_recv() {
            assert_ne!(bytes, [0x18]);
        }
    }

    #[test]
    fn grblhal_restart_banner_is_recognized_in_any_case_and_stops_the_job() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let (wire, _rx) = thread_mpsc::channel();
        let mut core = Core::new(sender, events);
        core.transport = Some(Transport {
            sender: wire,
            closed: Arc::new(AtomicBool::new(false)),
        });
        core.ready = true;
        core.has_status = true;
        core.version = Some("1.1h".into());
        core.load_job("t.nc".into(), "T1M6\nG21".into()).unwrap();
        core.job.as_mut().unwrap().state = "toolchange".into();
        core.handle_line("grblHAL 1.1f ['$' or '#' for help]");
        assert_eq!(core.job.as_ref().unwrap().state, "stopped");
        assert_eq!(core.version.as_deref(), Some("1.1f"));
    }

    #[test]
    fn four_axis_reports_update_xyz_and_unknown_errors_are_explained() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let mut core = Core::new(sender, events);
        core.on_status("<Idle|MPos:1,2,3>");
        core.on_status("<Idle|MPos:10,20,30,40>");
        assert_eq!((core.status.mpos.x, core.status.mpos.z), (10.0, 30.0));
        assert!(parse_point("1,2").is_none());
        assert_eq!(error_text(13), "Porte de sécurité ouverte");
        for code in [
            5, 6, 7, 10, 12, 13, 14, 16, 17, 23, 24, 25, 26, 27, 30, 31, 32, 35, 36, 37, 38,
        ] {
            assert_ne!(error_text(code), "Erreur inconnue", "code {code}");
        }
    }

    #[test]
    fn manual_commands_are_gated_during_jobs_and_rechecked_before_sending() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let (wire, rx) = thread_mpsc::channel();
        let mut core = Core::new(sender, events);
        core.transport = Some(Transport {
            sender: wire,
            closed: Arc::new(AtomicBool::new(false)),
        });
        core.ready = true;
        core.has_status = true;
        core.status.state = "Idle".into();
        core.load_job("test.nc".into(), "G1X5F10".into()).unwrap();

        for state in ["running", "paused", "spinup", "finishing", "stopping"] {
            core.job.as_mut().unwrap().state = state.into();
            for source in [Source::User, Source::Macro, Source::Jog] {
                assert!(core.validate_manual_line("G0X10", source).is_err());
            }
            for query in ["$g", "$#", "$I", "$$"] {
                assert!(core.validate_manual_line(query, Source::User).is_ok());
            }
        }

        core.job.as_mut().unwrap().state = "toolchange".into();
        core.enqueue(
            format!("G1X{}", "1".repeat(75)),
            Source::Init,
            PendingKind::Normal,
            None,
        );
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(_))));
        let (tx, mut result) = oneshot::channel();
        core.enqueue(
            format!("G1Y{}", "1".repeat(75)),
            Source::User,
            PendingKind::Normal,
            Some(tx),
        );
        assert_eq!(core.queue.len(), 1);
        core.job.as_mut().unwrap().state = "running".into();
        core.ack(None);
        assert!(result.try_recv().unwrap().unwrap_err().contains("Usinage"));
        while let Ok(TransportMessage::Write(bytes)) = rx.try_recv() {
            assert!(!bytes.starts_with(b"G1Y"));
        }
    }

    #[test]
    fn job_cannot_start_with_manual_commands_still_in_flight() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let (wire, _rx) = thread_mpsc::channel();
        let mut core = Core::new(sender, events);
        core.transport = Some(Transport {
            sender: wire,
            closed: Arc::new(AtomicBool::new(false)),
        });
        core.ready = true;
        core.has_status = true;
        core.status.state = "Idle".into();
        core.load_job("test.nc".into(), "G1X5F10".into()).unwrap();
        core.enqueue("G91".into(), Source::User, PendingKind::Normal, None);
        assert!(core.run_job(0, true, 3.0, 5.0).is_err());
        core.ack(None);
        core.run_job(0, true, 3.0, 5.0).unwrap();
    }

    #[test]
    fn failed_mode_restore_blocks_manual_motion_until_reset() {
        let (sender, _) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(16);
        let (wire, rx) = thread_mpsc::channel();
        let mut core = Core::new(sender, events);
        core.transport = Some(Transport {
            sender: wire,
            closed: Arc::new(AtomicBool::new(false)),
        });
        core.ready = true;
        core.has_status = true;
        core.mode_restore = Some(ModeRestore {
            units: "G20".into(),
            distance: "G90".into(),
            started: false,
            failed: false,
        });
        assert!(core.validate_manual_line("G0X1", Source::User).is_err());
        assert!(core.validate_manual_line("$X", Source::User).is_ok());
        core.handle_line("<Idle|MPos:0,0,0>");
        for expected in [b"G20\n".as_slice(), b"G90\n", b"$G\n"] {
            assert!(
                matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes == expected)
            );
        }
        core.ack(Some(2));
        core.ack(None);
        core.ack(None);
        assert!(core.view().restoring_modes);
        assert!(core.validate_manual_line("G0X1", Source::User).is_err());
        core.realtime("reset").unwrap();
        assert!(!core.view().restoring_modes);
    }

    #[tokio::test]
    async fn job_can_resume_after_a_safety_door_pause() {
        let controller = Controller::spawn();
        let (wire, rx) = thread_mpsc::channel();
        controller
            .call(move |core| {
                core.transport = Some(Transport {
                    sender: wire,
                    closed: Arc::new(AtomicBool::new(false)),
                });
                core.ready = true;
                core.has_status = true;
                core.status.state = "Door".into();
                core.load_job("test.nc".into(), "G1X5F10".into()).unwrap();
                core.job.as_mut().unwrap().state = "running".into();
            })
            .await
            .unwrap();
        controller.resume(0.0).await.unwrap();
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes == [b'~']));
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_rejects_new_motion_and_discards_unsent_commands() {
        let controller = Controller::spawn();
        let (wire, rx) = thread_mpsc::channel();
        let (queued_tx, queued_rx) = oneshot::channel();
        controller
            .call(move |core| {
                core.transport = Some(Transport {
                    sender: wire,
                    closed: Arc::new(AtomicBool::new(false)),
                });
                core.ready = true;
                core.has_status = true;
                core.enqueue(
                    format!("G1X{}", "1".repeat(75)),
                    Source::User,
                    PendingKind::Normal,
                    None,
                );
                core.enqueue(
                    format!("G1Y{}", "1".repeat(75)),
                    Source::User,
                    PendingKind::Normal,
                    Some(queued_tx),
                );
                core.load_job("test.nc".into(), "G1X5F10".into()).unwrap();
                core.job.as_mut().unwrap().state = "running".into();
            })
            .await
            .unwrap();
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(_))));
        controller.begin_shutdown().await.unwrap();
        assert_eq!(queued_rx.await.unwrap().unwrap_err(), "Annulé");
        assert!(controller
            .command("G1X1F10".into(), Source::User)
            .await
            .unwrap_err()
            .contains("fermeture"));
        assert!(controller.realtime("start").await.is_err());
        controller.call(|core| core.ack(None)).await.unwrap();
        while let Ok(TransportMessage::Write(bytes)) = rx.try_recv() {
            assert!(!bytes.starts_with(b"G1"));
        }
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn job_completes_and_reports_the_final_position() {
        let controller = setup().await;
        let mut lines = vec!["G21G90".into(), "G10L20P1X0Y0Z0".into(), "G0Z2".into()];
        lines.extend((0..60).map(|i| {
            format!(
                "G1X{}Y{}F6000",
                if i % 2 == 0 { 0 } else { 5 },
                i as f64 * 0.5
            )
        }));
        lines.extend(["G0Z5".into(), "M30".into()]);
        controller
            .load_job("test.nc".into(), lines.join("\n"))
            .await
            .unwrap();
        controller.run_job(0, true, 3.0, 5.0).await.unwrap();
        wait_for_state(&controller, "done").await;
        let view = controller.view().await.unwrap();
        near(view.status.wpos.y, 29.5, 0.01);
        near(view.status.wpos.z, 5.0, 0.01);
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn tool_change_waits_for_motion_and_then_continues() {
        let controller = setup().await;
        controller
            .load_job("outil.nc".into(), "G21G90\nG0Z1\nT2M6\nG0Z3\n".into())
            .await
            .unwrap();
        controller.run_job(0, true, 3.0, 5.0).await.unwrap();
        wait_for_state(&controller, "toolchange").await;
        near(controller.next_status().await.unwrap().wpos.z, 1.0, 0.01);
        controller.tool_done().await.unwrap();
        wait_for_state(&controller, "done").await;
        near(controller.view().await.unwrap().status.wpos.z, 3.0, 0.01);
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn grbl_error_pauses_the_job() {
        let controller = setup().await;
        controller
            .load_job("err.nc".into(), "G21\nG1X5\nG0X1\n".into())
            .await
            .unwrap();
        controller.run_job(0, true, 3.0, 5.0).await.unwrap();
        wait_for_state(&controller, "paused").await;
        let messages = controller.initial_messages().await.unwrap();
        let job = messages.iter().find(|m| m["t"] == "job").unwrap();
        assert!(job["j"]["error"].as_str().unwrap().contains("error:22"));
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn probes_z_corner_and_hole_center() {
        let controller = setup().await;
        controller
            .command("G90G53G0X-140Y-130Z-40".into(), Source::User)
            .await
            .unwrap();
        sync(&controller).await;
        controller
            .command("G20G91".into(), Source::User)
            .await
            .unwrap();
        probe::run(&controller, "z", &json!({"plate":0}))
            .await
            .unwrap();
        let modal = controller.view().await.unwrap().modal;
        assert_eq!(
            (modal.units.as_str(), modal.distance.as_str()),
            ("G20", "G91")
        );
        near(controller.next_status().await.unwrap().wco.z, -50.0, 0.01);

        controller
            .command("G21G90".into(), Source::User)
            .await
            .unwrap();
        controller
            .command("G90G53G0X-210Y-190Z-40".into(), Source::User)
            .await
            .unwrap();
        sync(&controller).await;
        let corner = probe::run(&controller, "corner", &json!({"corner":"FL","toolDia":6}))
            .await
            .unwrap();
        near(corner["edgeX"].as_f64().unwrap(), -220.0, 0.01);
        near(corner["edgeY"].as_f64().unwrap(), -200.0, 0.01);
        near(corner["top"].as_f64().unwrap(), -50.0, 0.01);
        near(controller.next_status().await.unwrap().wco.x, -220.0, 0.01);

        controller
            .command("G90G53G0X-165Y-147Z-60".into(), Source::User)
            .await
            .unwrap();
        sync(&controller).await;
        let hole = probe::run(&controller, "center", &json!({"toolDia":6}))
            .await
            .unwrap();
        near(hole["center"]["X"].as_f64().unwrap(), -170.0, 0.01);
        near(hole["center"]["Y"].as_f64().unwrap(), -150.0, 0.01);
        near(hole["diameterX"].as_f64().unwrap(), 25.0, 0.05);
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn failed_probe_reports_alarm_without_setting_an_origin() {
        let controller = setup().await;
        controller
            .command("G90G53G0X-10Y-10Z-5".into(), Source::User)
            .await
            .unwrap();
        sync(&controller).await;
        controller
            .command("G20G90".into(), Source::User)
            .await
            .unwrap();
        let error = probe::run(&controller, "z", &json!({"travel":10}))
            .await
            .unwrap_err();
        assert!(error.contains("Pas de contact"));
        assert_eq!(controller.next_status().await.unwrap().state, "Alarm");
        controller.command("$G".into(), Source::User).await.unwrap();
        let modal = controller.view().await.unwrap().modal;
        assert_eq!(
            (modal.units.as_str(), modal.distance.as_str()),
            ("G21", "G91")
        );
        assert!(controller
            .command("G0X1".into(), Source::User)
            .await
            .unwrap_err()
            .contains("modes"));
        controller.command("$X".into(), Source::User).await.unwrap();
        controller.next_status().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while controller.view().await.unwrap().restoring_modes {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let modal = controller.view().await.unwrap().modal;
        assert_eq!(
            (modal.units.as_str(), modal.distance.as_str()),
            ("G20", "G90")
        );
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn spindle_restarts_before_motion_resumes() {
        let controller = setup().await;
        let mut lines = vec!["G21G90".into(), "M3S12000".into(), "G0Z1".into()];
        lines.extend((0..30).map(|i| format!("G1X{}Y{i}F300", if i % 2 == 0 { 0 } else { 20 })));
        lines.extend(["M5".into(), "M30".into()]);
        controller
            .load_job("broche.nc".into(), lines.join("\n"))
            .await
            .unwrap();
        controller.run_job(0, true, 3.0, 5.0).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = controller.next_status().await.unwrap();
            if status.state == "Run" && status.speed > 0.0 {
                break;
            }
            assert!(Instant::now() < deadline, "Broche non démarrée");
        }
        controller.pause(true).await.unwrap();
        assert_eq!(controller.next_status().await.unwrap().speed, 0.0);
        let task = tokio::spawn({
            let controller = controller.clone();
            async move { controller.resume(0.3).await }
        });
        wait_for_state(&controller, "spinup").await;
        let status = controller.next_status().await.unwrap();
        assert_eq!(status.state, "Hold");
        assert!(status.speed > 0.0);
        task.await.unwrap().unwrap();
        wait_for_state(&controller, "done").await;
        controller.disconnect("fin").await.unwrap();
    }

    #[tokio::test]
    async fn stop_never_resets_using_a_stale_idle_status() {
        let controller = Controller::spawn();
        let (wire, rx) = thread_mpsc::channel();
        controller
            .call(move |core| {
                core.transport = Some(Transport {
                    sender: wire,
                    closed: Arc::new(AtomicBool::new(false)),
                });
                core.ready = true;
                core.status.state = "Idle".into();
                core.load_job("test.nc".into(), "G1X1F10".into()).unwrap();
                core.job.as_mut().unwrap().state = "running".into();
            })
            .await
            .unwrap();
        let stopping = tokio::spawn({
            let controller = controller.clone();
            async move { controller.stop().await }
        });
        let mut written = Vec::new();
        wait_until(
            || {
                while let Ok(TransportMessage::Write(bytes)) = rx.try_recv() {
                    written.push(bytes);
                }
                written.iter().any(|bytes| bytes == b"?")
            },
            Duration::from_secs(2),
        )
        .await;
        assert!(written.iter().any(|bytes| bytes == b"!"));
        assert!(!written.iter().any(|bytes| bytes == &[0x18]));
        controller
            .sender
            .send(Action::Data(0, b"<Run|MPos:0,0,0>\n".to_vec()))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        while let Ok(TransportMessage::Write(bytes)) = rx.try_recv() {
            written.push(bytes);
        }
        assert!(!written.iter().any(|bytes| bytes == &[0x18]));
        controller
            .sender
            .send(Action::Data(0, b"<Hold:0|MPos:0,0,0>\n".to_vec()))
            .unwrap();
        let mut flushed = false;
        wait_until(
            || {
                while let Ok(message) = rx.try_recv() {
                    match message {
                        TransportMessage::Write(bytes) => written.push(bytes),
                        TransportMessage::Flush(reply) => {
                            let _ = reply.send(Ok(()));
                            flushed = true;
                        }
                        TransportMessage::Close => {}
                    }
                }
                flushed
            },
            Duration::from_secs(2),
        )
        .await;
        stopping.await.unwrap().unwrap();
        while let Ok(TransportMessage::Write(bytes)) = rx.try_recv() {
            written.push(bytes);
        }
        assert!(written.iter().any(|bytes| bytes == &[0x18]));
    }

    #[tokio::test]
    async fn stop_ignores_a_status_query_sent_before_the_hold() {
        let controller = Controller::spawn();
        let (wire, rx) = thread_mpsc::channel();
        controller
            .call(move |core| {
                core.transport = Some(Transport {
                    sender: wire,
                    closed: Arc::new(AtomicBool::new(false)),
                });
                core.ready = true;
                core.load_job("test.nc".into(), "G1X1F10".into()).unwrap();
                core.job.as_mut().unwrap().state = "running".into();
                core.request_status().unwrap();
            })
            .await
            .unwrap();
        assert!(matches!(rx.try_recv(), Ok(TransportMessage::Write(bytes)) if bytes == b"?"));
        let stopping = tokio::spawn({
            let controller = controller.clone();
            async move { controller.stop().await }
        });
        let mut written = Vec::new();
        wait_until(
            || {
                while let Ok(TransportMessage::Write(bytes)) = rx.try_recv() {
                    written.push(bytes);
                }
                written.iter().any(|bytes| bytes == b"!")
            },
            Duration::from_secs(2),
        )
        .await;
        assert!(!written.iter().any(|bytes| bytes == b"?"));
        controller
            .sender
            .send(Action::Data(0, b"<Idle|MPos:0,0,0>\n".to_vec()))
            .unwrap();
        wait_until(
            || {
                while let Ok(TransportMessage::Write(bytes)) = rx.try_recv() {
                    written.push(bytes);
                }
                written.iter().any(|bytes| bytes == b"?")
            },
            Duration::from_secs(2),
        )
        .await;
        assert!(!written.iter().any(|bytes| bytes == &[0x18]));
        controller
            .sender
            .send(Action::Data(0, b"<Hold:0|MPos:0,0,0>\n".to_vec()))
            .unwrap();
        let mut flushed = false;
        wait_until(
            || {
                while let Ok(message) = rx.try_recv() {
                    match message {
                        TransportMessage::Write(bytes) => written.push(bytes),
                        TransportMessage::Flush(reply) => {
                            let _ = reply.send(Ok(()));
                            flushed = true;
                        }
                        TransportMessage::Close => {}
                    }
                }
                flushed
            },
            Duration::from_secs(2),
        )
        .await;
        stopping.await.unwrap().unwrap();
        assert!(written.iter().any(|bytes| bytes == &[0x18]));
    }

    #[tokio::test]
    async fn probe_shutdown_waits_for_a_fresh_stopped_status_before_reset() {
        let controller = Controller::spawn();
        let (wire, rx) = thread_mpsc::channel();
        controller
            .call(move |core| {
                core.transport = Some(Transport {
                    sender: wire,
                    closed: Arc::new(AtomicBool::new(false)),
                });
                core.ready = true;
                core.status.state = "Idle".into();
            })
            .await
            .unwrap();
        let stopping = tokio::spawn({
            let controller = controller.clone();
            async move { controller.hold_and_reset().await }
        });
        let mut written = Vec::new();
        wait_until(
            || {
                while let Ok(TransportMessage::Write(bytes)) = rx.try_recv() {
                    written.push(bytes);
                }
                written.iter().any(|bytes| bytes == b"?")
            },
            Duration::from_secs(2),
        )
        .await;
        assert!(written.iter().any(|bytes| bytes == b"!"));
        assert!(!written.iter().any(|bytes| bytes == &[0x18]));
        controller
            .sender
            .send(Action::Data(0, b"<Run|MPos:0,0,0>\n".to_vec()))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        while let Ok(TransportMessage::Write(bytes)) = rx.try_recv() {
            written.push(bytes);
        }
        assert!(!written.iter().any(|bytes| bytes == &[0x18]));
        controller
            .sender
            .send(Action::Data(0, b"<Hold:0|MPos:0,0,0>\n".to_vec()))
            .unwrap();
        let mut flushed = false;
        wait_until(
            || {
                while let Ok(message) = rx.try_recv() {
                    match message {
                        TransportMessage::Write(bytes) => written.push(bytes),
                        TransportMessage::Flush(reply) => {
                            let _ = reply.send(Ok(()));
                            flushed = true;
                        }
                        TransportMessage::Close => {}
                    }
                }
                flushed
            },
            Duration::from_secs(2),
        )
        .await;
        stopping.await.unwrap().unwrap();
        assert!(written.iter().any(|bytes| bytes == &[0x18]));
    }
}
