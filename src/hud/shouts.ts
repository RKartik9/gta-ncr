/**
 * What the street says out loud: at a driver who nearly ran them down, running from gunfire, egging on a fight,
 * squaring up to the player, walked into or walked past by him, and at the sight of his rifle. The lines are spoken
 * by an AI voice told how to say each (angry, terrified, casual), made ahead of time by tools/voices/make-lines.py
 * into public/sounds/lines: eight voices, five men and three women. Each person is given one the first time they
 * speak, at a pitch of their own, and keeps it: no two sound quite alike.
 */
export type ShoutKind = 'angry' | 'panic' | 'gawk' | 'fight' | 'bump' | 'passby' | 'armed';

/** whoever is shouting: a walker, or a fighter's feet */
type Who = { x: number; z: number };
type Speaker = (file: string, rate: number, x: number, z: number) => void;

/** never more than this many voices at once: a crowd's shouting is a few voices you can make out, not a roar */
const MOST = 3;

let index: { voices: { id: string; woman: boolean }[]; lines: Record<ShoutKind, number> } | null = null;
void fetch(`${import.meta.env.BASE_URL}sounds/lines/index.json`)
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((j) => (index = j))
  .catch((err) => console.warn('the street has no voices', err));

let speaker: Speaker | null = null;
let talking: number[] = [];
const people = new WeakMap<object, { voice: string; rate: number; until: number }>();

/** Where the lines are played (audio/sound.ts `speak`). */
export function setSpeaker(play: Speaker) {
  speaker = play;
}

/** `who` (a woman or a man) shouts a line of `kind`, one at a time each. `chance` is how likely they are to say anything at all. */
export function shout(who: Who, woman: boolean, kind: ShoutKind, chance = 1) {
  if (!index?.lines[kind] || !speaker || Math.random() > chance) return;
  const now = performance.now() / 1000;
  talking = talking.filter((end) => end > now);
  let me = people.get(who);
  if ((me && me.until > now) || talking.length >= MOST) return;
  if (!me) {
    const voices = index.voices.filter((v) => v.woman === woman);
    me = { voice: voices[Math.floor(Math.random() * voices.length)].id, rate: 0.94 + Math.random() * 0.12, until: 0 };
    people.set(who, me);
  }
  me.until = now + 2;
  talking.push(now + 1.5);
  speaker(`lines/${me.voice}/${kind}-${1 + Math.floor(Math.random() * index.lines[kind])}.mp3`, me.rate, who.x, who.z);
}
