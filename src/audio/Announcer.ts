/**
 * The battlefield herald: an original set of spoken cues, each opened by a
 * musical sting. The voice is the browser's own speech synthesis, pitched
 * low and slowed into a herald's tone; if a browser has no voices, the
 * stings still play.
 */

import type { AudioEngine } from './AudioEngine';

export type Mood = 'good' | 'bad' | 'neutral' | 'epic';

interface Line {
  text: string;
  mood: Mood;
  at: number;
  priority: number;
}

const STINGS: Record<Mood, string> = { good: 'sting.good', bad: 'sting.bad', neutral: 'sting.neutral', epic: 'sting.epic' };

export class Announcer {
  private queue: Line[] = [];
  private speaking = false;
  private voice: SpeechSynthesisVoice | null = null;
  private readonly synth: SpeechSynthesis | null = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;

  constructor(private readonly engine: AudioEngine) {
    const pick = () => (this.voice = pickVoice(this.synth?.getVoices() ?? []));
    pick();
    this.synth?.addEventListener?.('voiceschanged', pick);
  }

  /** Queue a line; higher priority lines jump the queue, stale ones are dropped. */
  say(text: string, mood: Mood = 'neutral', priority = 1): void {
    if (!this.engine.ready) return;
    const now = performance.now();
    // the same line twice in a row (two towers falling at once) is said once
    if (this.queue.some((l) => l.text === text)) return;
    this.queue.push({ text, mood, at: now, priority });
    this.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    if (this.queue.length > 3) this.queue.length = 3;
    this.next();
  }

  private next(): void {
    if (this.speaking) return;
    const now = performance.now();
    this.queue = this.queue.filter((l) => now - l.at < 5000);
    const line = this.queue.shift();
    if (!line) return;
    this.speaking = true;
    this.engine.play(STINGS[line.mood], { bus: 'voice', gain: 0.8 }, 5);
    const done = () => {
      this.speaking = false;
      setTimeout(() => this.next(), 250);
    };
    const s = this.engine.settings;
    if (!this.synth || s.muted || s.voice <= 0.01) {
      setTimeout(done, 1200);
      return;
    }
    const u = new SpeechSynthesisUtterance(line.text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang ?? 'en-GB';
    u.pitch = 0.62;
    u.rate = 0.9;
    u.volume = Math.min(1, s.master * s.voice * 1.1);
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      done();
    };
    u.onend = end;
    u.onerror = end;
    // some engines never fire onend; never let the queue jam
    setTimeout(end, 600 + line.text.length * 110);
    setTimeout(() => this.synth!.speak(u), 380);
  }

  stop(): void {
    this.queue = [];
    this.synth?.cancel();
  }
}

/** A deep English voice if there is one: named male voices first, then British, then any English. */
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const male = /\b(male|daniel|george|arthur|ryan|guy|david|mark|james|thomas|oliver|fred|alex|aaron|brian)\b/i;
  return (
    en.find((v) => /google uk english male/i.test(v.name)) ??
    en.find((v) => male.test(v.name) && /gb|uk/i.test(v.lang + v.name)) ??
    en.find((v) => male.test(v.name)) ??
    en.find((v) => /en-gb/i.test(v.lang)) ??
    en[0] ??
    null
  );
}
