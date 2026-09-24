/**
 * The "Approvals" badge refreshes itself on navigation and every 30 seconds; after an admin
 * decides something it should drop straight away, so deciding code announces it here.
 */
export const PENDING_CHANGED = "datadesk:pending-changed";

export function notifyPendingChanged() {
  window.dispatchEvent(new Event(PENDING_CHANGED));
}
