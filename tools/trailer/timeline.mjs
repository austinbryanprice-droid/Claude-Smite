// When everything in the trailer happens, in seconds. compose.html cuts the
// picture to it and score.ts lays the narration, music and effects on it.
// The music runs at 96 bpm from the title hit, so a bar is 2.5 s: the god
// cuts land on bar lines.

export const FPS = 30;
export const LENGTH = 88;
export const TITLE = 7.4;
export const BAR = 2.5;

/** Narration line starts (ids from script.json). */
export const VOICE = {
  open1: 1.0,
  open2: 5.1,
  choose: 10.5,
  zeus: 12.7,
  thor: 15.2,
  odin: 17.7,
  loki: 20.2,
  anubis: 22.7,
  skills1: 26.0,
  skills2: 31.6,
  trees: 42.2,
  conquest: 52.8,
  jungle: 63.6,
  bosses: 68.6,
  multi: 74.4,
  close1: 79.8,
  close2: 83.2,
};

/** Hero clips: which god, and when its cut starts (each one a bar long). */
export const HEROES = ['zeus', 'thor', 'odin', 'loki', 'anubis'].map((god, i) => ({ god, at: TITLE + BAR * (2 + i) }));

/** The final hit, on "Ascend". */
export const FINALE = VOICE.close2;
