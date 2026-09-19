use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GeoPoint {
    pub latitude: f64,
    pub longitude: f64,
}

const EARTH_RADIUS_KM: f64 = 6371.0088;

fn to_radians(degrees: f64) -> f64 {
    (degrees * std::f64::consts::PI) / 180.0
}

pub fn haversine_km(a: GeoPoint, b: GeoPoint) -> f64 {
    let d_lat = to_radians(b.latitude - a.latitude);
    let d_lon = to_radians(b.longitude - a.longitude);
    let lat1 = to_radians(a.latitude);
    let lat2 = to_radians(b.latitude);
    let h = (d_lat / 2.0).sin().powi(2)
        + lat1.cos() * lat2.cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_KM * h.sqrt().min(1.0).asin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_distance_for_same_point() {
        let point = GeoPoint {
            latitude: 48.8566,
            longitude: 2.3522,
        };
        assert_eq!(haversine_km(point, point), 0.0);
    }

    #[test]
    fn paris_to_london_is_about_344_km() {
        let paris = GeoPoint {
            latitude: 48.8566,
            longitude: 2.3522,
        };
        let london = GeoPoint {
            latitude: 51.5074,
            longitude: -0.1278,
        };
        let distance = haversine_km(paris, london);
        assert!((distance - 343.5).abs() < 2.0, "got {distance}");
    }
}
