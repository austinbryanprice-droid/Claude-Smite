import { godById } from '../game/gods';
import { NetSession } from './Session';
import type { NetMode } from './roster';
import './lobby.css';

const MODE_NAMES: Record<NetMode, string> = { coop: 'Co-op', versus: 'Versus' };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A link that opens the title screen and joins this lobby (keeping a custom signaling server for testing). */
function inviteLink(code: string): string {
  const url = new URL(location.pathname, location.origin);
  const peer = new URLSearchParams(location.search).get('peer');
  if (peer) url.searchParams.set('peer', peer);
  url.searchParams.set('join', code);
  return url.toString();
}

/**
 * The title screen's "Play with friends" box: host a co-op or versus lobby
 * (and share its code), or join one with a code. Calls `onStart` when the
 * host starts the match. `inLobby` tells the title screen to hold its own
 * Play button while a lobby is open.
 */
export function mountLobby(
  box: HTMLElement,
  hooks: { god: () => string; inLobby: (on: boolean) => void; onStart: (s: NetSession) => void },
): { godChanged: () => void } {
  let session: NetSession | null = null;
  let busy = '';
  let error = '';

  const render = () => {
    hooks.inLobby(session !== null);
    if (!session) {
      box.innerHTML = `
        <div class="lb-row">
          <button class="lb-btn" data-host="coop"><b>Host co-op</b><span>Friends together against bots</span></button>
          <button class="lb-btn" data-host="versus"><b>Host versus</b><span>Friends on both teams, bots fill in</span></button>
        </div>
        <div class="lb-row lb-join">
          <input class="lb-code" maxlength="5" placeholder="Lobby code" spellcheck="false" autocomplete="off">
          <button class="lb-small lb-go">Join</button>
        </div>
        <div class="lb-msg ${error ? 'lb-err' : ''}">${esc(busy || error || 'One player hosts and runs the match; up to 10 players.')}</div>`;
      box.querySelectorAll<HTMLButtonElement>('[data-host]').forEach((b) => b.addEventListener('click', () => void host(b.dataset.host as NetMode)));
      const input = box.querySelector<HTMLInputElement>('.lb-code')!;
      const go = () => void join(input.value);
      box.querySelector('.lb-go')!.addEventListener('click', go);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go();
      });
      if (busy) box.querySelectorAll('button, input').forEach((el) => ((el as HTMLButtonElement).disabled = true));
      return;
    }
    const s = session;
    const rows = s.players
      .map((p) => {
        const god = godById(p.god)?.name ?? p.god;
        const you = p.id === s.me ? ' <i>(you)</i>' : '';
        const team = s.mode === 'versus' ? `<span class="lb-team lb-${p.team}">${p.team === 'order' ? 'Order' : 'Chaos'}</span>` : '';
        return `<div class="lb-player"><span>${esc(p.name)}${you}</span><span>${esc(god)}</span>${team}</div>`;
      })
      .join('');
    box.innerHTML = `
      <div class="lb-head">
        <span>${MODE_NAMES[s.mode]} lobby <b class="lb-show">${s.code}</b></span>
        <button class="lb-small lb-copy">Copy invite link</button>
      </div>
      <div class="lb-players">${rows}</div>
      <div class="lb-row">
        ${s.mode === 'versus' ? '<button class="lb-small lb-switch">Switch team</button>' : ''}
        <button class="lb-small lb-leave">Leave</button>
        ${s.isHost ? '<button class="lb-start">Start match</button>' : '<span class="lb-msg">Waiting for the host to start…</span>'}
      </div>
      <div class="lb-msg">${s.isHost ? 'Share the code or link. Empty slots are played by bots.' : ''}</div>`;
    box.querySelector('.lb-copy')!.addEventListener('click', (e) => {
      void navigator.clipboard?.writeText(inviteLink(s.code));
      (e.currentTarget as HTMLButtonElement).textContent = 'Copied';
    });
    box.querySelector('.lb-switch')?.addEventListener('click', () => s.switchTeam());
    box.querySelector('.lb-leave')!.addEventListener('click', () => {
      s.close();
      session = null;
      error = '';
      render();
    });
    box.querySelector('.lb-start')?.addEventListener('click', () => s.start());
  };

  const opened = (s: NetSession) => {
    session = s;
    busy = '';
    s.onLobby = render;
    s.onStart = () => hooks.onStart(s);
    s.onLeave = (id) => {
      if (id !== 'host' || s.started) return;
      session = null;
      error = 'The host closed the lobby.';
      render();
    };
    render();
  };

  const host = async (mode: NetMode) => {
    busy = 'Opening a lobby…';
    error = '';
    render();
    try {
      opened(await NetSession.host(mode, hooks.god()));
    } catch (e) {
      busy = '';
      error = (e as Error).message;
      render();
    }
  };

  const join = async (code: string) => {
    if (code.trim().length < 5) {
      error = 'Lobby codes are 5 letters and digits.';
      render();
      return;
    }
    busy = 'Joining…';
    error = '';
    render();
    try {
      opened(await NetSession.join(code, hooks.god()));
    } catch (e) {
      busy = '';
      error = (e as Error).message;
      render();
    }
  };

  render();
  const invited = new URLSearchParams(location.search).get('join');
  if (invited) void join(invited);
  return { godChanged: () => session?.pick(hooks.god()) };
}
