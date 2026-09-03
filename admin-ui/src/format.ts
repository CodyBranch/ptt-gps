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
