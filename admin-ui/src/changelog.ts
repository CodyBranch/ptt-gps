/**
 * What changed, and when.
 *
 * The dates and the entries are taken from the actual history; the version
 * numbers were applied when this file was started, so releases before it exist
 * as a record of work rather than as things that were ever tagged.
 *
 * Add to the top when you ship. `VERSION` is whatever is first, and the
 * console shows it at the foot of the sidebar — so "which build is this?" is
 * answerable from the screen rather than from git.
 */

export interface Release {
  version: string;
  date: string;
  /** One line on why this release exists, shown under the heading. */
  summary?: string;
  added?: string[];
  changed?: string[];
  fixed?: string[];
}

export const RELEASES: Release[] = [
  {
    version: '0.9.0',
    date: '2026-09-02',
    summary: 'Finishing a meet, and a phone layout that stops working around itself.',
    added: [
      '**Complete** and **Reopen** on an event. Events already filed themselves once their end date passed, but that needs an end date and a date that has gone by — this puts one away explicitly, and stamps it in the event file so it survives a restart.',
      'A changelog and a version, at the foot of the sidebar.',
    ],
    changed: [
      'Phones get a real app bar with the hamburger and the page name, instead of a button floating over the page that every header had to reserve space for. On an event it names the meet, which the phone layout never did.',
      'Page toolbars pair their controls into a grid rather than wrapping into a ragged staircase.',
      'Deactivate and Complete sit apart from Open and Setup on an event card: working on a meet and putting it away are different kinds of action.',
      'The **RaceResult** button is only red until the connection exists; after that it is settings, and settings should not be the loudest thing on the page.',
    ],
    fixed: [
      'The selected tracker is obvious again. A faint tint stopped reading once every row carried a colour dot, so it now takes an accent edge — and the vehicle card shows it too, not just the table.',
      'Rows in a vehicle card fill it: 271px of content had been sitting in a 478px card with everything jammed left.',
      'The race picker starts at the left edge. A leftover padding shorthand was still reserving room for the old floating hamburger.',
      'The new-event form no longer truncates dates to "mm/dd/y" — three fields were sharing a 340px column.',
    ],
  },
  {
    version: '0.8.0',
    date: '2026-09-01',
    summary: 'Timing boxes alongside the vehicles, and a listener that stays up.',
    added: [
      'A **Decoders** page: RaceResult decoders, TrackBoxes and Ubidiums polled on a timer, with battery, online state, where each one is in words as well as coordinates, and when it was last heard from.',
      'Timing boxes on the race map behind a **Decoders** toggle, drawn as squares so they cannot be mistaken for a vehicle, hollow when offline.',
      'Hide a box that is not yours — a shared account at a big event carries other timers\' hardware — and restore it later. Hiding survives polling and restarts.',
      'Counts per device family for whatever is on the map, so zooming to an event tells you what is there.',
    ],
    changed: [
      'Clicking a decoder flies the map to it; clicking again comes back out to the whole fleet.',
      'Decoder rows become cards on a phone: six columns cannot be made to read at 375px.',
    ],
    fixed: [
      'The tracker port stays open whether or not an event is loaded. Ports were derived from active events alone, so a restart with nothing active opened no port at all, and deactivating the last event dropped every connected tracker.',
      'An event that cannot be restored on boot says why instead of being skipped in silence.',
      'A battery reported as `-1` — which mains-powered boxes do — reads as "no reading" rather than as flat.',
      'Stale state is no longer asserted for an offline box: no clock drift, no "timing" or "on battery" flags, and its battery is dimmed.',
    ],
  },
  {
    version: '0.7.0',
    date: '2026-08-31',
    summary: 'Documentation.',
    added: [
      'An operator manual, written once and rendered twice: the **Help** page in the console and a 33-page PDF, both from the same source so they cannot drift apart.',
      'Two tools that rebuild it — one drives a headless browser to re-shoot every screenshot with a race actually running, the other prints the PDF.',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-08-30',
    summary: 'Editing during a meet, a viewer for announcers, and a wire log worth coming back to.',
    added: [
      'Setup can be saved while a race is armed or live. Running races keep their engines, so every window, distance and open session survives; only what would reinterpret a race in progress is refused, and the message names it.',
      'A distances-only viewer at `/watch/distances` — one big figure per role, for an announcer or a screen at the finish. Decimal places are set per view in Setup.',
      'The wire log is recorded whether or not anyone is watching, so you can come back afterwards and search the whole log rather than what arrived since you opened it.',
      'Move a tracker to another vehicle mid-race, for one bolted to the wrong bike. Its distance and window carry over.',
    ],
    changed: [
      'Vehicles sit between roles and trackers: a role says what is published, a vehicle says who is covering it.',
      'Course markers thin out by zoom and, during a race, to a band around the vehicles — a lap course otherwise piles every mile post onto one loop.',
      'Every page works at phone width.',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-08-29',
    summary: 'Units, addresses, and seeing what is on the wire.',
    added: [
      'A raw wire log of everything arriving on the tracker ports, upstream of any parsing or roster filtering.',
      'Every page has its own address, so a refresh returns you to where you were and a link to a race can be handed on.',
    ],
    changed: [
      'Everything attached to an event honours the event\'s units, and every distance carries its unit.',
      'Snap window defaults match what was actually raced on the legacy system.',
    ],
    fixed: [
      'Tracker dots sit on their raw coordinates rather than drifting with zoom.',
      'A malformed frame can no longer take the listener down; the declared point count is trusted rather than inferred from length.',
    ],
  },
];

/** What this build calls itself. */
export const VERSION = RELEASES[0].version;
