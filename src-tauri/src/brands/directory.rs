use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use crate::domain::geo::{haversine_km, GeoPoint};

pub const EMPTY_UPDATED_AT: &str = "1970-01-01T00:00:00.000Z";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandDirectory {
    pub updated_at: String,
    pub brands: BTreeMap<String, Vec<i64>>,
}

pub fn empty_brand_directory() -> BrandDirectory {
    BrandDirectory {
        updated_at: EMPTY_UPDATED_AT.to_string(),
        brands: BTreeMap::new(),
    }
}

#[derive(Debug, Clone)]
pub struct ObservedBrand {
    pub brand: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone)]
pub struct GeoStation {
    pub station_id: i64,
    pub latitude: f64,
    pub longitude: f64,
}

pub fn merge_brand_directories(
    base: &BrandDirectory,
    incoming: &BrandDirectory,
) -> BrandDirectory {
    let mut brands: BTreeMap<String, Vec<i64>> = base.brands.clone();
    for (brand, ids) in &incoming.brands {
        let merged = brands.entry(brand.clone()).or_default();
        for id in ids {
            if !merged.contains(id) {
                merged.push(*id);
            }
        }
        merged.sort_unstable();
    }
    BrandDirectory {
        updated_at: incoming.updated_at.clone(),
        brands,
    }
}

pub fn match_brands(
    observed: &[ObservedBrand],
    stations: &[GeoStation],
    threshold_km: f64,
) -> BTreeMap<String, Vec<i64>> {
    let mut by_brand: BTreeMap<String, BTreeSet<i64>> = BTreeMap::new();

    for item in observed {
        let brand = item.brand.trim();
        if brand.is_empty() {
            continue;
        }

        let point = GeoPoint {
            latitude: item.latitude,
            longitude: item.longitude,
        };
        let mut nearest: Option<(i64, f64)> = None;
        for station in stations {
            let distance_km = haversine_km(
                point,
                GeoPoint {
                    latitude: station.latitude,
                    longitude: station.longitude,
                },
            );
            if distance_km > threshold_km {
                continue;
            }
            if nearest.is_none() || distance_km < nearest.unwrap().1 {
                nearest = Some((station.station_id, distance_km));
            }
        }
        if let Some((id, _)) = nearest {
            by_brand.entry(brand.to_string()).or_default().insert(id);
        }
    }

    by_brand
        .into_iter()
        .map(|(brand, ids)| (brand, ids.into_iter().collect()))
        .collect()
}

pub fn build_brand_index(directory: &BrandDirectory) -> BTreeMap<i64, BTreeSet<String>> {
    let mut index: BTreeMap<i64, BTreeSet<String>> = BTreeMap::new();
    for (brand, ids) in &directory.brands {
        for id in ids {
            index.entry(*id).or_default().insert(brand.clone());
        }
    }
    index
}

pub fn station_matches_brands(
    index: &BTreeMap<i64, BTreeSet<String>>,
    station_id: i64,
    selected: &[String],
) -> bool {
    if selected.is_empty() {
        return true;
    }
    match index.get(&station_id) {
        Some(brands) => selected.iter().any(|brand| brands.contains(brand)),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(updated_at: &str, brands: Vec<(&str, Vec<i64>)>) -> BrandDirectory {
        BrandDirectory {
            updated_at: updated_at.to_string(),
            brands: brands
                .into_iter()
                .map(|(brand, ids)| (brand.to_string(), ids))
                .collect(),
        }
    }

    #[test]
    fn merge_unions_ids_per_brand_and_keeps_incoming_updated_at() {
        let base = directory(
            "2026-01-01T00:00:00Z",
            vec![("Total", vec![1, 2]), ("Esso", vec![5])],
        );
        let incoming = directory(
            "2026-01-02T00:00:00Z",
            vec![("Total", vec![2, 3]), ("Shell", vec![9])],
        );
        let merged = merge_brand_directories(&base, &incoming);
        assert_eq!(merged.updated_at, "2026-01-02T00:00:00Z");
        assert_eq!(merged.brands["Total"], vec![1, 2, 3]);
        assert_eq!(merged.brands["Esso"], vec![5]);
        assert_eq!(merged.brands["Shell"], vec![9]);
    }

    #[test]
    fn match_brands_keeps_the_nearest_station_within_the_threshold() {
        let observed = vec![
            ObservedBrand {
                brand: "TotalEnergies".to_string(),
                latitude: 48.58,
                longitude: 7.68,
            },
            ObservedBrand {
                brand: "Esso".to_string(),
                latitude: 48.7,
                longitude: 7.9,
            },
        ];
        let stations = vec![
            GeoStation {
                station_id: 10,
                latitude: 48.5801,
                longitude: 7.6801,
            },
            GeoStation {
                station_id: 11,
                latitude: 48.5802,
                longitude: 7.6802,
            },
        ];
        let brands = match_brands(&observed, &stations, 0.15);
        assert_eq!(brands["TotalEnergies"], vec![10]);
        assert_eq!(brands.get("Esso"), None);
    }

    #[test]
    fn match_brands_ignores_stations_farther_than_the_threshold() {
        let observed = vec![ObservedBrand {
            brand: "Shell".to_string(),
            latitude: 48.58,
            longitude: 7.68,
        }];
        let stations = vec![GeoStation {
            station_id: 42,
            latitude: 49.0,
            longitude: 8.0,
        }];
        assert!(match_brands(&observed, &stations, 0.15).is_empty());
    }

    #[test]
    fn brand_index_filters_stations_by_selected_brands() {
        let dir = directory(
            "2026-01-01T00:00:00Z",
            vec![("Total", vec![1]), ("Esso", vec![2])],
        );
        let index = build_brand_index(&dir);
        assert!(station_matches_brands(&index, 1, &["Total".to_string()]));
        assert!(!station_matches_brands(&index, 1, &["Esso".to_string()]));
        assert!(!station_matches_brands(&index, 3, &["Total".to_string()]));
        assert!(station_matches_brands(&index, 9, &[]));
    }
}
