import { describe, expect, it } from 'vitest';
import { Story, type StoryState } from '../src/flight/story';

const base: StoryState = {
  r: 30,
  inErgosphere: false,
  horizon: 1.31,
  innerHorizon: 0.69,
  isco: 1.94,
  photonOuter: 3.9,
  speed: 0,
  timeAhead: 0,
  tidalG: 0,
};

describe('landmark captions', () => {
  it('stays quiet on the first look, then speaks once per crossing, in order', () => {
    const story = new Story();
    expect(story.update(base)).toEqual([]); // where you start isn't news
    expect(story.update({ ...base, r: 20 })).toEqual([]);
    const said: string[] = [];
    for (const r of [3.5, 2.5, 1.8, 1.2, 0.5]) {
      said.push(...story.update({ ...base, r, inErgosphere: r < 2 }).map((c) => c.text));
    }
    expect(said.map((t) => t.split(' ').slice(0, 3).join(' '))).toEqual([
      'Entering the photon',
      'Below the innermost',
      'Inside the ergosphere.',
      'You have crossed',
      'The inner horizon',
    ]);
    // Nothing repeats while you stay put.
    expect(story.update({ ...base, r: 0.5, inErgosphere: true })).toEqual([]);
  });

  it('notices leaving, and doesn\'t narrate a fresh start', () => {
    const story = new Story();
    story.update({ ...base, r: 1.9, inErgosphere: true }); // started inside: silent
    expect(story.update({ ...base, r: 2.1, inErgosphere: false })).toEqual([
      { text: "You've climbed back out of the ergosphere.", landmark: true },
    ]);
  });

  it('marks speed and time-dilation milestones', () => {
    const story = new Story();
    story.update(base);
    expect(story.update({ ...base, speed: 0.95 })).toHaveLength(2); // passed both 0.5c and 0.9c
    const time = story.update({ ...base, speed: 0.95, timeAhead: 90000 });
    expect(time[0].text).toMatch(/hour/);
    expect(time[0].landmark).toBe(false);
  });
});
