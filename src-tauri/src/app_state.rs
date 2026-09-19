use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::brands::directory::{empty_brand_directory, BrandDirectory};
use crate::domain::model::{FuelCode, FuelTrackerState};

pub const EPOCH_ISO: &str = "1970-01-01T00:00:00.000Z";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortMode {
    Distance,
    Price,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppFilters {
    pub longitude: f64,
    pub latitude: f64,
    pub radius_km: f64,
    pub free_text: String,
    pub selected_brands: Vec<String>,
    pub selected_fuel: Option<FuelCode>,
    pub only_available: bool,
    pub sort_by: SortMode,
    pub notifications_enabled: bool,
}

impl Default for AppFilters {
    fn default() -> Self {
        AppFilters {
            longitude: 7.687329,
            latitude: 48.579682,
            radius_km: 10.0,
            free_text: String::new(),
            selected_brands: Vec::new(),
            selected_fuel: None,
            only_available: false,
            sort_by: SortMode::Distance,
            notifications_enabled: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub version: u32,
    pub filters: AppFilters,
    pub brand_directory: BrandDirectory,
    pub brand_area: Option<String>,
    pub trackers: BTreeMap<String, FuelTrackerState>,
    pub updated_at: String,
}

pub fn create_initial_state() -> AppState {
    AppState {
        version: 1,
        filters: AppFilters::default(),
        brand_directory: empty_brand_directory(),
        brand_area: None,
        trackers: BTreeMap::new(),
        updated_at: EPOCH_ISO.to_string(),
    }
}

fn to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}

fn finite_or(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(to_number)
        .filter(|number| number.is_finite())
        .unwrap_or(fallback)
}

fn positive_or(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(to_number)
        .filter(|number| number.is_finite() && *number > 0.0)
        .unwrap_or(fallback)
}

fn string_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        _ => fallback.to_string(),
    }
}

fn to_fuel_code(value: Option<&Value>) -> Option<FuelCode> {
    match value {
        Some(Value::String(text)) => FuelCode::parse(text),
        _ => None,
    }
}

pub fn normalize_filters(input: &Value) -> AppFilters {
    let defaults = AppFilters::default();
    let raw = input.as_object();
    let field = |key: &str| raw.and_then(|map| map.get(key));

    let selected_brands = match field("selectedBrands") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect(),
        _ => Vec::new(),
    };

    let sort_by = match field("sortBy") {
        Some(Value::String(text)) if text == "price" => SortMode::Price,
        Some(Value::String(text)) if text == "distance" => SortMode::Distance,
        _ => defaults.sort_by,
    };

    AppFilters {
        longitude: finite_or(field("longitude"), defaults.longitude),
        latitude: finite_or(field("latitude"), defaults.latitude),
        radius_km: positive_or(field("radiusKm"), defaults.radius_km),
        free_text: string_or(field("freeText"), &defaults.free_text),
        selected_brands,
        selected_fuel: to_fuel_code(field("selectedFuel")),
        only_available: matches!(field("onlyAvailable"), Some(Value::Bool(true))),
        sort_by,
        notifications_enabled: matches!(
            field("notificationsEnabled"),
            Some(Value::Bool(true))
        ),
    }
}

pub fn normalize_state(input: &Value) -> AppState {
    let raw = input.as_object();

    let trackers = raw
        .and_then(|map| map.get("trackers"))
        .and_then(|value| serde_json::from_value::<BTreeMap<String, FuelTrackerState>>(value.clone()).ok())
        .unwrap_or_default();

    let brand_directory = raw
        .and_then(|map| map.get("brandDirectory"))
        .and_then(|value| serde_json::from_value::<BrandDirectory>(value.clone()).ok())
        .unwrap_or_else(empty_brand_directory);

    let brand_area = match raw.and_then(|map| map.get("brandArea")) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };

    let updated_at = match raw.and_then(|map| map.get("updatedAt")) {
        Some(Value::String(text)) => text.clone(),
        _ => EPOCH_ISO.to_string(),
    };

    AppState {
        version: 1,
        filters: normalize_filters(
            raw.and_then(|map| map.get("filters")).unwrap_or(&Value::Null),
        ),
        brand_directory,
        brand_area,
        trackers,
        updated_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_filters_falls_back_to_defaults() {
        let filters = normalize_filters(&Value::Null);
        assert_eq!(filters.longitude, 7.687329);
        assert_eq!(filters.latitude, 48.579682);
        assert_eq!(filters.radius_km, 10.0);
        assert_eq!(filters.selected_fuel, None);
        assert!(!filters.notifications_enabled);
        assert!(filters.selected_brands.is_empty());
    }

    #[test]
    fn normalize_filters_coerces_numbers_and_drops_junk() {
        let filters = normalize_filters(&json!({
            "longitude": "3.5",
            "radiusKm": -1,
            "selectedFuel": "Gazole",
            "notificationsEnabled": true,
            "selectedBrands": ["A", 2, "B"]
        }));
        assert_eq!(filters.longitude, 3.5);
        assert_eq!(filters.radius_km, 10.0);
        assert_eq!(filters.selected_fuel, Some(FuelCode::Gazole));
        assert!(filters.notifications_enabled);
        assert_eq!(filters.selected_brands, vec!["A", "B"]);
    }

    #[test]
    fn normalize_state_rejects_unknown_fuels_and_bad_directories() {
        let state = normalize_state(&json!({
            "filters": { "selectedFuel": "Diesel" },
            "brandDirectory": { "brands": {} }
        }));
        assert_eq!(state.filters.selected_fuel, None);
        assert!(state.brand_directory.brands.is_empty());
        assert!(state.trackers.is_empty());
    }
}
