/**
 * A page for auditioning every sound and both pieces of music
 * (sounds.html next to the game). Useful for tuning the mix and for
 * feedback on single sounds by name.
 */
import { Announcer } from '../audio/Announcer';
import { AudioEngine } from '../audio/AudioEngine';
import { bakeAll, jobs } from '../audio/bank';
import { Music, type SongName } from '../audio/music';
import { GODS } from '../game/gods';
import { mountAudioPanel } from '../ui/AudioPanel';
import './soundboard.css';

const engine = new AudioEngine();
const music = new Music(engine);
const herald = new Announcer(engine);
mountAudioPanel(engine);

const GROUP: Record<string, string> = {
  step: 'Footsteps', basic: 'Basic attacks', travel: 'Projectiles in flight', hit: 'Hits', minion: 'Minions', wave: 'Minions',
  tower: 'Structures', titan: 'Structures', structure: 'Structures', phoenix: 'Structures', monster: 'Jungle', warden: 'Jungle',
  wyrm: 'Bosses', colossus: 'Bosses', boss: 'Bosses', god: 'Gods', recall: 'Gods', teleport: 'Gods', heal: 'Gods', favor: 'Gods',
  kill: 'Gods', heartbeat: 'Gods', sting: 'Herald stings', ui: 'Menus', amb: 'Ambience',
};

const skillName = new Map<string, string>();
for (const g of GODS) for (const s of g.skills) skillName.set(s.id, `${g.name}: ${s.name}${s.kind === 'ultimate' ? ' (ultimate)' : ''}`);

const groups = new Map<string, string[]>();
for (const { name } of jobs()) {
  if (name.startsWith('mus.')) continue;
  const key = name.startsWith('skill:') ? skillName.get(name.split(':')[1]!) ?? 'Skills' : GROUP[name.split('.')[0]!] ?? 'Other';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(name);
}

const root = document.createElement('div');
root.className = 'sb';
root.innerHTML = `
  <h1>Ascendant sound board</h1>
  <p class="sb-note">Every sound in the game, made in code. Click to play (loops play for three seconds). <span class="sb-status">Rendering sounds…</span></p>
  <div class="sb-music">
    <button data-music="hymn">Title hymn</button>
    <button data-music="dawn">Match opening (calm)</button>
    <button data-music="dawn" data-fight="1">Match opening (skirmish)</button>
    <button data-music="battle">Battle theme (calm)</button>
    <button data-music="battle" data-fight="1">Battle theme (fighting)</button>
    <button data-music="siege">Late game (calm)</button>
    <button data-music="siege" data-fight="1">Late game (fighting)</button>
    <button data-sting="victory">Victory</button>
    <button data-sting="defeat">Defeat</button>
    <button data-stop="1">Stop music</button>
    <button data-say="First blood is spilled!" data-mood="good">Herald: first blood</button>
    <button data-say="The Molten Colossus rises from the deep." data-mood="epic">Herald: Colossus</button>
  </div>
  ${[...groups].map(([g, names]) => `<section><h2>${g}</h2><div class="sb-grid">${names.map((n) => `<button data-name="${n}">${label(n)}</button>`).join('')}</div></section>`).join('')}`;
document.body.appendChild(root);

const status = root.querySelector('.sb-status')!;
void bakeAll(engine).then(() => (status.textContent = 'Ready.'));

let fight = 0;
setInterval(() => music.setIntensity(fight, 0.1), 100);
root.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  engine.unlock();
  const d = b.dataset;
  if (d.music) {
    fight = d.fight ? 1 : 0;
    music.play(d.music as SongName);
  } else if (d.sting) music.sting(d.sting as 'victory' | 'defeat');
  else if (d.stop) music.stop();
  else if (d.say) herald.say(d.say, d.mood as 'good');
  else if (d.name) {
    const loop = d.name.endsWith(':travel') || d.name.endsWith(':zone') || /^(amb\.(wind|leaves|fountain|fire|jungle)|recall\.loop|heartbeat|travel\.)/.test(d.name);
    if (loop) {
      const l = engine.loop(d.name, { gain: 0.9 });
      setTimeout(() => l?.stop(0.3), 3000);
    } else engine.play(d.name, { gain: 1 }, 9);
  }
});

function label(n: string): string {
  if (n.startsWith('skill:')) return n.split(':')[2]!;
  return n.replace(/\./g, ' ');
}
