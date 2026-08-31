/**
 * The operator manual, written once and rendered twice: as the in-app Help
 * page, and as the printed PDF built by tools/build-manual.mjs.
 *
 * Keeping it as data rather than markup is what makes that possible — and it
 * means a screenshot filename appears in exactly one place, so a re-capture
 * cannot leave the two versions disagreeing.
 *
 * Inline markup is deliberately tiny: **bold** and `code`, nothing else.
 */

export type Block =
  | { t: 'p'; text: string }
  | { t: 'h3'; text: string }
  | { t: 'steps'; items: string[] }
  | { t: 'bullets'; items: string[] }
  | { t: 'note'; text: string }
  | { t: 'warn'; text: string }
  | { t: 'shot'; src: string; caption: string }
  | { t: 'table'; head: string[]; rows: string[][] };

export interface Section {
  id: string;
  title: string;
  blocks: Block[];
}

export const MANUAL: { title: string; subtitle: string; sections: Section[] } = {
  title: 'Primetime GPS — Operator Manual',
  subtitle: 'Live race tracking: setting an event up, running it, and fixing it when something goes wrong.',
  sections: [
    // ---------------------------------------------------------------- intro
    {
      id: 'overview',
      title: 'What this system does',
      blocks: [
        {
          t: 'p',
          text: 'Trackers on lead and chase vehicles report GPS positions to this server. The server places each position on the race course, works out how far along the course that vehicle is, and publishes that distance to scoreboards, clocks and map graphics. This console is where you set that up and watch it happen.',
        },
        {
          t: 'p',
          text: 'The important idea is that a raw GPS position is not a distance. A course doubles back on itself, runs beside itself, and on a lap race crosses the same ground many times. Turning "here is a point" into "this vehicle is at 4.2 miles" is the job the server does, and most of the settings in this manual exist to make it do that reliably.',
        },
        { t: 'h3', text: 'The five things everything is built from' },
        {
          t: 'table',
          head: ['Term', 'What it is'],
          rows: [
            ['Course', 'The route, drawn as a line and stored in the course library. Reused across events and years.'],
            ['Event', 'One meet on one day. Holds the roster, the vehicles, the roles, and one or more races.'],
            ['Race', 'One contest within the event, on one course, with its own start and finish.'],
            ['Tracker', 'A physical GPS device, identified by its IMEI. Lives in the fleet, gets borrowed by events.'],
            ['Vehicle', 'The moto, car or van carrying trackers. Usually two — a primary and a spare on the same bike.'],
            ['Role', 'What gets published: "Lead Men", "Chase Women". A role is covered by a vehicle.'],
          ],
        },
        {
          t: 'p',
          text: 'The chain runs **role → vehicle → tracker**. A role is the thing the scoreboard knows about; a vehicle is assigned to cover it; and one of that vehicle\'s trackers is the one actually publishing. That indirection is what lets you swap a dead tracker, or move a moto onto a different role, without touching the scoreboard configuration.',
        },
      ],
    },

    // ---------------------------------------------------------------- login
    {
      id: 'signing-in',
      title: 'Signing in',
      blocks: [
        { t: 'shot', src: 'login.png', caption: 'The sign-in screen.' },
        {
          t: 'p',
          text: 'Sign in with the username and password issued to you. There are three levels of access:',
        },
        {
          t: 'table',
          head: ['Level', 'Can do'],
          rows: [
            ['Admin', 'Everything: setup, courses, fleet, users, outputs.'],
            ['Staff', 'Run races — arm, start, finish, failover, windows, publishing. No setup changes.'],
            ['Viewer', 'Watch only. Signs in with a shared PIN, not a username. Every change is refused by the server.'],
          ],
        },
        {
          t: 'p',
          text: 'Viewers use **Watch with a viewer PIN** instead of a username. Hand out the PIN and the `/watch` link — see *Viewer links* below.',
        },
        {
          t: 'note',
          text: 'Change your own password from the account menu at the bottom-left of the sidebar.',
        },
      ],
    },

    // ----------------------------------------------------------------- home
    {
      id: 'home',
      title: 'Home',
      blocks: [
        { t: 'shot', src: 'home.png', caption: 'Home — the first thing to look at on arrival.' },
        {
          t: 'p',
          text: 'Home answers "is anything wrong" before you go looking. Four counters across the top: active events, races live, how many of the event\'s trackers are reporting, and how many things need attention.',
        },
        {
          t: 'bullets',
          items: [
            '**Event trackers reporting** is the one to watch before a start. `5/7` means two devices on the roster have not been heard from — flat, switched off, or still in the van.',
            '**Needs attention** collects open device issues and anything about the server worth knowing, such as remote access being off.',
            'Each active event is listed with its races, their status, course length and how many trackers are reporting for each.',
          ],
        },
        { t: 'shot', src: 'home-mobile.png', caption: 'The same page on a phone. Every page in the console works at phone width.' },
      ],
    },

    // --------------------------------------------------------------- events
    {
      id: 'events',
      title: 'Events',
      blocks: [
        { t: 'shot', src: 'events.png', caption: 'The event library.' },
        {
          t: 'p',
          text: 'An event is one meet. Events sit in the library until you activate them; only an active event has engines running and can track anything.',
        },
        { t: 'h3', text: 'Creating an event' },
        {
          t: 'steps',
          items: [
            'Give it a name, a meet ID, and start and end dates.',
            'Choose **Start from**: a blank event, or a copy of an existing one. Copying carries over the roster, roles, races, courses and Firebase outputs — much faster than building a recurring meet from scratch.',
            'Press **Create event**. It appears in the library, not yet active.',
            'Open **Setup** and build it (next section). You do not have to activate it first.',
            'On meet day, press **Activate**.',
          ],
        },
        {
          t: 'note',
          text: 'You can build next weekend\'s meet during the week. Setup works on an inactive event; activating it is the separate step that starts its engines.',
        },
        {
          t: 'p',
          text: 'Deactivating an event stops its engines. It is refused while one of its races is armed or live — finish or reset the race first. Completed events are tucked behind the **Completed events** toggle so the list stays short.',
        },
      ],
    },

    // ---------------------------------------------------------------- setup
    {
      id: 'setup',
      title: 'Event setup',
      blocks: [
        {
          t: 'p',
          text: 'Setup is where an event is built. It is reached from the event\'s **⚙ Setup** tab, or from the event card on Home or the Events page.',
        },
        { t: 'shot', src: 'setup-details.png', caption: 'Event details, timing settings and outputs.' },
        { t: 'h3', text: 'Event details' },
        {
          t: 'table',
          head: ['Setting', 'What it does'],
          rows: [
            ['Name, Meet ID, dates', 'Identity. The meet ID is what published data is filed under.'],
            ['Output units', 'The units distances are published in. Scoreboards expect one unit per meet.'],
            ['Report interval (s)', 'How often you expect each tracker to send. This only sets what counts as late — ages turn amber at 2 missed reports, red at 4, and a role offers its backup at 6. It does not configure the devices; that is set on the tracker itself.'],
            ['Window back / ahead', 'How far the snap window moves per fix — see *How snapping works*.'],
            ['Initial window', 'How much of the course a tracker may land on before the gun.'],
            ['Viewer decimals', 'Decimal places on the full viewer page.'],
            ['Distances decimals', 'Decimal places on the distances-only page. "5.1 km" is often the honest precision, and "5" is what gets read aloud.'],
          ],
        },
        {
          t: 'p',
          text: 'Below that: a **viewer PIN for this event only**, and the **Firebase outputs** this event publishes to. The System page holds a global PIN that already covers every event — do not duplicate it here.',
        },

        { t: 'h3', text: 'What we\'re tracking — roles' },
        { t: 'shot', src: 'setup-tracking.png', caption: 'Roles, and the vehicles covering them.' },
        {
          t: 'p',
          text: 'A role is a publishing identity — "Lead Men", "Chase Women". It holds the output bindings, which stay put no matter which vehicle or tracker is behind it:',
        },
        {
          t: 'bullets',
          items: [
            '**Map cmd** — the Krush map feed number. Together with the map event it writes the distance and the "distance complete" flag.',
            '**Clock slot** (1–4) — which scoreboard readout this role\'s distance feeds. Leave it blank and the distance never reaches the clock.',
            '**Map event** — the event name the map graphic publishes under. Blank means nothing is published for it.',
            '**Covered by** — which vehicle is currently on this role.',
          ],
        },
        { t: 'h3', text: 'Vehicles and the roster' },
        {
          t: 'p',
          text: 'Vehicles are the cars, motos and vans that carry trackers. Each vehicle holds an ordered list of trackers: the first is its primary, the rest are failover backups. The roster is the set of fleet trackers this event has borrowed; labels set here are per-event, so the same device can be "Lead A" at one meet and "Moto 3" at the next.',
        },
        { t: 'h3', text: 'Races' },
        { t: 'shot', src: 'setup-races.png', caption: 'Races, each with a course.' },
        {
          t: 'p',
          text: 'Each race gets a name and a course from the library. Races inherit the event\'s roster, vehicles and roles; per-race overrides exist for the exceptions — a tracker excluded from one race, an extra one added.',
        },

        { t: 'h3', text: 'Editing during an event' },
        {
          t: 'p',
          text: 'Setup can be saved while a race is armed or live. Running races keep their engines, so every snap window, distance and open session survives the save. Names, roles, vehicles, trackers, scoreboard slots and snap settings can all be changed mid-race.',
        },
        {
          t: 'warn',
          text: 'A running race\'s **course** and **units**, plus the event\'s **output units**, **listener ports** and **Firebase outputs**, are locked until it finishes. Every distance already computed is expressed in those, so changing one mid-race would silently reinterpret the race. The server refuses the save and names exactly which setting blocked it; nothing is written.',
        },
      ],
    },

    // -------------------------------------------------------------- courses
    {
      id: 'courses',
      title: 'Courses',
      blocks: [
        { t: 'shot', src: 'courses.png', caption: 'The course library.' },
        {
          t: 'p',
          text: 'Courses are shared by every event and reused year after year, which is why they live in their own library rather than inside an event. Each card shows the file, its measured length, how many points it has, and which events use it.',
        },
        { t: 'h3', text: 'Adding a course' },
        {
          t: 'steps',
          items: [
            'Draw the route in Google Earth as a single path and export it as KML.',
            'Press **⬆ Upload course** and pick the file.',
            'Open **Details** to name it, add notes — certification number, measurement date — and check the markers.',
          ],
        },
        { t: 'shot', src: 'course-detail.png', caption: 'Course details: the line, its markers, and the events using it.' },
        { t: 'h3', text: 'Markers' },
        {
          t: 'p',
          text: 'Markers are the mile and kilometre posts, aid stations and timing points drawn on the map. They belong to the course, not to the event, because the posts are in the same place every year.',
        },
        {
          t: 'bullets',
          items: [
            'Fill every mile or every kilometre in one action — and a course can carry both sets at once.',
            'Add your own at any distance; the list re-sorts itself as you type.',
            'Mark a timing point with the stopwatch icon so it stands out from the ordinary posts.',
            'Click the map to read off the distance at that spot — that is how an aid station gets its mileage without measuring.',
          ],
        },
        {
          t: 'note',
          text: 'On a lap course the map draws only the posts near the vehicles, and thins them out as you zoom away — otherwise a 120-mile race piles every mile post onto one loop. Start, finish and timing points are always drawn.',
        },
        {
          t: 'p',
          text: '**Replace** swaps the geometry while keeping the course\'s identity and history — use it when a route is re-measured. Archiving hides a course from the pickers without deleting it. A course in use by an event cannot be deleted.',
        },
      ],
    },

    // ---------------------------------------------------------------- fleet
    {
      id: 'fleet',
      title: 'Fleet',
      blocks: [
        { t: 'shot', src: 'fleet.png', caption: 'Every tracker you own, whatever event it is in.' },
        {
          t: 'p',
          text: 'The fleet is the permanent record of your devices. Events borrow from it. Search by name, IMEI or model, filter by owner, and sort by any column — most recent ping and fullest battery first are the useful defaults.',
        },
        {
          t: 'p',
          text: 'A banner appears when devices are reporting that are **not in the fleet**. They are tracked and logged either way; adding them just gives them names and owners.',
        },
        { t: 'shot', src: 'fleet-device.png', caption: 'Opening a device: live position, battery, and how long since it reported.' },
        {
          t: 'p',
          text: 'Click any row to open the device. Position and battery refresh while it is open, so you can walk the field with a phone and find a bike. Switch the map to **Satellite** when the answer is "under the trees by the creek" rather than a street name.',
        },
        {
          t: 'bullets',
          items: [
            '**History** shows where the device has been and its issue log.',
            'Log an issue against a device — a flat battery, a broken clip — and it shows on Home under *Needs attention* until it is closed.',
            'Retiring a device keeps its history but drops it out of the pickers.',
          ],
        },
      ],
    },

    // ------------------------------------------------------------- race day
    {
      id: 'race-day',
      title: 'Running a race',
      blocks: [
        { t: 'h3', text: 'The four states' },
        {
          t: 'table',
          head: ['Status', 'What the server is doing'],
          rows: [
            ['Scheduled', 'Positions are recorded and drawn on the map, but no distance is computed and nothing is published.'],
            ['Armed', 'Distances are computed and windows move — everything except publishing. This is the rehearsal: you can see it working before it matters.'],
            ['Live', 'Publishing. A session opens, and the first live race of the event tells the scoreboard to start showing distance.'],
            ['Finished', 'Publishing stops and the session closes. When the last race finishes, the scoreboard is told to stop showing distance.'],
          ],
        },
        {
          t: 'p',
          text: 'The normal sequence is **Arm → Start race → Finish race**. Arm early. Watching the distances climb sensibly while armed is how you catch a tracker on the wrong bike, a course in the wrong direction, or a device with no lock — all while it still costs nothing.',
        },
        {
          t: 'warn',
          text: '**Reset** returns a race to scheduled and puts every tracker back to zero on its own slice. It closes the session as a finish would. Use it to re-run a rehearsal; do not use it to pause a race in progress.',
        },

        { t: 'h3', text: 'The race page' },
        { t: 'shot', src: 'race-live.png', caption: 'A live race: vehicle cards, the tracker table, and the map.' },
        {
          t: 'p',
          text: 'The panel is vehicle-first, because a vehicle is a physical thing you can point at. Each card is one vehicle: what it is covering, the trackers it carries, and the distance being published for it.',
        },
        {
          t: 'bullets',
          items: [
            'The **big number** on a card is what that role is publishing right now.',
            '**Covering** is the role this vehicle is on. Changing it hands the role to this vehicle and takes it off whoever had it.',
            'Each tracker row shows a colour dot, battery, GPS lock, its own distance and how long since it reported.',
            'The **coloured dot** matches that tracker\'s marker on the map — with a full field the names alone will not do it.',
            'A role nobody is covering is listed plainly as **Not being covered**. The gap is the point.',
          ],
        },
        {
          t: 'table',
          head: ['Badge', 'Meaning'],
          rows: [
            ['LOCK (green)', 'A good satellite fix.'],
            ['LOCK (amber)', 'Degraded — a position, but a less certain one.'],
            ['No lock', 'The device is reporting but has no fix. It may be repeating its last known position; the server does not accept it as a distance.'],
            ['Age', 'Seconds since anything at all arrived from that device. Green fresh, amber aging, red stale.'],
            ['Window', 'The stretch of course a fix is currently allowed to land on.'],
          ],
        },
        { t: 'h3', text: 'The map' },
        {
          t: 'bullets',
          items: [
            'Tracker dots sit on the raw GPS coordinates — not snapped to the course — so you can see a vehicle that has gone off route.',
            '**Labels** turns the name-and-distance text on and off. With the pack bunched at a start line those labels overlap into a pile; the colours still tell them apart.',
            '**Satellite** helps when the question is which side of a tree line something is on.',
            'Selecting a tracker highlights it and draws its snap window along the course. Selecting it again clears it.',
          ],
        },
        { t: 'shot', src: 'race-selected.png', caption: 'A tracker selected: its window drawn along the course.' },
        { t: 'shot', src: 'race-mobile.png', caption: 'The race page on a phone — map on top, cards below.' },
      ],
    },

    // ------------------------------------------------------- interventions
    {
      id: 'interventions',
      title: 'Fixing things mid-race',
      blocks: [
        {
          t: 'p',
          text: 'Everything here works while the race is live and none of it interrupts tracking.',
        },
        { t: 'h3', text: 'A tracker has gone quiet — switch to the backup' },
        {
          t: 'p',
          text: 'Click any other tracker on the vehicle card to make it the publishing one. The card warns you when the active tracker has gone stale. Backups are computed all along, so the one you switch to already has a warm window and the right distance — the handover is seamless.',
        },
        { t: 'h3', text: 'A tracker is on the wrong bike — move it' },
        { t: 'shot', src: 'race-move-tracker.png', caption: 'The ⇄ control moves a tracker to another vehicle.' },
        {
          t: 'p',
          text: 'Press **⇄** on the tracker row and choose the vehicle it is really on. Its distance and window carry over — it is the same device on the same course, only the label of what is carrying it changes. If it was the publishing tracker, the role falls back to its vehicle\'s next one. The correction applies to every race in the event, and is saved so it survives a restart.',
        },
        { t: 'h3', text: 'A moto has swapped jobs — reassign the role' },
        {
          t: 'p',
          text: 'Use the **Covering** picker on the vehicle card. The role keeps its scoreboard slot and map channel; only the vehicle behind it changes. Whoever was on that role is stood down.',
        },
        { t: 'h3', text: 'A distance has jumped — fix the window' },
        { t: 'shot', src: 'race-window.png', caption: 'Setting a window by hand.' },
        {
          t: 'p',
          text: 'If a tracker has locked onto the wrong part of the course — the classic case is a course that doubles back — open **Window** and set the stretch it is allowed to land on. **Latch** holds that window until you release it, instead of letting it advance on its own.',
        },
        { t: 'h3', text: 'GPS is unusable — publish from splits' },
        {
          t: 'p',
          text: 'The **⏱** toggle on a vehicle card switches that role to publishing from the external split-time feed instead of GPS. Tracker data keeps flowing and keeps being recorded; only the headline distance changes source.',
        },
        {
          t: 'note',
          text: 'The **↑ PUBLISHING** switch in the top-right is the master output control for that event only. Turning it off stops anything reaching Firebase while you keep watching everything locally.',
        },
      ],
    },

    // ----------------------------------------------------------- how it works
    {
      id: 'snapping',
      title: 'How snapping works',
      blocks: [
        {
          t: 'p',
          text: 'You do not need this to run a race, but it explains every window setting and most surprises.',
        },
        {
          t: 'p',
          text: 'For each tracker the server keeps a **window** — a stretch of the course a new fix is allowed to land on. When a fix arrives it is matched to the nearest point on that stretch only, and the window then moves to sit around the new position. Without a window, a course that runs back beside itself would let a vehicle at mile 2 be read as mile 9.',
        },
        {
          t: 'table',
          head: ['Setting', 'Default', 'What it means'],
          rows: [
            ['Window back', '0.2', 'How far behind the last position the window reaches.'],
            ['Window ahead', '1.0', 'How far ahead it reaches. Larger than "back" because a lead vehicle only really moves forward.'],
            ['Initial window', '0.5', 'The stretch from the start a tracker may land on before the gun.'],
          ],
        },
        {
          t: 'p',
          text: 'All three are in the race\'s course units. A vehicle that goes further off course than allowed is flagged **suspect** rather than silently believed.',
        },
        {
          t: 'note',
          text: 'A lap course is drawn as the whole race distance — the loop traced once per lap — so distance keeps climbing lap after lap instead of resetting at the finish line each time round.',
        },
      ],
    },

    // -------------------------------------------------------------- viewers
    {
      id: 'viewers',
      title: 'Viewer links',
      blocks: [
        {
          t: 'p',
          text: 'Two read-only pages, for two different people. Both refuse every change at the server, so they are safe to hand out.',
        },
        { t: 'h3', text: '/watch — the full picture' },
        { t: 'shot', src: 'viewer-full.png', caption: 'The full viewer: map, vehicles and trackers, nothing to press.' },
        {
          t: 'p',
          text: 'For someone following the operation — a race director, a team manager. Markers on the map are named for the **role** they are covering rather than the device, because the role is what a watcher follows.',
        },
        { t: 'h3', text: '/watch/distances — just the numbers' },
        { t: 'shot', src: 'viewer-distances.png', caption: 'The distances board: one big figure per role.' },
        {
          t: 'p',
          text: 'For an announcer with a phone, a spotter, or a screen at the finish. One large figure per role with a bar behind it, readable across a room. It lists only races that are running, and with a single live race it simply shows it.',
        },
        {
          t: 'bullets',
            items: [
            'A role whose tracker has gone quiet says so rather than showing a number that has stopped moving.',
            'Tapping a row puts that vehicle under the map\'s spotlight.',
            'The **Full / Distances** switch flips between the two, and the address bar follows — so either can be bookmarked or passed on.',
            'Decimal places for each page are set per event in Setup.',
          ],
        },
        { t: 'shot', src: 'viewer-distances-mobile.png', caption: 'The distances board on a phone.' },
        {
          t: 'p',
          text: 'Give viewers the link plus the PIN. A global PIN on the System page covers every event; an event can also carry its own.',
        },
      ],
    },

    // ---------------------------------------------------------- diagnostics
    {
      id: 'diagnostics',
      title: 'Diagnostics',
      blocks: [
        { t: 'h3', text: 'Wire log' },
        { t: 'shot', src: 'wire-log.png', caption: 'Every frame arriving on the tracker ports, exactly as it arrives.' },
        {
          t: 'p',
          text: 'When a device is missing the first question is whether it is reaching the server at all, and that is invisible once a frame has been parsed and snapped. The wire log sits upstream of all of it: no roster filtering, no interpretation. A device you have not set up anywhere still shows here.',
        },
        {
          t: 'bullets',
            items: [
            'Every frame is recorded whether or not anyone is watching, so you can come back afterwards and look for it.',
            'The filter searches the whole recorded log, not just what is on screen — type an IMEI to see one device\'s traffic.',
            '**Load older** pages back through the history.',
            '**Live / History** stops the view following new frames so you can read; **Pause** holds the view while recording continues.',
            'The log keeps the newest 200,000 frames and nothing older than a week.',
          ],
        },
        { t: 'h3', text: 'Simulation' },
        { t: 'shot', src: 'sim.png', caption: 'Streaming realistic pings into the server\'s own listener.' },
        {
          t: 'p',
          text: 'The simulator sends real packets with live timestamps into the server exactly as a tracker would, so the whole pipeline runs as it does on race day. Use it to rehearse an event, to check a scoreboard is wired up, or to see the console work before you have hardware in the field.',
        },
        {
          t: 'warn',
          text: 'If publishing is on and a race goes live, simulated data reaches Firebase like any other. The panel warns you when that is the case.',
        },
        { t: 'h3', text: 'If the server restarts mid-race' },
        {
          t: 'p',
          text: 'It picks up where it left off. Races that were live are resumed with the same session, and the distances are rebuilt from the fixes already recorded. Devices that buffered while it was down send their backlog on reconnection and it is replayed in order.',
        },
      ],
    },

    // --------------------------------------------------------------- system
    {
      id: 'system',
      title: 'System',
      blocks: [
        { t: 'shot', src: 'system.png', caption: 'Operator logins, viewer access and Firebase connections.' },
        {
          t: 'bullets',
            items: [
            '**Operator logins** — add and remove admin and staff accounts.',
            '**Viewer access** — the shared PIN that lets announcers and displays watch with no controls. Replacing the PIN signs out everyone using the old one.',
            '**Firebase connections** — upload a service-account JSON per project. Events then pick which connection and flavour to publish to. **Test** checks a connection before you rely on it.',
          ],
        },
        {
          t: 'warn',
          text: 'A service-account file is a credential. Anyone holding one can write to that Firebase project — keep them off shared drives and out of email.',
        },
      ],
    },

    // ------------------------------------------------------- troubleshooting
    {
      id: 'troubleshooting',
      title: 'Troubleshooting',
      blocks: [
        {
          t: 'table',
          head: ['What you see', 'What it usually means'],
          rows: [
            [
              'A tracker shows no distance but the age is fresh',
              'It is reporting without a satellite fix, or the race is only scheduled. Check the LOCK badge; scheduled races record positions but compute no distance.',
            ],
            [
              'Distance is stuck while the vehicle is clearly moving',
              'The window has latched, or the vehicle is off course beyond the allowed distance. Open Window, check for a latch, and release or reset it.',
            ],
            [
              'Distance jumped far ahead or backwards',
              'A fix landed on the wrong part of a course that runs back beside itself. Set the window by hand around where the vehicle really is.',
            ],
            [
              'A device is not on the fleet page at all',
              'Check the wire log. If frames are arriving, the device is reaching the server and just is not on the roster. If nothing is arriving, it is a device, SIM or network problem.',
            ],
            [
              'Scoreboard shows nothing though the console looks right',
              'Check the ↑ PUBLISHING switch for that event, that the role has a clock slot, and that the event has a Firebase output configured.',
            ],
            [
              'Setup will not save',
              'A running race blocks a few settings — its course and units, output units, listener ports and Firebase outputs. The message names which one; everything else saves while racing.',
            ],
            [
              'Numbers on the announcer board look frozen',
              'The board says so explicitly when a role\'s tracker has gone quiet. Check that tracker\'s age on the race page and switch to its backup.',
            ],
          ],
        },
      ],
    },

    // ------------------------------------------------------------ reference
    {
      id: 'reference',
      title: 'Reference',
      blocks: [
        { t: 'h3', text: 'Pages and their addresses' },
        {
          t: 'table',
          head: ['Page', 'Address'],
          rows: [
            ['Home', '/'],
            ['An event', '/event/<event-id>'],
            ['One race', '/event/<event-id>/<race-id>'],
            ['Event setup', '/event/<event-id>/setup'],
            ['Events, Courses, Fleet, System', '/events, /courses, /fleet, /system'],
            ['Wire log, Simulation', '/wire, /sim'],
            ['Viewer — full', '/watch'],
            ['Viewer — distances only', '/watch/distances'],
          ],
        },
        {
          t: 'p',
          text: 'Every page has its own address, so a refresh returns you to where you were and a link to a race can be handed to someone else.',
        },
        { t: 'h3', text: 'Before a meet — a checklist' },
        {
          t: 'steps',
          items: [
            'Charge every tracker and check the fleet page shows them reporting.',
            'Build or copy the event, and check each race has the right course.',
            'Check every role has a vehicle covering it, and every vehicle has a primary and a backup tracker.',
            'Check clock slots and map events against what the scoreboard expects.',
            'Confirm the Firebase output is set and press Test on the connection.',
            'Activate the event.',
            'Arm the first race early and watch the distances climb before it matters.',
            'Hand out the viewer link and PIN.',
          ],
        },
      ],
    },
  ],
};
