use chrono::{DateTime, SecondsFormat, Utc};
use std::collections::BTreeMap;

use super::model::{
    initial_tracker_state, tracker_key, Alert, Availability, FuelCode, FuelTrackerState,
    StationSnapshot,
};

#[derive(Debug, Clone, Copy)]
pub struct DetectorOptions {
    pub confirmations: u32,
    pub cooldown_ms: i64,
}

pub struct DetectParams<'a> {
    pub previous: &'a BTreeMap<String, FuelTrackerState>,
    pub snapshot: &'a [StationSnapshot],
    pub fuels: &'a [FuelCode],
    pub now: DateTime<Utc>,
    pub options: DetectorOptions,
}

pub struct DetectResult {
    pub alerts: Vec<Alert>,
    pub next: BTreeMap<String, FuelTrackerState>,
}

#[derive(Debug, Clone)]
struct ObservedState {
    status: Availability,
    price: Option<f64>,
    updated_at: Option<String>,
    rupture_type: Option<String>,
    rupture_start: Option<String>,
}

impl ObservedState {
    fn not_offered() -> Self {
        ObservedState {
            status: Availability::NotOffered,
            price: None,
            updated_at: None,
            rupture_type: None,
            rupture_start: None,
        }
    }
}

fn observe(fuel: FuelCode, station: &StationSnapshot) -> ObservedState {
    let state = match station.fuels.get(&fuel) {
        Some(state) if state.status != Availability::NotOffered => state,
        _ => return ObservedState::not_offered(),
    };
    if state.status == Availability::Rupture {
        return ObservedState {
            status: Availability::Rupture,
            price: None,
            updated_at: state.updated_at.clone(),
            rupture_type: state.rupture_type.clone(),
            rupture_start: state.rupture_start.clone(),
        };
    }
    ObservedState {
        status: Availability::Available,
        price: state.price,
        updated_at: state.updated_at.clone(),
        rupture_type: None,
        rupture_start: None,
    }
}

struct StepResult {
    state: FuelTrackerState,
    became_available: bool,
}

fn step_fuel(
    previous: &FuelTrackerState,
    observed: &ObservedState,
    options: &DetectorOptions,
) -> StepResult {
    let confirmations = if previous.candidate == observed.status {
        previous.confirmations + 1
    } else {
        1
    };
    let candidate = observed.status;
    let confirmed_now = confirmations >= options.confirmations && candidate != previous.status;

    if confirmed_now {
        return StepResult {
            became_available: previous.status == Availability::Rupture
                && candidate == Availability::Available,
            state: FuelTrackerState {
                status: candidate,
                candidate,
                confirmations,
                price: observed.price,
                updated_at: observed.updated_at.clone(),
                rupture_type: observed.rupture_type.clone(),
                rupture_start: observed.rupture_start.clone(),
                last_notified_at: previous.last_notified_at.clone(),
            },
        };
    }

    let holding = candidate == previous.status;
    StepResult {
        became_available: false,
        state: FuelTrackerState {
            status: previous.status,
            candidate,
            confirmations,
            price: if holding { observed.price } else { previous.price },
            updated_at: if holding {
                observed.updated_at.clone()
            } else {
                previous.updated_at.clone()
            },
            rupture_type: if holding {
                observed.rupture_type.clone()
            } else {
                previous.rupture_type.clone()
            },
            rupture_start: if holding {
                observed.rupture_start.clone()
            } else {
                previous.rupture_start.clone()
            },
            last_notified_at: previous.last_notified_at.clone(),
        },
    }
}

fn station_last_notified(
    state: &BTreeMap<String, FuelTrackerState>,
    station_id: i64,
    fuels: &[FuelCode],
) -> Option<i64> {
    let mut latest: Option<i64> = None;
    for fuel in fuels {
        let tracker = match state.get(&tracker_key(station_id, *fuel)) {
            Some(tracker) => tracker,
            None => continue,
        };
        let at = match tracker
            .last_notified_at
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        {
            Some(at) => at.timestamp_millis(),
            None => continue,
        };
        if latest.is_none() || at > latest.unwrap() {
            latest = Some(at);
        }
    }
    latest
}

pub fn detect(params: DetectParams<'_>) -> DetectResult {
    let DetectParams {
        previous,
        snapshot,
        fuels,
        now,
        options,
    } = params;
    let mut next = previous.clone();
    let mut alerts = Vec::new();
    let now_ms = now.timestamp_millis();
    let now_iso = now.to_rfc3339_opts(SecondsFormat::Millis, true);

    for station in snapshot {
        let mut confirmed: Vec<(FuelCode, FuelTrackerState)> = Vec::new();

        for fuel in fuels {
            let key = tracker_key(station.station_id, *fuel);
            let previous_state = next.get(&key).cloned().unwrap_or_else(initial_tracker_state);
            let step = step_fuel(&previous_state, &observe(*fuel, station), &options);
            next.insert(key, step.state.clone());
            if step.became_available {
                confirmed.push((*fuel, step.state));
            }
        }

        if confirmed.is_empty() {
            continue;
        }

        let last_notified = station_last_notified(&next, station.station_id, fuels);
        let cooldown_elapsed =
            last_notified.is_none() || now_ms - last_notified.unwrap() >= options.cooldown_ms;
        if !cooldown_elapsed {
            continue;
        }

        for (fuel, state) in confirmed {
            let price = match state.price {
                Some(price) => price,
                None => continue,
            };
            alerts.push(Alert {
                station_id: station.station_id,
                station_name: station.name.clone(),
                city: station.city.clone(),
                distance_km: station.distance_km,
                fuel,
                price,
                updated_at: state.updated_at.clone(),
                detected_at: now_iso.clone(),
            });
            next.insert(
                tracker_key(station.station_id, fuel),
                FuelTrackerState {
                    last_notified_at: Some(now_iso.clone()),
                    ..state
                },
            );
        }
    }

    DetectResult { alerts, next }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const GAZOLE: FuelCode = FuelCode::Gazole;
    const COOLDOWN_MS: i64 = 6 * 60 * 60 * 1000;
    const T0: i64 = 1_767_225_600_000; // 2026-01-01T00:00:00Z

    fn options() -> DetectorOptions {
        DetectorOptions {
            confirmations: 2,
            cooldown_ms: COOLDOWN_MS,
        }
    }

    fn available(price: f64) -> super::super::model::FuelState {
        super::super::model::FuelState {
            status: Availability::Available,
            price: Some(price),
            updated_at: Some("2026-01-01T00:00:00Z".to_string()),
            rupture_type: None,
            rupture_start: None,
        }
    }

    fn rupture() -> super::super::model::FuelState {
        super::super::model::FuelState {
            status: Availability::Rupture,
            price: None,
            updated_at: Some("2026-01-01T00:00:00Z".to_string()),
            rupture_type: Some("temporaire".to_string()),
            rupture_start: Some("2025-12-31T00:00:00Z".to_string()),
        }
    }

    fn not_offered() -> super::super::model::FuelState {
        super::super::model::FuelState {
            status: Availability::NotOffered,
            price: None,
            updated_at: None,
            rupture_type: None,
            rupture_start: None,
        }
    }

    fn station(state: super::super::model::FuelState, id: i64) -> StationSnapshot {
        let mut fuels = BTreeMap::new();
        fuels.insert(GAZOLE, state);
        StationSnapshot {
            station_id: id,
            name: "Station".to_string(),
            address: "1 rue".to_string(),
            city: "Ville".to_string(),
            latitude: 48.0,
            longitude: 2.0,
            distance_km: 3.0,
            fuels,
        }
    }

    fn now(offset_ms: i64) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(T0 + offset_ms).unwrap()
    }

    fn tick(
        previous: &BTreeMap<String, FuelTrackerState>,
        state: super::super::model::FuelState,
        offset_ms: i64,
    ) -> DetectResult {
        detect(DetectParams {
            previous,
            snapshot: &[station(state, 1)],
            fuels: &[GAZOLE],
            now: now(offset_ms),
            options: options(),
        })
    }

    fn settle(
        previous: &BTreeMap<String, FuelTrackerState>,
        state: super::super::model::FuelState,
        start_ms: i64,
    ) -> DetectResult {
        let first = tick(previous, state.clone(), start_ms);
        tick(&first.next, state, start_ms + 60_000)
    }

    #[test]
    fn fires_once_on_rupture_to_available_after_confirmations() {
        let ruptured = settle(&BTreeMap::new(), rupture(), 0);
        assert_eq!(ruptured.alerts.len(), 0);

        let first_available = tick(&ruptured.next, available(2.1), 120_000);
        assert_eq!(first_available.alerts.len(), 0);

        let second_available = tick(&first_available.next, available(2.1), 180_000);
        assert_eq!(second_available.alerts.len(), 1);
        assert_eq!(second_available.alerts[0].fuel, GAZOLE);
        assert_eq!(second_available.alerts[0].price, 2.1);
    }

    #[test]
    fn does_not_fire_on_available_to_rupture() {
        let started = settle(&BTreeMap::new(), available(2.1), 0);
        assert_eq!(started.alerts.len(), 0);
        let out = settle(&started.next, rupture(), 120_000);
        assert_eq!(out.alerts.len(), 0);
    }

    #[test]
    fn does_not_fire_when_fuel_was_absent_before() {
        let absent = settle(&BTreeMap::new(), not_offered(), 0);
        let now_available = settle(&absent.next, available(2.1), 120_000);
        assert_eq!(now_available.alerts.len(), 0);
    }

    #[test]
    fn cooldown_suppresses_a_second_alert_for_the_same_station() {
        let ruptured = settle(&BTreeMap::new(), rupture(), 0);
        let first = settle(&ruptured.next, available(2.1), 120_000);
        assert_eq!(first.alerts.len(), 1);

        let again = settle(&first.next, available(2.1), 240_000);
        assert_eq!(again.alerts.len(), 0);

        let ruptured_again = settle(&again.next, rupture(), 360_000);
        assert_eq!(ruptured_again.alerts.len(), 0);
        let within_cooldown = settle(&ruptured_again.next, available(2.1), 480_000);
        assert_eq!(within_cooldown.alerts.len(), 0);

        let after_cooldown = settle(
            &within_cooldown.next,
            available(2.1),
            COOLDOWN_MS + 600_000,
        );
        assert_eq!(after_cooldown.alerts.len(), 0);
        let ruptured_later = settle(&after_cooldown.next, rupture(), COOLDOWN_MS + 720_000);
        assert_eq!(ruptured_later.alerts.len(), 0);
        let available_later = settle(
            &ruptured_later.next,
            available(2.1),
            COOLDOWN_MS + 840_000,
        );
        assert_eq!(available_later.alerts.len(), 1);
    }

    #[test]
    fn stable_available_updates_price_without_alerting() {
        let started = settle(&BTreeMap::new(), available(2.0), 0);
        let repriced = settle(&started.next, available(1.95), 120_000);
        assert_eq!(repriced.alerts.len(), 0);
        assert_eq!(repriced.next.get("1:Gazole").unwrap().price, Some(1.95));
    }
}
