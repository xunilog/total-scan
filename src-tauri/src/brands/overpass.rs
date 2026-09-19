use std::collections::HashMap;
use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

use crate::domain::geo::GeoPoint;
use crate::domain::model::FuelCode;
use crate::http::{retry_after_ms, HttpError};
use crate::ingest::normalizer::normalize_stations;
use crate::ports::StationFeed;

use super::directory::{
    match_brands, merge_brand_directories, BrandDirectory, GeoStation, ObservedBrand,
};

/// Public Overpass API instances with global data coverage, tried in order.
/// See <https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances>.
const OVERPASS_ENDPOINTS: [&str; 3] = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const MATCH_THRESHOLD_KM: f64 = 0.15;
const OVERPASS_TIMEOUT_MS: u64 = 30_000;
const OVERPASS_MAX_ROUNDS: u32 = 2;
const OVERPASS_MAX_RETRY_WAIT_MS: u64 = 60_000;
const OVERPASS_BASE_BACKOFF_MS: u64 = 1_000;

#[derive(Debug, Deserialize)]
struct OverpassElement {
    #[serde(default)]
    lat: Option<f64>,
    #[serde(default)]
    lon: Option<f64>,
    #[serde(default)]
    tags: HashMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
struct OverpassResponse {
    #[serde(default)]
    elements: Vec<OverpassElement>,
}

pub struct BrandRefreshParams<'a, F: StationFeed> {
    pub origin: GeoPoint,
    pub radius_km: f64,
    pub feed: &'a F,
}

pub struct BrandRefreshResult {
    pub directory: BrandDirectory,
    pub osm_stations: usize,
    pub matched_stations: usize,
}

struct EndpointFailure {
    error: HttpError,
    retryable: bool,
    retry_after_ms: Option<u64>,
}

fn is_retryable(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn backoff_ms(round: u32) -> u64 {
    OVERPASS_BASE_BACKOFF_MS.saturating_mul(1u64 << round.saturating_sub(1).min(4))
}

fn earliest_retry_after(current: Option<u64>, candidate: Option<u64>) -> Option<u64> {
    match (current, candidate) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, candidate) => candidate,
    }
}

/// A single request to one endpoint; the caller handles failover and waiting.
async fn fetch_from_endpoint(
    client: &Client,
    endpoint: &str,
    query: &str,
) -> Result<OverpassResponse, EndpointFailure> {
    let response = client
        .post(endpoint)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .form(&[("data", query)])
        .timeout(Duration::from_millis(OVERPASS_TIMEOUT_MS))
        .send()
        .await;

    match response {
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                return response
                    .json::<OverpassResponse>()
                    .await
                    .map_err(|error| EndpointFailure {
                        error: HttpError::Request(error),
                        retryable: true,
                        retry_after_ms: None,
                    });
            }
            Err(EndpointFailure {
                error: HttpError::Upstream(status.as_u16()),
                retryable: is_retryable(status),
                retry_after_ms: retry_after_ms(&response),
            })
        }
        Err(error) => Err(EndpointFailure {
            error: HttpError::Request(error),
            retryable: true,
            retry_after_ms: None,
        }),
    }
}

fn observed_brands(body: OverpassResponse) -> Vec<ObservedBrand> {
    body.elements
        .into_iter()
        .map(|element| ObservedBrand {
            brand: element.tags.get("brand").cloned().unwrap_or_default(),
            latitude: element.lat.unwrap_or(f64::NAN),
            longitude: element.lon.unwrap_or(f64::NAN),
        })
        .filter(|item| {
            !item.brand.trim().is_empty()
                && item.latitude.is_finite()
                && item.longitude.is_finite()
        })
        .collect()
}

pub async fn fetch_observed_brands(
    client: &Client,
    origin: GeoPoint,
    radius_km: f64,
) -> Result<Vec<ObservedBrand>, HttpError> {
    let radius_meters = (radius_km * 1000.0).round() as i64;
    let query = format!(
        "[out:json][timeout:25];node[\"amenity\"=\"fuel\"][\"brand\"](around:{radius_meters},{},{});out body;",
        origin.latitude, origin.longitude
    );

    let mut last_error: Option<HttpError> = None;

    for round in 1..=OVERPASS_MAX_ROUNDS {
        let mut retry_after: Option<u64> = None;

        // Try every endpoint before waiting on any single one, so a rate limit
        // on one instance does not stall a healthy one.
        for endpoint in OVERPASS_ENDPOINTS {
            match fetch_from_endpoint(client, endpoint, &query).await {
                Ok(body) => return Ok(observed_brands(body)),
                Err(failure) => {
                    if failure.retryable {
                        retry_after = earliest_retry_after(retry_after, failure.retry_after_ms);
                    }
                    tracing::warn!(
                        target: "scan_carburant",
                        endpoint,
                        error = %failure.error,
                        "overpass endpoint failed"
                    );
                    last_error = Some(failure.error);
                }
            }
        }

        if round == OVERPASS_MAX_ROUNDS {
            break;
        }
        let wait = retry_after
            .unwrap_or_else(|| backoff_ms(round))
            .min(OVERPASS_MAX_RETRY_WAIT_MS);
        tracing::warn!(
            target: "scan_carburant",
            wait_ms = wait,
            "all overpass endpoints failed, retrying"
        );
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }

    Err(last_error.unwrap_or(HttpError::Upstream(0)))
}

pub async fn refresh_brand_directory<F: StationFeed>(
    client: &Client,
    params: BrandRefreshParams<'_, F>,
    existing: &BrandDirectory,
) -> Result<BrandRefreshResult, HttpError> {
    let (observed, records) = tokio::join!(
        fetch_observed_brands(client, params.origin, params.radius_km),
        params.feed.fetch_records(crate::ports::FeedQuery {
            origin: params.origin,
            radius_km: params.radius_km,
        })
    );
    let observed = observed?;
    let records = records?;

    let stations: Vec<GeoStation> = normalize_stations(&records, params.origin, &FuelCode::ALL)
        .into_iter()
        .map(|station| GeoStation {
            station_id: station.station_id,
            latitude: station.latitude,
            longitude: station.longitude,
        })
        .collect();

    let brands = match_brands(&observed, &stations, MATCH_THRESHOLD_KM);
    let matched_stations = brands
        .values()
        .flat_map(|ids| ids.iter())
        .collect::<std::collections::BTreeSet<_>>()
        .len();

    let incoming = BrandDirectory {
        updated_at: now_iso(),
        brands,
    };
    let directory = merge_brand_directories(existing, &incoming);

    Ok(BrandRefreshResult {
        directory,
        osm_stations: observed.len(),
        matched_stations,
    })
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn earliest_retry_after_keeps_the_smallest_wait() {
        assert_eq!(earliest_retry_after(None, None), None);
        assert_eq!(earliest_retry_after(Some(60_000), None), Some(60_000));
        assert_eq!(earliest_retry_after(None, Some(5_000)), Some(5_000));
        assert_eq!(
            earliest_retry_after(Some(60_000), Some(5_000)),
            Some(5_000)
        );
    }

    #[test]
    fn backoff_grows_and_is_bounded() {
        assert_eq!(backoff_ms(1), 1_000);
        assert_eq!(backoff_ms(2), 2_000);
        assert_eq!(backoff_ms(3), 4_000);
        assert_eq!(backoff_ms(10), 16_000);
    }
}
