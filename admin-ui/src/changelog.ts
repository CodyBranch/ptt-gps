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
    version: '0.12.0',
    date: '2026-09-03',
    summary: 'Races carry a programme number, a start time, and a running order.',
    fixed: [
      'The live feed reported every vehicle as off course. It was publishing a yes/no derived from a distance, and that distance is never zero - a vehicle drives in a lane, not along the centreline of a course trace. It now sends how far off the line the fix was, in metres, and leaves the verdict to the existing suspect flag, which the engine raises against the race own off-course allowance.',
    ],
    added: [
      'A race can be given a programme number and a scheduled start in Setup, and both appear wherever races are listed - the number in front of the name, the time beside it.',
      'A running order per race. Races are listed in it everywhere: the console, the event snapshot and the live feed. An event that sets no order keeps the order it was written in, so nothing changes for meets that do not need this.',
      'Both fields go out on the live feed, in the meet list as well as in each race message, so a consumer can map races onto its own programme without subscribing first. Each race also carries its position in the running order, so a consumer can sort without depending on the order messages happen to arrive in.',
    ],
  },
  {
    version: '0.11.1',
    date: '2026-09-03',
    summary: 'Named tokens for the live feed, and who is on it.',
    added: [
      'The feed meet list carries what a consumer needs to map meets onto its own records without subscribing first: the meet number, start and end dates, and each race with its units, course length and session.',
      'One live-feed token per consumer instead of a single shared secret, each with a label, created from System. They can be disabled or revoked individually, and either takes effect immediately rather than at the consumer next reconnecting.',
      'A Connected now list under the same panel: who is on the feed, from where, and which meet each is watching. Connected but not subscribed shows as its own state, which is the usual reason a consumer sees no data.',
      'Each token records when it was last used and from which address, so an integration that has quietly stopped connecting is visible without asking anyone.',
    ],
  },
  {
    version: '0.11.0',
    date: '2026-09-03',
    summary: 'A live feed other software can consume.',
    added: [
      'A live race feed on the `/feed` socket.io namespace: connect with a token, choose a meet, and receive a message whenever anything in it changes. Distances come in the race units and in metres, with the position each one was derived from.',
      "Every position carries the age of the fix behind it and a `stale` flag, because a distance that has stopped updating still looks like a distance. Staleness is measured against the event's own reporting interval, and against when the server received the fix rather than the device's clock.",
      'A read-only feed token under System, separate from the split-feed token: one lets software write distances in, the other lets it read races out.',
      'Integration notes in `docs/live-feed.md`, with the payload reference and a worked example.',
    ],
  },
  {
    version: '0.10.0',
    date: '2026-09-03',
    summary: 'Running as a service, and deploying without a terminal.',
    added: [
      'The server runs as a Windows service, so it survives a reboot and restarts itself if it exits. `deploy/install-service.ps1` sets it up.',
      'Deploy from the console. Under the changelog, an admin sees what is waiting on `main` and can deploy it: the new code is pulled, built and tested while the current server keeps running, and only then does it restart. If the new build does not answer, it rolls back on its own.',
      'A deploy reports progress to a file rather than to the browser, because it restarts the server the browser is talking to. The page follows along through the outage and says how it ended once the new build answers.',
    ],
    fixed: [
      'A failed port bind says what happened instead of printing a stack trace. Under a service manager that restarts on failure, an unreadable crash becomes a silent restart loop.',
    ],
  },
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
