use tracing::{error, info, warn};

use crate::ports::Logger;

pub struct ConsoleLogger;

impl Logger for ConsoleLogger {
    fn info(&self, message: &str) {
        info!(target: "scan_carburant", "{message}");
    }

    fn warn(&self, message: &str) {
        warn!(target: "scan_carburant", "{message}");
    }

    fn error(&self, message: &str) {
        error!(target: "scan_carburant", "{message}");
    }
}
