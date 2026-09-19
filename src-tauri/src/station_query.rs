use std::collections::{BTreeMap, BTreeSet};

use crate::app_state::SortMode;
use crate::brands::directory::station_matches_brands;
use crate::domain::geo::GeoPoint;
use crate::domain::model::{Availability, FuelCode, StationSnapshot};

pub fn matches_text(station: &StationSnapshot, needle: &str) -> bool {
    let haystack = format!("{} {} {}", station.name, station.address, station.city).to_lowercase();
    haystack.contains(needle)
}

pub fn matches_filters(
    station: &StationSnapshot,
    brand_index: &BTreeMap<i64, BTreeSet<String>>,
    brands: &[String],
    needle: &str,
) -> bool {
    if !brands.is_empty()
        && !station_matches_brands(brand_index, station.station_id, brands)
    {
        return false;
    }
    if !needle.is_empty() && !matches_text(station, needle) {
        return false;
    }
    true
}

pub fn station_fuel_price(station: &StationSnapshot, fuel: Option<FuelCode>) -> Option<f64> {
    let fuel = fuel?;
    let state = station.fuels.get(&fuel)?;
    if state.status != Availability::Available {
        return None;
    }
    state.price
}

pub fn sort_stations(
    stations: &[StationSnapshot],
    fuel: Option<FuelCode>,
    mode: SortMode,
) -> Vec<StationSnapshot> {
    let mut sorted = stations.to_vec();
    let by_distance = |a: &StationSnapshot, b: &StationSnapshot| {
        a.distance_km
            .partial_cmp(&b.distance_km)
            .unwrap_or(std::cmp::Ordering::Equal)
    };
    if mode != SortMode::Price || fuel.is_none() {
        sorted.sort_by(by_distance);
        return sorted;
    }
    sorted.sort_by(|a, b| {
        let price_a = station_fuel_price(a, fuel);
        let price_b = station_fuel_price(b, fuel);
        match (price_a, price_b) {
            (None, None) => by_distance(a, b),
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(_), None) => std::cmp::Ordering::Less,
            (Some(a_price), Some(b_price)) => {
                a_price.partial_cmp(&b_price).unwrap_or(std::cmp::Ordering::Equal)
            }
        }
    });
    sorted
}

pub fn latest_fuel_maj(stations: &[StationSnapshot]) -> Option<String> {
    let mut latest_ms: Option<i64> = None;
    let mut latest_iso: Option<String> = None;
    for station in stations {
        for fuel in station.fuels.values() {
            let updated_at = match fuel.updated_at.as_deref() {
                Some(value) => value,
                None => continue,
            };
            let parsed = match chrono::DateTime::parse_from_rfc3339(updated_at) {
                Ok(parsed) => parsed.timestamp_millis(),
                Err(_) => continue,
            };
            if latest_ms.is_none() || parsed > latest_ms.unwrap() {
                latest_ms = Some(parsed);
                latest_iso = Some(updated_at.to_string());
            }
        }
    }
    latest_iso
}

pub fn area_key(origin: GeoPoint, radius_km: f64) -> String {
    format!("{}|{}|{}", origin.latitude, origin.longitude, radius_km)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::FuelState;

    #[test]
    fn latest_fuel_maj_picks_the_most_recent_timestamp() {
        let station = StationSnapshot {
            station_id: 1,
            name: "S".to_string(),
            address: String::new(),
            city: String::new(),
            latitude: 0.0,
            longitude: 0.0,
            distance_km: 0.0,
            fuels: BTreeMap::from([(
                FuelCode::Gazole,
                FuelState {
                    status: Availability::Available,
                    price: Some(2.0),
                    updated_at: Some("2026-01-02T00:00:00.000Z".to_string()),
                    rupture_type: None,
                    rupture_start: None,
                },
            )]),
        };
        assert_eq!(
            latest_fuel_maj(&[station]).as_deref(),
            Some("2026-01-02T00:00:00.000Z")
        );
    }
}
