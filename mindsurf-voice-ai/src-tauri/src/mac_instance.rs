use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

pub struct MacInstanceBroker {
    primary: bool,
    socket_path: PathBuf,
}

impl MacInstanceBroker {
    pub fn is_primary(&self) -> bool {
        self.primary
    }

    pub fn forward(&self, urls: &[String]) {
        let Ok(mut stream) = UnixStream::connect(&self.socket_path) else {
            return;
        };
        for url in urls {
            let _ = writeln!(stream, "{url}");
        }
        let _ = stream.flush();
    }
}

pub fn initialize(app: &AppHandle) {
    let socket_path = std::env::temp_dir().join("org_sast_mindsurf_auth.sock");
    if UnixStream::connect(&socket_path).is_ok() {
        app.manage(MacInstanceBroker {
            primary: false,
            socket_path,
        });
        return;
    }

    let _ = fs::remove_file(&socket_path);
    match UnixListener::bind(&socket_path) {
        Ok(listener) => {
            app.manage(MacInstanceBroker {
                primary: true,
                socket_path,
            });
            listen_for_callbacks(listener, app.clone());
        }
        Err(_) => {
            app.manage(MacInstanceBroker {
                primary: false,
                socket_path,
            });
        }
    }
}

fn listen_for_callbacks(listener: UnixListener, app: AppHandle) {
    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            let Ok(mut stream) = incoming else { continue };
            let mut message = String::new();
            if stream.read_to_string(&mut message).is_err() {
                continue;
            }
            let callbacks = message
                .lines()
                .filter(|url| url.starts_with("mindsurf://auth/callback"))
                .map(String::from)
                .collect::<Vec<_>>();
            crate::enqueue_auth_callbacks(&app, callbacks);
        }
    });
}
