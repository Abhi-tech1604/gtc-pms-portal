import { daysBetween, today } from '../util/date.js';

/** Section 9. Every calculated figure shown anywhere in the portal comes from here. */

export type EquipmentStatus = 'Normal' | 'Upcoming' | 'Overdue' | 'Breakdown';
export type HealthStatus = 'Normal' | 'Upcoming' | 'Overdue';

export const UPCOMING_SERVICE_WINDOW = 200; // hours
export const UPCOMING_HEALTH_WINDOW = 20;   // days

export function runningSinceLastService(currentRunningHours: number, lastServiceHours: number): number {
  return Math.round(currentRunningHours - lastServiceHours);
}

export function remainingServiceHours(
  currentRunningHours: number,
  lastServiceHours: number,
  serviceInterval: number,
): number {
  return Math.round(serviceInterval - runningSinceLastService(currentRunningHours, lastServiceHours));
}

/** Spec 9.3. Breakdown takes precedence over everything else. */
export function equipmentStatus(input: {
  currentRunningHours: number;
  lastServiceHours: number;
  serviceInterval: number;
  isBreakdown?: boolean | number;
}): EquipmentStatus {
  if (input.isBreakdown) return 'Breakdown';
  const remaining = remainingServiceHours(
    input.currentRunningHours,
    input.lastServiceHours,
    input.serviceInterval,
  );
  if (remaining <= 0) return 'Overdue';
  if (remaining <= UPCOMING_SERVICE_WINDOW) return 'Upcoming';
  return 'Normal';
}

/** Spec 9.2. Null when the machine has never been checked. */
export function remainingHealthCheckDays(
  lastHealthCheckDate: string | null | undefined,
  healthCheckInterval: number,
  asOf: string = today(),
): number | null {
  if (!lastHealthCheckDate) return null;
  const days = daysBetween(lastHealthCheckDate, asOf);
  return Math.round(healthCheckInterval - days);
}

/**
 * Spec 9.4. A machine that has never had a checkup is Overdue: there is no
 * evidence it was ever inspected, and the fleet cannot treat that as Normal.
 */
export function healthStatus(
  lastHealthCheckDate: string | null | undefined,
  healthCheckInterval: number,
  asOf: string = today(),
): HealthStatus {
  const remaining = remainingHealthCheckDays(lastHealthCheckDate, healthCheckInterval, asOf);
  if (remaining === null) return 'Overdue';
  if (remaining <= 0) return 'Overdue';
  if (remaining <= UPCOMING_HEALTH_WINDOW) return 'Upcoming';
  return 'Normal';
}
