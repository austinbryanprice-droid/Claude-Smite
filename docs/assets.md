# Free asset inventory

Every asset the game can use without paying or signing in, where it comes from, its license, and what it is for. All of it is downloaded by one script; nothing binary is committed.

```sh
node scripts/fetch-assets.mjs            # core set: 175 MB served + 55 MB build-time source (needs Node 18+, curl, git)
node scripts/fetch-assets.mjs --heavy    # adds 4K skies and the two 45 MB showcase models (+117 MB, more with Poly Haven)
node scripts/fetch-assets.mjs --list     # show the plan without downloading
```

- Runtime files go to `public/assets/`, build-time source data to `assets-src/`. Both are git-ignored.
- `public/assets/CREDITS.md` and `credits.json` are regenerated on every run. The in-game credits screen must show them, because several assets are CC-BY.
- Every GitHub source is pinned to a commit, and `scripts/assets.lock.json` holds the sha256 of each file. A changed file fails the run.
- The manifest is `scripts/assets.manifest.json`. To add an asset, add an entry there, run with `--write-lock`, and add a row to this page.

## Two tiers, because of the network

Surveyed on 2026-10-28 from the cloud sandbox. Reachable there: GitHub (git clone and raw.githubusercontent.com) and npm. Blocked there: polyhaven.com, ambientcg.com, kenney.nl, sketchfab.com, opengameart.org, Wikimedia, Hugging Face, Mixamo, jsDelivr and unpkg.

1. **GitHub tier (always works).** 34 entries from public GitHub repos, many of them mirrors of Poly Haven, Quaternius and Kenney originals. Tested here: all 34 downloaded, checksummed and spot-checked (GLB, FBX, HDR and PNG headers valid).
2. **Poly Haven tier (optional).** 37 CC0 textures, models and 4K skies fetched through the official Poly Haven API with md5 checks. This works from any normal connection (a developer machine, GitHub Actions) but not from the cloud sandbox, so the script skips it there with one warning. Every asset id comes from the live Poly Haven API listing, and the download path (URL lookup, md5 check, glTF with its textures) was tested against a local mock of the API.

The GitHub tier alone is enough to build a good-looking map. The Poly Haven tier is what takes terrain and props from good to photoreal, so the production build should run the fetch script in CI.

## Inventory: GitHub tier

Sizes are for the downloaded files. "Heavy" entries are only fetched with `--heavy`.

### Sky and image-based lighting

| Asset | License | Source | Use | Size |
| --- | --- | --- | --- | --- |
| `hdri/kloppenheim_05_2k.hdr` | CC0 (Poly Haven) | gkjohnson/3d-demo-data | Default daytime sky and IBL | 5.7 MB |
| `hdri/aristea_wreck_puresky_2k.hdr` | CC0 (Poly Haven) | gkjohnson/3d-demo-data | Sky-only HDRI for the map background | 5.3 MB |
| `hdri/wasteland_clouds_puresky_2k.hdr` | CC0 (Poly Haven) | gkjohnson/3d-demo-data | Dramatic clouds, alternate mood | 4.6 MB |
| `hdri/noon_grass_2k.hdr` | CC0 (Poly Haven) | gkjohnson/3d-demo-data | Bright lighting for god select | 6.3 MB |
| `hdri/hilly_terrain_01_2k.hdr` | CC0 (Poly Haven) | gkjohnson/3d-demo-data | Low warm sun, sunset variant | 6.4 MB |
| `hdri/sepulchral_chapel_rotunda_2k.hdr` | CC0 (Poly Haven) | gkjohnson/3d-demo-data | Dim stone interior, underworld | 6.6 MB |
| `hdri/spruit_sunrise_4k.hdr.jpg` | CC0 (Poly Haven) | mrdoob/three.js | 4K sky as a gain-map JPEG (load with `UltraHDRLoader`) | 1.8 MB |
| `env/the_sky_is_on_fire_2k.pmrem.ktx2` | CC0 (Poly Haven) | mrdoob/three.js | Pre-filtered env cubemap, no runtime PMREM cost | 1.8 MB |
| `env/cape_hill_2k.pmrem.ktx2` | CC0 (Poly Haven) | mrdoob/three.js | Pre-filtered env cubemap | 1.8 MB |
| `hdri/harties_cliff_view_4k.hdr` (heavy) | CC0 (Poly Haven) | BabylonJS/Assets | 4K cliffside sky and reflections | 26.4 MB |

### Characters and animation

| Asset | License | Source | Use | Size |
| --- | --- | --- | --- | --- |
| `characters/ual/` | CC0 (Quaternius) | J-Ponzo/gltf-universal-animation-library | Mannequin with a 53-bone humanoid rig and 46 clips: idle, walk, jog, sprint, roll, jump, punch, sword attack, spell cast (enter, idle, shoot, exit), hit, death. The shared skeleton for every god. | 4.0 MB |
| `characters/lee-perry-smith/` | CC-BY 3.0, Lee Perry-Smith / Infinite Realities | mrdoob/three.js | Photoscanned head with color, specular and normal maps; test subject for the skin shader | 1.4 MB |
| `characters/scattering-skull/` | CC0, Vladimir Petkovic | KhronosGroup/glTF-Sample-Assets | Realistic skull for underworld dressing and death-god VFX | 9.0 MB |
| `assets-src/makehuman/` | CC0, MakeHuman team | makehumancommunity/makehuman | Realistic human base mesh, young-adult age/gender/muscle/weight morph targets, body and face shape targets, skeleton and skin weights, eyes. Input for the god body generator (see Gaps). | 44 MB |
| `assets-src/mocap/cmu/` | CMU mocap terms (free for any use, raw data may not be resold) | una-dinosauria/cmu-mocap | 9 raw BVH clips: walk, run, punch, three swordplay takes, boxing, jump kick. For retargeting extra combat clips onto the UAL rig. | 9.5 MB |

### Statues, architecture and props

| Asset | License | Source | Use | Size |
| --- | --- | --- | --- | --- |
| `props/statues/athena/` | No copyright (Three D Scans) | keijiro/ThreeDScans | Photoscanned marble Athena, decimated for real time, with normal, AO and curvature maps (FBX) | 15.6 MB |
| `props/statues/hermes/` | No copyright (Three D Scans) | keijiro/ThreeDScans | Marble Hermes | 7.5 MB |
| `props/statues/nymph/` | No copyright (Three D Scans) | keijiro/ThreeDScans | Marble nymph | 13.3 MB |
| `props/statues/penelope/` | No copyright (Three D Scans) | keijiro/ThreeDScans | Marble Penelope | 14.8 MB |
| `props/statues/marbleplayer/` | No copyright (Three D Scans) | keijiro/ThreeDScans | Marble figure | 4.6 MB |
| `props/statues/shepherdboy/` | No copyright (Three D Scans) | keijiro/ThreeDScans | Marble shepherd boy | 8.8 MB |
| `props/statues/column03/` | No copyright (Three D Scans) | keijiro/ThreeDScans | Scanned classical column for temples and lane borders | 5.8 MB |
| `props/statues/tennyson-bust/` | No copyright (Three D Scans) | mrdoob/three.js | Marble bust, already GLB | 0.5 MB |
| `props/statues/nemetona/` | CC-BY 4.0, JOJObrush | mrdoob/three.js | Sculpted goddess head; shrine centerpiece | 3.8 MB |
| `props/pot-of-coals/` | CC-BY 4.0, Eric Chadwick | KhronosGroup/glTF-Sample-Assets | Copper brazier with glowing coals for lanes and towers | 4.7 MB |
| `props/lantern/` | CC0, sbtron and Frank Galligan | KhronosGroup/glTF-Sample-Assets | Wooden lamp post with emissive lantern | 9.6 MB |
| `props/coastal-cliff/` | CC0 (Poly Haven, processed by Babylon.js) | BabylonJS/Assets | Photoscanned cliff for map edges and jungle outcrops | 4.9 MB |
| `props/gothic-cloister/` (heavy) | CC-BY 4.0, Zoilo | BabylonJS/Assets | Photoscanned stone arcade; benchmark for stone architecture | 44.2 MB |
| `props/tarisland-dragon/` (heavy) | CC-BY 4.0, Dr A | BabylonJS/Assets | High-poly dragon; candidate boss objective | 46.7 MB |

Three D Scans states its scans are of public-domain sculptures and carry no copyright (https://threedscans.com/info/). We credit them anyway. The FBX statues load directly with three.js `FBXLoader`; the graphics build step should convert them to GLB and compress the maps to KTX2.

### Nature, textures and VFX

| Asset | License | Source | Use | Size |
| --- | --- | --- | --- | --- |
| `nature/ez-tree/` | MIT; bark textures CC0 (ambientCG) | dgreenheck/ez-tree | 11 PBR bark sets, leaf cards, ground textures, rock and grass meshes. Feeds the EZ-Tree procedural tree generator (npm `@dgreenheck/ez-tree`, MIT). | 1.4 MB |
| `textures/rocky-ground/` | CC-BY 4.0, Babylon.js team | BabylonJS/Assets | Tileable PBR rocky ground; offline fallback terrain layer | 4.9 MB |
| `vfx/kenney/` | CC0, Kenney | Calinou/kenney-particle-pack | 80 grayscale particle sprites (fire, flame, smoke, spark, magic, slash, trace, twirl, star, light, scorch) to tint per ability | 4.5 MB |
| `vfx/flipbooks/` | CC-BY 4.0, Babylon.js team | BabylonJS/Assets | 8x8 animated flipbooks for fire, smoke and explosions, plus flares | 2.5 MB |
| `vfx/spell-meshes/` | CC-BY 4.0, Babylon.js team | BabylonJS/Assets | Energy-ball and spell-disk meshes for projectiles | 12.0 MB |

## Inventory: Poly Haven tier (CC0, optional)

Fetched through `https://api.polyhaven.com` at 2K (skies at 4K). Poly Haven assets are CC0. Their API terms ask for a "Powered by Poly Haven" credit when you build on the API, so the credits file adds that line whenever these assets are present.

- **Textures (2K: color, OpenGL normal, AO/rough/metal, displacement):** `marble_01`, `floor_tiles_06`, `rabdentse_ruins_wall`, `castle_wall_slates`, `medieval_blocks_02`, `rustic_stone_wall`, `cobblestone_floor_01`, `cliff_side`, `lichen_rock`, `marble_cliff_01`, `aerial_grass_rock`, `aerial_rocks_02`, `forest_ground_04`, `leafy_grass`, `brown_mud_leaves_01`. Temple floors, ruin walls, lanes, cliffs, jungle floor and large-scale terrain.
- **Models (2K glTF):** `marble_bust_01`, `gothic_statue`, `lion_head`, `horse_statue_01`, `bull_head`, `antique_ceramic_vase_01`, `boulder_01`, `rock_face_01`, `rock_moss_set_01`, `namaqualand_cliff_01`, `dead_tree_trunk`, `island_tree_01`, `pine_tree_01`, `shrub_01`, `fern_02`, `grass_medium_01`, `ornate_war_hammer`. Statues and carvings for shrines and gates, rocks and cliffs, trees, ground cover.
- **Skies (4K .hdr, heavy):** `kloofendal_43d_clear_puresky`, `kloppenheim_06_puresky`, `belfast_sunset_puresky`, `drakensberg_solitary_mountain_puresky`, `kloppenheim_02_puresky` (night).

## Checked and excluded

| Asset | Why not |
| --- | --- |
| Mixamo characters and animations (three.js `Soldier`, `Xbot`, `Michelle`, FBX samples; Babylon `mixamo/`) | Adobe's Mixamo terms, not an open license. Using them needs an Adobe login, and shipping the raw files in a public repo is redistribution. |
| Nefertiti scan (three.js) | CC-BY-NC, non-commercial only |
| Venice mask (three.js), lens flare sprites (three.js, from ROME) | CC-BY-NC / CC-BY-NC-SA |
| Kira, Ready Player Me sample, Littlest Tokyo and other sample scenes | Unity Asset Store or unclear terms, or the wrong art style |
| Crytek Sponza (Khronos) | CryEngine license, not open |
| DamagedHelmet, BrainStem (Khronos) | Part CC-BY-NC / Poser EULA |
| KayKit character packs (CC0) | Legal, but low-poly cartoon style clashes with the realistic look |
| `@pmndrs/assets` on npm (CC0) | Same Poly Haven HDRIs as above, but base64 inside JS modules, which bloats the bundle |
| Three.js `waternormals.jpg`, `grasslight-big.jpg`, brick and hardwood textures | Unknown origin or low resolution (the grass is CC-BY 3.0 at 1K) |

## Gaps and the fallback for each

**1. Realistic god characters. This is the big one.** No free, open-licensed, realistic, rigged god-quality characters exist on any reachable source. Mixamo is excluded, Sketchfab is blocked and needs login, and the realistic CC0 humans that do exist are bare base meshes. The recommended pipeline, all built on assets above:

- **Body:** a build-time generator script reads the MakeHuman CC0 data in `assets-src/makehuman/`, applies morph targets (for example "male, young, max muscle, average weight" for a war god; "female, young, average muscle, min weight" for a huntress), and writes a GLB. MakeHuman's base mesh has the topology and proportions of a real human, which is what sells "realistic".
- **Rig and motion:** bind that body to the Quaternius UAL skeleton (or retarget UAL clips onto the MakeHuman default rig) so every god shares the 46 UAL clips. Extra combat clips come from the CMU mocap BVH files, retargeted and cleaned.
- **Skin and materials:** procedural PBR in the shader (subsurface-style skin tuned on the Lee Perry-Smith head, plus detail normal noise), with body-part regions taken from bone weights, the same trick `ch-bas/threejs-sims-house-builder` uses on the UAL mannequin.
- **Armor, cloth, weapons and divine features:** code-generated geometry (lathe, extrude and sweep for helmets, pauldrons, shields, spears; cloth as skinned ribbons), metal PBR from physically based values (physicallybased.info data, CC0), and emissive shader effects (glowing eyes, auras, rune patterns) carrying most of the "god" read.
- **Image-to-sprite option, for UI only:** god portraits and ability icons can be rendered from the in-engine models. Hand-drawn or AI-generated portraits would need their own license check, so avoid sprites for anything in the 3D view; they break the realistic look.

**2. Metals: gold, bronze and marble trims.** Poly Haven has rusty metals but no clean gold. Fallback: procedural PBR materials (base color plus roughness from noise, physically correct metal values) with Kenney scratch sprites as detail masks. Reliable and cheap.

**3. Water and lava.** No openly licensed normal maps were found on GitHub. Fallback: procedural (Gerstner or FFT waves and flow-mapped noise in the shader). That is how most WebGL water is done anyway.

**4. Terrain when the Poly Haven tier is not available.** Only the Babylon rocky ground and EZ-Tree ground textures are offline. Fallback: tri-planar procedural terrain shading in the cloud sandbox; run the fetch script in CI for production builds.

**5. Flowing VFX textures (noise, gradient ramps, trails).** Generate them in code at load time (or bake once into PNG) from simplex, Worley and curl noise; combine with the Kenney sprites and Babylon flipbooks above.

**6. Not surveyed yet:** UI fonts and icons. (Audio and music are covered below: all made in code.) Fonts are easy: `@fontsource/cinzel` and `@fontsource/cormorant-garamond` on npm are OFL-licensed and fit the mythology theme.

## Audio and music: made in code, no files

Every sound effect, ambience loop and piece of music is synthesized in code at load time (`src/audio/`), so there are no audio files, downloads or licenses to track. Nothing is sampled from Smite, Hi-Rez or any other game.

- **Effects:** `src/audio/gestures.ts` holds the building blocks (filtered-noise whooshes, pitch-dropping thumps, electric zaps, thunder, struck metal, sand, smoke, insect swarms, formant-filtered voices and roars, falling debris, bells, fire, birdsong). `sounds.ts` layers them into the bank (footsteps on stone, grass and dirt; god, minion, tower and monster attacks and hits; deaths; collapses; bosses; UI; ambience). `skillSounds.ts` gives each of the 55 skills its own cast, in-flight, impact and lingering-area sounds.
- **Music:** `music.ts` synthesizes strings, choir, harp, horn, bass and drums, and plays two original pieces from written parts: a title hymn and a battle theme whose drums and brass rise with the fighting. Victory and defeat have their own fanfares.
- **Herald:** the spoken cues are original lines spoken by the browser's built-in speech synthesis (the player's own system voices; nothing is shipped). Each line opens with a synthesized sting.
- Rendering takes a few seconds of CPU and runs on worker threads, so it never stalls the game. Unit tests (`src/audio/audio.test.ts`) check every sound for clipping, silence and DC offset.

If we later want recorded sounds, CC0 libraries on GitHub (for example Kenney's audio packs mirrored there) can be added through the fetch script like the other assets.

## License obligations, in one place

- **CC0:** no obligation; credited anyway.
- **CC-BY 3.0 / 4.0** (Lee Perry-Smith head, Nemetona, Pot of Coals, Gothic Cloister, Tarisland Dragon, Babylon textures, flipbooks, spell meshes): credit the author and license in the game's credits screen. `public/assets/CREDITS.md` has the exact lines.
- **MIT** (EZ-Tree): keep the MIT notice when shipping its files or package.
- **CMU mocap:** free for any use, including commercial; the raw data may not be resold. Credit: "The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217."
- **Poly Haven API:** "Powered by Poly Haven" credit when the Poly Haven tier is used.
- **Audio:** synthesized in code; no obligations.
- Nothing here uses Smite or Hi-Rez art, audio, names or trademarks.
