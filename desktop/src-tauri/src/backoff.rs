//! Restart policy for a sidecar that dies after having been healthy.
//!
//! Bounded and increasing on purpose: a server that cannot stay up must surface
//! its logs to the user, not restart in a tight loop against the same broken
//! data directory.

use std::time::Duration;

/// Delay before each restart attempt. Length is also the attempt budget.
pub const RESTART_DELAYS: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(15),
];

/// Total number of restarts the shell will attempt.
pub const MAX_RESTARTS: usize = RESTART_DELAYS.len();

/// Delay before restart attempt `attempt` (0-based), or `None` once the budget
/// is spent - the caller then shows the captured sidecar log instead.
pub fn restart_delay(attempt: usize) -> Option<Duration> {
    RESTART_DELAYS.get(attempt).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_increase_and_then_stop() {
        assert_eq!(restart_delay(0), Some(Duration::from_secs(1)));
        assert_eq!(restart_delay(1), Some(Duration::from_secs(5)));
        assert_eq!(restart_delay(2), Some(Duration::from_secs(15)));
        assert_eq!(restart_delay(MAX_RESTARTS), None);
        assert_eq!(restart_delay(99), None);
    }

    #[test]
    fn the_budget_is_finite_and_strictly_increasing() {
        assert_eq!(MAX_RESTARTS, 3);
        for window in RESTART_DELAYS.windows(2) {
            assert!(window[1] > window[0], "delays must grow: {window:?}");
        }
    }
}
