# Pushing a meet in

How another system hands this server a meet: its races, their schedule, and the
courses they run on.

The point is to stop an operator re-keying, on the morning of a meet, a
schedule that already exists somewhere else. It is the counterpart to
[live-feed.md](live-feed.md), which is how you read distances back out.

- **Route**: `POST /api/sync/meet`
- **Auth**: a feed token with **Setup write**, as `Authorization: Bearer …`
- **Body**: JSON, up to 25 MB (courses travel as raw KML)
- **Safe to repeat**: sending the same meet twice changes nothing the second
  time. Send it again whenever your copy changes.

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

A token that may write setup still cannot start a race or write positions.

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

## Reading it back

Everything you send comes back on the live feed, and your own ids come with it:
`externalId` on the meet in `hello`, and on every race in both the meet list
and the `race` messages. Match on that and nothing has to be inferred from
names or dates. See [live-feed.md](live-feed.md).

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
