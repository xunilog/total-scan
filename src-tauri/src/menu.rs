use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Manager, Runtime,
};

use crate::tray::show_main_window;

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "reload" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.reload()");
            }
        }
        "open" => show_main_window(app),
        "devtools" => {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

pub fn setup_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let reload = MenuItemBuilder::with_id("reload", "Reload").build(app)?;
    let open = MenuItemBuilder::with_id("open", "Open Window")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let devtools = MenuItemBuilder::with_id("devtools", "Toggle DevTools")
        .accelerator("CmdOrCtrl+Alt+I")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Scan Carburant")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Scan Carburant")
        .item(&reload)
        .separator()
        .item(&quit)
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open)
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&devtools)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}
