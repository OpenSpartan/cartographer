// Live zones for films-ui's zone layer (films-ui zones.ts, the layer Films
// draws its zones with): each zone of the mode in play, its volume from the
// map variant's placements (objectives.rs), its state from the game's own
// marker on it as libfilmshell reads a film's (observer.rs navpoint.zone:
// owner, capture, contest, countdown, letter), with the capture's progress
// and the players inside. A zone the game has no marker on is one the mode
// isn't using now (a KOTH hill to come or gone). With no markers at all (an
// older server) every zone shows plain.

import { ZONE_NEAR } from './model.js';

/** `placed`: the mode's placements, `mode`: objectiveMode(snapshot). */
export function liveZones(snapshot, placed, mode) {
  const markers = (snapshot?.navpoints ?? []).filter(n => n.kind === 'mp_control_area' && n.position);
  const teamOfSlot = new Map((snapshot?.players ?? []).map(p => [p.slot, p.team ?? undefined]));
  const hills = mode === 'koth';
  return placed.filter(o => o.kind === 'zone' && o.b).map(o => {
    const zone = {
      x: o.x, y: o.y,
      shape: { cylinder: o.b[0] === 2, a: o.b[1], b: o.b[2], angle: o.yaw ?? 0 },
      label: hills ? 'H' : undefined,
    };
    const n = markers.find(m => Math.hypot(m.position.x - o.x, m.position.y - o.y) < ZONE_NEAR);
    if (!n) return { ...zone, phase: hills && markers.length ? 'off' : 'on' };
    const z = n.zone ?? {};
    const owner = z.owner ?? undefined;
    const countdown = Boolean(z.countdown);
    return {
      ...zone,
      label: hills ? 'H' : z.letter ?? undefined,
      phase: countdown ? 'countdown' : owner !== undefined ? 'controlled' : hills ? 'live' : 'on',
      owner,
      capturing: z.capturing ?? undefined,
      progress: countdown ? 0 : Math.min(1, Math.abs(n.progress ?? 0)),
      contested: Boolean(z.contested),
      inside: n.inside.map(slot => teamOfSlot.get(slot)),
      countdownSeconds: countdown && Number.isFinite(n.timer_seconds) ? n.timer_seconds : undefined,
    };
  });
}
