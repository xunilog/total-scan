use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::Client;
use serde::Serialize;

use crate::app_state::{AppFilters, AppState, EPOCH_ISO};
use crate::brands::directory::build_brand_index;
use crate::brands::overpass::{refresh_brand_directory, BrandRefreshParams};
use crate::domain::edge_detector::{detect, DetectParams, DetectorOptions};
use crate::domain::fuel_filter::filter_stations;
use crate::domain::geo::GeoPoint;
use crate::domain::model::{Alert, FuelCode, StationSnapshot};
use crate::feed::ods::{OdsConfig, OdsFeed};
use crate::ingest::normalizer::normalize_stations;
use crate::log::ConsoleLogger;
use crate::ports::{FeedQuery, Logger, Notifier, StationFeed};
use crate::station_query::{area_key, latest_fuel_maj, matches_filters, sort_stations};
use crate::state_store::save_state;

const POLL_INTERVAL_MS: u64 = 5 * 60 * 1000;
const BRAND_TTL_MS: i64 = 60 * 60 * 1000;
const CONFIRMATIONS: u32 = 2;
const COOLDOWN_MS: i64 = 6 * 60 * 60 * 1000;

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
struct SnapshotMeta {
    fetched_at: String,
    data_updated_at: Option<String>,
    polling: bool,
    error: Option<String>,
}

impl Default for SnapshotMeta {
    fn default() -> Self {
        SnapshotMeta {
            fetched_at: EPOCH_ISO.to_string(),
            data_updated_at: None,
            polling: false,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultsPayload {
    pub stations: Vec<StationSnapshot>,
    pub fetched_at: String,
    pub data_updated_at: Option<String>,
    pub polling: bool,
    pub error: Option<String>,
    pub poll_interval_ms: u64,
}

pub struct DesktopPoller {
    state: RwLock<AppState>,
    stations: RwLock<Vec<StationSnapshot>>,
    snapshot: RwLock<SnapshotMeta>,
    notifier: Arc<dyn Notifier>,
    logger: ConsoleLogger,
    state_file: Option<PathBuf>,
    poll_interval: Duration,
    last_brand_refresh: AtomicI64,
    brand_refreshing: AtomicBool,
    running: AtomicBool,
    tick_lock: tokio::sync::Mutex<()>,
    client: Client,
}

impl DesktopPoller {
    pub fn new(
        state: AppState,
        notifier: Arc<dyn Notifier>,
        state_file: Option<PathBuf>,
        poll_interval_ms: Option<u64>,
    ) -> Self {
        let client = Client::builder()
            // Public Overpass instances require a User-Agent that identifies
            // the app; requests without one may be rejected with 429/406.
            .user_agent(concat!("scan-carburant/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        DesktopPoller {
            state: RwLock::new(state),
            stations: RwLock::new(Vec::new()),
            snapshot: RwLock::new(SnapshotMeta::default()),
            notifier,
            logger: ConsoleLogger,
            state_file,
            poll_interval: Duration::from_millis(poll_interval_ms.unwrap_or(POLL_INTERVAL_MS)),
            last_brand_refresh: AtomicI64::new(0),
            brand_refreshing: AtomicBool::new(false),
            running: AtomicBool::new(false),
            tick_lock: tokio::sync::Mutex::new(()),
            client,
        }
    }

    pub fn get_state(&self) -> AppState {
        self.state.read().unwrap().clone()
    }

    pub fn notifications_available(&self) -> bool {
        self.notifier.available()
    }

    pub fn request_notification_permission(&self) -> bool {
        self.notifier.request_permission()
    }

    pub fn update_filters(self: &Arc<Self>, filters: AppFilters) -> AppState {
        {
            let mut state = self.state.write().unwrap();
            state.filters = filters;
            state.updated_at = iso(Utc::now());
        }
        self.persist();
        self.logger.info("filters updated");
        let poller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            poller.tick_after().await;
        });
        self.get_state()
    }

    pub async fn refresh(self: &Arc<Self>) {
        self.tick().await;
    }

    pub fn start(self: &Arc<Self>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let poller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                poller.tick().await;
                if !poller.running.load(Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(poller.poll_interval).await;
            }
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn get_results(&self) -> ResultsPayload {
        let (filters, brand_directory) = {
            let state = self.state.read().unwrap();
            (state.filters.clone(), state.brand_directory.clone())
        };
        let brand_index = build_brand_index(&brand_directory);

        let stations = self.stations.read().unwrap();
        let needle = filters.free_text.trim().to_lowercase();
        let matching: Vec<StationSnapshot> = stations
            .iter()
            .filter(|station| {
                matches_filters(station, &brand_index, &filters.selected_brands, &needle)
            })
            .cloned()
            .collect();
        drop(stations);

        let selected_fuels: Vec<FuelCode> = filters
            .selected_fuel
            .map(|fuel| vec![fuel])
            .unwrap_or_default();
        let filtered = filter_stations(&matching, &selected_fuels, filters.only_available);
        let sorted = sort_stations(&filtered, filters.selected_fuel, filters.sort_by);

        let meta = self.snapshot.read().unwrap();
        ResultsPayload {
            stations: sorted,
            fetched_at: meta.fetched_at.clone(),
            data_updated_at: meta.data_updated_at.clone(),
            polling: meta.polling,
            error: meta.error.clone(),
            poll_interval_ms: self.poll_interval.as_millis() as u64,
        }
    }

    /// Run a tick, unless one is already in flight — in that case await the
    /// running one instead of starting a second poll.
    pub async fn tick(self: &Arc<Self>) {
        if let Ok(_guard) = self.tick_lock.try_lock() {
            self.run_tick().await;
        } else {
            let _guard = self.tick_lock.lock().await;
        }
    }

    /// Run a tick once any in-flight tick has finished, so changes made during
    /// a poll are picked up right away.
    async fn tick_after(self: &Arc<Self>) {
        let _guard = self.tick_lock.lock().await;
        self.run_tick().await;
    }

    async fn run_tick(self: &Arc<Self>) {
        let started_at = Utc::now();
        let filters = self.state.read().unwrap().filters.clone();
        let origin = GeoPoint {
            latitude: filters.latitude,
            longitude: filters.longitude,
        };

        {
            let mut meta = self.snapshot.write().unwrap();
            meta.polling = true;
            meta.error = None;
        }

        if let Err(error) = self.tick_inner(&filters, origin, started_at).await {
            self.logger.error(&format!("poll failed: {error}"));
            let mut meta = self.snapshot.write().unwrap();
            meta.fetched_at = iso(started_at);
            meta.polling = false;
            meta.error = Some(error);
        }
    }

    async fn tick_inner(
        self: &Arc<Self>,
        filters: &AppFilters,
        origin: GeoPoint,
        started_at: DateTime<Utc>,
    ) -> Result<(), String> {
        // Kick off a brand refresh in the background: it hits a different
        // service (Overpass) that may ask us to wait, and must not delay the
        // results the UI is waiting for.
        self.refresh_brands_if_needed(origin, filters.radius_km);

        let feed = OdsFeed::new(self.client.clone(), OdsConfig::default_config());
        let records = feed
            .fetch_records(FeedQuery {
                origin,
                radius_km: filters.radius_km,
            })
            .await
            .map_err(|error| error.to_string())?;
        let stations = normalize_stations(&records, origin, &FuelCode::ALL);

        let (brand_directory, trackers) = {
            let state = self.state.read().unwrap();
            (state.brand_directory.clone(), state.trackers.clone())
        };

        let brand_index = build_brand_index(&brand_directory);
        let needle = filters.free_text.trim().to_lowercase();
        let matching: Vec<StationSnapshot> = stations
            .iter()
            .filter(|station| {
                matches_filters(station, &brand_index, &filters.selected_brands, &needle)
            })
            .cloned()
            .collect();

        let fuels: Vec<FuelCode> = filters
            .selected_fuel
            .map(|fuel| vec![fuel])
            .unwrap_or_else(|| FuelCode::ALL.to_vec());

        let result = detect(DetectParams {
            previous: &trackers,
            snapshot: &matching,
            fuels: &fuels,
            now: started_at,
            options: DetectorOptions {
                confirmations: CONFIRMATIONS,
                cooldown_ms: COOLDOWN_MS,
            },
        });

        {
            let mut state = self.state.write().unwrap();
            state.trackers = result.next.clone();
            state.updated_at = iso(started_at);
        }
        self.persist();

        {
            let mut stored = self.stations.write().unwrap();
            *stored = stations.clone();
        }
        {
            let mut meta = self.snapshot.write().unwrap();
            meta.fetched_at = iso(started_at);
            meta.data_updated_at = latest_fuel_maj(&stations);
            meta.polling = false;
            meta.error = None;
        }

        self.notify(&result.alerts, filters).await;

        self.logger.info(&format!(
            "poll complete: inRadius={} matching={} alerts={}",
            stations.len(),
            matching.len(),
            result.alerts.len()
        ));
        Ok(())
    }

    async fn notify(&self, alerts: &[Alert], filters: &AppFilters) {
        if alerts.is_empty() {
            return;
        }
        if !filters.notifications_enabled {
            self.logger.info(&format!(
                "alerts suppressed (notifications disabled): {}",
                alerts.len()
            ));
            return;
        }
        if !self.notifier.available() {
            self.logger.warn(&format!(
                "notifications unavailable in this runtime: {}",
                alerts.len()
            ));
            return;
        }

        for alert in alerts {
            let body = [
                format!("{} : {:.3} EUR/L", alert.fuel.as_str(), alert.price),
                alert.station_name.clone(),
                format!("Distance : {:.1} km", alert.distance_km),
                match &alert.updated_at {
                    Some(updated_at) => format!("Maj station : {updated_at}"),
                    None => "Maj station : inconnue".to_string(),
                },
                "Disponibilite declaree par la station: a verifier par telephone.".to_string(),
            ]
            .join("\n");
            let city = if alert.city.is_empty() {
                alert.station_name.clone()
            } else {
                alert.city.clone()
            };
            let title = format!("{} disponible - {}", alert.fuel.as_str(), city);
            match self.notifier.notify(&title, &body) {
                Ok(()) => self.logger.info(&format!(
                    "alert delivered: station={} fuel={}",
                    alert.station_id,
                    alert.fuel.as_str()
                )),
                Err(error) => self
                    .logger
                    .warn(&format!("failed to deliver notification: {error}")),
            }
        }
    }

    fn refresh_brands_if_needed(self: &Arc<Self>, origin: GeoPoint, radius_km: f64) {
        let area = area_key(origin, radius_km);
        let now = now_ms();
        let stale = now - self.last_brand_refresh.load(Ordering::SeqCst) >= BRAND_TTL_MS;
        {
            let state = self.state.read().unwrap();
            if state.brand_area.as_deref() == Some(area.as_str()) && !stale {
                return;
            }
        }
        if self.brand_refreshing.swap(true, Ordering::SeqCst) {
            return;
        }

        let poller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            poller.run_brand_refresh(origin, radius_km, area, now).await;
            poller.brand_refreshing.store(false, Ordering::SeqCst);
        });
    }

    async fn run_brand_refresh(
        &self,
        origin: GeoPoint,
        radius_km: f64,
        area: String,
        started_at: i64,
    ) {
        let feed = OdsFeed::new(self.client.clone(), OdsConfig::default_config());
        let existing = self.state.read().unwrap().brand_directory.clone();
        match refresh_brand_directory(
            &self.client,
            BrandRefreshParams {
                origin,
                radius_km,
                feed: &feed,
            },
            &existing,
        )
        .await
        {
            Ok(result) => {
                {
                    let mut state = self.state.write().unwrap();
                    state.brand_directory = result.directory;
                    state.brand_area = Some(area);
                }
                self.last_brand_refresh.store(started_at, Ordering::SeqCst);
                self.persist();
                self.logger.info(&format!(
                    "brand directory refreshed: osm={} matched={}",
                    result.osm_stations, result.matched_stations
                ));
            }
            Err(error) => self
                .logger
                .warn(&format!("brand refresh failed: {error}")),
        }
    }

    fn persist(&self) {
        let state = self.state.read().unwrap().clone();
        save_state(&self.state_file, &state);
    }
}
