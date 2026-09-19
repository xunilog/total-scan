use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

use crate::menu::handle_menu_event;

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open Window").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let tray_menu = MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&quit)
        .build()?;

    let builder = TrayIconBuilder::with_id("main")
        .tooltip("Scan Carburant")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);

    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder,
    };

    builder.build(app)?;
    Ok(())
}
