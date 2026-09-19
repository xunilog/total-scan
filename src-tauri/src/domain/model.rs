use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FuelCode {
    Gazole,
    Sp95,
    E10,
    Sp98,
    E85,
    Gplc,
}

impl FuelCode {
    pub const ALL: [FuelCode; 6] = [
        FuelCode::Gazole,
        FuelCode::Sp95,
        FuelCode::E10,
        FuelCode::Sp98,
        FuelCode::E85,
        FuelCode::Gplc,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            FuelCode::Gazole => "Gazole",
            FuelCode::Sp95 => "SP95",
            FuelCode::E10 => "E10",
            FuelCode::Sp98 => "SP98",
            FuelCode::E85 => "E85",
            FuelCode::Gplc => "GPLc",
        }
    }

    pub fn parse(value: &str) -> Option<FuelCode> {
        match value {
            "Gazole" => Some(FuelCode::Gazole),
            "SP95" => Some(FuelCode::Sp95),
            "E10" => Some(FuelCode::E10),
            "SP98" => Some(FuelCode::Sp98),
            "E85" => Some(FuelCode::E85),
            "GPLc" => Some(FuelCode::Gplc),
            _ => None,
        }
    }
}

impl Serialize for FuelCode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for FuelCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        FuelCode::parse(&value)
            .ok_or_else(|| de::Error::custom(format!("unknown fuel code: {value}")))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    Rupture,
    NotOffered,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuelState {
    pub status: Availability,
    pub price: Option<f64>,
    pub updated_at: Option<String>,
    pub rupture_type: Option<String>,
    pub rupture_start: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StationSnapshot {
    pub station_id: i64,
    pub name: String,
    pub address: String,
    pub city: String,
    pub latitude: f64,
    pub longitude: f64,
    pub distance_km: f64,
    pub fuels: BTreeMap<FuelCode, FuelState>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub station_id: i64,
    pub station_name: String,
    pub city: String,
    pub distance_km: f64,
    pub fuel: FuelCode,
    pub price: f64,
    pub updated_at: Option<String>,
    pub detected_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuelTrackerState {
    pub status: Availability,
    pub candidate: Availability,
    pub confirmations: u32,
    pub price: Option<f64>,
    pub updated_at: Option<String>,
    pub rupture_type: Option<String>,
    pub rupture_start: Option<String>,
    pub last_notified_at: Option<String>,
}

pub fn tracker_key(station_id: i64, fuel: FuelCode) -> String {
    format!("{}:{}", station_id, fuel.as_str())
}

pub fn initial_tracker_state() -> FuelTrackerState {
    FuelTrackerState {
        status: Availability::NotOffered,
        candidate: Availability::NotOffered,
        confirmations: 0,
        price: None,
        updated_at: None,
        rupture_type: None,
        rupture_start: None,
        last_notified_at: None,
    }
}
