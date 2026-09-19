use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Geom {
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lon: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawStationRecord {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub geom: Option<Geom>,
    #[serde(default)]
    pub latitude: Option<Value>,
    #[serde(default)]
    pub longitude: Option<Value>,
    #[serde(default)]
    pub adresse: Option<Value>,
    #[serde(default)]
    pub ville: Option<Value>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}
