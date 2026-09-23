/**
 * How a race is labelled wherever it is listed.
 *
 * The programme number goes in front where the meet uses one, because that is
 * what a schedule, an announcer and a results system all call it. The name
 * alone is not enough to pick a race out of a track or cross-country meet,
 * where several are called "5000m".
 */
export function raceLabel(race: { name: string; eventNumber?: number | null }): string {
  return race.eventNumber === null || race.eventNumber === undefined
    ? race.name
    : `${race.eventNumber}. ${race.name}`;
}

/**
 * Characters a device id may contain, and whether a given one is usable.
 *
 * Mirrors DEVICE_ID in `server/src/config/schema.ts`, which is the rule that
 * actually decides: a tracker IMEI is exactly fifteen digits, and anything
 * else has to carry a letter. That second branch is for the in-vehicle
 * routers, whose ids are short serials like "16CD" - and the letter is what
 * keeps a fourteen-digit IMEI from being waved through as one.
 */
export const DEVICE_ID_CHARS = /[^A-Za-z0-9._-]/g;

export function isDeviceId(id: string): boolean {
  return /^\d{15}$/.test(id) || (/[A-Za-z]/.test(id) && /^[A-Za-z0-9._-]{2,24}$/.test(id));
}
