use super::model::{Availability, FuelCode, StationSnapshot};

pub fn offers_fuel(station: &StationSnapshot, fuels: &[FuelCode]) -> bool {
    if fuels.is_empty() {
        return true;
    }
    fuels.iter().any(|fuel| {
        station
            .fuels
            .get(fuel)
            .map(|state| state.status != Availability::NotOffered)
            .unwrap_or(false)
    })
}

pub fn has_available_fuel(station: &StationSnapshot, fuels: &[FuelCode]) -> bool {
    if fuels.is_empty() {
        return station
            .fuels
            .values()
            .any(|state| state.status == Availability::Available);
    }
    fuels.iter().any(|fuel| {
        station
            .fuels
            .get(fuel)
            .map(|state| state.status == Availability::Available)
            .unwrap_or(false)
    })
}

pub fn filter_stations(
    stations: &[StationSnapshot],
    selected_fuels: &[FuelCode],
    only_available: bool,
) -> Vec<StationSnapshot> {
    stations
        .iter()
        .filter(|station| {
            if only_available {
                has_available_fuel(station, selected_fuels)
            } else {
                offers_fuel(station, selected_fuels)
            }
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::{FuelState, StationSnapshot};
    use std::collections::BTreeMap;

    fn state(status: Availability, price: Option<f64>) -> FuelState {
        FuelState {
            status,
            price,
            updated_at: None,
            rupture_type: None,
            rupture_start: None,
        }
    }

    fn station(id: i64, fuels: Vec<(FuelCode, FuelState)>) -> StationSnapshot {
        StationSnapshot {
            station_id: id,
            name: format!("Station {id}"),
            address: "A".to_string(),
            city: "B".to_string(),
            latitude: 0.0,
            longitude: 0.0,
            distance_km: 1.0,
            fuels: fuels.into_iter().collect::<BTreeMap<_, _>>(),
        }
    }

    fn fixtures() -> (StationSnapshot, StationSnapshot, StationSnapshot) {
        let a = station(
            1,
            vec![
                (FuelCode::Gazole, state(Availability::Available, Some(2.0))),
                (FuelCode::E10, state(Availability::Rupture, None)),
            ],
        );
        let b = station(2, vec![(FuelCode::Sp98, state(Availability::Rupture, None))]);
        let c = station(3, vec![(FuelCode::E85, state(Availability::NotOffered, None))]);
        (a, b, c)
    }

    #[test]
    fn offers_fuel_with_no_selection_is_always_true() {
        let (a, _, _) = fixtures();
        assert!(offers_fuel(&a, &[]));
    }

    #[test]
    fn offers_fuel_matches_available_or_rupture_not_not_offered() {
        let (a, _, c) = fixtures();
        assert!(offers_fuel(&a, &[FuelCode::Gazole]));
        assert!(offers_fuel(&a, &[FuelCode::E10]));
        assert!(!offers_fuel(&c, &[FuelCode::E85]));
        assert!(!offers_fuel(&a, &[FuelCode::Gplc]));
    }

    #[test]
    fn has_available_fuel_with_no_selection_checks_any_fuel() {
        let (a, b, _) = fixtures();
        assert!(has_available_fuel(&a, &[]));
        assert!(!has_available_fuel(&b, &[]));
    }

    #[test]
    fn has_available_fuel_respects_selected_fuels() {
        let (a, _, _) = fixtures();
        assert!(has_available_fuel(&a, &[FuelCode::Gazole]));
        assert!(!has_available_fuel(&a, &[FuelCode::E10]));
    }

    #[test]
    fn filter_stations_narrows_by_selection_and_availability() {
        let (a, b, c) = fixtures();
        let all = vec![a, b, c];
        assert_eq!(filter_stations(&all, &[], false).len(), 3);
        assert_eq!(
            filter_stations(&all, &[], true)
                .iter()
                .map(|s| s.station_id)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(
            filter_stations(&all, &[FuelCode::E10], false)
                .iter()
                .map(|s| s.station_id)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(filter_stations(&all, &[FuelCode::E10], true).len(), 0);
    }
}
