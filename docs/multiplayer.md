# Multiplayer

Co-op and versus Conquest, peer to peer, with no server of our own.

## Connecting

`src/net/Session.ts` wraps [PeerJS](https://peerjs.com). The host registers the peer id `ascendant-lobby-<CODE>` on the free public PeerJS signaling server; guests connect to that id. After the WebRTC handshake, all traffic runs over direct data channels (reliable, ordered, JSON text). PeerJS's default ICE servers include Google STUN and PeerJS's free TURN relays, so most home networks connect.

The lobby (`LobbyPanel.ts`, on the title screen) lists the players; the host owns the player list and broadcasts it on every change. **Start match** sends the list to everyone, and every end builds the same ten god slots from it (`roster.ts`): humans take the mid, solo, roam and duo spots of their team in that order, and bots play the rest with gods no human on their team picked.

## Host-authoritative match

Only the host runs the simulation (`NetHost` in `NetGame.ts`). Bots think there, and each guest's god is a plain body that follows that guest's inputs:

- Guests send one input per fixed step: position, facing, aim point, whether the basic attack is held, and their **authority sequence**. Casts, recalls and loadout/tree changes are separate messages.
- Guests own their normal movement, so walking feels instant. The host owns everything else: when it moves a guest's god itself (a teleport, respawn or recall, or the end of a dash, leap or knockback) it bumps that player's sequence. Inputs sent before the guest saw the bump are ignored, and the guest snaps its controller to the host's position.

## Snapshots

`Replica.ts` sends each guest a snapshot 20 times a second (`HostSync`), holding only what changed since that guest's last one: units' positions and timers, rules-engine state (`Combatant.netState`, 10 times a second), new units (with their `Unit.origin`, so the guest builds the same minion, monster or summon), removed units, projectiles, areas, flashes, the events since the last snapshot, the match clock and the scoreboard. Timers travel as the match time they end at, so a unit that is only counting down is not resent. A busy match costs a guest about 60 KB/s.

Guests (`GuestSync`) never step the simulation. They draw the match 0.12 s in the past, interpolating positions between snapshots, and apply each snapshot's events and state when the delayed clock reaches it. Events go to the same views, effects, HUD and audio as in a single-player match; the guest's match drops its own event listeners so nothing is counted twice.

## Testing locally

```sh
npx peerjs --port 9000 --host 127.0.0.1   # a local signaling server (the `peer` dev dependency)
npm run dev
```

Open `http://localhost:5173/?peer=127.0.0.1:9000` in two windows, host in one and join in the other. `src/net/*.test.ts` cover the snapshot copy (a bot match mirrored for 100 s) and the input/authority handshake.
