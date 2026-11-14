import type { DriveInput } from './vehicle.ts';

const DRIVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']);

/**
 * Controller buttons (W3C "standard" layout: Xbox names, PlayStation in brackets) fire the same actions as these keys,
 * so every action is defined once, in main.ts.
 */
const PAD_BUTTONS: Record<number, string> = {
  1: 'KeyR', // B [circle]: back onto the road
  2: 'KeyH', // X [square]: horn
  3: 'KeyC', // Y [triangle]: next camera
  4: 'KeyV', // LB [L1]: switch car
  5: 'KeyL', // RB [R1]: headlights
  8: 'KeyN', // View [Share]: day / night
  9: 'Escape', // Menu [Options]: pause menu
  12: 'KeyT', // d-pad up: pause or run the clock
  13: 'KeyM', // d-pad down: map
  0: 'PadA', // A [cross]: also the handbrake while driving; on the map, set the waypoint
};
const HANDBRAKE = 0; // A [cross], held
const RT = 7, LT = 6;
const DEAD = 0.12;

/** Stick value with the dead zone cut out and the rest stretched back to the full -1..1. */
const stick = (v: number) => (Math.abs(v) < DEAD ? 0 : Math.sign(v) * ((Math.abs(v) - DEAD) / (1 - DEAD)));

/** Keyboard and game controller together: whichever is pushed harder wins. */
export class Keyboard {
  private down = new Set<string>();
  private handlers = new Map<string, () => void>();
  private padIndex: number | null = null;
  private padWas: boolean[] = [];
  private pad = { throttle: 0, steer: 0, handbrake: false };
  /** right stick, -1..1, for looking round */
  look = { x: 0, y: 0 };
  /** left stick and triggers as they are, for the map */
  raw = { x: 0, y: 0, rt: 0, lt: 0 };
  /** called with the controller's name when one is plugged in, or null when it goes */
  onPadChange: (name: string | null) => void = () => {};

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // typing in a menu box (the music link) is not driving; Esc still closes the menu
      if (e.target instanceof HTMLInputElement && e.target.type === 'text' && e.code !== 'Escape') return;
      if (DRIVE_KEYS.has(e.code) || this.handlers.has(e.code)) e.preventDefault();
      if (!e.repeat) this.handlers.get(e.code)?.();
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    // A key released while the tab is in the background would otherwise stay "held".
    window.addEventListener('blur', () => this.down.clear());
    window.addEventListener('gamepadconnected', (e) => this.adopt(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index !== this.padIndex) return;
      this.padIndex = null;
      this.padWas = [];
      this.pad = { throttle: 0, steer: 0, handbrake: false };
      this.look = { x: 0, y: 0 };
      this.onPadChange(null);
    });
  }

  on(code: string, handler: () => void) {
    this.handlers.set(code, handler);
  }

  /** Key held right now, or the controller button mapped to it. */
  held(code: string) {
    if (this.down.has(code)) return true;
    for (const i in PAD_BUTTONS) if (PAD_BUTTONS[i] === code && this.padWas[i]) return true;
    return false;
  }

  private adopt(gp: Gamepad) {
    if (this.padIndex !== null) return;
    this.padIndex = gp.index;
    this.padWas = gp.buttons.map((b) => b.pressed);
    const name = gp.id.replace(/\s*\(.*\)\s*/g, ' ').trim() || 'Controller';
    this.onPadChange(gp.mapping === 'standard' ? name : `${name} (unrecognised layout: some buttons may be off)`);
  }

  /** What the browser reports for the controller, for the pause menu: enough to see why one does not respond. */
  padReport() {
    const gp = this.padIndex === null ? null : navigator.getGamepads()[this.padIndex];
    if (!gp) {
      // Say why, as far as the page can tell: these are the usual reasons a paired controller never shows up.
      if (!window.isSecureContext) return `Blocked: browsers only allow controllers on https:// or localhost pages.\nThis page is ${location.origin}. Open http://localhost:${location.port || 80}/ instead.`;
      if (typeof navigator.getGamepads !== 'function') return 'This browser has no controller support (Gamepad API missing).';
      let slots: (Gamepad | null)[] = [];
      try {
        slots = [...navigator.getGamepads()];
      } catch (err) {
        return `The browser refused controller access: ${err instanceof Error ? err.message : String(err)}`;
      }
      return `None seen yet. Click the game, then press A / ✕ on the controller.\nBrowser reports ${slots.length} slots, all empty.\nIf it stays empty, the browser cannot see this controller (see notes).`;
    }
    const pressed = gp.buttons.flatMap((b, i) => (b.pressed || b.value > 0.05 ? [`${i}:${b.value.toFixed(2)}`] : []));
    return `${gp.id}\nlayout ${gp.mapping || 'non-standard'} · ${gp.buttons.length} buttons · ${gp.axes.length} axes\naxes ${gp.axes.map((a) => a.toFixed(2)).join(' ')}\npressed ${pressed.join(' ') || '-'}\nthrottle ${this.pad.throttle.toFixed(2)} · steer ${this.pad.steer.toFixed(2)}`;
  }

  /** Once a frame: read the controller and fire the actions of buttons that were just pressed. */
  poll() {
    // The browser announces a controller once, on its first button press; one pressed during loading
    // was announced before this listened. Looking for it every frame catches that, and reconnects too.
    if (this.padIndex === null) {
      const found = [...(navigator.getGamepads?.() ?? [])].find((g): g is Gamepad => !!g && g.connected);
      if (!found) return;
      this.adopt(found);
    }
    // the browser hands out a fresh snapshot each call; holding on to an old one reads stale values
    const gp = navigator.getGamepads()[this.padIndex!];
    if (!gp) {
      this.padIndex = null;
      return;
    }
    const b = (i: number) => gp.buttons[i];
    gp.buttons.forEach((btn, i) => {
      if (btn.pressed && !this.padWas[i] && PAD_BUTTONS[i]) this.handlers.get(PAD_BUTTONS[i])?.();
      this.padWas[i] = btn.pressed;
    });
    // triggers are analogue on most pads; some report only pressed
    const trigger = (i: number) => (b(i) ? Math.max(b(i).value, b(i).pressed ? 1 : 0) : 0);
    const dpad = (i: number) => (b(i)?.pressed ? 1 : 0);
    this.pad.throttle = trigger(RT) - trigger(LT);
    this.pad.steer = -stick(gp.axes[0] ?? 0) || dpad(14) - dpad(15);
    this.pad.handbrake = !!b(HANDBRAKE)?.pressed;
    this.raw = { x: stick(gp.axes[0] ?? 0), y: stick(gp.axes[1] ?? 0), rt: trigger(RT), lt: trigger(LT) };
    // only on the standard layout: elsewhere axes 2 and 3 are often the triggers, and the view swung with the throttle
    const std = gp.mapping === 'standard';
    this.look.x = std ? stick(gp.axes[2] ?? 0) : 0;
    this.look.y = std ? stick(gp.axes[3] ?? 0) : 0;
  }

  /** A short shake, where the controller can. */
  rumble(strength: number, ms: number) {
    if (this.padIndex === null) return;
    const gp = navigator.getGamepads()[this.padIndex];
    void gp?.vibrationActuator?.playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strength), weakMagnitude: Math.min(1, strength * 0.6) }).catch(() => {});
  }

  drive(): DriveInput {
    const d = this.down;
    const held = (a: string, b: string) => (d.has(a) || d.has(b) ? 1 : 0);
    const keys = { throttle: held('ArrowUp', 'KeyW') - held('ArrowDown', 'KeyS'), steer: held('ArrowLeft', 'KeyA') - held('ArrowRight', 'KeyD') };
    const stronger = (a: number, b: number) => (Math.abs(a) >= Math.abs(b) ? a : b);
    return {
      throttle: stronger(keys.throttle, this.pad.throttle),
      steer: stronger(keys.steer, this.pad.steer),
      handbrake: d.has('Space') || this.pad.handbrake,
    };
  }
}
