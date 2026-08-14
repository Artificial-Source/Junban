//! Process-wide maintenance barrier and recovery-mode gate.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

/// Process-wide maintenance state.
///
/// Coordinates restore/cutover so normal API traffic stops admitting, drains,
/// and either resumes only after restart or serves a narrow recovery surface.
pub struct MaintenanceGate {
    /// When true, new normal API requests are rejected.
    maintenance_active: AtomicBool,
    /// When true, the process needs a restart after a successful restore.
    restart_required: AtomicBool,
    /// When true, only health + recovery routes are available.
    recovery_mode: AtomicBool,
    /// Count of currently admitted normal requests.
    admitted: AtomicUsize,
}

impl MaintenanceGate {
    /// Create a shared gate in the normal (open) state.
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            maintenance_active: AtomicBool::new(false),
            restart_required: AtomicBool::new(false),
            recovery_mode: AtomicBool::new(false),
            admitted: AtomicUsize::new(0),
        })
    }

    /// True if normal requests are currently allowed.
    #[must_use]
    pub fn is_normal(&self) -> bool {
        !self.maintenance_active.load(Ordering::Acquire)
            && !self.restart_required.load(Ordering::Acquire)
            && !self.recovery_mode.load(Ordering::Acquire)
    }

    /// True while the restore/maintenance barrier holds.
    #[must_use]
    pub fn maintenance_active(&self) -> bool {
        self.maintenance_active.load(Ordering::Acquire)
    }

    /// True after a successful restore that requires process restart.
    #[must_use]
    pub fn restart_required(&self) -> bool {
        self.restart_required.load(Ordering::Acquire)
    }

    /// True when only health and recovery endpoints may be served.
    #[must_use]
    pub fn recovery_mode(&self) -> bool {
        self.recovery_mode.load(Ordering::Acquire)
    }

    /// Snapshot of currently admitted normal requests.
    #[must_use]
    pub fn admitted_requests(&self) -> usize {
        self.admitted.load(Ordering::Acquire)
    }

    /// Enter maintenance mode. Returns true if this call won the race.
    ///
    /// Sets `maintenance_active` and stops new admission.
    pub fn enter_maintenance(&self) -> bool {
        self.maintenance_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// Leave maintenance mode after a failed pre-cutover restore attempt.
    ///
    /// No-op once restart is required so a successful restore cannot reopen traffic.
    pub fn leave_maintenance(&self) {
        if self.restart_required.load(Ordering::Acquire) {
            return;
        }
        self.maintenance_active.store(false, Ordering::Release);
    }

    /// After successful restore, mark restart required.
    pub fn mark_restart_required(&self) {
        self.restart_required.store(true, Ordering::Release);
    }

    /// Enter recovery mode (only health + recovery endpoints).
    pub fn enter_recovery(&self) {
        self.recovery_mode.store(true, Ordering::Release);
    }

    /// Try to admit one normal request. Returns true if admitted.
    pub fn try_admit(&self) -> bool {
        if !self.is_normal() {
            return false;
        }
        self.admitted.fetch_add(1, Ordering::AcqRel);
        // Lose the race cleanly if maintenance flipped between the check and the increment.
        if self.is_normal() {
            true
        } else {
            self.admitted.fetch_sub(1, Ordering::AcqRel);
            false
        }
    }

    /// Release an admitted request count.
    pub fn release(&self) {
        // Saturating sub keeps a mismatched release from wrapping the counter.
        let _ = self
            .admitted
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                count.checked_sub(1)
            });
    }

    /// Wait for all admitted requests to drain, up to `deadline`.
    ///
    /// Returns true if all drained before the deadline elapsed.
    pub async fn drain(&self, deadline: Duration) -> bool {
        let start = tokio::time::Instant::now();
        loop {
            if self.admitted.load(Ordering::Acquire) == 0 {
                return true;
            }
            if start.elapsed() >= deadline {
                return self.admitted.load(Ordering::Acquire) == 0;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enter_maintenance_is_single_winner() {
        let gate = MaintenanceGate::new();
        assert!(gate.is_normal());
        assert!(gate.enter_maintenance());
        assert!(!gate.enter_maintenance());
        assert!(gate.maintenance_active());
        assert!(!gate.is_normal());
    }

    #[test]
    fn try_admit_rejects_during_maintenance_and_tracks_count() {
        let gate = MaintenanceGate::new();
        assert!(gate.try_admit());
        assert_eq!(gate.admitted_requests(), 1);
        assert!(gate.enter_maintenance());
        assert!(!gate.try_admit());
        gate.release();
        assert_eq!(gate.admitted_requests(), 0);
    }

    #[tokio::test]
    async fn drain_waits_for_release() {
        let gate = MaintenanceGate::new();
        assert!(gate.try_admit());
        let drain = tokio::spawn({
            let gate = Arc::clone(&gate);
            async move { gate.drain(Duration::from_secs(1)).await }
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        gate.release();
        assert!(drain.await.unwrap());
    }
}
