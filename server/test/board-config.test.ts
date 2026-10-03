import { describe, expect, it } from 'vitest';
import { BOARD_THEMES, defaultBoard, normaliseBoard } from '../src/config/board.js';

/**
 * What the board will accept as its configuration.
 *
 * The board has no controls on it and nobody standing at it. It is on a screen
 * in a truck or behind a finish line, and the only thing worse than it showing
 * the wrong colour is it showing nothing - so every field falls back rather
 * than refusing, and the whole thing is rebuilt from defaults when what was
 * stored turns out to be rubbish.
 */

describe('what survives a bad config', () => {
  it('builds a whole board from nothing at all', () => {
    for (const junk of [null, undefined, 'board', 42, []]) {
      expect(normaliseBoard(junk)).toEqual(defaultBoard());
    }
  });

  it('keeps the good fields and replaces only the bad ones', () => {
    const out = normaliseBoard({ units: 'kilometers', decimals: 'two', value: 'sideways', zoom: 3 });
    expect(out.units).toBe('kilometers');
    expect(out.zoom).toBe(3);
    expect(out.decimals).toBe(defaultBoard().decimals);
    expect(out.value).toBe(defaultBoard().value);
  });

  it('holds zoom and type scale inside what can actually be drawn', () => {
    expect(normaliseBoard({ zoom: 500 }).zoom).toBe(12);
    expect(normaliseBoard({ zoom: -4 }).zoom).toBe(1);
    expect(normaliseBoard({ layout: { typeScale: 99 } }).layout.typeScale).toBe(1.8);
  });
});

describe('colours', () => {
  it('takes hex in the forms a colour picker produces', () => {
    for (const c of ['#fff', '#FFFF', '#00b140', '#00b140ff']) {
      expect(normaliseBoard({ theme: { bg: c } }).theme.bg).toBe(c);
    }
  });

  it('refuses anything that is not a colour, because these reach a style attribute', () => {
    // A field that accepts arbitrary text here is a way to put CSS of someone
    // else's choosing on a screen that is going out live.
    const attacks = [
      'red; background-image: url(http://example.com/x)',
      'url(javascript:alert(1))',
      'var(--x)',
      'expression(alert(1))',
      '#ggg',
      '',
    ];
    for (const bad of attacks) {
      expect(normaliseBoard({ theme: { bg: bad } }).theme.bg).toBe(BOARD_THEMES.primetime.bg);
    }
  });

  it('caps the wordmark rather than letting it run across the footer', () => {
    const long = 'A'.repeat(200);
    expect(normaliseBoard({ theme: { brandText: long } }).theme.brandText).toHaveLength(24);
  });

  it('carries a whole preset through untouched', () => {
    expect(normaliseBoard({ theme: BOARD_THEMES.chroma }).theme).toEqual(BOARD_THEMES.chroma);
  });
});

describe('groups', () => {
  it('keeps each role’s own settings', () => {
    const out = normaliseBoard({
      groups: {
        mens_lead: { shown: true, distance: false, marker: true, color: '#e11d48' },
        wc_lead: { shown: false },
      },
    });
    expect(out.groups.mens_lead).toEqual({ shown: true, distance: false, marker: true, color: '#e11d48' });
    // A partial entry is filled in rather than dropped.
    expect(out.groups.wc_lead.shown).toBe(false);
    expect(out.groups.wc_lead.marker).toBe(true);
  });

  it('drops an order entry that is not a string', () => {
    expect(normaliseBoard({ order: ['a', 7, null, 'b'] }).order).toEqual(['a', 'b']);
  });

  it('only takes a centre that is a real pair of numbers', () => {
    expect(normaliseBoard({ center: [-84.3, 30.4] }).center).toEqual([-84.3, 30.4]);
    for (const bad of [[1], ['a', 'b'], 'middle', [1, 2, 3]]) {
      expect(normaliseBoard({ center: bad }).center).toBeNull();
    }
  });
});
