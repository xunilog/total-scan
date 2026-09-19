use tauri::AppHandle;
use tauri_plugin_notification::{NotificationExt, PermissionState};

use crate::ports::Notifier;

pub struct AppNotifier {
    app: AppHandle,
}

impl AppNotifier {
    pub fn new(app: AppHandle) -> Self {
        AppNotifier { app }
    }
}

impl Notifier for AppNotifier {
    fn available(&self) -> bool {
        true
    }

    fn request_permission(&self) -> bool {
        matches!(
            self.app.notification().request_permission(),
            Ok(PermissionState::Granted)
        )
    }

    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}
