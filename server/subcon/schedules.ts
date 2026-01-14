/**
 * Subconscious Schedules Configuration
 * 
 * Defines all subconscious pack schedules.
 * SUP-11: Simple scheduler (hourly/daily stub)
 * 
 * To add a new scheduled pack:
 * 1. Add the pack in server/subcon/packs/
 * 2. Register it in server/subcon/packs/index.ts
 * 3. Add its schedule ID to SubconScheduleId type in scheduler-types.ts
 * 4. Add a schedule entry below
 */

import type { SubconSchedule } from './scheduler-types';

/**
 * All defined subconscious schedules.
 * 
 * The scheduler reads from this list on each tick to determine
 * which packs need to run.
 */
export const SUBCON_SCHEDULES: SubconSchedule[] = [
  {
    id: 'stale_leads_hourly',
    packId: 'stale_leads',
    frequency: 'hourly',
    enabled: true,
    description: 'Check for stale leads that need follow-up nudges',
  },
  // Add more schedules here as packs are created:
  // {
  //   id: 'inactive_accounts_daily',
  //   packId: 'inactive_accounts',
  //   frequency: 'daily',
  //   enabled: true,
  //   description: 'Check for accounts with no recent activity',
  // },
];

/**
 * Get a schedule by ID.
 */
export function getScheduleById(id: string): SubconSchedule | undefined {
  return SUBCON_SCHEDULES.find(s => s.id === id);
}

/**
 * Get all enabled schedules.
 */
export function getEnabledSchedules(): SubconSchedule[] {
  return SUBCON_SCHEDULES.filter(s => s.enabled);
}

