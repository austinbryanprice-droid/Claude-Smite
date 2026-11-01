# God forge

Builds every god's character model in code: `python3 tools/gods/build.py [god ...|clips]`
writes `public/models/gods/<god>.glb` (and `clips.glb`, the shared animations).

Inputs (fetched by `npm run fetch:assets`, never committed): MakeHuman CC0 base mesh,
morph targets, skeleton and weights; the Quaternius Universal Animation Library rig and clips (CC0).
Python deps: `pip install -r tools/gods/requirements.txt`.

How a god is made (`forge/gods/<god>.py`):

- **Body**: MakeHuman morphs (`mh.Shape`) for a heroic build, then `bulk` thickens limbs around their bones.
- **Rig**: the UAL skeleton is fitted to the body's joints. Each bone's rest rotation is chosen so the
  UAL clips play unchanged on it (`forge/rig.py`); clips keep every rotation track, because each body's
  rest pose differs from the mannequin's.
- **Armor and cloth**: `shell.plate` cuts a body region along a smooth scalar field and gives it thickness,
  a rolled rim and walls; it inherits the body's skin weights. `add_skirt` wraps pleated skirts that split
  between the legs.
- **Hair and fur**: tapered clumps grown along a flow field with body collision (`forge/hair.py`).
- **Animal heads**: signed-distance sculpting meshed with marching cubes (`forge/sdf.py`, Anubis).
- **Runtime physics**: capes and panels in `meta.cloths` are simulated by `src/actors/gods/Physics.ts`.
- **Grip**: `meta.curl` closes the weapon hand on top of every clip.

Preview any god with `?showcase=zeus,thor&view=close|portrait|front|back|side|three&pose=idle|jog|cast&flip`.

## Sculpted gods

Thor is a painted sculpt (a Meshy export, `sources/thor_meshy.glb`) rigged onto the same UAL
skeleton by `python3 tools/gods/meshy.py thor`: the forge skeleton (`sources/ual_rig.json`) is
swung onto landmarks read off the sculpt, weights come from distance to the bones, the hammer is
re-seated in the hand where the forge Thor held his (`sources/thor_hammer_ref.json`), and the
low-poly surface gets one level of Phong tessellation plus baked AO. In game its texture drives
one `paintedMaterial` (gold, blued steel and glowing runes are read from the paint).
`build.py` with no arguments skips sculpted gods; `build.py thor` rebuilds the old code-built Thor.
