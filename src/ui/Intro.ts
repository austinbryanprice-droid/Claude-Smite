import type { AudioEngine } from '../audio/AudioEngine';
import './intro.css';

const BASE = import.meta.env.BASE_URL;

/**
 * The launch: a home page with one big Play button, then the intro trailer
 * (tools/trailer) with its sound. Browsers only allow sound after the player
 * clicks or presses a key, and the Play click is that gesture, so the trailer
 * always starts with its narration. Esc skips it. Resolves once it is over,
 * and the game keeps loading behind it the whole time.
 */
export function playIntro(audio: AudioEngine): Promise<void> {
  const root = document.createElement('div');
  root.className = 'intro';
  root.innerHTML = `
    <div class="intro-home">
      <div class="intro-title">ASCENDANT</div>
      <div class="intro-tag">A war of gods</div>
      <button class="intro-play">Play</button>
    </div>
    <video class="intro-video" playsinline preload="auto" poster="${BASE}trailer/poster.jpg" src="${BASE}trailer/trailer.mp4"></video>
    <div class="intro-skip">Esc to skip</div>`;
  root.style.backgroundImage = `url(${BASE}trailer/poster.jpg)`;
  document.body.appendChild(root);
  const video = root.querySelector<HTMLVideoElement>('.intro-video')!;
  const play = root.querySelector<HTMLButtonElement>('.intro-play')!;
  play.focus();

  return new Promise((resolve) => {
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      video.pause();
      window.removeEventListener('keydown', onKey, true);
      root.classList.add('done');
      setTimeout(() => {
        root.remove();
        video.removeAttribute('src');
        video.load();
      }, 600);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' || !root.classList.contains('playing')) return;
      e.preventDefault();
      e.stopPropagation();
      finish();
    };
    window.addEventListener('keydown', onKey, true);

    const start = () => {
      if (root.classList.contains('playing')) return;
      root.classList.add('playing');
      audio.unlock();
      const s = audio.settings;
      video.muted = s.muted;
      video.volume = Math.min(1, s.master * 1.1);
      video.addEventListener('ended', finish);
      // a missing or broken video (or a browser that refuses it) goes straight on to the game
      video.addEventListener('error', finish);
      video.play().catch(finish);
    };
    play.addEventListener('click', start);
  });
}
