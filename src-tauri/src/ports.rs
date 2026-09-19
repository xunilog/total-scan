use crate::domain::geo::GeoPoint;
use crate::http::HttpError;
use crate::ingest::raw_record::RawStationRecord;

#[derive(Debug, Clone, Copy)]
pub struct FeedQuery {
    pub origin: GeoPoint,
    pub radius_km: f64,
}

pub trait StationFeed: Send + Sync {
    fn fetch_records(
        &self,
        query: FeedQuery,
    ) -> impl std::future::Future<Output = Result<Vec<RawStationRecord>, HttpError>> + Send;
}

pub trait Logger: Send + Sync {
    fn info(&self, message: &str);
    fn warn(&self, message: &str);
    fn error(&self, message: &str);
}

pub trait Notifier: Send + Sync {
    fn available(&self) -> bool;
    fn request_permission(&self) -> bool;
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
}
