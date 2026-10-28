import * as THREE from 'three/webgpu';
import './style.css';
import { Input } from './core/Input';
import { Loop } from './core/Loop';
import { GodModel } from './actors/GodModel';
import { PlayerController } from './player/PlayerController';
import { ThirdPersonCamera } from './player/ThirdPersonCamera';
import { grading, PostFX } from './render/PostFX';
import { createRenderer } from './render/Renderer';
import { initialQuality, QUALITY_PRESETS, saveQuality, type QualityName } from './render/Quality';
import { TextureLibrary } from './scene/Materials';
import { World } from './scene/World';
import { Hud } from './ui/Hud';
import { CombatGame } from './combat/CombatGame';

async function main(): Promise<void> {
  let applyQuality: (q: QualityName) => Promise<void> = async () => {};
  const hud = new Hud((q) => void applyQuality(q));
  hud.progress(0.05, 'Starting renderer…');

  const { renderer, isWebGPU } = await createRenderer(document.body);
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 3000);

  const textures = new TextureLibrary(renderer.getMaxAnisotropy?.() ?? 8);
  await textures.load((f) => hud.progress(0.05 + f * 0.5, 'Quarrying marble…'));

  hud.progress(0.6, 'Raising the temple…');
  await new Promise((r) => setTimeout(r, 0));
  const world = new World(textures, camera);

  const input = new Input(renderer.domElement);
  const god = new GodModel();
  world.actors.add(god.root);
  const player = new PlayerController(input, world.collision, god);
  player.spawn(world.spawn.x, world.spawn.z, world.spawn.yaw);
  const follow = new ThirdPersonCamera(camera, player, world.collision);

  const post = new PostFX(renderer, world.scene, camera);
  let quality = QUALITY_PRESETS[initialQuality(isWebGPU)];

  const resize = () => {
    const pr = Math.min(window.devicePixelRatio * quality.resolutionScale, quality.maxPixelRatio);
    renderer.setPixelRatio(pr);
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  applyQuality = async (name: QualityName) => {
    quality = QUALITY_PRESETS[name];
    saveQuality(name);
    hud.setQuality(name);
    resize();
    await world.applyQuality(renderer, quality);
    post.build(quality);
  };

  hud.progress(0.8, 'Lighting the braziers…');
  await applyQuality(quality.name);
  world.bakeLighting(renderer);
  hud.setInfo(isWebGPU ? 'WebGPU' : 'WebGL 2');

  const loop = new Loop();
  loop.addFixed(player);
  const combat = new CombatGame({ world, input, player, camera });
  loop.addFixed(combat);
  // Pre-compile shaders before revealing the scene to avoid first-frame hitches.
  player.render(0, 1);
  follow.update(1 / 60);
  await renderer.compileAsync(world.scene, camera);
  hud.ready();

  document.addEventListener('pointerlockchange', () => hud.setLocked(input.locked));

  const frame = (now: number) => {
    player.look();
    const wheel = input.consumeWheel();
    if (wheel) follow.zoom(wheel);
    const dt = loop.tick(now);
    player.render(dt, loop.alpha);
    combat.frame(dt, loop.alpha, loop.time);
    follow.update(dt);
    world.update(dt, loop.time, god.root.position);
    post.render();
    input.endFrame();
    hud.frame(dt);
  };
  // `?capture` leaves the loop stopped so automated screenshots can step frames
  // themselves (software GPUs in CI can't keep up with a live loop).
  const captureMode = new URLSearchParams(location.search).has('capture');
  if (!captureMode) renderer.setAnimationLoop(frame);

  /**
   * Deterministic capture for automated screenshots: stops the live loop,
   * renders `frames` frames at a fixed 60 Hz (so temporal AA converges) and
   * returns the canvas as a PNG data URL.
   */
  let simNow = 0;
  const capture = async (frames = 8): Promise<string> => {
    renderer.setAnimationLoop(null);
    const device = (renderer.backend as unknown as { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device;
    for (let i = 0; i < frames; i++) {
      frame((simNow += 1000 / 60));
      await device?.queue.onSubmittedWorkDone();
    }
    await new Promise((r) => requestAnimationFrame(r));
    frame((simNow += 1000 / 60));
    const url = renderer.domElement.toDataURL('image/png');
    await device?.queue.onSubmittedWorkDone();
    return url;
  };

  // Hooks for automated screenshots and for gameplay code during development.
  const debug = { grading, combat, world, player, camera, follow, renderer, post, setQuality: applyQuality, isWebGPU, capture, resume: () => renderer.setAnimationLoop(frame) };
  (window as unknown as { __game: typeof debug }).__game = debug;
}

main().catch((err) => {
  console.error(err);
  const el = document.querySelector('.hud-sub');
  if (el) el.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
