use reqwest::Client;
use serde::Deserialize;
use url::Url;

use crate::http::{fetch_with_retry, CircuitBreaker, HttpError, RetryPolicy, DEFAULT_RETRY};
use crate::ingest::raw_record::RawStationRecord;
use crate::ports::{FeedQuery, StationFeed};

const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 200;
const FUEL_PREFIXES: [&str; 6] = ["gazole", "sp95", "e10", "sp98", "e85", "gplc"];

fn select_fields() -> String {
    let mut fields: Vec<String> = vec![
        "id".to_string(),
        "geom".to_string(),
        "latitude".to_string(),
        "longitude".to_string(),
        "adresse".to_string(),
        "ville".to_string(),
        "cp".to_string(),
        "carburants_disponibles".to_string(),
        "carburants_indisponibles".to_string(),
    ];
    for prefix in FUEL_PREFIXES {
        for suffix in ["prix", "maj", "rupture_type", "rupture_debut"] {
            fields.push(format!("{prefix}_{suffix}"));
        }
    }
    fields.join(",")
}

#[derive(Debug, Default, Deserialize)]
struct OdsPage {
    #[serde(default)]
    total_count: i64,
    #[serde(default)]
    results: Vec<RawStationRecord>,
}

#[derive(Debug, Clone)]
pub struct OdsConfig {
    pub base_url: String,
    pub dataset_id: String,
}

impl OdsConfig {
    pub fn default_config() -> Self {
        OdsConfig {
            base_url: "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets".to_string(),
            dataset_id: "prix-des-carburants-en-france-flux-instantane-v2".to_string(),
        }
    }
}

pub struct OdsFeed {
    client: Client,
    config: OdsConfig,
    breaker: CircuitBreaker,
}

impl OdsFeed {
    pub fn new(client: Client, config: OdsConfig) -> Self {
        OdsFeed {
            client,
            config,
            breaker: CircuitBreaker::new(5, 5 * 60 * 1000),
        }
    }

    async fn fetch_page(&self, url: &str) -> Result<OdsPage, HttpError> {
        if self.breaker.is_open() {
            return Err(HttpError::CircuitOpen);
        }
        let client = self.client.clone();
        let target = url.to_string();
        let result = fetch_with_retry(
            || {
                client
                    .get(target.clone())
                    .header(reqwest::header::ACCEPT, "application/json")
            },
            RetryPolicy {
                max_attempts: 4,
                ..DEFAULT_RETRY
            },
        )
        .await;

        match &result {
            Ok(_) => self.breaker.record_success(),
            Err(_) => self.breaker.record_failure(),
        }

        let response = result?;
        if !response.status().is_success() {
            return Err(HttpError::Upstream(response.status().as_u16()));
        }
        Ok(response.json::<OdsPage>().await?)
    }
}

impl StationFeed for OdsFeed {
    async fn fetch_records(&self, query: FeedQuery) -> Result<Vec<RawStationRecord>, HttpError> {
        let where_clause = format!(
            "within_distance(geom, geom'POINT({} {})', {}km)",
            query.origin.longitude, query.origin.latitude, query.radius_km
        );
        let select = select_fields();
        let mut records: Vec<RawStationRecord> = Vec::new();

        for page in 0..MAX_PAGES {
            let mut url = Url::parse(&format!(
                "{}/{}/records",
                self.config.base_url, self.config.dataset_id
            ))
            .map_err(|_| HttpError::Upstream(0))?;
            url.query_pairs_mut()
                .append_pair("where", &where_clause)
                .append_pair("select", &select)
                .append_pair("limit", &PAGE_SIZE.to_string())
                .append_pair("offset", &(page * PAGE_SIZE).to_string());

            let body = self.fetch_page(url.as_str()).await?;
            records.extend(body.results.iter().cloned());

            tracing::info!(
                target: "scan_carburant",
                page,
                received = body.results.len(),
                total = body.total_count,
                "ods page fetched"
            );

            if body.results.len() < PAGE_SIZE || records.len() as i64 >= body.total_count {
                break;
            }
        }

        Ok(records)
    }
}
