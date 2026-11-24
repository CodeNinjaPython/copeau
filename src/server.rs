use crate::{
    controller::{Controller, Source},
    probe,
    profile::Profile,
    tcp::parse_host,
};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use include_dir::{include_dir, Dir};
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde_json::{json, Value};
use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, mpsc, oneshot, Mutex, RwLock},
};

type Result<T> = std::result::Result<T, String>;
const PUBLIC: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/public");
const MAX_FILE: usize = 60 * 1024 * 1024;
const DEFAULT_MACROS: &str = r#"[
  {"id":"park","name":"Garer (Z haut, X0 Y0)","gcode":"G90 G53 G0 Z-2\nG90 G0 X0 Y0"},
  {"id":"spindle-warmup","name":"Chauffe broche 2 min","gcode":"M3 S8000\nG4 P60\nM3 S16000\nG4 P60\nM5"}
]"#;

#[derive(Clone)]
pub struct AppState {
    pub controller: Controller,
    data_dir: PathBuf,
    config: Arc<Mutex<Value>>,
    storage_lock: Arc<Mutex<()>>,
    probe_lock: Arc<RwLock<()>>,
    path_lock: Arc<Mutex<()>>,
    jog_generation: Arc<AtomicU64>,
    next_connection: Arc<AtomicU64>,
    shutting_down: Arc<AtomicBool>,
}

struct Connection {
    jogging: AtomicBool,
    closed: Arc<AtomicBool>,
    id: u64,
}

impl AppState {
    async fn new(data_dir: PathBuf) -> Result<Self> {
        let config = read_json(&data_dir.join("config.json"), json!({})).await?;
        if !config.is_object() {
            return Err("Le fichier config.json doit contenir un objet".into());
        }
        Ok(Self {
            controller: Controller::spawn(),
            data_dir,
            config: Arc::new(Mutex::new(config)),
            storage_lock: Arc::new(Mutex::new(())),
            probe_lock: Arc::new(RwLock::new(())),
            path_lock: Arc::new(Mutex::new(())),
            jog_generation: Arc::new(AtomicU64::new(0)),
            next_connection: Arc::new(AtomicU64::new(1)),
            shutting_down: Arc::new(AtomicBool::new(false)),
        })
    }

    fn broadcast(&self, event: Value) {
        let _ = self.controller.events.send(event);
    }

    async fn macros(&self) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        let defaults: Value = serde_json::from_str(DEFAULT_MACROS).map_err(|e| e.to_string())?;
        let list = read_json(&self.data_dir.join("macros.json"), defaults).await?;
        if !list.is_array() {
            return Err("Le fichier macros.json doit contenir une liste".into());
        }
        Ok(list)
    }

    async fn save_macros(&self, list: Value) -> Result<()> {
        if !list.is_array() {
            return Err("Liste de macros invalide".into());
        }
        let _guard = self.storage_lock.lock().await;
        write_json(&self.data_dir.join("macros.json"), &list).await?;
        self.broadcast(json!({"t":"macros","list":list}));
        Ok(())
    }

    async fn save_program(&self, name: &str, text: &str) -> Result<()> {
        let _guard = self.storage_lock.lock().await;
        write_json(
            &self.data_dir.join("program.json"),
            &json!({"name":name,"text":text}),
        )
        .await
    }

    // Le programme reste chargé mais n'est jamais relancé : il faut un nouveau Démarrer.
    async fn restore_program(&self) {
        let Ok(saved) = read_json(&self.data_dir.join("program.json"), Value::Null).await else {
            return;
        };
        let (Some(name), Some(text)) = (
            saved.get("name").and_then(Value::as_str),
            saved.get("text").and_then(Value::as_str),
        ) else {
            return;
        };
        if text.len() <= MAX_FILE {
            let _ = self.controller.load_job(name.into(), text.into()).await;
        }
    }

    async fn set_config(&self, key: &str, value: Value) -> Result<()> {
        if key != "zones" && key != "machine" {
            return Err(format!("Clé de configuration inconnue : {key}"));
        }
        if key == "machine" {
            let machine = value.as_object().ok_or("Configuration machine invalide")?;
            let profile = Profile::parse(
                machine
                    .get("profile")
                    .and_then(Value::as_str)
                    .unwrap_or("cnc"),
            )?;
            if machine.get("host").is_some_and(|host| !host.is_string()) {
                return Err("Adresse réseau invalide".into());
            }
            if let Some(s_max) = machine.get("sMax").filter(|value| !value.is_null()) {
                if s_max
                    .as_f64()
                    .is_none_or(|value| !value.is_finite() || value <= 0.0)
                {
                    return Err("Puissance maximale invalide".into());
                }
            }
            let view = self.controller.view().await?;
            if view.connected && view.profile != profile {
                return Err("Déconnectez la machine avant de changer de profil".into());
            }
        }
        let _storage = self.storage_lock.lock().await;
        let mut current = self.config.lock().await;
        let mut next = current.clone();
        next.as_object_mut()
            .expect("config is object")
            .insert(key.into(), value);
        write_json(&self.data_dir.join("config.json"), &next).await?;
        *current = next.clone();
        self.broadcast(json!({"t":"config","config":next}));
        Ok(())
    }

    fn cancel_jog(&self) {
        self.jog_generation.fetch_add(1, Ordering::SeqCst);
    }
}

async fn read_json(path: &Path, default: Value) -> Result<Value> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Fichier {} invalide : {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default),
        Err(error) => Err(format!(
            "Lecture de {} impossible : {error}",
            path.display()
        )),
    }
}

async fn write_json(path: &Path, value: &Value) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| "Dossier de données invalide".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Création de {} impossible : {error}", parent.display()))?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    tokio::fs::write(&temp, bytes)
        .await
        .map_err(|error| format!("Écriture de {} impossible : {error}", temp.display()))?;
    if let Err(error) = tokio::fs::rename(&temp, path).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(format!(
            "Enregistrement de {} impossible : {error}",
            path.display()
        ));
    }
    Ok(())
}

pub struct RunningServer {
    pub state: AppState,
    pub address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl RunningServer {
    pub async fn shutdown(mut self) -> Result<()> {
        self.state.shutting_down.store(true, Ordering::SeqCst);
        self.state.cancel_jog();
        let mut stop_error = self.state.controller.pointer_off().await.err();
        let activity_guard = self.state.probe_lock.try_write();
        let operation_pending = activity_guard.is_err();
        if let Err(error) = self.state.controller.begin_shutdown().await {
            stop_error.get_or_insert(error);
        }
        if let Ok(view) = self.state.controller.view().await {
            if view.connected && view.ready {
                let status = self.state.controller.next_status().await;
                let active = view.job_state.as_deref().is_some_and(|s| {
                    [
                        "running",
                        "paused",
                        "spinup",
                        "toolchange",
                        "finishing",
                        "stopping",
                    ]
                    .contains(&s)
                });
                let stop = if operation_pending {
                    tokio::time::timeout(
                        Duration::from_secs(8),
                        self.state.controller.hold_and_reset(),
                    )
                    .await
                } else if active {
                    tokio::time::timeout(Duration::from_secs(8), self.state.controller.stop()).await
                } else if view.jog_active
                    || status.as_ref().is_ok_and(|status| status.state == "Jog")
                {
                    tokio::time::timeout(Duration::from_secs(3), self.state.controller.jog_stop())
                        .await
                } else if !status
                    .as_ref()
                    .is_ok_and(|status| ["Idle", "Alarm"].contains(&status.state.as_str()))
                {
                    tokio::time::timeout(
                        Duration::from_secs(8),
                        self.state.controller.hold_and_reset(),
                    )
                    .await
                } else {
                    Ok(Ok(()))
                };
                match stop {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        stop_error.get_or_insert(error);
                    }
                    Err(_) => {
                        stop_error.get_or_insert(
                            "Arrêt de la machine non confirmé avant la fermeture".into(),
                        );
                    }
                }
            } else if view.connected && view.job_state.as_deref() == Some("stopped") {
                if let Err(error) = self.state.controller.flush().await {
                    stop_error = Some(error);
                }
            }
        }
        if let Err(error) = self.state.controller.disconnect("Application fermée").await {
            stop_error.get_or_insert(error);
        }
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if tokio::time::timeout(Duration::from_secs(2), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
        }
        stop_error.map_or(Ok(()), Err)
    }
}

pub async fn start(data_dir: PathBuf, address: SocketAddr) -> Result<RunningServer> {
    let state = AppState::new(data_dir).await?;
    state.restore_program().await;
    let listener = TcpListener::bind(address)
        .await
        .map_err(|error| format!("Impossible d'ouvrir l'adresse {address} : {error}"))?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let router = Router::new()
        .route("/ws", get(websocket))
        .route("/manuel", get(manual))
        .route("/api/version", get(version))
        .fallback(get(static_file))
        .with_state(state.clone());
    let (shutdown, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
    });
    Ok(RunningServer {
        state,
        address,
        shutdown: Some(shutdown),
        task,
    })
}

fn valid_origin(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Ok(authority) = host.parse::<axum::http::uri::Authority>() else {
        return false;
    };
    let hostname = authority.host().trim_matches(['[', ']']);
    let local_name = hostname.len() > ".local".len()
        && hostname
            .get(hostname.len() - ".local".len()..)
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".local"));
    if hostname != "localhost" && !local_name && hostname.parse::<IpAddr>().is_err() {
        return false;
    }
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Ok(uri) = origin.parse::<Uri>() else {
        return false;
    };
    matches!(uri.scheme_str(), Some("http" | "https"))
        && uri.authority().is_some_and(|origin_host| {
            origin_host
                .as_str()
                .eq_ignore_ascii_case(authority.as_str())
        })
}

async fn websocket(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !valid_origin(&headers) {
        return (StatusCode::FORBIDDEN, "Origine WebSocket refusée").into_response();
    }
    ws.max_message_size(64 * 1024 * 1024)
        .max_frame_size(64 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let connection = Arc::new(Connection {
        jogging: AtomicBool::new(false),
        closed: Arc::new(AtomicBool::new(false)),
        id: state.next_connection.fetch_add(1, Ordering::SeqCst),
    });
    let mut events = state.controller.events.subscribe();
    let (mut sink, mut stream) = socket.split();
    let (out, mut outbound) = mpsc::channel::<Value>(256);
    let writer = tokio::spawn(async move {
        while let Some(message) = outbound.recv().await {
            if sink
                .send(Message::Text(message.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let initial = match state.controller.initial_messages().await {
        Ok(initial) => initial,
        Err(error) => {
            eprintln!("{error}");
            writer.abort();
            return;
        }
    };
    for message in initial {
        if out.send(message).await.is_err() {
            return;
        }
    }
    if out
        .send(json!({"t":"config","config":*state.config.lock().await}))
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let parsed = serde_json::from_str::<Value>(&text);
                    let message = match parsed {
                        Ok(v) if v.is_object() => v,
                        _ => {
                            let _ = out.send(json!({"t":"reply","id":null,"ok":false,"error":"Message JSON invalide"})).await;
                            continue;
                        }
                    };
                    let state = state.clone();
                    let out = out.clone();
                    let connection = connection.clone();
                    if message.get("t").and_then(Value::as_str)
                        .is_some_and(|kind| ["jogStop", "stop", "disconnect", "connect"].contains(&kind))
                    {
                        state.cancel_jog();
                    }
                    let generation = state.jog_generation.load(Ordering::SeqCst);
                    tokio::spawn(async move {
                        let id = message.get("id").cloned().unwrap_or(Value::Null);
                        let response = match handle_message(&state, &connection, &message, generation).await {
                            Ok(result) => json!({"t":"reply","id":id,"ok":true,"result":result}),
                            Err(error) => json!({"t":"reply","id":id,"ok":false,"error":error}),
                        };
                        let _ = out.send(response).await;
                    });
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            event = events.recv() => match event {
                Ok(event) => if out.send(event).await.is_err() { break; },
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = state.controller.log("err", "Écran trop lent : reconnexion nécessaire".into()).await;
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }
    connection.closed.store(true, Ordering::SeqCst);
    let jogging = connection.jogging.load(Ordering::SeqCst);
    if jogging {
        state.cancel_jog();
    }
    let off = state.controller.pointer_off_owner(connection.id);
    let stop = async {
        if jogging {
            tokio::time::timeout(Duration::from_secs(5), state.controller.jog_stop())
                .await
                .unwrap_or_else(|_| Err("Arrêt du jog non confirmé".into()))
        } else {
            Ok(())
        }
    };
    let (off_result, stop_result) = tokio::join!(off, stop);
    for error in [off_result, stop_result]
        .into_iter()
        .filter_map(std::result::Result::err)
    {
        let _ = state.controller.log("err", error).await;
    }
    writer.abort();
}

fn required_str<'a>(message: &'a Value, key: &str) -> Result<&'a str> {
    message
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Champ {key} invalide"))
}

fn number(message: &Value, key: &str, default: f64) -> Result<f64> {
    let Some(value) = message.get(key) else {
        return Ok(default);
    };
    if value.is_null() || value.as_str() == Some("") {
        return Ok(default);
    }
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|v| v.parse::<f64>().ok()))
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("Champ {key} invalide"))
}

fn positive(message: &Value, key: &str, default: f64) -> Result<f64> {
    let value = number(message, key, default)?;
    if value <= 0.0 {
        return Err(format!("Champ {key} doit être positif"));
    }
    Ok(value)
}

fn check_jog(state: &AppState, connection: &Connection, generation: u64) -> Result<()> {
    if connection.closed.load(Ordering::SeqCst)
        || state.jog_generation.load(Ordering::SeqCst) != generation
    {
        return Err("Annulé".into());
    }
    Ok(())
}

async fn jog_command(
    state: &AppState,
    connection: &Connection,
    generation: u64,
    line: String,
) -> Result<()> {
    check_jog(state, connection, generation)?;
    state
        .controller
        .jog_command(line, state.jog_generation.clone(), generation)
        .await?;
    check_jog(state, connection, generation)
}

async fn prepare_port_change(state: &AppState) -> Result<()> {
    state.controller.pointer_off().await?;
    let view = state.controller.view().await?;
    if !view.connected {
        return Ok(());
    }
    if view.recovering {
        return Err("Attendez la fin de l'arrêt de la machine".into());
    }
    if view.job_state.as_deref().is_some_and(|s| {
        [
            "running",
            "paused",
            "spinup",
            "toolchange",
            "finishing",
            "stopping",
        ]
        .contains(&s)
    }) {
        return Err("Arrêtez le job avant de déconnecter la machine".into());
    }
    if view.jog_active {
        tokio::time::timeout(Duration::from_secs(3), async {
            state.controller.jog_stop().await?;
            loop {
                let status = state.controller.next_status().await?;
                if status.state == "Idle"
                    || status.state == "Alarm"
                    || (status.state == "Hold" && status.sub_state.as_deref() == Some("0"))
                {
                    return Ok::<(), String>(());
                }
            }
        })
        .await
        .map_err(|_| "Arrêt du jog non confirmé".to_string())??;
    } else if ["Run", "Home"].contains(&view.status.state.as_str()) {
        return Err("Attendez l'arrêt de la machine avant de la déconnecter".into());
    }
    Ok(())
}

async fn handle_message(
    state: &AppState,
    connection: &Connection,
    message: &Value,
    generation: u64,
) -> Result<Value> {
    if state.shutting_down.load(Ordering::SeqCst) {
        return Err("Application en cours de fermeture".into());
    }
    let kind = required_str(message, "t")?;
    let controller = &state.controller;
    let pointer_start =
        kind == "laserPointer" && message.get("on").and_then(Value::as_bool).unwrap_or(false);
    let _job_guard = if matches!(kind, "run" | "toolDone") || pointer_start {
        Some(
            state
                .probe_lock
                .try_write()
                .map_err(|_| "Un mouvement ou un palpage est déjà en cours")?,
        )
    } else {
        None
    };
    let _motion_guard = if matches!(
        kind,
        "cmd" | "jog" | "axisToZero" | "gotoOrigin" | "jogTo" | "jogPath" | "resume" | "runMacro"
    ) {
        Some(
            state
                .probe_lock
                .try_read()
                .map_err(|_| "Un palpage est déjà en cours")?,
        )
    } else {
        None
    };
    match kind {
        "ports" => {
            let mut list =
                vec![json!({"path":"simulateur","label":"Simulateur Grbl (sans machine)"})];
            list.push(json!({"path":"reseau","label":"Réseau (Wi-Fi / Ethernet)"}));
            match serialport::available_ports() {
                Ok(ports) => {
                    for port in ports {
                        if port.port_name.to_lowercase().contains("bluetooth")
                            || port.port_name.to_lowercase().contains("debug-console")
                        {
                            continue;
                        }
                        let manufacturer = match port.port_type {
                            serialport::SerialPortType::UsbPort(info) => info.manufacturer,
                            _ => None,
                        };
                        let label = manufacturer.filter(|m| !m.is_empty()).map_or_else(
                            || port.port_name.clone(),
                            |m| format!("{} · {m}", port.port_name),
                        );
                        list.push(json!({"path":port.port_name,"label":label}));
                    }
                }
                Err(error) => {
                    controller
                        .log(
                            "err",
                            format!("Liste des ports série indisponible : {error}"),
                        )
                        .await?
                }
            }
            Ok(json!(list))
        }
        "profiles" => Ok(Profile::all()),
        "connect" => {
            let port = required_str(message, "port")?.to_string();
            let baud = positive(message, "baud", 115200.0)?;
            if baud.fract() != 0.0 || baud > u32::MAX as f64 {
                return Err("Vitesse série invalide".into());
            }
            let _guard = state
                .probe_lock
                .try_write()
                .map_err(|_| "Mouvement ou palpage en cours : déconnexion impossible")?;
            prepare_port_change(state).await?;
            let saved = state.config.lock().await["machine"].clone();
            let profile = Profile::parse(
                message
                    .get("profile")
                    .and_then(Value::as_str)
                    .or_else(|| saved.get("profile").and_then(Value::as_str))
                    .unwrap_or("cnc"),
            )?;
            let host = message
                .get("host")
                .and_then(Value::as_str)
                .or_else(|| saved.get("host").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            if port == "reseau" {
                parse_host(&host)?;
            }
            let mut machine = saved.as_object().cloned().unwrap_or_default();
            machine.insert("profile".into(), json!(profile.id()));
            machine.insert("host".into(), json!(host));
            if state.controller.view().await?.connected {
                state.controller.disconnect("Changement de port").await?;
            }
            state.set_config("machine", Value::Object(machine)).await?;
            controller.connect(port, baud as u32, profile, host).await?;
            Ok(Value::Null)
        }
        "disconnect" => {
            let _guard = state
                .probe_lock
                .try_write()
                .map_err(|_| "Mouvement ou palpage en cours : déconnexion impossible")?;
            prepare_port_change(state).await?;
            controller
                .disconnect("Déconnecté par l'utilisateur")
                .await?;
            Ok(Value::Null)
        }
        "cmd" => {
            let text = required_str(message, "line")?;
            let lines: Vec<_> = text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect();
            controller
                .validate_manual_lines(lines.clone(), Source::User)
                .await?;
            for line in lines {
                controller.command(line, Source::User).await?;
            }
            Ok(Value::Null)
        }
        "realtime" => {
            let name = required_str(message, "name")?;
            let view = controller.view().await?;
            if view.profile.smoothie()
                && (name.starts_with("feed") || name.starts_with("spindle"))
                && name != "spindleStop"
            {
                controller.smoothie_override(name).await?;
            } else {
                controller.realtime(name).await?;
            }
            Ok(Value::Null)
        }
        "laserPointer" => {
            if !pointer_start {
                controller.pointer_off().await?;
            } else {
                controller.next_status().await?;
                let view = controller.view().await?;
                let saved = state.config.lock().await["machine"]["sMax"].as_f64();
                let s_max = saved
                    .filter(|value| *value > 0.0)
                    .or_else(|| {
                        view.settings
                            .get("30")
                            .and_then(|value| value.parse::<f64>().ok())
                            .filter(|value| *value > 0.0)
                    })
                    .unwrap_or(if view.profile.smoothie() { 1.0 } else { 1000.0 });
                controller
                    .pointer_on(
                        connection.id,
                        connection.closed.clone(),
                        number(message, "power", 1.0)?,
                        s_max,
                    )
                    .await?;
            }
            Ok(Value::Null)
        }
        "jog" => {
            let axes = message
                .get("axes")
                .and_then(Value::as_object)
                .ok_or("Axes invalides")?;
            let feed = positive(message, "feed", 1000.0)?;
            let continuous = message
                .get("continuous")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let view = controller.view().await?;
            if view.pointer_on && !view.profile.smoothie() {
                controller.pointer_off().await?;
            }
            let mut parts = String::new();
            for axis in ['X', 'Y', 'Z'] {
                let Some(value) = axes.get(&axis.to_string()) else {
                    continue;
                };
                let distance = value
                    .as_f64()
                    .filter(|v| v.is_finite())
                    .ok_or("Distance de jog invalide")?;
                let distance = if continuous && distance != 0.0 {
                    let direction = distance.signum();
                    let travel = view
                        .settings
                        .get(&(130 + (axis as u32 - 'X' as u32)).to_string())
                        .and_then(|v| v.parse::<f64>().ok())
                        .filter(|v| *v > 0.0);
                    if view.settings.get("20").is_some_and(|v| v == "1") {
                        if let Some(travel) = travel {
                            let pos = view.status.mpos.get(axis);
                            let distance = if direction > 0.0 {
                                -0.5 - pos
                            } else {
                                -travel + 0.5 - pos
                            };
                            if distance.signum() == direction {
                                distance
                            } else {
                                0.0
                            }
                        } else {
                            direction * 1000.0
                        }
                    } else {
                        direction * 1000.0
                    }
                } else {
                    distance
                };
                if distance.abs() >= 0.001 {
                    parts.push_str(&format!("{axis}{distance:.3}"));
                }
            }
            if parts.is_empty() {
                return Err(if continuous {
                    "Limite logicielle atteinte dans cette direction"
                } else {
                    "Aucun déplacement valide"
                }
                .into());
            }
            connection.jogging.store(true, Ordering::SeqCst);
            jog_command(
                state,
                connection,
                generation,
                format!("$J=G91G21{parts}F{feed}"),
            )
            .await?;
            Ok(Value::Null)
        }
        "axisToZero" => {
            let axis = required_str(message, "axis")?;
            if !["X", "Y", "Z"].contains(&axis) {
                return Err("Axe invalide".into());
            }
            let mut feed = positive(message, "feed", 1000.0)?;
            let view = controller.view().await?;
            if view.pointer_on && !view.profile.smoothie() {
                controller.pointer_off().await?;
            }
            if axis == "Z" && view.status.wpos.z > 0.0 {
                feed = feed.min(positive(message, "plungeFeed", 300.0)?);
            }
            connection.jogging.store(true, Ordering::SeqCst);
            controller
                .log("info", format!("Retour de {axis} à l'origine"))
                .await?;
            jog_command(
                state,
                connection,
                generation,
                format!("$J=G90G21{axis}0F{feed}"),
            )
            .await?;
            Ok(Value::Null)
        }
        "gotoOrigin" | "jogTo" | "jogPath" => {
            let feed = positive(message, "feed", 1000.0)?;
            let lift = message
                .get("liftZ")
                .filter(|v| !v.is_null())
                .map(|_| number(message, "liftZ", 0.0))
                .transpose()?;
            connection.jogging.store(true, Ordering::SeqCst);
            let _path_guard = if kind == "jogPath" {
                Some(
                    state
                        .path_lock
                        .try_lock()
                        .map_err(|_| "Un parcours est déjà en cours")?,
                )
            } else {
                None
            };
            let points = if kind == "jogPath" {
                let array = message
                    .get("points")
                    .and_then(Value::as_array)
                    .ok_or("Parcours invalide")?;
                if !(2..=400).contains(&array.len()) {
                    return Err("Parcours invalide".into());
                }
                array
                    .iter()
                    .map(|p| Ok((number(p, "X", f64::NAN)?, number(p, "Y", f64::NAN)?)))
                    .collect::<Result<Vec<_>>>()?
            } else if kind == "jogTo" {
                vec![(
                    number(message, "X", f64::NAN)?,
                    number(message, "Y", f64::NAN)?,
                )]
            } else {
                vec![(0.0, 0.0)]
            };
            if points.iter().any(|(x, y)| !x.is_finite() || !y.is_finite()) {
                return Err("Cible invalide".into());
            }
            let plunge = if kind == "gotoOrigin" {
                Some(feed.min(positive(message, "plungeFeed", 300.0)?))
            } else {
                None
            };
            let view = controller.view().await?;
            if view.pointer_on && !view.profile.smoothie() {
                controller.pointer_off().await?;
            }
            let pointer_power = number(message, "pointer", 0.0)?;
            let with_pointer = kind == "jogPath"
                && view.profile.smoothie()
                && pointer_power > 0.0
                && !view.pointer_on;
            if with_pointer {
                controller.next_status().await?;
                controller
                    .pointer_on(connection.id, connection.closed.clone(), pointer_power, 1.0)
                    .await?;
            }
            let result: Result<()> = async {
                if let Some(z) = lift {
                    if view.status.wpos.z < z {
                        jog_command(
                            state,
                            connection,
                            generation,
                            format!("$J=G90G21Z{z:.3}F{feed}"),
                        )
                        .await?;
                    }
                }
                let description = match kind {
                    "jogPath" => format!("Parcours du contour ({} points)", points.len()),
                    "jogTo" => format!("Déplacement vers X{} Y{}", points[0].0, points[0].1),
                    _ => "Retour à l'origine X0 Y0 Z0".into(),
                };
                controller.log("info", description).await?;
                for (x, y) in points {
                    jog_command(
                        state,
                        connection,
                        generation,
                        format!("$J=G90G21X{x:.3}Y{y:.3}F{feed}"),
                    )
                    .await?;
                }
                if let Some(plunge) = plunge {
                    jog_command(
                        state,
                        connection,
                        generation,
                        format!("$J=G90G21Z0F{plunge}"),
                    )
                    .await?;
                }
                if with_pointer {
                    controller.command("M400".into(), Source::Sync).await?;
                }
                Ok(())
            }
            .await;
            if with_pointer {
                let off = controller.pointer_off_owner(connection.id).await;
                if let Err(error) = off {
                    return Err(match result {
                        Ok(()) => error,
                        Err(previous) => format!("{previous} ; extinction : {error}"),
                    });
                }
            }
            result?;
            Ok(Value::Null)
        }
        "jogStop" => {
            connection.jogging.store(false, Ordering::SeqCst);
            controller
                .jog_stop_with(
                    message
                        .get("gentle")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .await?;
            Ok(Value::Null)
        }
        "getConfig" => Ok(state.config.lock().await.clone()),
        "setConfig" => {
            let key = required_str(message, "key")?;
            let value = message
                .get("value")
                .cloned()
                .ok_or("Valeur de configuration absente")?;
            state.set_config(key, value).await?;
            Ok(Value::Null)
        }
        "load" => {
            let text = required_str(message, "text")?;
            if text.len() > MAX_FILE {
                return Err("Fichier trop gros (60 Mo max)".into());
            }
            let name = message
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("programme.nc");
            controller.load_job(name.into(), text.into()).await?;
            if let Err(error) = state.save_program(name, text).await {
                controller
                    .log(
                        "err",
                        format!("Programme non conservé pour le prochain démarrage : {error}"),
                    )
                    .await?;
            }
            Ok(Value::Null)
        }
        "run" => {
            let from = number(message, "from", 0.0)?;
            if from < 0.0 || from > usize::MAX as f64 {
                return Err("Ligne de reprise invalide".into());
            }
            let spin_up = number(message, "spinUp", 3.0)?;
            let min_safe_z = number(message, "safeZ", 5.0)?;
            let tool_change = message
                .get("toolChange")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            controller.next_status().await?;
            controller
                .run_job(from.floor() as usize, tool_change, spin_up, min_safe_z)
                .await?;
            Ok(Value::Null)
        }
        "pause" => {
            controller
                .pause(
                    message
                        .get("stopSpindle")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .await?;
            Ok(Value::Null)
        }
        "resume" => {
            controller.resume(number(message, "spinUp", 3.0)?).await?;
            Ok(Value::Null)
        }
        "spindleStop" => {
            controller.stop_spindle().await?;
            Ok(Value::Null)
        }
        "stop" => {
            controller.pointer_off().await?;
            controller.stop().await?;
            Ok(Value::Null)
        }
        "toolDone" => {
            controller.next_status().await?;
            controller.tool_done().await?;
            Ok(Value::Null)
        }
        "probe" => {
            let _guard = state
                .probe_lock
                .try_write()
                .map_err(|_| "Un mouvement ou un palpage est déjà en cours")?;
            controller.next_status().await?;
            if controller.view().await?.profile.laser() {
                return Err("Le palpage est indisponible avec un profil laser".into());
            }
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
            let result = probe::run(controller, required_str(message, "kind")?, &params).await?;
            if let Some(message) = result.get("message").and_then(Value::as_str) {
                controller.log("info", message.into()).await?;
            }
            Ok(result)
        }
        "macros" => state.macros().await,
        "saveMacros" => {
            state
                .save_macros(
                    message
                        .get("list")
                        .cloned()
                        .ok_or("Liste de macros absente")?,
                )
                .await?;
            Ok(Value::Null)
        }
        "runMacro" => {
            let id = required_str(message, "id")?;
            let list = state.macros().await?;
            let item = list
                .as_array()
                .expect("macros array")
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
                .ok_or("Macro introuvable")?;
            let name = required_str(item, "name")?;
            let gcode = required_str(item, "gcode")?;
            let lines: Vec<_> = gcode
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect();
            controller
                .validate_manual_lines(lines.clone(), Source::Macro)
                .await?;
            controller.log("info", format!("Macro : {name}")).await?;
            for line in lines {
                controller.command(line, Source::Macro).await?;
            }
            Ok(Value::Null)
        }
        _ => Err(format!("Message inconnu : {kind}")),
    }
}

async fn static_file(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let vendor: Option<&'static [u8]> = match path {
        "vendor/three/build/three.module.js" => {
            Some(include_bytes!(concat!(env!("OUT_DIR"), "/three.module.js")))
        }
        "vendor/three/build/three.core.js" => {
            Some(include_bytes!(concat!(env!("OUT_DIR"), "/three.core.js")))
        }
        "vendor/three/examples/jsm/controls/OrbitControls.js" => Some(include_bytes!(concat!(
            env!("OUT_DIR"),
            "/OrbitControls.js"
        ))),
        "vendor/three/LICENSE" => Some(include_bytes!(concat!(env!("OUT_DIR"), "/three-LICENSE"))),
        _ => None,
    };
    let data = vendor.or_else(|| PUBLIC.get_file(path).map(|file| file.contents()));
    match data {
        Some(data) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CACHE_CONTROL, "no-store")
            .header(
                header::CONTENT_TYPE,
                mime_guess::from_path(path).first_or_octet_stream().as_ref(),
            )
            .body(Body::from(data))
            .expect("valid response"),
        None => (StatusCode::NOT_FOUND, "Introuvable").into_response(),
    }
}

async fn version() -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(
            json!({"name":"copeau-rust","version":env!("CARGO_PKG_VERSION")}).to_string(),
        ))
        .expect("valid response")
}

fn slug(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter_map(|c| {
            if c.is_alphanumeric() || c == '-' {
                Some(c)
            } else if c.is_whitespace() {
                Some('-')
            } else {
                None
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

async fn manual() -> impl IntoResponse {
    let parser = Parser::new_ext(include_str!("../docs/MANUEL.md"), Options::all());
    let events: Vec<_> = parser.collect();
    let mut rendered = Vec::with_capacity(events.len());
    for (index, event) in events.iter().cloned().enumerate() {
        if let Event::Start(Tag::Heading {
            level,
            classes,
            attrs,
            ..
        }) = event
        {
            let mut title = String::new();
            for next in events.iter().skip(index + 1) {
                match next {
                    Event::End(TagEnd::Heading(_)) => break,
                    Event::Text(text) | Event::Code(text) => title.push_str(text),
                    _ => {}
                }
            }
            rendered.push(Event::Start(Tag::Heading {
                level,
                id: Some(CowStr::Boxed(slug(&title).into_boxed_str())),
                classes,
                attrs,
            }));
        } else {
            rendered.push(event);
        }
    }
    let mut body = String::new();
    html::push_html(&mut body, rendered.into_iter());
    (
        [(header::CACHE_CONTROL, "no-store")],
        Html(format!(
            r#"<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Manuel Copeau</title>
<link rel="stylesheet" href="/css/manuel.css"></head><body>
<nav class="top"><a href="/">← Retour à Copeau</a><a href="/?tour=0">Lancer la démo guidée</a></nav>
<main>{body}</main></body></html>"#
        )),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{client::IntoClientRequest, Message as ClientMessage},
        MaybeTlsStream, WebSocketStream,
    };

    type Client = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

    async fn connect(address: SocketAddr) -> Client {
        let mut request = format!("ws://{address}/ws").into_client_request().unwrap();
        request
            .headers_mut()
            .insert(header::ORIGIN, format!("http://{address}").parse().unwrap());
        connect_async(request).await.unwrap().0
    }

    async fn request(client: &mut Client, id: u64, message: Value) -> Value {
        let mut message = message;
        message["id"] = json!(id);
        client
            .send(ClientMessage::Text(message.to_string().into()))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let frame = client.next().await.unwrap().unwrap();
                if let ClientMessage::Text(text) = frame {
                    let message: Value = serde_json::from_str(&text).unwrap();
                    if message["t"] == "reply" && message["id"] == id {
                        assert_eq!(message["ok"], true, "{message}");
                        return message["result"].clone();
                    }
                }
            }
        })
        .await
        .expect("réponse WebSocket")
    }

    async fn http_get(address: SocketAddr, path: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[tokio::test]
    async fn embedded_interface_manual_and_three_are_available_offline() {
        let dir = tempfile::tempdir().unwrap();
        let server = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let index = http_get(server.address, "/").await;
        assert!(index.starts_with("HTTP/1.1 200"));
        assert!(index
            .to_ascii_lowercase()
            .contains("cache-control: no-store"));
        assert!(index.contains("<title>Copeau</title>"));
        let module = http_get(server.address, "/vendor/three/build/three.module.js").await;
        assert!(module.starts_with("HTTP/1.1 200"));
        assert!(module
            .to_ascii_lowercase()
            .contains("cache-control: no-store"));
        assert!(module.contains("three.core.js"));
        assert!(
            http_get(server.address, "/vendor/three/build/three.core.js")
                .await
                .starts_with("HTTP/1.1 200")
        );
        assert!(http_get(
            server.address,
            "/vendor/three/examples/jsm/controls/OrbitControls.js"
        )
        .await
        .contains("OrbitControls"));
        assert!(http_get(server.address, "/vendor/three/LICENSE")
            .await
            .contains("MIT License"));
        let licenses = http_get(server.address, "/licenses-rust.html").await;
        assert!(licenses.contains("Mozilla Public License 2.0"));
        assert!(licenses.contains("serialport"));
        let manual = http_get(server.address, "/manuel").await;
        assert!(manual
            .to_ascii_lowercase()
            .contains("cache-control: no-store"));
        assert!(manual.contains("id=\"1-installation-et-lancement\""));
        server.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn websocket_rejects_other_origins_and_rebinding_hostnames() {
        let dir = tempfile::tempdir().unwrap();
        let server = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let mut request = format!("ws://{}/ws", server.address)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(header::ORIGIN, "https://example.invalid".parse().unwrap());
        let error = connect_async(request).await.unwrap_err();
        assert!(
            matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == StatusCode::FORBIDDEN)
        );

        let mut request = format!("ws://{}/ws", server.address)
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            header::HOST,
            format!("example.invalid:{}", server.address.port())
                .parse()
                .unwrap(),
        );
        request.headers_mut().insert(
            header::ORIGIN,
            format!("http://example.invalid:{}", server.address.port())
                .parse()
                .unwrap(),
        );
        let error = connect_async(request).await.unwrap_err();
        assert!(
            matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == StatusCode::FORBIDDEN)
        );
        server.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn websocket_runs_a_simulated_job_and_persists_data() {
        let dir = tempfile::tempdir().unwrap();
        let server = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let mut client = connect(server.address).await;
        let ports = request(&mut client, 1, json!({"t":"ports"})).await;
        assert_eq!(ports[0]["path"], "simulateur");
        request(
            &mut client,
            2,
            json!({"t":"connect","port":"simulateur","baud":115200}),
        )
        .await;
        request(&mut client, 3, json!({"t":"cmd","line":"$X"})).await;
        server.state.controller.next_status().await.unwrap();
        request(
            &mut client,
            4,
            json!({"t":"jog","axes":{"X":1},"feed":6000}),
        )
        .await;
        request(&mut client, 5, json!({"t":"jogStop"})).await;
        request(
            &mut client,
            6,
            json!({"t":"load","name":"job.nc","text":"G21G90\nG1X2F6000\nM30"}),
        )
        .await;
        server.state.controller.next_status().await.unwrap();
        request(&mut client, 7, json!({"t":"run","from":0})).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if server
                    .state
                    .controller
                    .view()
                    .await
                    .unwrap()
                    .job_state
                    .as_deref()
                    == Some("done")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();

        let zones = json!({"table":{"kind":"rectangle"},"zone":null});
        let macros = json!([{"id":"test","name":"Test","gcode":"G0X0"}]);
        request(
            &mut client,
            8,
            json!({"t":"setConfig","key":"zones","value":zones}),
        )
        .await;
        request(&mut client, 9, json!({"t":"saveMacros","list":macros})).await;
        client.close(None).await.unwrap();
        drop(client);
        server.shutdown().await.unwrap();

        let restarted = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        assert_eq!(restarted.state.config.lock().await["zones"], zones);
        assert_eq!(restarted.state.macros().await.unwrap(), macros);
        assert_eq!(
            restarted
                .state
                .controller
                .view()
                .await
                .unwrap()
                .job_state
                .as_deref(),
            Some("loaded")
        );
        restarted.shutdown().await.unwrap();
    }

    #[test]
    fn accepts_local_network_names_but_not_arbitrary_hosts() {
        let headers = |host: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, host.parse().unwrap());
            headers.insert(header::ORIGIN, format!("http://{host}").parse().unwrap());
            headers
        };
        assert!(valid_origin(&headers("atelier.local:8000")));
        assert!(valid_origin(&headers("ATELIER.LOCAL")));
        assert!(valid_origin(&headers("192.168.1.20:8000")));
        assert!(!valid_origin(&headers("evil.example:8000")));
        assert!(!valid_origin(&headers(".local")));
    }

    #[tokio::test]
    async fn laser_pointer_turns_off_when_its_own_screen_disconnects() {
        let dir = tempfile::tempdir().unwrap();
        let server = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let mut owner = connect(server.address).await;
        request(
            &mut owner,
            1,
            json!({"t":"connect","port":"simulateur","profile":"emblaser2"}),
        )
        .await;
        request(
            &mut owner,
            2,
            json!({"t":"laserPointer","on":true,"power":1}),
        )
        .await;
        assert!(server.state.controller.view().await.unwrap().pointer_on);
        let mut other = connect(server.address).await;
        request(&mut other, 3, json!({"t":"getConfig"})).await;
        other.close(None).await.unwrap();
        drop(other);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(server.state.controller.view().await.unwrap().pointer_on);
        owner.close(None).await.unwrap();
        drop(owner);
        tokio::time::timeout(Duration::from_secs(3), async {
            while server.state.controller.view().await.unwrap().pointer_on {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        server.shutdown().await.unwrap();
        let restarted = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        assert_eq!(
            restarted.state.config.lock().await["machine"]["profile"],
            "emblaser2"
        );
        restarted.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn smoothie_frame_waits_for_motion_then_turns_off_its_pointer() {
        let dir = tempfile::tempdir().unwrap();
        let server = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let mut client = connect(server.address).await;
        request(
            &mut client,
            1,
            json!({"t":"connect","port":"simulateur","profile":"emblaser2"}),
        )
        .await;
        request(
            &mut client,
            2,
            json!({"t":"jogPath","points":[{"X":1,"Y":1},{"X":2,"Y":1}],"feed":6000,"pointer":1}),
        )
        .await;
        let view = server.state.controller.view().await.unwrap();
        assert!(!view.pointer_on);
        let status = server.state.controller.next_status().await.unwrap();
        assert!((status.wpos.x - 2.0).abs() < 0.01);
        assert!((status.wpos.y - 1.0).abs() < 0.01);
        client.close(None).await.unwrap();
        drop(client);
        server.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn losing_the_screen_cancels_a_continuous_jog() {
        let dir = tempfile::tempdir().unwrap();
        let server = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let mut client = connect(server.address).await;
        request(&mut client, 1, json!({"t":"connect","port":"simulateur"})).await;
        request(&mut client, 2, json!({"t":"cmd","line":"$X"})).await;
        server.state.controller.next_status().await.unwrap();
        request(
            &mut client,
            3,
            json!({"t":"jog","axes":{"X":1},"feed":6000,"continuous":true}),
        )
        .await;
        client.close(None).await.unwrap();
        drop(client);
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                let view = server.state.controller.view().await.unwrap();
                if !view.jog_active && view.status.state == "Idle" {
                    assert!(view.status.mpos.x < 1000.0);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
        server.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn port_changes_are_refused_during_a_job_or_probe() {
        let dir = tempfile::tempdir().unwrap();
        let server = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let connection = Connection {
            jogging: AtomicBool::new(false),
            closed: Arc::new(AtomicBool::new(false)),
            id: 1,
        };
        server
            .state
            .controller
            .connect_simulator(1.0)
            .await
            .unwrap();
        server
            .state
            .controller
            .command("$X".into(), Source::User)
            .await
            .unwrap();
        server.state.controller.next_status().await.unwrap();
        {
            let _motion = server.state.probe_lock.read().await;
            handle_message(
                &server.state,
                &connection,
                &json!({"t":"cmd","line":"$G"}),
                0,
            )
            .await
            .unwrap();
            let error = handle_message(
                &server.state,
                &connection,
                &json!({"t":"probe","kind":"z"}),
                0,
            )
            .await
            .unwrap_err();
            assert!(error.contains("mouvement"));
            for kind in ["run", "toolDone"] {
                let error = handle_message(&server.state, &connection, &json!({"t":kind}), 0)
                    .await
                    .unwrap_err();
                assert!(error.contains("mouvement"));
            }
        }
        {
            let _probe = server.state.probe_lock.write().await;
            let error = handle_message(&server.state, &connection, &json!({"t":"disconnect"}), 0)
                .await
                .unwrap_err();
            assert!(error.contains("palpage en cours"));
            let error = handle_message(
                &server.state,
                &connection,
                &json!({"t":"jog","axes":{"X":1},"feed":1000}),
                0,
            )
            .await
            .unwrap_err();
            assert!(error.contains("palpage"));
        }
        server
            .state
            .controller
            .load_job("long.nc".into(), "G21G90\nG1X100F1".into())
            .await
            .unwrap();
        server
            .state
            .controller
            .run_job(0, true, 3.0, 5.0)
            .await
            .unwrap();
        server
            .state
            .save_macros(json!([{"id":"unsafe","name":"Unsafe","gcode":"$I\nG0X20"}]))
            .await
            .unwrap();
        for message in [
            json!({"t":"cmd","line":"$I\nG0X20"}),
            json!({"t":"runMacro","id":"unsafe"}),
        ] {
            let error = handle_message(&server.state, &connection, &message, 0)
                .await
                .unwrap_err();
            assert!(error.contains("Usinage"));
        }
        let messages = server.state.controller.initial_messages().await.unwrap();
        let logs = messages
            .iter()
            .find(|message| message["t"] == "logs")
            .unwrap()["list"]
            .as_array()
            .unwrap();
        assert!(!logs
            .iter()
            .any(|entry| entry["dir"] == "tx" && entry["text"] == "$I"));
        for message in [
            json!({"t":"disconnect"}),
            json!({"t":"connect","port":"simulateur"}),
        ] {
            let error = handle_message(&server.state, &connection, &message, 0)
                .await
                .unwrap_err();
            assert!(error.contains("Arrêtez le job"));
            assert!(server.state.controller.view().await.unwrap().connected);
        }
        server.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn resume_uses_the_safety_height_sent_by_the_frontend() {
        let dir = tempfile::tempdir().unwrap();
        let server = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let connection = Connection {
            jogging: AtomicBool::new(false),
            closed: Arc::new(AtomicBool::new(false)),
            id: 1,
        };
        server
            .state
            .controller
            .connect_simulator(40.0)
            .await
            .unwrap();
        server
            .state
            .controller
            .command("$X".into(), Source::User)
            .await
            .unwrap();
        server.state.controller.next_status().await.unwrap();
        server
            .state
            .controller
            .load_job(
                "reprise.nc".into(),
                "G21G90\nG53G0Z0\nG0X10Y10\nG1Z-2F300\nG1X50F800\nG53G0Z0\nG0X10Y30\nG1Z-2F300"
                    .into(),
            )
            .await
            .unwrap();
        let error = handle_message(
            &server.state,
            &connection,
            &json!({"t":"run","from":7,"safeZ":"invalid"}),
            0,
        )
        .await
        .unwrap_err();
        assert!(error.contains("safeZ"));
        handle_message(
            &server.state,
            &connection,
            &json!({"t":"run","from":7,"safeZ":12}),
            0,
        )
        .await
        .unwrap();
        let messages = server.state.controller.initial_messages().await.unwrap();
        let logs = messages
            .iter()
            .find(|message| message["t"] == "logs")
            .unwrap()["list"]
            .as_array()
            .unwrap();
        assert!(logs.iter().any(|entry| entry["text"]
            .as_str()
            .is_some_and(|text| text.contains("Reprise à la ligne") && text.contains("G0Z12"))));
        server.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn disconnect_cancels_and_waits_for_an_active_jog() {
        let dir = tempfile::tempdir().unwrap();
        let server = start(dir.path().into(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let mut client = connect(server.address).await;
        request(&mut client, 1, json!({"t":"connect","port":"simulateur"})).await;
        request(&mut client, 2, json!({"t":"cmd","line":"$X"})).await;
        server.state.controller.next_status().await.unwrap();
        request(
            &mut client,
            3,
            json!({"t":"jog","axes":{"X":1},"feed":6000,"continuous":true}),
        )
        .await;
        assert!(server.state.controller.view().await.unwrap().jog_active);
        request(&mut client, 4, json!({"t":"disconnect"})).await;
        assert!(!server.state.controller.view().await.unwrap().connected);
        client.close(None).await.unwrap();
        server.shutdown().await.unwrap();
    }
}
