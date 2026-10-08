/**
 * Captions for the moments that matter: crossing real landmarks of the black hole's geometry,
 * passing speed and time-dilation milestones. Each is said once per crossing, and the words
 * stay true to the physics.
 */

export interface StoryState {
  r: number;
  /** Inside the ergosphere (g_tt > 0). */
  inErgosphere: boolean;
  horizon: number;
  innerHorizon: number;
  isco: number;
  /** Outermost photon orbit (retrograde, equatorial). */
  photonOuter: number;
  /** Speed relative to the local non-rotating observer (c). */
  speed: number;
  /** Far-away time minus your time, in seconds. */
  timeAhead: number;
  /** Tidal stretching across the ship (g). */
  tidalG: number;
}

interface Beat {
  id: string;
  /** Whether we're "past" this landmark. A caption plays each time this becomes true. */
  past: (s: StoryState) => boolean;
  text: string;
  /** Said when going back out, if anything. */
  leaving?: string;
  /** A place in the hole's geometry (vs a speed, time or tidal milestone). */
  landmark?: boolean;
}

export interface Caption {
  text: string;
  /** Landmark captions describe where you are right now, so they interrupt others. */
  landmark: boolean;
  /** A caution: it is never dropped from the queue, only delayed, until it has been shown. */
  keep?: boolean;
}

const BEATS: Beat[] = [
  {
    id: 'photon',
    landmark: true,
    past: (s) => s.r < s.photonOuter,
    text: 'Entering the photon region. Light itself can circle the hole here, on orbits that never quite close.',
    leaving: 'Out of the photon region again.',
  },
  {
    id: 'isco',
    landmark: true,
    past: (s) => s.r < s.isco,
    text: 'Below the innermost stable orbit. Nothing can coast in a circle here: the disk\'s gas plunges from this edge.',
  },
  {
    id: 'ergosphere',
    landmark: true,
    past: (s) => s.inErgosphere,
    text: 'Inside the ergosphere. Space here is dragged around faster than any engine could resist: nothing can stand still.',
    leaving: 'You\'ve climbed back out of the ergosphere.',
  },
  {
    id: 'horizon',
    landmark: true,
    past: (s) => s.r < s.horizon,
    text: 'You have crossed the event horizon. Locally, nothing feels different. But every future now leads inward.',
  },
  {
    id: 'inner',
    landmark: true,
    past: (s) => s.innerHorizon > 1e-3 && s.r < s.innerHorizon + 0.25 * (s.horizon - s.innerHorizon),
    text: 'The inner horizon is close. Light from outside is arriving ever bluer. In a real black hole, it is thought that nothing passes through it intact.',
  },
  { id: 'v50', past: (s) => s.speed > 0.5, text: 'Half the speed of light, relative to anyone holding still here.' },
  { id: 'v90', past: (s) => s.speed > 0.9, text: 'Ninety percent of light speed. The sky is crowding toward where you\'re heading.' },
  { id: 'v99', past: (s) => s.speed > 0.99, text: 'Ninety-nine percent of light speed.' },
  { id: 'hour', past: (s) => s.timeAhead > 3600, text: 'Far from here, an hour more has passed than for you.' },
  { id: 'day', past: (s) => s.timeAhead > 86400, text: 'Back home, a whole day more has passed than for you.' },
  { id: 'year', past: (s) => s.timeAhead > 3.156e7, text: 'Back home, a year more has gone by than for you.' },
  {
    id: 'tides',
    past: (s) => s.tidalG > 1,
    text: 'Tides stretch the ship by more than one g from nose to tail. Near a small black hole they grow lethal long before the horizon.',
  },
  {
    id: 'tidesStrain',
    past: (s) => s.tidalG > 100,
    text: 'Tidal stretching past a hundred g: the hull is straining. Near a thousand g it will fail.',
  },
];

export class Story {
  private past = new Map<string, boolean>();

  /** Forget everything (a new journey). The first update afterwards sets the scene silently. */
  reset() {
    this.past.clear();
  }

  /** New captions triggered by this state (empty most of the time). */
  update(s: StoryState): Caption[] {
    const out: Caption[] = [];
    const first = this.past.size === 0;
    for (const b of BEATS) {
      const now = b.past(s);
      const before = this.past.get(b.id);
      this.past.set(b.id, now);
      if (first || before === undefined || before === now) continue;
      const landmark = b.landmark ?? false;
      if (now) out.push({ text: b.text, landmark });
      else if (b.leaving) out.push({ text: b.leaving, landmark });
    }
    return out;
  }
}

export type Fate = 'innerHorizon' | 'singularity' | 'tidal';

/** Words for the end of the journey: a title, then lines. */
export function epilogue(fate: Fate, yourClock: string, farClock: string) {
  const clocks = `Your clock read ${yourClock}. By the far-away clock, ${farClock} had passed.`;
  switch (fate) {
    case 'innerHorizon':
      return [
        'The end of the journey: the inner horizon.',
        clocks,
        'In the exact equations of a spinning black hole you would cross it calmly, and go on past a ring-shaped singularity into other universes.',
        'A real black hole is expected to be different. For anyone falling in long after it formed, this half of the inner horizon becomes an effective shock wave, crushing them in a vanishing instant (Marolf & Ori, 2012). Its other half, where all of the outside universe’s future arrives, becomes a singularity (mass inflation).',
        'The flash is an illustration of that, not a calculation.',
      ];
    case 'tidal':
      return [
        'The end of the journey: torn apart by tides.',
        clocks,
        'The difference in gravity between the nose and tail of the ship passed a thousand g, and the hull failed. Near a small black hole this happens long before the horizon; near a giant one, only deep inside.',
      ];
    default:
      return [
        'The end of the journey: the singularity.',
        clocks,
        'Inside a black hole without spin, the singularity is not a place ahead of you but a moment: every future path reaches it.',
        'Light from the outside universe kept reaching you until the very end.',
      ];
  }
}
