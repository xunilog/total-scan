use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::app_state::{create_initial_state, normalize_state, AppState};

const STATE_FILE_NAME: &str = "state.json";

pub fn state_file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join(STATE_FILE_NAME))
}

pub fn load_state(path: Option<PathBuf>) -> AppState {
    let path = match path {
        Some(path) => path,
        None => return create_initial_state(),
    };
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return create_initial_state(),
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) => normalize_state(&value),
        Err(error) => {
            tracing::error!(target: "scan_carburant", "failed to read state, using defaults: {error}");
            create_initial_state()
        }
    }
}

pub fn save_state(path: &Option<PathBuf>, state: &AppState) {
    let path = match path {
        Some(path) => path,
        None => return,
    };
    let json = match serde_json::to_string_pretty(state) {
        Ok(json) => json,
        Err(error) => {
            tracing::error!(target: "scan_carburant", "failed to serialize state: {error}");
            return;
        }
    };
    if let Some(directory) = path.parent() {
        let _ = fs::create_dir_all(directory);
    }
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    if let Err(error) = fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, path)) {
        tracing::error!(target: "scan_carburant", "failed to persist state: {error}");
    }
}
