use std::collections::{BTreeMap, HashSet};

use chrono::{LocalResult, NaiveDate, SecondsFormat, TimeZone, Utc};
use chrono_tz::Europe::Paris;
use regex::Regex;
use serde_json::Value;

use crate::domain::geo::{haversine_km, GeoPoint};
use crate::domain::model::{Availability, FuelCode, FuelState, StationSnapshot};

use super::raw_record::RawStationRecord;

fn fuel_prefix(fuel: FuelCode) -> &'static str {
    match fuel {
        FuelCode::Gazole => "gazole",
        FuelCode::Sp95 => "sp95",
        FuelCode::E10 => "e10",
        FuelCode::Sp98 => "sp98",
        FuelCode::E85 => "e85",
        FuelCode::Gplc => "gplc",
    }
}

fn number_or_null(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|n| n.is_finite()),
        Some(Value::String(text)) if !text.trim().is_empty() => {
            text.parse::<f64>().ok().filter(|n| n.is_finite())
        }
        _ => None,
    }
}

fn string_or_null(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

/// The ODS feed returns French station timestamps as local wall-clock time but
/// labels them UTC (e.g. "2026-09-18T18:49:25+00:00"). Reinterpret the
/// wall-clock as Europe/Paris time so the resulting instant is correct.
pub fn normalize_french_timestamp(value: &str) -> Option<String> {
    let pattern =
        Regex::new(r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?").ok()?;
    let captures = pattern.captures(value)?;

    let year: i32 = captures.get(1)?.as_str().parse().ok()?;
    let month: u32 = captures.get(2)?.as_str().parse().ok()?;
    let day: u32 = captures.get(3)?.as_str().parse().ok()?;
    let hour: u32 = captures.get(4)?.as_str().parse().ok()?;
    let minute: u32 = captures.get(5)?.as_str().parse().ok()?;
    let second: u32 = captures
        .get(6)
        .and_then(|part| part.as_str().parse().ok())
        .unwrap_or(0);

    let date = NaiveDate::from_ymd_opt(year, month, day)?;
    let naive = date.and_hms_opt(hour % 24, minute, second)?;
    let localized = match Paris.from_local_datetime(&naive) {
        LocalResult::Single(datetime) => datetime,
        LocalResult::Ambiguous(datetime, _) => datetime,
        LocalResult::None => return None,
    };
    Some(
        localized
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}

fn timestamp_or_null(value: Option<&Value>) -> Option<String> {
    let raw = string_or_null(value)?;
    Some(normalize_french_timestamp(&raw).unwrap_or(raw))
}

fn to_name_set(value: Option<&Value>) -> HashSet<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect(),
        Some(Value::String(text)) => text
            .split(';')
            .map(|part| part.trim())
            .filter(|part| !part.is_empty())
            .map(|part| part.to_string())
            .collect(),
        _ => HashSet::new(),
    }
}

fn coordinates_of(record: &RawStationRecord) -> Option<GeoPoint> {
    if let Some(geom) = &record.geom {
        if let (Some(lat), Some(lon)) = (geom.lat, geom.lon) {
            return Some(GeoPoint {
                latitude: lat,
                longitude: lon,
            });
        }
    }
    let lat = number_or_null(record.latitude.as_ref())?;
    let lon = number_or_null(record.longitude.as_ref())?;
    let scaled = lat.abs() > 1000.0 || lon.abs() > 1000.0;
    Some(if scaled {
        GeoPoint {
            latitude: lat / 1e5,
            longitude: lon / 1e5,
        }
    } else {
        GeoPoint {
            latitude: lat,
            longitude: lon,
        }
    })
}

fn classify_fuel(
    fuel: FuelCode,
    record: &RawStationRecord,
    available: &HashSet<String>,
    unavailable: &HashSet<String>,
) -> FuelState {
    let prefix = fuel_prefix(fuel);
    let price = number_or_null(record.extra.get(&format!("{prefix}_prix")));
    let updated_at = timestamp_or_null(record.extra.get(&format!("{prefix}_maj")));
    let rupture_type = string_or_null(record.extra.get(&format!("{prefix}_rupture_type")));
    let rupture_start = timestamp_or_null(record.extra.get(&format!("{prefix}_rupture_debut")));

    let status = if unavailable.contains(fuel.as_str()) || rupture_type.is_some() {
        Availability::Rupture
    } else if available.contains(fuel.as_str()) || price.is_some() {
        Availability::Available
    } else {
        Availability::NotOffered
    };

    match status {
        Availability::Rupture => FuelState {
            status,
            price: None,
            updated_at,
            rupture_type,
            rupture_start,
        },
        Availability::Available => FuelState {
            status,
            price,
            updated_at,
            rupture_type: None,
            rupture_start: None,
        },
        Availability::NotOffered => FuelState {
            status,
            price: None,
            updated_at: None,
            rupture_type: None,
            rupture_start: None,
        },
    }
}

pub fn normalize_station(
    record: &RawStationRecord,
    origin: GeoPoint,
    fuels: &[FuelCode],
) -> Option<StationSnapshot> {
    let point = coordinates_of(record)?;

    let available = to_name_set(record.extra.get("carburants_disponibles"));
    let unavailable = to_name_set(record.extra.get("carburants_indisponibles"));

    let mut fuel_map = BTreeMap::new();
    for fuel in fuels {
        fuel_map.insert(*fuel, classify_fuel(*fuel, record, &available, &unavailable));
    }

    let address = string_or_null(record.adresse.as_ref()).unwrap_or_default();
    let city = string_or_null(record.ville.as_ref()).unwrap_or_default();
    let name = {
        let parts: Vec<&str> = [address.as_str(), city.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect();
        if parts.is_empty() {
            format!("Station {}", record.id)
        } else {
            parts.join(", ")
        }
    };

    Some(StationSnapshot {
        station_id: record.id,
        name,
        address,
        city,
        latitude: point.latitude,
        longitude: point.longitude,
        distance_km: haversine_km(origin, point),
        fuels: fuel_map,
    })
}

pub fn normalize_stations(
    records: &[RawStationRecord],
    origin: GeoPoint,
    fuels: &[FuelCode],
) -> Vec<StationSnapshot> {
    records
        .iter()
        .filter_map(|record| normalize_station(record, origin, fuels))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fuels() -> Vec<FuelCode> {
        FuelCode::ALL.to_vec()
    }

    fn origin() -> GeoPoint {
        GeoPoint {
            latitude: 48.8566,
            longitude: 2.3522,
        }
    }

    fn record(value: Value) -> RawStationRecord {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn classifies_available_rupture_and_not_offered() {
        let raw = record(json!({
            "id": 89100001,
            "geom": { "lon": 3.309, "lat": 48.183 },
            "adresse": "84 ROUTE DE MAILLOT",
            "ville": "Sens",
            "gazole_prix": 2.469,
            "gazole_maj": "2026-09-18T09:07:28+00:00",
            "gazole_rupture_type": null,
            "sp95_prix": null,
            "sp95_rupture_type": "definitive",
            "sp95_rupture_debut": "2022-11-26T09:30:22+00:00",
            "carburants_disponibles": ["Gazole", "E85", "E10", "SP98"],
            "carburants_indisponibles": ["SP95", "GPLc"]
        }));

        let station = normalize_station(&raw, origin(), &fuels()).unwrap();
        assert_eq!(station.fuels[&FuelCode::Gazole].status, Availability::Available);
        assert_eq!(station.fuels[&FuelCode::Gazole].price, Some(2.469));
        assert_eq!(station.fuels[&FuelCode::Sp95].status, Availability::Rupture);
        assert_eq!(
            station.fuels[&FuelCode::Sp95].rupture_type.as_deref(),
            Some("definitive")
        );
        assert_eq!(station.fuels[&FuelCode::Gplc].status, Availability::Rupture);
        assert_eq!(station.fuels[&FuelCode::E10].status, Availability::Available);
        assert_eq!(station.fuels[&FuelCode::E10].price, None);
    }

    #[test]
    fn treats_a_fuel_with_no_price_and_no_rupture_as_not_offered() {
        let raw = record(json!({
            "id": 1,
            "geom": { "lon": 2.35, "lat": 48.85 },
            "adresse": "A",
            "ville": "B",
            "carburants_disponibles": null,
            "carburants_indisponibles": null
        }));
        let station = normalize_station(&raw, origin(), &fuels()).unwrap();
        assert_eq!(station.fuels[&FuelCode::Sp98].status, Availability::NotOffered);
        assert_eq!(station.fuels[&FuelCode::Sp98].price, None);
    }

    #[test]
    fn falls_back_to_scaled_integer_coordinates() {
        let raw = record(json!({
            "id": 2,
            "latitude": "4818300",
            "longitude": "330900",
            "adresse": "A",
            "ville": "B"
        }));
        let station = normalize_station(&raw, origin(), &fuels()).unwrap();
        assert_eq!(station.latitude, 48.183);
        assert_eq!(station.longitude, 3.309);
    }

    #[test]
    fn computes_a_plausible_distance_from_the_origin() {
        let raw = record(json!({ "id": 3, "geom": { "lon": 2.3522, "lat": 48.8566 } }));
        let station = normalize_station(&raw, origin(), &fuels()).unwrap();
        assert_eq!(station.distance_km, 0.0);
    }

    #[test]
    fn parses_semicolon_delimited_fuel_lists() {
        let raw = record(json!({
            "id": 4,
            "geom": { "lon": 2.35, "lat": 48.85 },
            "carburants_disponibles": "Gazole;E10",
            "carburants_indisponibles": "SP95",
            "sp95_rupture_type": "temporaire"
        }));
        let station = normalize_station(&raw, origin(), &fuels()).unwrap();
        assert_eq!(station.fuels[&FuelCode::Gazole].status, Availability::Available);
        assert_eq!(station.fuels[&FuelCode::E10].status, Availability::Available);
        assert_eq!(station.fuels[&FuelCode::Sp95].status, Availability::Rupture);
        assert_eq!(
            station.fuels[&FuelCode::Sp95].rupture_type.as_deref(),
            Some("temporaire")
        );
    }

    #[test]
    fn reinterprets_french_local_timestamps_labelled_as_utc() {
        assert_eq!(
            normalize_french_timestamp("2026-09-18T18:49:25+00:00").as_deref(),
            Some("2026-09-18T16:49:25.000Z")
        );
        assert_eq!(
            normalize_french_timestamp("2026-01-15T08:30:00+00:00").as_deref(),
            Some("2026-01-15T07:30:00.000Z")
        );
        assert_eq!(
            normalize_french_timestamp("2026-09-18 18:49:25").as_deref(),
            Some("2026-09-18T16:49:25.000Z")
        );
        assert_eq!(normalize_french_timestamp("not a date"), None);
    }
}
