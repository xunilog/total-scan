use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, thiserror::Error)]
pub enum HttpError {
    #[error("circuit breaker is open")]
    CircuitOpen,
    #[error("upstream responded {0}")]
    Upstream(u16),
    #[error("request failed: {0}")]
    Request(#[from] reqwest::Error),
}

pub struct CircuitBreaker {
    threshold: u32,
    cooldown_ms: i64,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    failures: u32,
    opened_at: Option<i64>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

impl CircuitBreaker {
    pub fn new(threshold: u32, cooldown_ms: i64) -> Self {
        CircuitBreaker {
            threshold,
            cooldown_ms,
            inner: Mutex::new(Inner::default()),
        }
    }

    pub fn is_open(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let opened_at = match inner.opened_at {
            Some(opened_at) => opened_at,
            None => return false,
        };
        if now_ms() - opened_at >= self.cooldown_ms {
            inner.opened_at = None;
            inner.failures = 0;
            return false;
        }
        true
    }

    pub fn record_success(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.failures = 0;
        inner.opened_at = None;
    }

    pub fn record_failure(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.failures += 1;
        if inner.failures >= self.threshold {
            inner.opened_at = Some(now_ms());
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

pub const DEFAULT_RETRY: RetryPolicy = RetryPolicy {
    max_attempts: 3,
    base_delay_ms: 500,
    max_delay_ms: 8000,
};

/// Upper bound for a server-provided `Retry-After` wait, so a bad or hostile
/// header cannot stall a poll indefinitely.
const MAX_RETRY_WAIT_MS: u64 = 60_000;

fn jitter_ms(base_delay_ms: u64) -> u64 {
    if base_delay_ms == 0 {
        return 0;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as u64)
        .unwrap_or(0);
    nanos % base_delay_ms
}

/// The wait requested by a `Retry-After` response header, in milliseconds.
pub fn retry_after_ms(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after)
}

/// Parse a `Retry-After` value: either a number of seconds or an HTTP-date
/// (RFC 2822 / IMF-fixdate). A date in the past yields `Some(0)`.
pub fn parse_retry_after(value: &str) -> Option<u64> {
    let text = value.trim();
    if let Ok(seconds) = text.parse::<u64>() {
        return Some(seconds.saturating_mul(1000));
    }
    let date = chrono::DateTime::parse_from_rfc2822(text).ok()?;
    let wait = date.with_timezone(&chrono::Utc) - chrono::Utc::now();
    Some(wait.num_milliseconds().max(0) as u64)
}

pub async fn fetch_with_retry<F>(
    build: F,
    policy: RetryPolicy,
) -> Result<reqwest::Response, HttpError>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let mut last_error: Option<HttpError> = None;
    for attempt in 1..=policy.max_attempts {
        let retry_after = match build().send().await {
            Ok(response) => {
                let status = response.status();
                if !(status.is_server_error() || status.as_u16() == 429) {
                    return Ok(response);
                }
                last_error = Some(HttpError::Upstream(status.as_u16()));
                retry_after_ms(&response)
            }
            Err(error) => {
                last_error = Some(HttpError::Request(error));
                None
            }
        };
        if attempt == policy.max_attempts {
            break;
        }
        let backoff = policy
            .max_delay_ms
            .min(policy.base_delay_ms.saturating_mul(1u64 << (attempt - 1)));
        let delay = match retry_after {
            Some(wait) => wait.min(MAX_RETRY_WAIT_MS),
            None => backoff + jitter_ms(policy.base_delay_ms),
        };
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    Err(last_error.unwrap_or(HttpError::Upstream(0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breaker_opens_after_threshold_failures() {
        let breaker = CircuitBreaker::new(2, 60_000);
        assert!(!breaker.is_open());
        breaker.record_failure();
        assert!(!breaker.is_open());
        breaker.record_failure();
        assert!(breaker.is_open());
        breaker.record_success();
        assert!(!breaker.is_open());
    }

    #[test]
    fn breaker_closes_after_cooldown() {
        let breaker = CircuitBreaker::new(1, 0);
        breaker.record_failure();
        assert!(!breaker.is_open());
    }

    #[test]
    fn parses_retry_after_seconds() {
        assert_eq!(parse_retry_after("120"), Some(120_000));
        assert_eq!(parse_retry_after("  5 "), Some(5_000));
        assert_eq!(parse_retry_after("0"), Some(0));
    }

    #[test]
    fn parses_retry_after_http_date_in_the_past_as_zero() {
        assert_eq!(parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT"), Some(0));
    }

    #[test]
    fn rejects_invalid_retry_after() {
        assert_eq!(parse_retry_after("not-a-date"), None);
        assert_eq!(parse_retry_after(""), None);
    }
}
