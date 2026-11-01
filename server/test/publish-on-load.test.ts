import { describe, expect, it } from 'vitest';
import { initialPublishing } from '../src/app.js';
import { EventSchema } from '../src/config/schema.js';

/**
 * An event that comes up quiet.
 *
 * Publishing defaults to on, which is right for a meet with its own
 * scoreboard and wrong for the ones where it matters most: an event built on
 * the morning of a race shares a Firebase meet with whatever is already on
 * air, and the cost of coming up live is a number appearing on a screen in
 * front of a crowd. `publishOnLoad: false` lets the event say so itself,
 * rather than relying on somebody reaching the switch first.
 *
 * The ordering is the substance. An operator who has flipped the switch has
 * made a decision, and a restart — or a deploy mid-meet — must not undo it.
 */

const base = {
  id: 'e', name: 'E', meetId: 1,
  trackers: [], vehicles: [], roles: [], races: [],
};

describe('where the publishing switch starts', () => {
  it('is on when nothing has an opinion — unchanged from before', () => {
    expect(initialPublishing({}, undefined, undefined)).toBe(true);
  });

  it('is off when the event asks to come up quiet', () => {
    expect(initialPublishing({ publishOnLoad: false }, undefined, undefined)).toBe(false);
  });

  it('THE OPERATOR OUTRANKS THE FILE — a switch flipped on stays on', () => {
    // The case that matters: they turned outputs on for the race, then the
    // box restarted. Coming back silent because the file still says "quiet"
    // would lose the scoreboard with nothing on screen to say why.
    expect(initialPublishing({ publishOnLoad: false }, '1', undefined)).toBe(true);
  });

  it('  and a switch flipped off stays off, whatever the file says', () => {
    expect(initialPublishing({ publishOnLoad: true }, '0', undefined)).toBe(false);
  });

  it('the old global setting still applies to an event that says nothing', () => {
    expect(initialPublishing({}, undefined, '0')).toBe(false);
    expect(initialPublishing({}, undefined, '1')).toBe(true);
  });

  it('  but the event outranks it, since the global is only a migration', () => {
    expect(initialPublishing({ publishOnLoad: false }, undefined, '1')).toBe(false);
  });

  it('is a real config field, and optional', () => {
    expect(EventSchema.parse({ ...base, publishOnLoad: false }).publishOnLoad).toBe(false);
    expect(EventSchema.parse(base).publishOnLoad).toBeUndefined();
  });

  it('survives a round-trip through the schema, so Setup cannot drop it', () => {
    // Event Setup reads the config, edits part of it and writes the whole
    // thing back; a field the form does not know about has to come through
    // that unchanged or it would quietly revert on the next save.
    const once = EventSchema.parse({ ...base, publishOnLoad: false });
    expect(EventSchema.parse(JSON.parse(JSON.stringify(once))).publishOnLoad).toBe(false);
  });
});
