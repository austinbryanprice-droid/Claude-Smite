import { describe, expect, it } from 'vitest';
import { thor, zeus } from '../game/gods';
import { godUnit } from '../sim/factory';
import { KillTally } from './killTally';

const at = { x: 0, z: 0, yaw: 0 };

describe('kill tally', () => {
  it('first blood, multi-kills inside 10 s, streaks and a shutdown', () => {
    const me = godUnit(zeus, 'order', at);
    const foes = [0, 1, 2].map(() => godUnit(thor, 'chaos', at));
    const tally = new KillTally(() => me);
    expect(tally.onGodDeath(foes[0]!, me, 0)?.title).toBe('First Blood');
    expect(tally.onGodDeath(foes[1]!, me, 5)?.title).toBe('Double Kill');
    const third = tally.onGodDeath(foes[2]!, me, 30)!;
    expect(third.title).toBe('Rampage');
    expect(third.sub).toBe('3 kill streak');
    // an enemy ends the player's streak, then the player shuts them down later
    const slain = tally.onGodDeath(me, foes[0]!, 40)!;
    expect(slain.title).toBe('You have been slain');
    expect(slain.sub).toContain('3 kill streak');
    expect(tally.onGodDeath(foes[0]!, me, 60)?.title).toBe('Enemy Slain');
  });

  it('others trade kills quietly after first blood', () => {
    const me = godUnit(zeus, 'order', at);
    const ally = godUnit(zeus, 'order', at);
    const foe = godUnit(thor, 'chaos', at);
    const tally = new KillTally(() => me);
    expect(tally.onGodDeath(foe, ally, 0)).toEqual({ title: 'First Blood', sub: '', side: 'ally' });
    expect(tally.onGodDeath(ally, foe, 3)).toBeNull();
  });
});
