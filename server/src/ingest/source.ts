import net from 'node:net';
import { MixedFramer } from './framer.js';
import { parseAsciiFrame } from './parsers/ascii-gtfri.js';
import { parseBinaryFrame, parseHeartbeat } from './parsers/binary-pro.js';
import type { Fix, Telemetry } from './types.js';

export interface SourceEvents {
  onFix: (fix: Fix) => void;
  onTelemetry: (t: Telemetry) => void;
  onConnection: (event: 'connect' | 'close' | 'error', ip: string, source: string) => void;
  onRawFrame?: (raw: string, source: string, ip: string) => void;
}

export interface ListenerConfig {
  name: string;
  port: number;
}

/**
 * One TCP listener = one source. Devices (or the Franklin-GPS mirror) connect
 * inbound; each connection gets its own MixedFramer, which handles pure-ASCII
 * GL-family streams and the mixed ASCII+binary mirror identically. One-way:
 * nothing is written back to the socket.
 */
export function startListener(cfg: ListenerConfig, events: SourceEvents): net.Server {
  const server = net.createServer((sock) => {
    const ip = (sock.remoteAddress ?? '?').replace('::ffff:', '');
    const framer = new MixedFramer();
    events.onConnection('connect', ip, cfg.name);

    sock.on('data', (chunk: Buffer) => {
      const receivedAtMs = Date.now();
      for (const frame of framer.push(chunk)) {
        try {
          if (frame.kind === 'ascii') {
            events.onRawFrame?.(frame.text, cfg.name, ip);
            const { fix, telemetry } = parseAsciiFrame(frame.text, cfg.name, receivedAtMs);
            if (fix) events.onFix(fix);
            if (telemetry) events.onTelemetry(telemetry);
          } else if (frame.kind === 'binary') {
            events.onRawFrame?.(frame.bytes.toString('hex'), cfg.name, ip);
            const { fixes, telemetry } = parseBinaryFrame(frame.bytes, cfg.name, receivedAtMs);
            fixes.forEach(events.onFix);
            telemetry.forEach(events.onTelemetry);
          } else {
            events.onTelemetry(parseHeartbeat(frame.bytes, cfg.name, receivedAtMs));
          }
        } catch (err) {
          // A malformed frame must never take down the listener mid-race.
          console.error(`[${cfg.name}] frame parse error:`, err);
        }
      }
    });
    sock.on('error', () => events.onConnection('error', ip, cfg.name));
    sock.on('close', () => events.onConnection('close', ip, cfg.name));
  });

  server.listen(cfg.port, () => {
    console.log(`[ingest] listener "${cfg.name}" on tcp:${cfg.port}`);
  });
  return server;
}
