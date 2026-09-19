mod app_state;
mod brands;
mod commands;
mod domain;
mod feed;
mod http;
mod ingest;
mod log;
mod menu;
mod notifications;
mod poller;
mod ports;
mod station_query;
mod state_store;
mod tray;

use std::sync::Arc;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

use poller::DesktopPoller;
use state_store::{load_state, state_file_path};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        tray::show_main_window(app);
    }));

    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();

    builder
        .setup(|app| {
            let _ = tracing_subscriber::fmt()
                .with_env_filter(
                    EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| EnvFilter::new("scan_carburant=info")),
                )
                .try_init();

            let handle = app.handle().clone();
            let state_file = state_file_path(&handle);
            let state = load_state(state_file.clone());
            let notifier = Arc::new(notifications::AppNotifier::new(handle.clone()));
            let poller = Arc::new(DesktopPoller::new(state, notifier, state_file, None));
            app.manage(poller.clone());
            poller.start();

            menu::setup_menu(&handle)?;
            let menu_handle = handle.clone();
            handle.on_menu_event(move |_app, event| {
                menu::handle_menu_event(&menu_handle, event.id().as_ref());
            });
            tray::setup_tray(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::update_filters,
            commands::get_results,
            commands::refresh,
            commands::get_brands,
            commands::notification_permission,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::Reopen { .. } => tray::show_main_window(app_handle),
            tauri::RunEvent::ExitRequested { .. } => {
                if let Some(poller) = app_handle.try_state::<Arc<DesktopPoller>>() {
                    poller.inner().stop();
                }
            }
            _ => {}
        });
}
