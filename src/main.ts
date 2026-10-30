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
import { PerfStats } from './render/PerfStats';
import { shareShaders } from './render/instancing';
import { createRenderer, gpuName } from './render/Renderer';
import { gpuAdvice } from './render/gpuAdvice';
import { initialQuality, QUALITY_PRESETS, saveQuality, type QualityName } from './render/Quality';
import { TextureLibrary } from './scene/Materials';
import { mapFromUrl, World } from './scene/World';
import { Hud } from './ui/Hud';
import { CombatGame } from './combat/CombatGame';
import { monsterWarmup } from './combat/MonsterViews';
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
  const perf = new PerfStats();
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
  const graphics = rendering.then((r) => {
    const gpu = gpuName(r.renderer);
    return { webgpu: r.isWebGPU, gpu, advice: gpuAdvice(gpu) };
  });
  const chosen: Promise<StartChoice> = skipMenu
    ? Promise.resolve({ mode: mapFromUrl(), god: godById(params.get('god') ?? '')?.id ?? 'zeus' })
    : showStartMenu(GODS, graphics);
  if (!skipMenu) music.play('hymn');

  const { renderer, isWebGPU } = await rendering;
  const { gpu, advice: slowGpu } = await graphics;
  // shaders compile in parallel in the background and never freeze a frame
  const pipelines = new AsyncPipelines(renderer);
  shareShaders(renderer);
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 3000);

  // textures and god models load behind the title screen
  const textures = new TextureLibrary(renderer.getMaxAnisotropy?.() ?? 8);
  await textures.load((f) => hud.progress(0.05 + f * 0.5, 'Quarrying marble…'));

  await preloadGodAssets((f) => hud.progress(0.55 + f * 0.05, 'Summoning the gods…'));

  let quality = QUALITY_PRESETS[initialQuality(isWebGPU, slowGpu !== null)];
  /** Lowered by AutoQuality when the frame rate stays low. */
  let renderScale = 1;
  let autoDrops = 0;
  const resize = () => {
    const pr = Math.min(window.devicePixelRatio * quality.resolutionScale, quality.maxPixelRatio) * renderScale;
    renderer.setPixelRatio(pr);
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  /**
   * Draws hidden frames of everything (the whole map unculled, every shadow
   * cascade) until no draw is left waiting for its shader, so shaders are
   * generated now rather than mid-match. These are the real passes and render
   * targets: `compileAsync` only reaches a stand-in of the scene pass (measured:
   * 470 of its shaders were never used). A quarter second's worth per frame
   * keeps the loading screen moving, and the frames send no draws to the GPU.
   */
  const prepareShaders = async (world: World, post: PostFX, from: number, to: number): Promise<void> => {
    pipelines.limitShaderBuilds(250);
    pipelines.preparing = true;
    const cull = world.showEverything();
    const start = pipelines.built;
    for (;;) {
      // a new frame number each time: passes render once per frame
      await new Promise((r) => requestAnimationFrame(r));
      world.environment.redrawShadows();
      const waiting = pipelines.deferred;
      post.render();
      const left = pipelines.deferred - waiting;
      const done = pipelines.built - start;
      hud.progress(from + ((to - from) * done) / (done + left || 1), `Preparing materials ${done}…`);
      if (left === 0) break;
    }
    cull();
    pipelines.preparing = false;
  };

  /**
   * Builds the map, lights it and prepares its shaders, plus every god's (and the
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
    // the lights a match starts with: the pool at the fires nearest the spawn
    // (the map's spell lights are already in place)
    world.update(0, 0, new THREE.Vector3(world.spawn.x, 0, world.spawn.z));
    // every god and monster, kept until the match's own last preparation
    const models = new THREE.Group();
    for (const g of GODS) models.add(new GodModel(g.id).root);
    if (mode === 'conquest') for (const root of monsterWarmup()) models.add(root);
    world.actors.add(models);
    await prepareShaders(world, post, 0.85, 0.86);
    return { world, post, models };
  };
  // Start on the mode the title screen opens with (the last one played) while
  // the player picks a god; a different pick builds its own map after Play.
  const guessMode = skipMenu ? null : savedMode();
  const guess = guessMode ? prepare(guessMode) : null;
  const choice = await chosen;
  // A map built for the other mode is left to the garbage collector, not disposed:
  // it shares cached geometry with the new map, and disposing destroys GPU
  // buffers that the new map still draws ("buffer used in submit while destroyed").
  const reuse = guess && guessMode === choice.mode;
  const { world, post, models } = reuse ? await guess : await prepare(choice.mode);

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
    renderScale = 1;
    saveQuality(name);
    hud.setQuality(name);
    resize();
    await world.applyQuality(renderer, quality);
    post.build(quality);
  };
  saveQuality(quality.name);
  hud.setQuality(quality.name);
  hud.setInfo(`${isWebGPU ? 'WebGPU' : 'WebGL 2'}${gpu ? ` · ${gpu}` : ''}`);
  const advice = params.has('capture') ? null : slowGpu;
  // a quality forced in the URL (tests, shared links) stays put
  if (!params.has('quality')) {
    autoQuality = new AutoQuality((scale) => {
      renderScale = scale;
      autoDrops++;
      resize();
      hud.notice(`Lowered the render resolution to ${Math.round(scale * 100)}% for a smoother frame rate. Picking a quality at the bottom right resets it.`);
    }, () => perf.gpuAverage(4));
  }

  const loop = new Loop();
  loop.addFixed(player);
  // Conquest plays a full match against bots; the arena is the training ground
  const combat = new CombatGame({ world, input, player, camera, mode: choice.mode, god: choice.god, net: choice.net, shake: (a) => follow.addShake(a) });
  loop.addFixed(combat);
  void baked;
  const gameAudio = new GameAudio(audio, music, herald, combat, camera, choice.mode === 'conquest', () => !player.grounded);
  // Prepare what the match added (the player, spell effects, structures), every
  // god and monster still included, then wait (bounded) for the driver to
  // finish compiling the pipelines before revealing the scene.
  player.render(0, 1);
  follow.update(1 / 60);
  world.update(0, 0, player.model.root.position);
  const slow = setTimeout(() => hud.slowLoad(isWebGPU), 15000);
  const effects = combat.prime();
  await prepareShaders(world, post, 0.86, 0.9);
  effects();
  models.removeFromParent();
  await pipelines.settle(60000, (done, total) => hud.progress(0.9 + (total ? (0.1 * done) / total : 0.1), `Preparing shaders ${done} / ${total}…`));
  clearTimeout(slow);
  hud.ready();
  if (advice) hud.notice(advice.text, 15);
  const shadersAtStart = pipelines.built;
  const deferredAtStart = pipelines.deferred;
  const builtForAtStart = new Map(pipelines.builtFor);
  perf.watchGpu(renderer);
  // (automated captures want every object in the frame they ask for)
  pipelines.limitShaderBuilds(params.has('capture') ? Infinity : 4);
  hud.report = () => perf.report({
    gpu,
    backend: isWebGPU ? 'WebGPU' : 'WebGL 2',
    quality: quality.label,
    renderScale,
    autoDrops,
    canvas: renderer.domElement,
    mode: `${choice.mode}${choice.net ? ' online' : ''}`,
    shaders: pipelines.built - shadersAtStart,
    deferred: pipelines.deferred - deferredAtStart,
    shadersFor: new Map([...pipelines.builtFor].map(([what, n]) => [what, n - (builtForAtStart.get(what) ?? 0)] as const).filter(([, n]) => n > 0)),
  });
  combat.netReady();

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyH' && !e.repeat) hud.toggleHelp();
  });
  document.addEventListener('pointerlockchange', () => hud.setLocked(input.locked));

  const frame = (now: number) => {
    perf.begin(now);
    player.look();
    const wheel = input.consumeWheel();
    if (wheel) follow.zoom(wheel);
    const dt = loop.tick(now);
    perf.mark(0);
    player.render(dt, loop.alpha);
    combat.frame(dt, loop.alpha, loop.time);
    gameAudio.frame(dt);
    showcase?.update(dt);
    follow.update(dt);
    perf.mark(1);
    world.update(dt, loop.time, player.model.root.position);
    perf.mark(2);
    post.render();
    perf.mark(3);
    input.endFrame();
    hud.frame(dt);
    // (not inside the call below: `?.` would skip it when auto quality is off)
    const cpu = perf.end(pipelines.built);
    // the real interval: the loop's dt is clamped to 100 ms, which would make a
    // very slow GPU look CPU bound and hide stalls from auto quality
    autoQuality?.frame(perf.gap / 1000, cpu);
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
  const debug = { perf, pipelines, grading, combat, audio, music, herald, world, player, camera, follow, renderer, post, setQuality: applyQuality, isWebGPU, capture, resume: () => renderer.setAnimationLoop(frame) };
  (window as unknown as { __game: typeof debug }).__game = debug;
}

main().catch((err) => {
  showFatal('The game failed to start.', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
});
