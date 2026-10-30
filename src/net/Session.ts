import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type { Side } from '../game/combatant';
import { teamFor, TEAM_SIZE, type NetMode, type NetPlayer } from './roster';

/** Every message is a JSON object with a type tag. */
export interface Msg {
  t: string;
  [key: string]: unknown;
}

/** Peer ids on the shared signaling server start with this, so lobby codes stay short. */
const PREFIX = 'ascendant-lobby-';
/** No 0/O or 1/I, so a code read aloud or typed from a screenshot comes out right. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const JOIN_TIMEOUT = 20000;

function newCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/**
 * Where peers find each other. The free public PeerJS server by default;
 * `?peer=host:port` points at another one (a local `npx peerjs` for testing).
 */
function peerOptions(): PeerOptions {
  const custom = new URLSearchParams(location.search).get('peer');
  if (!custom) return {};
  const [host, port] = custom.split(':');
  return { host, port: Number(port ?? 9000), path: '/', secure: location.protocol === 'https:' };
}

/** Numbers in snapshots keep two decimals: centimeters and hundredths of a second. */
function round(_key: string, v: unknown): unknown {
  return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v;
}

export function encode(msg: Msg): string {
  return JSON.stringify(msg, round);
}

/**
 * A multiplayer lobby and, once it starts, the match's connections. One
 * player hosts: their browser runs the match, and everyone else connects to
 * them directly over WebRTC data channels (the signaling server only
 * introduces the peers). Guests send their inputs; the host sends the match.
 */
export class NetSession {
  players: NetPlayer[] = [];
  started = false;
  /** Lobby changes: someone joined, left, picked a god or switched teams. */
  onLobby: () => void = () => undefined;
  /** The host started the match. */
  onStart: () => void = () => undefined;
  /** Someone left: a guest (on the host) or the host (on a guest, id 'host'). */
  onLeave: (id: string) => void = () => undefined;
  private handler: ((from: string, msg: Msg) => void) | null = null;
  private early: [string, Msg][] = [];
  private readonly conns = new Map<string, DataConnection>();

  private constructor(
    readonly role: 'host' | 'guest',
    public mode: NetMode,
    readonly code: string,
    private readonly peer: Peer,
  ) {}

  /** This player's id. */
  get me(): string {
    return this.peer.id;
  }

  get isHost(): boolean {
    return this.role === 'host';
  }

  /** Open a lobby with a fresh code. */
  static host(mode: NetMode, god: string): Promise<NetSession> {
    return new Promise((resolve, reject) => {
      const attempt = (tries: number) => {
        const code = newCode();
        const peer = new Peer(PREFIX + code, peerOptions());
        let open = false;
        peer.on('open', () => {
          open = true;
          const s = new NetSession('host', mode, code, peer);
          s.players = [{ id: peer.id, name: 'Player 1', god, team: 'order' }];
          peer.on('connection', (c) => s.accept(c));
          resolve(s);
        });
        peer.on('error', (err) => {
          // once open, the lobby lives on its direct connections; a signaling hiccup doesn't end it
          if (open) return;
          peer.destroy();
          if (err.type === 'unavailable-id' && tries > 0) attempt(tries - 1);
          else reject(new Error(describe(err.type)));
        });
      };
      attempt(3);
    });
  }

  /** Join the lobby with this code. */
  static join(code: string, god: string): Promise<NetSession> {
    code = code.trim().toUpperCase();
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerOptions());
      let joined = false;
      const fail = (why: string) => {
        if (joined) return;
        clearTimeout(timer);
        peer.destroy();
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail('No answer from that lobby. Check the code, or ask the host to open a new one.'), JOIN_TIMEOUT);
      peer.on('error', (err) => fail(describe(err.type)));
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'raw' });
        const s = new NetSession('guest', 'coop', code, peer);
        conn.on('open', () => conn.send(encode({ t: 'hello', god })));
        conn.on('data', (d) => {
          const msg = JSON.parse(d as string) as Msg;
          if (msg.t === 'full') return fail(msg.why as string);
          if (msg.t === 'lobby' && !s.conns.has('host')) {
            joined = true;
            clearTimeout(timer);
            s.conns.set('host', conn);
            conn.on('close', () => s.lost('host'));
            resolve(s);
          }
          s.receive('host', msg);
        });
      });
    });
  }

  /** This player's lobby entry. */
  self(): NetPlayer | undefined {
    return this.players.find((p) => p.id === this.me);
  }

  /** Change this player's god in the lobby. */
  pick(god: string): void {
    if (this.isHost) this.update(this.me, { god });
    else this.send('host', { t: 'pick', god });
  }

  /** Switch this player's team (versus only). */
  switchTeam(): void {
    const p = this.self();
    if (!p || this.mode !== 'versus') return;
    const team: Side = p.team === 'order' ? 'chaos' : 'order';
    if (this.isHost) this.update(this.me, { team });
    else this.send('host', { t: 'team', team });
  }

  /** Host: start the match for everyone in the lobby. */
  start(): void {
    if (!this.isHost || this.started) return;
    this.started = true;
    this.broadcast({ t: 'start', mode: this.mode, players: this.players });
    this.onStart();
  }

  /** In-match messages go here once the match is set up; earlier ones wait. */
  listen(handler: (from: string, msg: Msg) => void): void {
    this.handler = handler;
    for (const [from, msg] of this.early.splice(0)) handler(from, msg);
  }

  send(to: string, msg: Msg | string): void {
    const c = this.conns.get(to);
    if (c?.open) c.send(typeof msg === 'string' ? msg : encode(msg));
  }

  broadcast(msg: Msg | string): void {
    const text = typeof msg === 'string' ? msg : encode(msg);
    for (const id of this.conns.keys()) this.send(id, text);
  }

  /** Ids of the guests still connected (host only). */
  get guests(): string[] {
    return this.isHost ? [...this.conns.keys()] : [];
  }

  close(): void {
    this.peer.destroy();
  }

  // -------------------------------------------------------------------------

  private accept(conn: DataConnection): void {
    conn.on('data', (d) => this.receive(conn.peer, JSON.parse(d as string) as Msg, conn));
    conn.on('close', () => this.lost(conn.peer));
    conn.on('error', () => this.lost(conn.peer));
  }

  private receive(from: string, msg: Msg, conn?: DataConnection): void {
    switch (msg.t) {
      case 'hello': {
        if (!conn || !this.isHost) return;
        const cap = this.mode === 'coop' ? TEAM_SIZE : TEAM_SIZE * 2;
        const why = this.started ? 'That match has already started.' : this.players.length >= cap ? 'That lobby is full.' : null;
        if (why) {
          conn.send(encode({ t: 'full', why }));
          setTimeout(() => conn.close(), 500);
          return;
        }
        this.conns.set(from, conn);
        this.players.push({ id: from, name: `Player ${this.players.length + 1}`, god: msg.god as string, team: teamFor(this.mode, this.players) });
        this.changed();
        return;
      }
      case 'pick':
        if (this.isHost && !this.started) this.update(from, { god: msg.god as string });
        return;
      case 'team':
        if (this.isHost && !this.started && this.mode === 'versus') this.update(from, { team: msg.team as Side });
        return;
      case 'lobby':
        this.mode = msg.mode as NetMode;
        this.players = msg.players as NetPlayer[];
        this.onLobby();
        return;
      case 'start':
        if (this.isHost || this.started) return;
        this.mode = msg.mode as NetMode;
        this.players = msg.players as NetPlayer[];
        this.started = true;
        this.onStart();
        return;
      default:
        if (this.handler) this.handler(from, msg);
        else this.early.push([from, msg]);
    }
  }

  private update(id: string, change: Partial<NetPlayer>): void {
    const p = this.players.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, change);
    this.changed();
  }

  private changed(): void {
    this.broadcast({ t: 'lobby', mode: this.mode, players: this.players });
    this.onLobby();
  }

  private lost(id: string): void {
    if (!this.conns.delete(id)) return;
    if (this.isHost && !this.started) {
      this.players = this.players.filter((p) => p.id !== id);
      this.changed();
    }
    this.onLeave(id);
  }
}

function describe(type: string): string {
  switch (type) {
    case 'peer-unavailable':
      return 'No lobby with that code. Check it, or ask the host to open a new one.';
    case 'browser-incompatible':
      return 'This browser does not support peer-to-peer connections.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the matchmaking server. Check your connection and try again.';
    default:
      return `Connection failed (${type}).`;
  }
}
