import { describe, expect, it } from 'vitest';
import { inRunningOrder, RaceSchema } from '../src/config/schema.js';

/**
 * The running order is presented by the console, the live feed and the
 * snapshot, so it has one definition and these tests pin its edges: what
 * happens when nothing is ordered, when only some races are, and when two
 * share a number.
 */

const race = (id: string, order?: number) => ({ id, order });

describe('the running order of an event', () => {
  it('leaves an event that sets no order exactly as it was', () => {
    const races = [race('c'), race('a'), race('b')];
    expect(inRunningOrder(races).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('sorts by order where it is set', () => {
    const races = [race('third', 30), race('first', 10), race('second', 20)];
    expect(inRunningOrder(races).map((r) => r.id)).toEqual(['first', 'second', 'third']);
  });

  it('puts unordered races after ordered ones, not before', () => {
    // "No opinion" must not outrank an explicit 1, or adding an order to one
    // race would silently push every other race to the front.
    const races = [race('unset'), race('second', 2), race('alsoUnset'), race('first', 1)];
    expect(inRunningOrder(races).map((r) => r.id)).toEqual(['first', 'second', 'unset', 'alsoUnset']);
  });

  it('breaks ties by file position, so the result is stable', () => {
    const races = [race('a', 5), race('b', 5), race('c', 5)];
    expect(inRunningOrder(races).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('accepts negative and zero orders', () => {
    const races = [race('zero', 0), race('negative', -1), race('positive', 1)];
    expect(inRunningOrder(races).map((r) => r.id)).toEqual(['negative', 'zero', 'positive']);
  });

  it('does not mutate what it is given', () => {
    const races = [race('b', 2), race('a', 1)];
    inRunningOrder(races);
    expect(races.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('handles an empty list', () => {
    expect(inRunningOrder([])).toEqual([]);
  });
});

describe('the new race fields', () => {
  const base = { id: 'r1', name: 'Marathon', course: 'courses/x.kml' };

  it('accepts a race with none of them, so existing events still load', () => {
    const parsed = RaceSchema.parse(base);
    expect(parsed.eventNumber).toBeUndefined();
    expect(parsed.scheduledStart).toBeUndefined();
    expect(parsed.order).toBeUndefined();
  });

  it('accepts a 24-hour scheduled start', () => {
    expect(RaceSchema.parse({ ...base, scheduledStart: '09:00' }).scheduledStart).toBe('09:00');
    expect(RaceSchema.parse({ ...base, scheduledStart: '00:00' }).scheduledStart).toBe('00:00');
    expect(RaceSchema.parse({ ...base, scheduledStart: '23:59' }).scheduledStart).toBe('23:59');
  });

  it('rejects a time that is not one, rather than storing nonsense', () => {
    for (const bad of ['9:00', '24:00', '09:60', '9am', '09-00', '']) {
      expect(() => RaceSchema.parse({ ...base, scheduledStart: bad })).toThrow();
    }
  });

  it('requires the event number to be a whole number', () => {
    expect(RaceSchema.parse({ ...base, eventNumber: 12 }).eventNumber).toBe(12);
    expect(() => RaceSchema.parse({ ...base, eventNumber: 1.5 })).toThrow();
    expect(() => RaceSchema.parse({ ...base, eventNumber: -1 })).toThrow();
  });
});
