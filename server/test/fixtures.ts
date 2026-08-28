/** Shared test fixtures. */

// Real 22-field GL300 GTFRI frames captured at a 2022 event (legacy/logs).
export const REAL_GTFRI_22 =
  '+RESP:GTFRI,F50A01,015181000128000,,0,0,1,1,0.0,0,811.5,-113.582319,37.063092,20221028094541,0310,0410,9909,06F23911,,100,20221028094542,75C4$';

export const REAL_GTFRI_22_NEXT =
  '+RESP:GTFRI,F50A01,015181000128000,,0,0,1,1,0.0,0,811.5,-113.582319,37.063092,20221028094546,0310,0410,9909,06F23911,,100,20221028094547,75C5$';

// Synthetic 27-field GL30 frame (layout from the legacy port-1001 parser:
// csq_rssi, csq_ber, battery_volt at 18–20, battery at 21, sendTime 25, count 26).
export const GTFRI_27 =
  '+RESP:GTFRI,110302,860201060067272,GL300,0,0,1,1,4.2,178,23.4,-71.517991,42.229944,20260420150001,0310,0260,2F67,0A5C0B3,16,99,4.12,87,1,0,,20260420150003,0A2B$';

// @Track (GL300/320 family) frame as relayed on the Franklin-GPS mirror.
export const MIRROR_ASCII =
  '+RESP:GTFRI,930402,860931070051250,,0,0,1,1,6.4,90,301.3,-84.363354,33.849298,20260818151005,0310,0260,0D5B,0B4DF13,,95,20260818151007,018A$';

// GV500CNA ACK relay — no position, but must be framed correctly.
export const MIRROR_ACK = '+ACK:RTO,865134050946566,8203,3,0,1,028A,20260826140331,0005$';

// The worked example from the @Track Protocol Pro doc (§7): one 50H fixed report.
// IMEI 123456789012345, lon −115.300127, lat −13.778794, utc 1595383200,
// speed 38.1 km/h, HDOP 1.0, azimuth 37°, altitude 43.5 m, 12 sats, count 291, CRC 0x34.
export const PRO_REPORT_HEX =
  '2b0000380001234567890123458203000a00002166' +
  '8e47f7000050005216' +
  '09f920a8e1ff2dc0965f179da0017d0a002500' +
  '01b30c012334' +
  '24';

export const PRO_REPORT = Buffer.from(PRO_REPORT_HEX, 'hex');
