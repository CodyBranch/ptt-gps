# Pushing a meet in, and running it

How another system hands this server a meet - its races, their schedule, and
the courses they run on - and then starts and finishes those races at the times
it holds.

The point is to stop an operator re-keying, on the morning of a meet, a
schedule that already exists somewhere else. It is the counterpart to
[live-feed.md](live-feed.md), which is how you read distances back out.

- `POST /api/sync/meet` — the setup push. Needs **Setup write**.
- `POST /api/sync/lifecycle` — start and finish. Needs **Run races**.
- **Auth** on both: a feed token, as `Authorization: Bearer …`
- **Safe to repeat**: both are. Sending the same meet twice changes nothing the
  second time, and a repeated start never opens a second session.

The two grants are separate and both start off. Building a meet and running one
are different jobs here — it is the same line the console draws between an
admin and a staff login — so a system that only needs one is never handed the
other.

---

## What it will and will not do

**It is a merge, never a replace.** Your system knows about races, schedules
and courses. It knows nothing about trackers, vehicles, roles, Firebase
targets, listener ports or snap settings — which is most of what makes a GPS
event work, and all of it built by hand. So the sync only ever writes the half
it knows about, and everything else is carried through untouched, including
keys this server has never heard of.

Specifically, a sync **never**:

- removes a race. Races already here that you did not send come back in
  `untouched` and are left exactly as they are.
- removes or edits a tracker, vehicle, role, clock slot, Firebase connection,
  listener or snap setting.
- starts, arms or stops anything.
- overwrites a course file another event is snapping to.
- replaces a meet number with `0`. If you do not know the meet number, leave it
  out or send `0` and whatever an operator typed stays.

And while a race is **armed or live**, its course and units are left alone and
the reply says so — changing either mid-race reinterprets every distance
already published. Send the meet again after it finishes and the change lands.

---

## Getting a token

In the console: **System → Live feed → Create**, label it with the name of your
system. Then press **Setup write** on that token and confirm. Without it the
route answers `403` — a token is read-only by default, and the one that reads
the feed does not have to be the one that writes setup.

**Setup write** does not include starting races. That is **Run races**, below,
granted the same way. Neither lets a token write positions.

---

## The request

```json
{
  "source": "nexus-xc",
  "sourceVersion": "2026.3.1",
  "dryRun": false,
  "event": {
    "externalId": "nx-meet-9",
    "name": "FSU Invitational",
    "meetId": 4210,
    "startDate": "2026-10-03",
    "endDate": "2026-10-03",
    "outputUnits": "miles"
  },
  "courses": [
    { "key": "c-8k", "name": "Apalachee 8K", "kml": "<?xml version=\"1.0\"…" }
  ],
  "races": [
    {
      "externalId": "nx-race-1",
      "name": "Men's 8K",
      "eventNumber": 2,
      "scheduledStart": "09:30",
      "order": 1,
      "units": "kilometers",
      "courseKey": "c-8k"
    }
  ]
}
```

### `event`

| Field | Type | Meaning |
| --- | --- | --- |
| `externalId` | string | **Your** id for the meet. How a re-send finds the same event; send it every time |
| `id` | string | This server's event id, if you already know it. Used ahead of `externalId`. A `404`-ish `400` if no such event exists |
| `name` | string | Required |
| `meetId` | number | The meet number in the wider timing system. Firebase publishes under it, so this matters. `0` or absent means "not known" and never overwrites |
| `startDate`, `endDate` | string | `YYYY-MM-DD` |
| `outputUnits` | string | `miles` or `kilometers`, the meet default. Not applied while a race is running |

### `courses`

Each entry is a course you want available, keyed so races can point at it.

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | Your own handle for this course within **this request** only. Not stored |
| `name` | string | Used to name the file if it has to be created |
| `kml` | string | The course as KML. A `LineString` is what is read from it |
| `lengthMeters` | number | Optional and advisory — the server measures the line itself |

**Courses are matched on their geometry, not their name.** If the line you send
is already in the course library the existing file is reused, whatever it is
called; the same course arrives named differently from one season to the next,
and courses outlive the events that use them. Only a genuinely new line creates
a file, and a name already taken gets a `-2` suffix rather than overwriting
something another event is snapping to.

### `races`

| Field | Type | Meaning |
| --- | --- | --- |
| `externalId` | string | **Your** id for the race. Match key; survives a rename and a renumber |
| `name` | string | Required |
| `eventNumber` | number | Programme number |
| `scheduledStart` | string | `"HH:MM"`, 24-hour, local to the meet |
| `order` | number | Running order. This is what the console and the feed sort by |
| `units` | string | `miles` or `kilometers` for this race's distances |
| `courseKey` | string \| null | Points at an entry in `courses`. `null` when the course is not traced yet |

**A race with no course is skipped, not created.** There is nothing for the
engine to snap to, so it would not build. It comes back as `skipped` with a
reason; trace the course, send the meet again, and it appears.

### How a sent race is matched to one already here

In order, first hit wins, and one existing race is never claimed twice:

1. `externalId` — the only one that survives both a rename and a renumber. Send
   it.
2. `eventNumber`, against a race that has the same number.
3. Name, trimmed and case-insensitive.

No match creates a race, with an id slugged from the name (`Men's 8K` →
`mens-8k`, `-2` if taken).

---

## Dry run

`"dryRun": true` plans the whole thing and writes nothing — no event, no course
files, no config. The reply is the same shape, so you can show an operator
exactly what a real send would do. Worth doing on the first send of a meet,
when the answer to "did it find my event or make a new one?" matters.

---

## The reply

```json
{
  "ok": true,
  "dryRun": false,
  "event": { "id": "fsu-invite", "file": "fsu-invite.json", "action": "updated", "loaded": true },
  "candidates": [],
  "courses": [{ "key": "c-8k", "file": "courses/apalachee-8k.kml", "action": "reused" }],
  "races": [
    { "externalId": "nx-race-1", "id": "mens-8k", "name": "Men's 8K", "action": "updated" },
    { "externalId": "nx-race-2", "id": "open-3k", "name": "Open 3K", "action": "skipped",
      "reason": "no course yet - trace it and send the meet again" }
  ],
  "untouched": [{ "id": "alumni-2m", "name": "Alumni 2 Mile" }],
  "warnings": []
}
```

| Field | Meaning |
| --- | --- |
| `event.id` | This server's event id. Store it — it is also what you `subscribe` to on the live feed |
| `event.action` | `created`, `updated` or `unchanged` |
| `event.loaded` | Whether the meet is active on this server right now |
| `candidates` | Only when a new event was made: existing events sharing the name, so an operator can link them deliberately instead of the sync guessing |
| `courses[].action` | `created` or `reused` |
| `races[].action` | `created`, `updated`, `unchanged` or `skipped` |
| `races[].reason` | Why something was skipped, or which field was held back and why |
| `untouched` | Races here that you did not send. Left alone — never deleted |
| `warnings` | Things worth showing an operator: no meet number, units held back, a course that would not parse |

**Two meets a year apart share a name**, so a name-only match is never merged
into automatically — it comes back in `candidates`. Link the two by sending
`event.id` next time, and from then on `externalId` does it on its own.

### Errors

| Status | Body | Meaning |
| --- | --- | --- |
| `401` | `unknown or disabled token` | No `Authorization: Bearer`, or the token is not known or has been disabled |
| `403` | `this token cannot write setup` | A valid feed token without **Setup write** |
| `400` | a sentence | The body could not be used: no `event.name`, an `event.id` that is not here, malformed JSON |

Errors are `{ "ok": false, "error": "…" }`. A course that will not parse is not
an error — it is a warning, and the rest of the meet still lands.

---

## Starting and finishing a race

```
POST /api/sync/lifecycle
Authorization: Bearer <token with Run races>

{
  "source": "nexus-xc",
  "eventId": "fsu-invite",
  "raceId": "mens-8k",
  "externalId": "nx-race-1",
  "action": "start",
  "atMs": 1788419071380,
  "reason": "gun"
}
```

| Field | Meaning |
| --- | --- |
| `eventId` | The event id from the setup push. It must be **open** on this server |
| `raceId` | The race id from the setup push. Falls back to `externalId` if it does not match, so a sender that never stored ours can still drive a race |
| `action` | `start` or `finish`. Arm and reset are not reachable from here — they stay with the operator watching the course |
| `atMs` | Epoch milliseconds: the gun for a start, the gun plus the winner's time for a finish. **Not "now"** — a late delivery still stamps the race at the gun |
| `reason` | Free text, logged. `gun` and `first-finisher` are the useful ones |

Replies:

```json
{ "ok": true, "status": "live", "sessionId": 12 }
{ "ok": true, "status": "live", "sessionId": 12, "unchanged": true }
{ "ok": false, "error": "this race has not started here, so there is nothing to finish", "status": "armed" }
```

`unchanged: true` means the race was already in that state. **Retry freely**: a
start on a race that is already live is a no-op and never opens a second
session, and a finish on a finished race is the same. `status` on a refusal is
the race's status here, so a sender can see why.

| Status | When |
| --- | --- |
| `200` `unchanged` | Already started, or already finished |
| `400` | `action` is not `start` or `finish`; `atMs` missing, not a number, in the future, or more than 12 hours ago |
| `404` | No such race in that event |
| `409` | Start on a finished race, finish on one that never started, or the event is not open here |
| `401` / `403` | As for the setup push. The 403 sentence is `this token cannot run races` |

`atMs` is checked before anything else, so a broken timestamp is never reported
as "already done". Twelve hours of lateness is accepted because a sender that
lost its connection at the gun is still right about when the gun went; a time
in the future is not, beyond five minutes of clock skew between the machines.

### The feed is the confirmation, not the reply

A start or finish that applies pushes a fresh `race` message to everyone
subscribed to that meet, emitted before the POST returns — 4 ms after the call
on a local server. Drive your display from that message rather than from your
own request succeeding: it is the same message the console draws from, so the
two cannot disagree, and it also arrives when an operator here presses the
button instead of you.

One thing to take from the reply rather than the message: a finished race's
`race` message carries `sessionId: null`, because the session is closed and
gone. The id of the session your finish closed is in the POST reply.

### Undoing one

A start or finish applied in error is undone from the console: reset the race
there and it goes back to `scheduled`, after which a pushed start is accepted
again and opens a new session. That is what the 409 on a finished race means by
"reopen it from the console" — there is no API for it, because a race that has
to be un-run is a conversation between people standing at the finish.

### What "finish" means here

**The leader is home, not the results are final.** A race is finished by GPS
standards once first place crosses: the lead vehicle's job is over and it can
be moved to the next race. Runners are still on the course and you are still
timing them. On this side a finish ends the GPS session and stops publishing
distances for that race, which is all it has ever meant here — nothing reads it
as a result.

### What stays with the operator

Arming and resetting. Arming is how the person watching the course says the
vehicles are in place, and resetting is how they undo a false start; neither is
something a machine elsewhere can see. If an operator has already started or
finished a race from the console, the feed says so and a push for the same
thing comes back `unchanged`.

Correcting the start time of a race that is already live is a console job too.
There is no API for it: it rewrites every distance timestamp in an open
session, and that wants the person who can see the consequences.

---

## Reading it back

Everything you send comes back on the live feed, and your own ids come with it:
`externalId` on the meet in `hello`, and on every race in both the meet list
and the `race` messages. Match on that and nothing has to be inferred from
names or dates. See [live-feed.md](live-feed.md).

**The `race` message is the authoritative status**, and there is one for every
race in a subscribed meet — a race that is still `scheduled` is not silent. You
get the full set on subscribe and the full set again whenever anything in the
meet changes, including a lifecycle push from you or a button pressed in the
console. The `events` list carries the same `status` for a meet you have not
subscribed to.

---

## A worked call

```bash
curl -sS -X POST https://gps.example.com/api/sync/meet \
  -H "Authorization: Bearer $PTT_SYNC_TOKEN" \
  -H 'Content-Type: application/json' \
  --data @meet.json
```

To try it against a server on your own machine:

```bash
git clone <this repo> && cd ptt-gps
npm install
npm run dev:server     # API on :8080
npm run dev:ui         # console on :5173, in a second terminal
```

Create an event, then **System → Live feed → Create**, press **Setup write**,
and point your sender at `http://localhost:8080/api/sync/meet`. Send it with
`"dryRun": true` first and read the reply.
