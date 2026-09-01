import { describe, expect, it } from 'vitest';
import { RaceResultClient, normalizeDevice } from '../src/decoders/raceresult.js';

/** Shapes taken from the three families RaceResult reports. */
const DECODER = {
  Customer: 32993,
  DeviceID: 'D-1042',
  DeviceName: 'Finish Decoder',
  DeviceType: 'Decoder',
  Connected: true,
  BatteryCharge: 78,
  Temperature: 24.5,
  RecordsCount: 1841,
  FileNo: '17',
  RealTime: '2026-09-01T10:14:02',
  RealTimeAtRequest: '2026-09-01T10:14:03',
  Received: '2026-09-01T10:14:03Z',
  Position: { Flag: 'US', Latitude: 38.9012, Longitude: -92.3301 },
  DecoderStatus: {
    Firmware: '3.14.2',
    HasPower: true,
    IsInTimingMode: true,
    ReaderIsHealthy: true,
    TimeIsRunning: true,
    ReaderTemperature: 31.2,
    TimeSource: 'GPS',
    IsInStandby: false,
    ErrorFlags: '0',
  },
};

const TRACKBOX = {
  Customer: 32993,
  DeviceID: 'TB-88',
  DeviceName: 'Split 5k',
  DeviceType: 'TrackBox',
  Connected: false,
  BatteryCharge: 41,
  Position: { Flag: '', Latitude: 38.9105, Longitude: -92.3417 },
  DecoderStatus: null,
  TrackboxStatus: {
    Firmware: '1.8.0',
    HasPower: false,
    IsInTimingMode: true,
    IsTimeRunning: false,
    ReaderTemperature: 19.8,
    TimeSource: 'Internal',
    IsInStandby: true,
    ErrorFlags: '2',
  },
};

const UBIDIUM = {
  Customer: 32993,
  System: { DeviceID: 'UB-7', DeviceName: 'Start Ubidium', Firmware: '2.0.1', Temperature: 27 },
  ConnStatus: 1, // 0/1, not a boolean
  Time: { Time: '2026-09-01T10:13:59', DeviceTimeAtRequest: '2026-09-01T10:14:03', Received: '2026-09-01T10:14:03Z' },
  Power: { Source: 1, Battery1: { Level: 64 } },
  Position: { Flag: 'US', Latitude: 38.8998, Longitude: -92.3288 },
  Data: { FileNumber: 17 },
};

describe('RaceResult device normalising', () => {
  it('reads a decoder', () => {
    const d = normalizeDevice(DECODER, 1000)!;
    expect(d.deviceId).toBe('D-1042');
    expect(d.type).toBe('Decoder');
    expect(d.connected).toBe(true);
    expect(d.lat).toBeCloseTo(38.9012, 4);
    expect(d.battery).toBe(78);
    expect(d.firmware).toBe('3.14.2');
    expect(d.inTimingMode).toBe(true);
    expect(d.readerHealthy).toBe(true);
    // the pair that shows clock drift is kept as reported
    expect(d.deviceTime).toBe('2026-09-01T10:14:02');
    expect(d.requestTime).toBe('2026-09-01T10:14:03');
    expect(d.seenMs).toBe(1000);
  });

  it("reads a TrackBox, whose status lives under a different key and names things differently", () => {
    const d = normalizeDevice(TRACKBOX, 1000)!;
    expect(d.type).toBe('TrackBox');
    expect(d.connected).toBe(false);
    expect(d.firmware).toBe('1.8.0');
    expect(d.hasPower).toBe(false);
    // TrackBox calls this IsTimeRunning where a decoder says TimeIsRunning
    expect(d.timeRunning).toBe(false);
    expect(d.inStandby).toBe(true);
    expect(d.readerTemperature).toBeCloseTo(19.8, 1);
  });

  it('reads a Ubidium, where everything is nested and connection is a number', () => {
    const d = normalizeDevice(UBIDIUM, 1000)!;
    expect(d.deviceId).toBe('UB-7');
    expect(d.name).toBe('Start Ubidium');
    expect(d.type).toBe('Ubidium');
    expect(d.connected).toBe(true); // ConnStatus 1
    expect(d.battery).toBe(64); // Power.Battery1.Level
    expect(d.firmware).toBe('2.0.1');
    expect(d.fileNo).toBe('17'); // Data.FileNumber, a number in the source
    expect(d.hasPower).toBe(true); // Power.Source !== 0
    expect(d.lon).toBeCloseTo(-92.3288, 4);
  });

  it('treats ConnStatus 0 as offline, not as missing', () => {
    const d = normalizeDevice({ ...UBIDIUM, ConnStatus: 0 }, 1000)!;
    expect(d.connected).toBe(false);
  });

  it('falls back to the active-connection flags when ConnStatus is absent', () => {
    const { ConnStatus, ...noStatus } = UBIDIUM;
    expect(normalizeDevice({ ...noStatus, ActiveInternal: { Connected: true } }, 1)!.connected).toBe(true);
    expect(normalizeDevice({ ...noStatus, ActiveInternal: { Connected: false } }, 1)!.connected).toBe(false);
  });

  it('treats a -1 battery as no reading, not as flat', () => {
    // Mains-powered boxes report -1. Passed through it renders as a dead
    // battery and puts a red bar against a perfectly healthy decoder.
    expect(normalizeDevice({ ...DECODER, BatteryCharge: -1 }, 1)!.battery).toBeUndefined();
    const ub = { ...UBIDIUM, Power: { Source: 1, Battery1: { Level: -1 } } };
    expect(normalizeDevice(ub, 1)!.battery).toBeUndefined();
    // a real reading of 0 is still a real reading
    expect(normalizeDevice({ ...DECODER, BatteryCharge: 0 }, 1)!.battery).toBe(0);
  });

  it('drops a shape it does not recognise rather than half-reading it', () => {
    expect(normalizeDevice({ Something: 'else' }, 1)).toBeNull();
    expect(normalizeDevice(null as never, 1)).toBeNull();
  });
});

/** A fetch stand-in that records calls and answers from a script. */
function fakeFetch(steps: Array<{ status: number; body: unknown }>) {
  const calls: string[] = [];
  const fn = async (url: string | URL | Request) => {
    calls.push(String(url));
    const step = steps.shift() ?? { status: 500, body: 'no more steps' };
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      statusText: String(step.status),
      text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body)),
      json: async () => step.body,
    } as Response;
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('RaceResult client', () => {
  it('caches the token across calls rather than asking every time', async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { access_token: 'tok', expires_in: 7200 } },
      { status: 200, body: { Devices: [DECODER] } },
      { status: 200, body: { Devices: [DECODER] } },
    ]);
    const c = new RaceResultClient({ apiKey: 'k', customerId: 1 }, fn);
    await c.listDevices();
    await c.listDevices();
    // one token, two device calls — the API rations tokens
    expect(calls.filter((u) => u.endsWith('/token'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/devices'))).toHaveLength(2);
  });

  it('asks for one token when several calls race', async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { access_token: 'tok', expires_in: 7200 } },
      { status: 200, body: { Devices: [] } },
      { status: 200, body: { Devices: [] } },
      { status: 200, body: { Devices: [] } },
    ]);
    const c = new RaceResultClient({ apiKey: 'k', customerId: 1 }, fn);
    await Promise.all([c.listDevices(), c.listDevices(), c.listDevices()]);
    expect(calls.filter((u) => u.endsWith('/token'))).toHaveLength(1);
  });

  it('refreshes the token once on a 401 and retries', async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { access_token: 'stale', expires_in: 7200 } },
      { status: 401, body: '' },
      { status: 200, body: { access_token: 'fresh', expires_in: 7200 } },
      { status: 200, body: { Devices: [DECODER] } },
    ]);
    const c = new RaceResultClient({ apiKey: 'k', customerId: 1 }, fn);
    const devices = await c.listDevices();
    expect(devices).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/token'))).toHaveLength(2);
  });

  it('reports the token limit plainly so the poller can back off', async () => {
    const { fn } = fakeFetch([{ status: 406, body: '' }]);
    const c = new RaceResultClient({ apiKey: 'k', customerId: 1 }, fn);
    await expect(c.listDevices()).rejects.toThrow(/406/);
  });

  it('accepts a bare-string token response', async () => {
    const { fn } = fakeFetch([
      { status: 200, body: '"just-a-token"' },
      { status: 200, body: { Devices: [] } },
    ]);
    const c = new RaceResultClient({ apiKey: 'k', customerId: 1 }, fn);
    await expect(c.listDevices()).resolves.toEqual([]);
  });

  it('mixes the three families in one list', async () => {
    const { fn } = fakeFetch([
      { status: 200, body: { access_token: 't' } },
      { status: 200, body: { Devices: [DECODER, TRACKBOX, UBIDIUM] } },
    ]);
    const c = new RaceResultClient({ apiKey: 'k', customerId: 1 }, fn);
    const list = await c.listDevices();
    expect(list.map((d) => d.type)).toEqual(['Decoder', 'TrackBox', 'Ubidium']);
  });
});
