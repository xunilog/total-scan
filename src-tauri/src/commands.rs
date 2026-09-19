use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::app_state::{normalize_filters, AppState};
use crate::brands::directory::BrandDirectory;
use crate::poller::{DesktopPoller, ResultsPayload};

#[tauri::command]
pub fn get_state(poller: State<'_, Arc<DesktopPoller>>) -> AppState {
    poller.inner().get_state()
}

#[tauri::command]
pub fn update_filters(
    poller: State<'_, Arc<DesktopPoller>>,
    filters: serde_json::Value,
) -> AppState {
    poller.inner().update_filters(normalize_filters(&filters))
}

#[tauri::command]
pub fn get_results(poller: State<'_, Arc<DesktopPoller>>) -> ResultsPayload {
    poller.inner().get_results()
}

#[tauri::command]
pub async fn refresh(
    poller: State<'_, Arc<DesktopPoller>>,
) -> Result<ResultsPayload, String> {
    let poller = poller.inner();
    poller.refresh().await;
    Ok(poller.get_results())
}

#[tauri::command]
pub fn get_brands(poller: State<'_, Arc<DesktopPoller>>) -> BrandDirectory {
    poller.inner().get_state().brand_directory
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPermission {
    pub granted: bool,
    pub available: bool,
}

#[tauri::command]
pub fn notification_permission(
    poller: State<'_, Arc<DesktopPoller>>,
) -> NotificationPermission {
    let poller = poller.inner();
    let available = poller.notifications_available();
    let granted = if available {
        poller.request_notification_permission()
    } else {
        false
    };
    NotificationPermission { granted, available }
}
