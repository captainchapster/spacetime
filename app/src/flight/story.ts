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
    past: (s) => s.innerHorizon > 0 && s.r < s.innerHorizon,
    text: 'The inner horizon. In this idealised spinning hole, the whole future of the outside universe would arrive here at once. What really happens is unknown.',
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
  { id: 'tidesLethal', past: (s) => s.tidalG > 1000, text: 'Tidal stretching beyond a thousand g. No ship, and no body, survives this.' },
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

/** Words for the end, when the ship reaches the singularity. */
export function epilogue(yourClock: string, farClock: string) {
  return [
    'The end of the journey.',
    `Your clock read ${yourClock}. Far from the hole, ${farClock} had passed.`,
    'Light from the outside universe kept reaching you until the very end.',
  ];
}
