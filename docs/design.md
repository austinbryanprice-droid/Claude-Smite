# Game Design Document

Working title: **Ascendant** (placeholder, final name TBD).

A third-person, browser-based 5v5 MOBA modeled on Smite 2, with one big change: there is no item shop. Gods grow through a skill loadout system and three skill trees instead. The top priority across the whole project is visual quality.

Status: draft v1, written 2026-10-28. Open questions are collected at the end.

---

## 1. What we keep from Smite 2

Research sources: the official Smite 2 wiki (Conquest, Stats, god pages), the Smite community wiki (crowd control, structures), and Smite 2 patch notes. Numbers are noted where they matter for tuning.

### 1.1 Core feel

- **Third-person, over-the-shoulder camera** behind your god, not top-down. The mouse turns the camera, and the god faces where you aim.
- **Skillshot combat.** Basic attacks and most abilities are aimed with a reticle, not clicked on targets. Projectiles stop on the first target hit and are blocked by walls.
- **Matches last 25 to 45 minutes** in Smite 2. We'll aim for 15 to 25 minutes against bots so a session fits in a sitting.

### 1.2 The Conquest map

- Three lanes. **Solo** is the shorter side lane, **Mid** is the shortest path between bases, and **Duo** is the longer side lane.
- Each lane has **two towers and a Phoenix**. Towers and Phoenixes only take damage from basic attacks, not abilities.
- Destroying a Phoenix empowers that lane's minions and is required before the **Titan** can be damaged. Phoenixes respawn after a while; towers don't.
- The **Titan** sits in the heart of each base and fights back. Destroying the enemy Titan wins.
- The **jungle** between lanes holds neutral camps that give experience and buffs. Killing a buff camp on either side also levels up that buff type for your team.
- **Four jungle buffs:** red (damage), blue (mana/cooldowns), yellow (gold and speed in Smite 2), purple (cooldown/utility).
- **Bosses:** a duo-side boss that pays out team-wide rewards and later becomes a stronger version that disables enemy towers for a window, a solo-side boss whose buff gives the whole team large damage and protection boosts (the game-ender), and a mid-game boss that weakens enemy structures.
- **Phases:** laning (farm minions), mid game (group for objectives), late game (team fights and sieges).

### 1.3 Gods and stats

- Five roles: **Solo, Jungle, Mid, Carry, Support**. Attack types are ranged or melee, physical or magical.
- God level runs **1 to 20**. Each level adds health, mana, protections, attack power and attack speed.
- Example base stats (Zeus at level 1, plus per level): health 569 (+86), mana 316 (+42), physical protection 19 (+3), magical protection 27.5 (+1.5), attack speed 1.0 (+1.6%), move speed 375.
- **Movement speed by role:** around 370 to 375 for most gods and 380 for junglers.
- **Strength and Intelligence** are the two offensive stats. Basic attacks scale with 100% Strength and 20% Intelligence. Each ability scales with one or the other.
- **Protections:** damage taken is multiplied by `100 / (100 + protection)`, so each point of protection is worth about 1% more effective health.

### 1.4 God kit shape

Every Smite 2 god has a passive, a basic attack, three abilities and an ultimate. Ability ranks run 1 to 5. The ultimate typically has a 70 to 90 second cooldown. Zeus is a good template:

| Slot | Ability | Gist |
|---|---|---|
| Passive | Overcharge | Hits apply charges (max 3); each charge adds 15% damage taken from your attacks |
| 1 | Chain Lightning | Bouncing bolt, slows 20% for 2 s, 12 s cooldown |
| 2 | Thunderclap | Area damage around you plus attack speed, move speed and haste |
| 3 | Detonate Charge | Explodes charges; max charges stun for 0.5 s |
| Ult | Lightning Storm | 4.8 m radius storm, 5 hits over 4.5 s, 90 to 70 s cooldown |

### 1.5 Crowd control

- **Soft CC** (slow, cripple, blind, intoxicate) makes actions harder. Stacked slows have diminishing effect: `effective = slow × 100 / (slow + 60)`.
- **Hard CC** (stun, root, silence, disarm, fear, taunt, mesmerize, disorient) blocks an action type. Each one applies a **diminishing returns** stack: 20% CC reduction per stack for 15 s, up to 4 stacks.
- **True hard CC** (knockup, knockback, pull, grab, banish, polymorph) ignores DR but applies 2 stacks.

### 1.6 What we drop or change

- **Items, gold spending, relics and Aspects are gone.** The skill loadout and trees (section 3) replace them.
- **Gold** is replaced by **Favor**, which feeds skill-tree points (section 3.4).
- **Original names, art, UI and abilities.** The mythological gods are public domain, but Hi-Rez's names for bosses and buffs, its ability names, art, logos and UI are not, so we write our own. Mechanics such as lanes, towers and protections are fair game.

---

## 2. Controls

| Input | Action |
|---|---|
| WASD | Move |
| Mouse | Turn camera and aim |
| Left click | Basic attack |
| 1, 2, 3, 4 | Regular skills |
| R | Ultimate |
| Hold a skill key | Show targeting preview; release to cast. Right click cancels |
| Space | Jump/dodge hop (visual only, no gameplay effect, like Smite) |
| B | Recall to base |
| Tab | Scoreboard |
| K | Loadout and skill trees (only usable in base) |

Gamepad support comes later.

---

## 3. The skill system (replaces items)

### 3.1 Loadout: 5 active skills

- Every god has a **passive** (fixed, part of the god's identity) and a **basic attack** (fixed).
- On top of that, the god has **5 active skill slots**: four **regular** slots (keys 1 to 4) and one **ultimate** slot (key R).
- The ultimate slot only takes ultimates, and regular slots only take regular skills. That keeps fights readable, since you always know what a big cooldown looks like.

### 3.2 Skill pools

- Each god has a **pool of 8 to 10 regular skills and 3 ultimates**, all themed on that god.
- You fill your loadout from the pool. Any of the 5 slots can be swapped for another skill from the matching pool.
- Every pool covers a spread of jobs so different builds play differently: damage, mobility, crowd control, sustain, utility and zone control.
- Swapping is allowed **before the match and while standing in your base fountain**. That keeps the "build adjustment" moment that buying items has in Smite, without letting you swap mid-fight.

### 3.3 Skill trees

- Each god has **three themed trees**. For Zeus: **Tempest** (ability damage and storm effects), **Sky Father** (basic attacks, attack speed, charges) and **Olympian Aegis** (health, protections, sustain, CC reduction).
- Each tree has **about 15 nodes in 4 tiers**:
  - **Stat nodes** (1 to 3 ranks): health, protections, Strength or Intelligence, attack speed, cooldown reduction, mana, movement speed.
  - **Modifier nodes**: change a specific skill. For example, Chain Lightning gains 2 bounces, or Thunderclap leaves a lingering field. A modifier only does something if that skill is in your loadout, so trees and loadout build on each other.
  - **Keystones** (tier 4, one per tree): build-defining effects, like an ultimate that refunds 30% cooldown on a takedown.
- **Tier gating is per tree:** tier 2 needs 5 points spent in that tree, tier 3 needs 10, and tier 4 needs 15.
- **Mix and match freely.** Points can go into any tree in any split. A full keystone needs 15 points in one tree, so you can reach at most two keystones; most builds take one keystone and spread the rest.
- **Respec** is free while in base, the same as loadout swaps.

### 3.4 Earning points: the cap

- **Hard cap: 35 points** per match.
- **Levels:** 1 point per level from 2 to 20 (19 points).
- **Favor (16 points):** earned from minion kills, god kills and assists, jungle camps, structures and bosses. A point unlocks at each Favor threshold. This keeps farming and objectives meaningful now that gold is gone.
- A full tree costs about 30 points, so no one can max everything. Choosing what to skip is the build decision.

### 3.5 Skill ranks

- There are no manual rank-ups. Each skill's **rank follows god level automatically**: rank 1 at level 1, rank 2 at 4, rank 3 at 8, rank 4 at 12 and rank 5 at 16.
- Ultimates **unlock at level 5** and rank up at 9, 13 and 17.
- This keeps the point system simple: levels give tree points, and ranks take care of themselves.

---

## 4. First gods (v1)

Four gods covering four roles, from four pantheons. Hercules (Solo) comes right after.

| God | Pantheon | Role | Style | Trees |
|---|---|---|---|---|
| Zeus | Greek | Mid | Ranged magical burst | Tempest, Sky Father, Olympian Aegis |
| Thor | Norse | Jungle | Melee physical assassin with a hammer throw and leaps | Mjolnir, Thunderer, Jotun-Slayer |
| Artemis | Greek | Carry | Ranged physical hunter with traps and a beast companion | Huntress, Moonlight, Wild |
| Athena | Greek | Support | Melee magical guardian with shields, taunts and a team dash | Aegis, Strategist, War-Goddess |

All skills are original designs. A sample pool for Zeus:

| Type | Skill | Gist |
|---|---|---|
| Regular | Arc Bolt | Bouncing bolt that slows |
| Regular | Storm Step | Short lightning blink that leaves a damaging trail |
| Regular | Thundering Presence | Area pulse plus self speed boost |
| Regular | Static Discharge | Detonates charges; max charges stun |
| Regular | Aegis of Clouds | Shield that shocks attackers |
| Regular | Ball Lightning | Slow orb that pulses damage, recastable to detonate |
| Regular | Wrath Mark | Marks a target; your next 3 hits on it chain |
| Regular | Cyclone | Vortex that pulls enemies toward its center |
| Ultimate | Skyfall Storm | Large area storm hitting 5 times |
| Ultimate | Olympian Spear | Long-range line bolt, executes low-health gods |
| Ultimate | Ascension | Lift off for 4 s, raining bolts at the cursor |

Full numbers for all four gods go in `src/data/gods/*.ts` during step 3.

---

## 5. The map (v1)

A smaller Conquest-style map. It is about 70% of Smite's scale so a bot match moves faster.

- Three lanes (Solo, Mid, Duo). Each has 2 towers and a Phoenix; the Titan sits behind them.
- **Minion waves** every 30 s: 3 melee, 3 archers, and a brute every third wave. Minions empowered by a destroyed Phoenix get stronger.
- **Jungle:** 4 buff camps per side (Might red, Wisdom blue, Swiftness yellow, Insight purple), 4 smaller camps per side, and 2 bosses.
  - **Treasure Wyrm** (duo side): team Favor bonus. After 3 kills it becomes the **Elder Wyrm**, which disables enemy towers for 20 s.
  - **Molten Colossus** (solo side, spawns at 10:00): team-wide damage and protection buff. The game-ender.
- **Respawn** timers grow with level, from 8 s to about 60 s.
- Visual theme: a sunlit ruined temple valley. Marble and sandstone structures, stone lanes, grassy jungle with dense foliage and fog, and the Titan as a huge statue-god.

---

## 6. Bots

- Lane bots: farm, trade, retreat at low health, use skills on targets in range.
- Jungle bot: clears camps in a route and ganks a lane when the enemy is overextended.
- Team behavior: group for bosses after 10:00 and push after winning fights.
- Three difficulty levels that change reaction time, skillshot accuracy and decision quality.

---

## 7. Graphics direction (top priority)

Target: as close to the look of Unreal Engine 5 as a browser can get.

- **Renderer:** three.js with WebGPU, falling back to WebGL2. PBR materials, HDRI image-based lighting, a strong sun with soft cascaded shadows, ambient occlusion, bloom, filmic tone mapping, anti-aliasing (TAA or SMAA), color grading, height fog and light shafts.
- **Detail:** dense instanced grass and foliage with wind, high-resolution stone and marble textures, decals for wear, and water with reflections.
- **Effects:** GPU particles for lightning, fire and impacts, screen shake and hit flashes, and dissolve effects on death.
- **Quality presets:** Low, Medium, High and Ultra. High targets 60 fps on a mid-range GPU.
- **Assets:** free assets only, with licenses checked. See `docs/assets.md`, built in a separate workstream. Where no free asset fits (most likely the god characters), we generate meshes in code and use stylized-realistic materials. Image-based sprites are a last resort for distant effects.
- The graphics foundation is being built in parallel and will land in `src/render/` and `src/scene/`.

---

## 8. Build order

1. **This design doc** (done when approved).
2. **Graphics foundation** in progress: the arena, the camera and one movable god.
3. **Combat and skills:** stats, damage, CC, the loadout and tree system and its menus, the four gods, minions and towers.
4. **Full match vs bots:** the map, jungle, bosses, bot AI, win and loss, and performance tuning.
5. Later: online multiplayer, more gods, more modes (Arena, Joust).

---

## 9. Open questions for Austin

1. **Name:** keep "Ascendant" as the working title, or choose another?
2. **Ultimate slot:** may it hold only ultimates (proposed), or any skill?
3. **Swapping:** in base only (proposed), or anywhere outside combat?
4. **Point cap:** is 35 points (19 from levels, 16 from Favor) the right size, or should it be fixed per level only?
5. **First gods:** are Zeus, Thor, Artemis and Athena good choices?
