#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod controller;
mod gcode;
mod probe;
mod profile;
mod server;
mod simulator;
mod tcp;

use std::{net::SocketAddr, path::PathBuf};

fn main() {
    if let Err(error) = run() {
        eprintln!("Copeau : {error}");
        #[cfg(windows)]
        show_error(&error);
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("Copeau Rust\n  --server  Démarrer uniquement le serveur web (HOST et PORT sont facultatifs)");
        return Ok(());
    }
    if args.iter().any(|arg| arg != "--server") {
        return Err("Argument inconnu. Utilisez --help.".into());
    }
    let server_only = args.iter().any(|arg| arg == "--server");
    #[cfg(windows)]
    let _instance = if server_only {
        None
    } else {
        match single_instance() {
            Some(handle) => Some(handle),
            None => return Ok(()),
        }
    };
    #[cfg(not(windows))]
    if !server_only {
        return Err("La fenêtre portable est disponible sous Windows. Utilisez --server.".into());
    }

    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let data_dir = match std::env::var_os("COPEAU_DATA_DIR") {
        Some(path) => PathBuf::from(path),
        None => executable
            .parent()
            .ok_or("Dossier de l'exécutable introuvable")?
            .join("data"),
    };
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Dossier {} inaccessible : {error}", data_dir.display()))?;
    let address: SocketAddr = if server_only {
        let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port = std::env::var("PORT").unwrap_or_else(|_| "8000".into());
        format!("{host}:{port}")
            .parse()
            .map_err(|_| "HOST ou PORT invalide")?
    } else {
        "127.0.0.1:38427".parse().expect("valid address")
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Démarrage du moteur impossible : {error}"))?;
    let server = runtime.block_on(server::start(data_dir.clone(), address))?;
    let url = if server.address.ip().is_unspecified() {
        format!("http://127.0.0.1:{}", server.address.port())
    } else {
        format!("http://{}", server.address)
    };
    println!("Copeau prêt : {url}");
    let result = if server_only {
        runtime.block_on(async {
            tokio::signal::ctrl_c()
                .await
                .map_err(|error| error.to_string())
        })
    } else {
        #[cfg(windows)]
        {
            window(&url, data_dir)
        }
        #[cfg(not(windows))]
        {
            unreachable!()
        }
    };
    let shutdown = runtime.block_on(server.shutdown());
    result.and(shutdown)
}

#[cfg(windows)]
fn window(url: &str, data_dir: PathBuf) -> Result<(), String> {
    use tao::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoop},
        platform::run_return::EventLoopExtRunReturn,
        window::WindowBuilder,
    };
    use wry::{WebContext, WebViewBuilder};

    let mut event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Copeau")
        .with_inner_size(LogicalSize::new(1440.0, 960.0))
        .with_min_inner_size(LogicalSize::new(960.0, 640.0))
        .build(&event_loop)
        .map_err(|error| format!("Création de la fenêtre impossible : {error}"))?;
    let mut context = WebContext::new(Some(data_dir.join("webview2")));
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_url(url)
        .build(&window)
        .map_err(|error| {
            format!(
                "Impossible d'ouvrir l'interface (Microsoft Edge WebView2 est requis) : {error}"
            )
        })?;
    event_loop.run_return(|event, _, control| {
        *control = ControlFlow::Wait;
        if matches!(
            event,
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            }
        ) {
            *control = ControlFlow::Exit;
        }
    });
    drop(webview);
    drop(window);
    Ok(())
}

// Un second lancement remet la fenêtre existante au premier plan au lieu d'échouer sur le port.
#[cfg(windows)]
fn single_instance() -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_ALREADY_EXISTS},
        System::Threading::CreateMutexW,
        UI::WindowsAndMessaging::{
            FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
        },
    };
    let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() };
    let name = wide("Local\\CopeauRustPortable");
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() || unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
        return Some(handle);
    }
    let title = wide("Copeau");
    unsafe {
        let window = FindWindowW(std::ptr::null(), title.as_ptr());
        if !window.is_null() {
            if IsIconic(window) != 0 {
                ShowWindow(window, SW_RESTORE);
            }
            SetForegroundWindow(window);
        }
    }
    None
}

#[cfg(windows)]
fn show_error(error: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let title: Vec<u16> = "Copeau — erreur de démarrage"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let message: Vec<u16> = error.encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}
