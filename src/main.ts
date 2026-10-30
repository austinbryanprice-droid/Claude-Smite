import * as THREE from 'three/webgpu';
import './style.css';
import { Input } from './core/Input';
import { Loop } from './core/Loop';
import { GodModel } from './actors/GodModel';
import { preloadGodAssets } from './actors/gods/assets';
import { Showcase } from './dev/Showcase';
import { PlayerController } from './player/PlayerController';
import { ThirdPersonCamera } from './player/ThirdPersonCamera';
import { grading, PostFX } from './render/PostFX';
import { AsyncPipelines } from './render/AsyncPipelines';
import { AutoQuality } from './render/AutoQuality';
import { shareShaders } from './render/instancing';
import { createRenderer } from './render/Renderer';
import { initialQuality, QUALITY_PRESETS, saveQuality, type QualityName } from './render/Quality';
import { TextureLibrary } from './scene/Materials';
import { mapFromUrl, World } from './scene/World';
import { Hud } from './ui/Hud';
import { CombatGame } from './combat/CombatGame';
import { monsterWarmup } from './combat/MonsterViews';
import { SPELL_LIGHTS } from './combat/Vfx';
import { GODS, godById } from './game/gods';
import { savedMode, showStartMenu, type GameMode, type StartChoice } from './ui/StartMenu';
import { installErrorHandlers, showFatal } from './ui/Fatal';
import { Announcer } from './audio/Announcer';
import { AudioEngine } from './audio/AudioEngine';
import { bakeAll } from './audio/bank';
import { GameAudio } from './audio/GameAudio';
import { Music } from './audio/music';
import { installUiSounds, mountAudioPanel } from './ui/AudioPanel';

async function main(): Promise<void> {
  installErrorHandlers();
  let applyQuality: (q: QualityName) => Promise<void> = async () => {};
  let autoQuality: AutoQuality | null = null;
  let sensitivity = 1;
  let applySensitivity = (v: number): void => {
    sensitivity = v;
  };
  const hud = new Hud((q) => {
    autoQuality?.stop();
    void applyQuality(q);
  }, (v) => applySensitivity(v));
  hud.progress(0.05, 'Starting renderer…');

  const params = new URLSearchParams(location.search);
  // Sound starts with the first click or key press (browsers require a gesture);
  // the bank renders in small slices while everything else loads.
  const audio = new AudioEngine();
  const music = new Music(audio);
  const herald = new Announcer(audio);
  mountAudioPanel(audio);
  installUiSounds(audio);
  const baked = bakeAll(audio);
  (window as unknown as { __audio: unknown }).__audio = { audio, music, herald, baked };
  // Links with ?map= (and automated captures) skip the title screen.
  const skipMenu = params.has('map') || params.has('capture') || params.has('showcase');
  const rendering = createRenderer(document.body);
  const chosen: Promise<StartChoice> = skipMenu
    ? Promise.resolve({ mode: mapFromUrl(), god: godById(params.get('god') ?? '')?.id ?? 'zeus' })
    : showStartMenu(GODS, rendering.then((r) => r.isWebGPU));
  if (!skipMenu) music.play('hymn');

  const { renderer, isWebGPU } = await rendering;
  // shaders compile in parallel in the background and never freeze a frame
  const pipelines = new AsyncPipelines(renderer);
  shareShaders(renderer);
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 3000);

  // textures and god models load behind the title screen
  const textures = new TextureLibrary(renderer.getMaxAnisotropy?.() ?? 8);
  await textures.load((f) => hud.progress(0.05 + f * 0.5, 'Quarrying marble…'));

  await preloadGodAssets((f) => hud.progress(0.55 + f * 0.05, 'Summoning the gods…'));

  let quality = QUALITY_PRESETS[initialQuality(isWebGPU)];
  const resize = () => {
    const pr = Math.min(window.devicePixelRatio * quality.resolutionScale, quality.maxPixelRatio);
    renderer.setPixelRatio(pr);
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  /**
   * Builds the map, lights it and compiles its shaders, plus every god's (and the
   * jungle's in Conquest), so pressing Play only has the little that is left to do.
   */
  const prepare = async (mode: GameMode) => {
    hud.progress(0.6, mode === 'conquest' ? 'Raising the battlefield…' : 'Raising the temple…');
    await new Promise((r) => setTimeout(r, 0));
    const world = new World(textures, camera, mode);
    const post = new PostFX(renderer, world.scene, camera);
    hud.progress(0.8, 'Lighting the braziers…');
    resize();
    await world.applyQuality(renderer, quality);
    post.build(quality);
    world.bakeLighting(renderer);
    hud.progress(0.85, 'Preparing shaders…');
    // Shaders are built per light count, so compile with the lights a match starts
    // with: the fires nearest the spawn, plus the combat effects' spell lights.
    world.update(0, 0, new THREE.Vector3(world.spawn.x, 0, world.spawn.z));
    const warm = new THREE.Group();
    for (let i = 0; i < SPELL_LIGHTS; i++) warm.add(new THREE.PointLight(0xffffff, 0, 14, 2));
    for (const g of GODS) warm.add(new GodModel(g.id).root);
    if (mode === 'conquest') for (const root of monsterWarmup()) warm.add(root);
    world.actors.add(warm);
    await renderer.compileAsync(world.scene, camera);
    warm.removeFromParent();
    return { world, post };
  };
  // Start on the mode the title screen opens with (the last one played) while
  // the player picks a god; a different pick builds its own map after Play.
  const guessMode = skipMenu ? null : savedMode();
  const guess = guessMode ? prepare(guessMode) : null;
  const choice = await chosen;
  const reuse = guess && guessMode === choice.mode;
  // free the map built for the other mode; three re-uploads anything still shared
  if (guess && !reuse) {
    void guess.then(({ world: unused }) => {
      unused.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      unused.scene.environment?.dispose();
    });
  }
  const { world, post } = reuse ? await guess : await prepare(choice.mode);

  const input = new Input(renderer.domElement);
  const god = new GodModel();
  world.actors.add(god.root);
  const player = new PlayerController(input, world.collision, god);
  const baseSensitivity = player.mouseSensitivity;
  applySensitivity = (v) => {
    player.mouseSensitivity = baseSensitivity * v;
  };
  applySensitivity(sensitivity);
  player.spawn(world.spawn.x, world.spawn.z, world.spawn.yaw);
  const follow = new ThirdPersonCamera(camera, player, world.collision);
  const showcase = params.has('showcase')
    ? new Showcase(params, world.actors, world.spawn, (x, z) => world.collision.groundAt(x, z), camera)
    : null;
  if (showcase) {
    god.root.visible = false;
    follow.update = () => {};
  }

  applyQuality = async (name: QualityName) => {
    quality = QUALITY_PRESETS[name];
    saveQuality(name);
    hud.setQuality(name);
    resize();
    await world.applyQuality(renderer, quality);
    post.build(quality);
  };
  saveQuality(quality.name);
  hud.setQuality(quality.name);
  hud.setInfo(isWebGPU ? 'WebGPU' : 'WebGL 2');
  // a quality forced in the URL (tests, shared links) stays put
  if (!params.has('quality')) {
    autoQuality = new AutoQuality(() => quality.name, (to) => {
      void applyQuality(to);
      hud.notice(`Lowered graphics to ${QUALITY_PRESETS[to].label} for a smoother frame rate. You can change it at the bottom right.`);
    });
  }

  const loop = new Loop();
  loop.addFixed(player);
  // Conquest plays a full match against bots; the arena is the training ground
  const combat = new CombatGame({ world, input, player, camera, mode: choice.mode, god: choice.god, net: choice.net, shake: (a) => follow.addShake(a) });
  loop.addFixed(combat);
  void baked;
  const gameAudio = new GameAudio(audio, music, herald, combat, camera, choice.mode === 'conquest', () => !player.grounded);
  // Draw one hidden frame so the shadow and post passes queue their shaders too,
  // then wait (bounded) for the driver to finish them before revealing the scene.
  player.render(0, 1);
  follow.update(1 / 60);
  world.update(0, 0, player.model.root.position);
  const slow = setTimeout(() => hud.slowLoad(isWebGPU), 15000);
  await renderer.compileAsync(world.scene, camera, null, (e: ProgressEvent) =>
    hud.progress(0.86 + (0.04 * e.loaded) / e.total, `Preparing materials ${e.loaded} / ${e.total}…`));
  post.render();
  await pipelines.settle(60000, (done, total) => hud.progress(0.9 + (total ? (0.1 * done) / total : 0.1), `Preparing shaders ${done} / ${total}…`));
  clearTimeout(slow);
  hud.ready();
  combat.netReady();

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyH' && !e.repeat) hud.toggleHelp();
  });
  document.addEventListener('pointerlockchange', () => hud.setLocked(input.locked));

  const frame = (now: number) => {
    player.look();
    const wheel = input.consumeWheel();
    if (wheel) follow.zoom(wheel);
    const dt = loop.tick(now);
    player.render(dt, loop.alpha);
    combat.frame(dt, loop.alpha, loop.time);
    gameAudio.frame(dt);
    showcase?.update(dt);
    follow.update(dt);
    world.update(dt, loop.time, player.model.root.position);
    post.render();
    input.endFrame();
    hud.frame(dt);
    autoQuality?.frame(dt);
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
    // continue from the live clock if the loop already ran, so time never steps backwards
    if (simNow === 0) simNow = performance.now();
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
  const debug = { pipelines, grading, combat, audio, music, herald, world, player, camera, follow, renderer, post, setQuality: applyQuality, isWebGPU, capture, resume: () => renderer.setAnimationLoop(frame) };
  (window as unknown as { __game: typeof debug }).__game = debug;
}

main().catch((err) => {
  showFatal('The game failed to start.', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
});
