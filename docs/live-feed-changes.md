# Live feed — changes

What has changed in the feed's contract, newest first, so you can see the delta
rather than re-reading [live-feed.md](live-feed.md).

`protocol` is still **1**. It goes up only for a change that would break a
consumer written against the previous shape and cannot be handled by the notes
below; until then, everything here is additive or a correction to something
that never worked.

---

## v0.12.0 — off course became a measurement

**`position.offCourse` changed from a boolean to a number.** It now reports how
far the fix was from the course line, in the race's units, alongside a new
`position.offCourseMeters` with the same value in metres.

**If you branch on `offCourse` being truthy, stop.** Under the old field it was
`true` for essentially every vehicle at every moment, which made it useless
rather than merely wrong: the engine measures a perpendicular distance, the
feed published `!!` of that number, and a vehicle is never on the exact
centreline of a course trace — it drives in a lane, and consumer GPS is good to
a few metres. On the demo course the leaders sit 1.5 to 11 metres out, and all
five reported as off course.

**Use `suspect` for the verdict.** The engine raises it when a fix is further
off than the race's own `maxOffCourse` allowance — 0.25 course units by
default — which is what "off course" was always meant to convey: a wrong turn,
a detour, or a bad lock, and a distance not to be trusted.

```js
// before — true for every vehicle, always
if (role.position.offCourse) warn();

// after — the server's own judgement
if (role.position.suspect) warn();

// or your own threshold, on a real measurement
if (role.position.offCourseMeters > 50) warn();
```

`offCourse` is the same quantity the Firebase output has always published as
`path_distoff`, and which the scoring system already consumes, so the two
outputs now agree rather than describing one thing two ways.

## v0.12.0 — the running order is published

**Added `race.orderIndex`**, a race's position in the meet's running order from
0, present in both the meet list and every `race` message.

**Sort on it.** Previously the only way to know the order was the sequence
messages arrived in, which is correct for the burst sent on `subscribe` and
wrong from then on: every later message is pushed on its own as that race
changes, so a consumer holding races by id had nothing to lay them out by.

## v0.12.0 — races carry a programme number and a start time

**Added `race.eventNumber`** — the number the race carries in the meet
programme, or null for a road race with a single start. Where a meet uses them,
this is the natural key to match races against your own records.

**Added `race.scheduledStart`** — `"HH:MM"`, 24-hour, **local to the venue**
rather than an instant. A schedule is written in the time at the meet and does
not move because a server is in another zone. Combine it with the meet's
`startDate` if you need an absolute time, and note that it is what was planned:
`status` and `sessionId` are what happened.

Both appear in the meet list as well as in `race` messages.

## v0.11.1 — the meet list gained identity

**Added `startDate` and `endDate`** to each meet, and `units`, `courseLength`,
`courseLengthMeters` and `sessionId` to each race in the list — so a meet can
be matched without subscribing to it first. `meetId` remains the anchor where
both systems have it; the dates and distances are the fallback where they do
not, because names do not distinguish meets.

**The list is requestable at any time**, not only on connect:

```js
socket.emit('events', null, (res) => console.log(res.events));
```

## v0.11.1 — one token per consumer

**Tokens are now created individually, with a label**, under **System → Live
feed** in the console, rather than there being a single shared token.

**Nothing to change in a client.** A token still goes in the handshake exactly
as before, and the single token that existed before this release keeps working
— it is carried into the new list the first time it is used.

What it buys: a consumer can be revoked without disconnecting every other one,
and the console can show which consumers are connected and what each is
watching. **Revoking or disabling a token disconnects it immediately**, not at
its next reconnect.

## v0.11.0 — the feed

First release. `/feed` namespace, token in the handshake, `hello` → `subscribe`
→ `race`. See [live-feed.md](live-feed.md).
