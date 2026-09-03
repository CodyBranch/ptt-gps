# Primetime GPS — live race feed

A socket.io feed for other software to consume live race distances. You connect
with a token, choose a meet, and receive a message every time anything in that
meet changes.

This is a **published contract**. The console's own socket is a separate,
internal thing that changes shape whenever the UI needs it to; this one does
not move under you. If the shape ever has to change incompatibly, `protocol`
goes up and the old shape keeps working until you migrate.

---

## Before you start

**One thing matters more than the rest of this document.** A distance that has
stopped updating still looks like a distance. If a vehicle's tracker loses
signal at mile 8, the last number it sent stays the last number it sent, and
nothing about `distance` alone tells you it is forty minutes old.

Every position therefore carries `ageS` and a `stale` flag. **Check `stale`
before you show a number to anyone.** It is computed against the event's own
reporting interval, so it means "this has missed several reports it should have
made", not a fixed number of seconds.

---

## Connecting

- **URL**: `https://<host>/feed` — the `/feed` socket.io **namespace**, not a path
- **Transport**: socket.io v4
- **Auth**: a feed token, in the handshake

Get a token from the console: **System → Live feed**. Give it a label naming
the consumer ("Scoreboard", "Broadcast partner") and press Create; the token is
shown once created and can be revealed and copied at any time.

**Create one token per consumer.** They are individually revocable, so turning
off one partner does not disconnect everyone else, and the console can show you
which consumers are actually connected and what each is watching. A single
shared token can answer neither question.

A token is read-only: it cannot start races, change setup, or write data.
Disabling or revoking one **disconnects anything using it immediately** — not
at its next reconnect.

```js
import { io } from 'socket.io-client';

const socket = io('https://gps.example.com/feed', {
  auth: { token: process.env.PTT_FEED_TOKEN },
  transports: ['websocket'],
});
```

The token may also be sent as `?token=…` or an `X-Feed-Token` header if your
client cannot set handshake auth. Prefer handshake auth: a query string ends up
in logs.

A bad token fails the connection with `invalid feed token` on `connect_error`.

---

## The conversation

### 1. `hello` — what meets exist

Sent by the server as soon as you connect. You do not have to ask.

```json
{
  "protocol": 1,
  "serverTimeMs": 1788419071380,
  "events": [
    {
      "id": "boston-2026-demo",
      "name": "Boston Marathon 2026 (demo)",
      "meetId": 9999,
      "startDate": "2026-04-20",
      "endDate": "2026-04-20",
      "races": [
        {
          "id": "wheelchair",
          "name": "Wheelchair",
          "orderIndex": 0,
          "eventNumber": 11,
          "scheduledStart": "09:02",
          "status": "scheduled",
          "units": "miles",
          "courseLength": 26.294,
          "courseLengthMeters": 42316.2,
          "sessionId": null
        },
        {
          "id": "marathon",
          "name": "Marathon",
          "orderIndex": 1,
          "eventNumber": 12,
          "scheduledStart": "09:30",
          "status": "live",
          "units": "miles",
          "courseLength": 26.294,
          "courseLengthMeters": 42316.2,
          "sessionId": 3
        }
      ]
    }
  ]
}
```

Use `id` to subscribe.

**Mapping meets to your own records.** `meetId` is the anchor: it is the number
the meet is known by in the wider timing system, and where both sides have it,
match on that alone. Where they do not, the dates and course lengths are what
distinguish one meet from another — names do not. "10K" is not a distinguishing
name, two races in one meet often share a course, and the same event runs again
next year under exactly the same title.

Each race also carries `orderIndex`, `eventNumber`, `scheduledStart`, `units`,
`courseLength`, `courseLengthMeters` and `sessionId`, so you can line races up
without subscribing first. Where a meet uses programme numbers, `eventNumber`
is the natural key to match races on.

**Sort races by `orderIndex`** — a race's position in the meet's running order,
from 0. That order is what the meet intends to run, which is not necessarily by
scheduled time and is not the order races appear in the event file.

Do not rely on the order messages arrive in. The burst you receive on
`subscribe` is in running order, but every later `race` message is pushed on
its own as that race changes — so a consumer holding races by id and updating
them would otherwise have nothing to lay them out by. `orderIndex` is identical
in the meet list and in the race messages.

`scheduledStart` is a wall-clock time at the venue, deliberately not an
instant. A schedule is written in local time and does not move because your
server is in another zone. Combine it with the meet's `startDate` yourself if
you need an absolute time, and be aware that a scheduled time is what was
planned, not what happened — use `status` and `sessionId` for that.

The list is of meets **loaded on the server right now**, not every meet that
exists. A meet not yet activated, or put away after its event, will not appear.

Ask for it again at any time — you do not have to reconnect:

```js
socket.emit('events', null, (res) => console.log(res.events));
```

### 2. `subscribe` — choose the meet

```js
socket.emit('subscribe', { eventId: 'boston-2026-demo' }, (ack) => {
  if (!ack.ok) throw new Error(ack.error);
  console.log('watching races', ack.races);
});
```

The ack is `{ ok: true, eventId, races: [...] }`, or
`{ ok: false, error, events: [...] }` if the event is not loaded — the current
list comes back with the error so you can recover without another round trip.

**One meet at a time.** Subscribing again moves your subscription rather than
adding to it. Open a second connection if you genuinely need two meets.

Immediately after subscribing you receive one `race` message per race, with
current state. You are never left waiting for the next change to find out where
things are.

### 3. `race` — the data

Sent on subscribe, and again whenever anything in that race changes: a new
position, a distance, a status change, a tracker swapped between vehicles.
During a live race with trackers reporting every 10s, expect a message per
race every few seconds.

```json
{
  "protocol": 1,
  "serverTimeMs": 1788419071382,
  "event": { "id": "boston-2026-demo", "name": "Boston Marathon 2026 (demo)", "meetId": 9999 },
  "race": {
    "id": "marathon",
    "name": "Marathon",
    "orderIndex": 1,
    "eventNumber": 12,
    "scheduledStart": "09:30",
    "status": "live",
    "units": "miles",
    "courseLength": 26.294,
    "courseLengthMeters": 42316.2,
    "sessionId": 3,
    "roles": [
      {
        "key": "womens_lead",
        "label": "Women's Lead",
        "vehicle": "womens_lead",
        "imei": "015181000128000",
        "source": "gps",
        "distance": 1.259,
        "distanceMeters": 2026.2,
        "position": {
          "lat": 42.236977,
          "lon": -71.496637,
          "speedKmh": 19.3,
          "speedMph": 11.99,
          "fixMs": 1788419070000,
          "receivedMs": 1788419070733,
          "ageS": 1,
          "stale": false,
          "offCourse": false,
          "suspect": false,
          "gpsQuality": "good"
        }
      }
    ]
  }
}
```

### Other messages

- **`events`** — the meet list. Pushed when events are loaded, unloaded or
  reconfigured, and requestable at any time with an ack, as above. Same shape as
  `hello`. Refresh your menu; your subscription is unaffected unless the meet
  itself went away.
- **`unsubscribe`** — emit with no payload to stop receiving `race` messages.

---

## Field reference

### The message envelope

Every `race` message is wrapped in these.

| Field | Type | Meaning |
| --- | --- | --- |
| `protocol` | number | The payload version. Currently `1`. **Check it and refuse a shape you do not know** rather than guessing at unfamiliar fields |
| `serverTimeMs` | number | The server's clock when the message was built, epoch ms. Compare it with your own to spot clock skew: every age in the payload is computed against this clock, so if the two disagree by minutes, so will your idea of how fresh the data is |
| `event` | object | `{ id, name, meetId }` — which meet this race belongs to |
| `race` | object | The race and its roles. See below |

### The meet list (`hello` and `events`)

Each entry describes a meet loaded on the server.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | The meet id. This is what you pass to `subscribe` |
| `name` | string | Display name |
| `meetId` | number | The number this meet is known by in the wider timing system. Your primary key for matching, where you have it |
| `startDate` | string \| null | `YYYY-MM-DD`, from the meet's setup |
| `endDate` | string \| null | `YYYY-MM-DD`. Differs from `startDate` for a multi-day meet |
| `races` | array | Each with `id`, `name`, `orderIndex`, `eventNumber`, `scheduledStart`, `status`, `units`, `courseLength`, `courseLengthMeters` and `sessionId` — the same meanings as in the `race` message below |

### `race`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Race id, unique within the meet |
| `name` | string | Display name |
| `orderIndex` | number | Position in the meet's running order, from 0. **Sort on this** — see above |
| `eventNumber` | number \| null | The number this race carries in the meet programme, where the meet uses them. Null for a road race with one start |
| `scheduledStart` | string \| null | Scheduled start as `"HH:MM"`, 24-hour, **local to the meet**. Null if not scheduled |
| `status` | string | `scheduled`, `armed`, `live`, `finished` |
| `units` | string | `miles` or `kilometers` — what `distance` and `courseLength` are in |
| `courseLength` | number | Course length in `units` |
| `courseLengthMeters` | number | The same length in metres |
| `sessionId` | number \| null | Identifies one run of this race. **Changes when a race is reset** — treat a new `sessionId` as "start over", and discard anything you accumulated |
| `roles` | array | See below |

### `role`

A **role** is a position in the race — "Lead Vehicle", "Women's Lead" — rather
than a specific vehicle or device. Which vehicle covers a role, and which
tracker is on that vehicle, can both change mid-race. `key` is stable across
all of that, so **key off `key`**, not `imei` or `vehicle`.

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | Stable id for the role. Your join key |
| `label` | string | Human name |
| `vehicle` | string \| null | Vehicle currently covering the role; null if uncovered |
| `imei` | string \| null | Tracker currently supplying the position |
| `source` | string | `gps`, or `splits` when distance comes from timing mats |
| `distance` | number \| null | Distance along the course in `units`. Null until known |
| `distanceMeters` | number \| null | The same distance in metres |
| `position` | object \| null | Null when nothing has been heard from this role yet |

A role with no vehicle assigned still appears, with nulls. It is deliberately
not omitted: "this role exists and is uncovered" is different from "this role
does not exist", and a board that silently drops a row is worse than one
showing a gap.

### `position`

| Field | Type | Meaning |
| --- | --- | --- |
| `lat`, `lon` | number \| null | WGS84 |
| `speedKmh` | number \| null | Ground speed as the tracker reports it |
| `speedMph` | number \| null | The same speed in mph |
| `fixMs` | number \| null | Epoch ms the **device** says the fix was taken |
| `receivedMs` | number \| null | Epoch ms **this server** received it |
| `ageS` | number \| null | Seconds since `receivedMs` |
| `stale` | boolean | The position has missed several expected reports — **do not trust `distance`** |
| `offCourse` | boolean | The vehicle is not near the course line — took a wrong turn, or a detour |
| `suspect` | boolean | The engine doubts this fix: an implausible jump, or a poor lock |
| `gpsQuality` | string \| null | `good`, `ok`, `poor` |

`ageS` is measured from `receivedMs`, not `fixMs`, deliberately. A tracker with
a wrong clock would otherwise report positions that look hours old — or worse,
permanently fresh. Both timestamps are given so you can spot a device whose
clock has drifted (`fixMs` far from `receivedMs`).

### Precision

Numbers are rounded on the way out: distances to 4 decimals of the unit (about
16cm in miles), metres to 0.1, speeds to 2. The engine works at full float
precision, but publishing fifteen decimal places would imply an accuracy that
consumer GPS cannot support.

---

## A worked example

Tracks the leader of every live race and prints changes, ignoring stale data.

```js
import { io } from 'socket.io-client';

const socket = io('https://gps.example.com/feed', {
  auth: { token: process.env.PTT_FEED_TOKEN },
  transports: ['websocket'],
});

const sessions = new Map(); // raceId -> sessionId we are tracking
const races = new Map(); // raceId -> latest message, laid out by orderIndex

socket.on('connect_error', (err) => console.error('feed refused:', err.message));

socket.on('hello', (hello) => {
  if (hello.protocol !== 1) {
    console.error('unexpected protocol', hello.protocol, '- refusing rather than guessing');
    socket.close();
    return;
  }
  const meet = hello.events.find((e) => e.races.some((r) => r.status === 'live')) ?? hello.events[0];
  if (!meet) return console.log('no meets loaded');

  socket.emit('subscribe', { eventId: meet.id }, (ack) => {
    if (!ack.ok) return console.error('subscribe failed:', ack.error);
    console.log(`watching ${meet.name}: ${ack.races.join(', ')}`);
  });
});

socket.on('race', (msg) => {
  const { race } = msg;

  // Keep every race, and lay them out by orderIndex rather than by the order
  // messages happen to arrive in - after the first burst, that is the order
  // things changed, not the running order.
  races.set(race.id, race);
  const runningOrder = [...races.values()].sort((a, b) => a.orderIndex - b.orderIndex);
  void runningOrder; // render this, not the map

  if (race.status !== 'live') return;

  // A reset starts a new session; anything accumulated for the old one is void.
  if (sessions.get(race.id) !== race.sessionId) {
    sessions.set(race.id, race.sessionId);
    console.log(`[${race.name}] new session ${race.sessionId} - resetting`);
  }

  const usable = race.roles.filter((r) => r.distance !== null && r.position && !r.position.stale);
  if (usable.length === 0) {
    console.log(`[${race.name}] no fresh positions`);
    return;
  }

  const leader = usable.reduce((a, b) => (b.distance > a.distance ? b : a));
  const pct = ((leader.distance / race.courseLength) * 100).toFixed(1);
  console.log(
    `[${race.name}] ${leader.label}: ${leader.distance.toFixed(2)} ${race.units} (${pct}%)` +
      `${leader.position.offCourse ? ' OFF COURSE' : ''}`,
  );
});
```

---

## Operational notes

**Reconnection** is socket.io's own, and automatic. You must re-`subscribe`
after a reconnect — the server does not remember you. Do it in the `hello`
handler and it happens for free, since `hello` is sent on every connection.

```js
socket.on('disconnect', (reason) => console.warn('feed dropped:', reason));
```

**Deploys restart the server**, typically for a few seconds. Clients reconnect
on their own; expect a gap in messages, not an error worth alerting on. Treat a
disconnect as "data is not arriving", not as "the race stopped".

**No history.** The feed is live only. You get current state on subscribe, and
changes after that. Nothing is replayed for a client that was disconnected — if
you need continuity across a gap, record what you receive.

**Message volume** is roughly one message per race per report interval, plus
one per operator action. A ten-vehicle meet with two live races at a 10s
interval is a handful of messages a second at most.

**`status` values**: `scheduled` (not started), `armed` (ready, clock not
running), `live`, `finished`. Distances only advance while `live`.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `connect_error: invalid feed token` | Wrong, disabled or revoked token. Check **System → Live feed** |
| Connects, but no `race` messages | You have not subscribed, or the meet has no races. **System → Live feed → Connected now** shows each connection and what it is watching; "not subscribed" there is the usual answer |
| `subscribe` acks `no such event` | The meet is not loaded on the server. `ack.events` lists what is |
| `distance` is null | The role has no vehicle, or nothing has been heard from its tracker yet |
| `distance` frozen, `stale: true` | The tracker has gone quiet. Show the age, or nothing — not the number alone |
| All roles `offCourse` | Usually the wrong course loaded for the race, not fifty wrong turns |
| Distances jumped backwards | A race reset. Check `sessionId` |
