import type { Server as SocketIOServer } from 'socket.io';
import type { AuthService } from './auth.js';

/**
 * The live feed: a machine-facing socket.io namespace for other software to
 * consume race distances in real time.
 *
 * This is deliberately not the console's socket. The console gets the internal
 * snapshot, which changes shape whenever the UI needs something different; an
 * external consumer needs a contract that does not move under it. So the feed
 * has its own namespace, its own token, and its own payload shape, and
 * `PROTOCOL` is bumped if that shape ever changes incompatibly.
 *
 * The one thing worth understanding before reading the rest: a distance that
 * has stopped updating is more dangerous than no distance at all, because it
 * still looks like an answer. Every position therefore carries the age of the
 * fix it came from, and a `stale` flag computed against the event's own
 * reporting interval.
 */

export const PROTOCOL = 1;

/** Multiples of the expected reporting interval before a position is suspect. */
const STALE_AFTER_INTERVALS = 3;
/** Used when an event does not configure one; the Queclink default. */
const DEFAULT_INTERVAL_S = 10;

const MI_PER_KM = 0.621371;
/** Course distances are in the race's own units; consumers should not have to care. */
const toMeters = (v: number, units: string): number =>
  units === 'miles' ? (v / MI_PER_KM) * 1000 : v * 1000;

/**
 * Rounded on the way out.
 *
 * The engine's numbers carry full float precision, which over the wire becomes
 * both noise (11.992460300000001) and a false claim: a distance quoted to
 * fifteen places implies nanometre accuracy from a GPS unit good to a few
 * metres. Four decimals of a mile is about 16cm, which is far finer than
 * anything upstream can actually support.
 */
const round = (v: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

export interface FeedPosition {
  lat: number | null;
  lon: number | null;
  /** Ground speed as the tracker reports it. */
  speedKmh: number | null;
  /** The same speed in mph, for convenience. */
  speedMph: number | null;
  /** Epoch ms the device says the fix was taken. */
  fixMs: number | null;
  /** Epoch ms this server received it. Ages are measured from this. */
  receivedMs: number | null;
  /**
   * Seconds since the server received the fix.
   *
   * Measured against receipt rather than the device's own clock: a tracker
   * with a wrong clock would otherwise report positions that look hours old,
   * or worse, permanently fresh.
   */
  ageS: number | null;
  /** The fix is old enough that the distance should not be trusted. */
  stale: boolean;
  /**
   * How far this fix was from the course line, in metres.
   *
   * Never exactly zero in practice - a vehicle drives in a lane, not along a
   * centreline, and consumer GPS is good to a few metres. Read it as a
   * magnitude, not as a yes/no: `suspect` is the flag.
   */
  offCourseMeters: number | null;
  /**
   * The fix is further off the course than the race allows (its
   * `maxOffCourse`, 0.25 course units by default), so the distance derived
   * from it should not be trusted. A wrong turn, a detour, or a bad lock.
   */
  suspect: boolean;
  gpsQuality: 'good' | 'ok' | 'poor' | null;
}

export interface FeedRole {
  /** Stable identifier for this position in the race, e.g. "lead". */
  key: string;
  label: string;
  /** Which vehicle is currently covering the role, if any. */
  vehicle: string | null;
  /** The tracker currently supplying this role's position. */
  imei: string | null;
  /** Where the distance comes from: normally GPS, or timing splits. */
  source: 'gps' | 'splits';
  /** Distance along the course, in the race's units. Null when not yet known. */
  distance: number | null;
  /** The same distance in metres, so consumers need not care about units. */
  distanceMeters: number | null;
  position: FeedPosition | null;
}

export interface FeedRace {
  id: string;
  name: string;
  /**
   * This race's position in the meet's running order, from 0.
   *
   * Sort by this. Arrival order only conveys the order for the burst you get
   * on subscribe: after that, each race is pushed as it changes, so a consumer
   * holding races by id and updating them has no other way to lay them out.
   */
  orderIndex: number;
  /** Programme number, where the meet uses them. */
  eventNumber: number | null;
  /** Scheduled start as "HH:MM", local to the meet. Null if not scheduled. */
  scheduledStart: string | null;
  status: string;
  /** 'miles' or 'kilometers' - the units `distance` and `courseLength` use. */
  units: string;
  courseLength: number;
  courseLengthMeters: number;
  /** Identifies one run of this race; changes when the race is reset. */
  sessionId: number | null;
  roles: FeedRole[];
}

/**
 * Enough to recognise a meet without subscribing to it.
 *
 * A consumer usually has its own record of the same event and needs to line
 * the two up. `meetId` is the anchor where both systems know it; the dates and
 * the course length are what you fall back on when they do not, since "10K" is
 * not a distinguishing name and two meets can share one.
 */
export interface FeedEventSummary {
  id: string;
  name: string;
  meetId: number;
  /** ISO dates from the event's setup, where set. */
  startDate: string | null;
  endDate: string | null;
  races: Array<{
    id: string;
    name: string;
    /** Position in the running order, from 0. Matches the race messages. */
    orderIndex: number;
    eventNumber: number | null;
    scheduledStart: string | null;
    status: string;
    units: string;
    courseLength: number;
    courseLengthMeters: number;
    /** Present once the race has been run at least once; changes on reset. */
    sessionId: number | null;
  }>;
}

export interface FeedMessage {
  protocol: number;
  serverTimeMs: number;
  event: { id: string; name: string; meetId: number };
  race: FeedRace;
}

interface InternalSnapshot {
  events: Array<{
    event: {
      id: string;
      name: string;
      meetId: number;
      reportIntervalS?: number;
      startDate?: string | null;
      endDate?: string | null;
    };
    races: Array<{
      raceId: string;
      name: string;
      eventNumber?: number | null;
      scheduledStart?: string | null;
      status: string;
      units: string;
      courseLength: number;
      sessionId: number | null;
      roles: Array<{
        key: string;
        label: string;
        vehicle?: string | null;
        activeImei?: string | null;
        source?: string;
        cmd?: number;
      }>;
      trackers: Array<{
        imei: string;
        distance?: number | null;
        /** Perpendicular distance from the course line, in course units. */
        offCourse?: number;
        suspect?: boolean;
        gpsQuality?: 'good' | 'ok' | 'poor';
        lastFix?: {
        lat?: number;
        lon?: number;
        tUtcMs?: number;
        receivedAtMs?: number;
        speedKmh?: number;
      } | null;
      }>;
    }>;
  }>;
  simulated?: Record<string, { distance?: number } | undefined>;
}

/** Build the external shape for one event from the internal snapshot. */
export function feedMessages(snapshot: InternalSnapshot, nowMs: number): FeedMessage[] {
  const out: FeedMessage[] = [];

  for (const ev of snapshot.events ?? []) {
    const intervalS = ev.event.reportIntervalS || DEFAULT_INTERVAL_S;
    const staleAfterMs = intervalS * STALE_AFTER_INTERVALS * 1000;

    // Position in this array is the running order; app.snapshot() sorts it.
    for (const [orderIndex, race] of (ev.races ?? []).entries()) {
      const byImei = new Map(race.trackers.map((t) => [t.imei, t]));

      const roles: FeedRole[] = race.roles.map((role) => {
        const source = role.source === 'splits' ? 'splits' : 'gps';
        const tracker = role.activeImei ? byImei.get(role.activeImei) : undefined;

        // A splits-fed role has no tracker of its own; its distance arrives
        // keyed by role, by imei, or by the legacy numeric command id.
        const sim =
          snapshot.simulated?.[role.key] ??
          (role.activeImei ? snapshot.simulated?.[role.activeImei] : undefined) ??
          (role.cmd !== undefined ? snapshot.simulated?.[String(role.cmd)] : undefined);

        const distance = source === 'splits' ? (sim?.distance ?? null) : (tracker?.distance ?? null);
        const fix = tracker?.lastFix ?? null;
        const fixMs = typeof fix?.tUtcMs === 'number' ? fix.tUtcMs : null;
        const receivedMs = typeof fix?.receivedAtMs === 'number' ? fix.receivedAtMs : null;
        // Both clocks are ours when measured from receipt; the device's is not.
        const basis = receivedMs ?? fixMs;
        const ageS = basis === null ? null : Math.max(0, Math.round((nowMs - basis) / 1000));

        return {
          key: role.key,
          label: role.label,
          vehicle: role.vehicle ?? null,
          imei: role.activeImei ?? null,
          source,
          distance: distance === null || distance === undefined ? null : round(distance, 4),
          distanceMeters:
            distance === null || distance === undefined ? null : round(toMeters(distance, race.units), 1),
          position: fix
            ? {
                lat: fix.lat ?? null,
                lon: fix.lon ?? null,
                speedKmh: fix.speedKmh === undefined ? null : round(fix.speedKmh, 2),
                speedMph: fix.speedKmh === undefined ? null : round(fix.speedKmh * MI_PER_KM, 2),
                fixMs,
                receivedMs,
                ageS,
                stale: basis === null ? true : nowMs - basis > staleAfterMs,
                offCourseMeters:
                  typeof tracker?.offCourse === 'number'
                    ? round(toMeters(tracker.offCourse, race.units), 1)
                    : null,
                suspect: !!tracker?.suspect,
                gpsQuality: tracker?.gpsQuality ?? null,
              }
            : null,
        };
      });

      out.push({
        protocol: PROTOCOL,
        serverTimeMs: nowMs,
        event: { id: ev.event.id, name: ev.event.name, meetId: ev.event.meetId },
        race: {
          id: race.raceId,
          name: race.name,
          orderIndex,
          eventNumber: race.eventNumber ?? null,
          scheduledStart: race.scheduledStart ?? null,
          status: race.status,
          units: race.units,
          courseLength: round(race.courseLength, 4),
          courseLengthMeters: round(toMeters(race.courseLength, race.units), 1),
          sessionId: race.sessionId ?? null,
          roles,
        },
      });
    }
  }

  return out;
}

/** One entry in the meet list, from an event's internal snapshot. */
export function eventSummary(id: string, snap: InternalSnapshot['events'][number]): FeedEventSummary {
  return {
    id,
    name: snap.event.name,
    meetId: snap.event.meetId,
    startDate: snap.event.startDate ?? null,
    endDate: snap.event.endDate ?? null,
    // The snapshot's races are already in running order, so their position in
    // it is the order - derived in one place rather than recomputed here.
    races: snap.races.map((r, orderIndex) => ({
      id: r.raceId,
      name: r.name,
      orderIndex,
      eventNumber: r.eventNumber ?? null,
      scheduledStart: r.scheduledStart ?? null,
      status: r.status,
      units: r.units,
      courseLength: round(r.courseLength, 4),
      courseLengthMeters: round(toMeters(r.courseLength, r.units), 1),
      sessionId: r.sessionId ?? null,
    })),
  };
}

export interface FeedContext {
  apps: Map<string, { snapshot: () => unknown }>;
  snapshotFor: (eventId: string) => unknown;
}

export interface FeedConnection {
  /** Which token it authenticated with, so a noisy consumer can be identified. */
  tokenId: number | null;
  tokenLabel: string;
  ip: string;
  connectedMs: number;
  /** The meet it is watching, or null if it has not chosen one. */
  eventId: string | null;
}

export interface Feed {
  /** Rebuild and push an event's races to whoever is subscribed to it. */
  publish: (eventId: string) => void;
  /** Push every loaded event, for changes that are not race-scoped. */
  publishAll: () => void;
  /** Who is connected and what each one is listening to. */
  connections: () => FeedConnection[];
  /** Drop everyone using a token, for when it is revoked or disabled. */
  disconnectToken: (tokenId: number) => void;
}

export function attachFeed(io: SocketIOServer, ctx: FeedContext, auth: AuthService): Feed {
  const ns = io.of('/feed');
  const room = (eventId: string) => `feed:${eventId}`;

  ns.use((socket, next) => {
    const handshake = socket.handshake;
    const fromAuth = (handshake.auth as Record<string, unknown> | undefined)?.token;
    const fromQuery = handshake.query?.token;
    const header = handshake.headers?.['x-feed-token'];
    const token = [fromAuth, fromQuery, header].find((t) => typeof t === 'string') as string | undefined;

    const row = token ? auth.feedTokenRow(token) : undefined;
    if (!row) return next(new Error('invalid feed token'));

    socket.data.tokenId = row.id;
    socket.data.tokenLabel = row.label;
    next();
  });

  const summaries = (): FeedEventSummary[] =>
    [...ctx.apps.entries()].map(([id, app]) =>
      eventSummary(id, app.snapshot() as InternalSnapshot['events'][number]),
    );

  ns.on('connection', (socket) => {
    const ip = socket.handshake.address?.replace('::ffff:', '') ?? '?';
    socket.data.ip = ip;
    socket.data.connectedMs = Date.now();
    socket.data.eventId = null;
    if (typeof socket.data.tokenId === 'number') auth.noteFeedTokenUse(socket.data.tokenId, ip);
    console.log(`[feed] "${socket.data.tokenLabel}" connected from ${ip}`);

    // Everything a client needs to choose a meet, without a second round trip.
    socket.emit('hello', {
      protocol: PROTOCOL,
      serverTimeMs: Date.now(),
      events: summaries(),
    });

    socket.on('subscribe', (payload: unknown, ack?: (res: unknown) => void) => {
      const eventId =
        typeof payload === 'string' ? payload : (payload as { eventId?: string } | undefined)?.eventId;

      if (typeof eventId !== 'string' || !ctx.apps.has(eventId)) {
        const err = { ok: false, error: `no such event: ${String(eventId)}`, events: summaries() };
        if (ack) ack(err);
        else socket.emit('error', err);
        return;
      }

      // One event at a time keeps the client's handling simple; subscribing
      // again moves the subscription rather than adding to it.
      for (const r of socket.rooms) if (r.startsWith('feed:')) void socket.leave(r);
      void socket.join(room(eventId));
      socket.data.eventId = eventId;
      console.log(`[feed] "${socket.data.tokenLabel}" subscribed to ${eventId}`);

      const messages = feedMessages(ctx.snapshotFor(eventId) as InternalSnapshot, Date.now());
      if (ack) ack({ ok: true, eventId, races: messages.map((m) => m.race.id) });
      // The current state arrives immediately, so a client is never waiting on
      // the next change to find out where anything is.
      for (const m of messages) socket.emit('race', m);
    });

    socket.on('unsubscribe', () => {
      for (const r of socket.rooms) if (r.startsWith('feed:')) void socket.leave(r);
      socket.data.eventId = null;
    });

    socket.on('events', (_payload: unknown, ack?: (res: unknown) => void) => {
      if (ack) ack({ ok: true, events: summaries() });
      else socket.emit('hello', { protocol: PROTOCOL, serverTimeMs: Date.now(), events: summaries() });
    });

    socket.on('disconnect', () => console.log(`[feed] "${socket.data.tokenLabel}" from ${ip} disconnected`));
  });

  // Several races in an event can change in the same tick; rebuilding the
  // event's snapshot once per tick rather than once per race keeps a busy race
  // from doing the same work repeatedly.
  const pending = new Set<string>();
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    for (const eventId of pending) {
      const r = room(eventId);
      if (!ns.adapter.rooms.get(r)?.size) continue;
      for (const m of feedMessages(ctx.snapshotFor(eventId) as InternalSnapshot, Date.now())) {
        ns.to(r).emit('race', m);
      }
    }
    pending.clear();
  };

  const publish = (eventId: string): void => {
    pending.add(eventId);
    if (scheduled) return;
    scheduled = true;
    setImmediate(flush);
  };

  return {
    publish,
    connections: () =>
      [...ns.sockets.values()].map((socket) => ({
        tokenId: typeof socket.data.tokenId === 'number' ? socket.data.tokenId : null,
        tokenLabel: String(socket.data.tokenLabel ?? 'unknown'),
        ip: String(socket.data.ip ?? '?'),
        connectedMs: Number(socket.data.connectedMs ?? 0),
        eventId: typeof socket.data.eventId === 'string' ? socket.data.eventId : null,
      })),
    disconnectToken: (tokenId: number) => {
      for (const socket of ns.sockets.values()) {
        if (socket.data.tokenId === tokenId) socket.disconnect(true);
      }
    },
    publishAll: () => {
      for (const id of ctx.apps.keys()) publish(id);
      // The set of events itself may have changed, so anyone connected but not
      // yet subscribed gets a fresh menu.
      ns.emit('events', { protocol: PROTOCOL, serverTimeMs: Date.now(), events: summaries() });
    },
  };
}
