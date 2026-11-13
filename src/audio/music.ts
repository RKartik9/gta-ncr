import { store, stored } from '../util.ts';

const KEY = 'delhi-drive:music';

interface Saved {
  url: string;
  volume: number;
  playing: boolean;
}

/** The few YouTube IFrame Player calls used here. */
interface YTPlayer {
  loadVideoById(id: string): void;
  loadPlaylist(args: { list: string; listType: 'playlist'; index?: number }): void;
  playVideo(): void;
  stopVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  setVolume(v: number): void;
  setLoop(loop: boolean): void;
  getVideoData(): { title?: string };
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: object) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** Video and/or playlist id from any usual YouTube link (watch, youtu.be, shorts, embed, music.youtube) or a bare id. */
export function parseYouTube(text: string): { video?: string; list?: string } | null {
  const s = text.trim();
  if (/^[\w-]{11}$/.test(s)) return { video: s };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(u.hostname)) return null;
  const list = u.searchParams.get('list') ?? undefined;
  let video = u.searchParams.get('v') ?? undefined;
  if (u.hostname.endsWith('youtu.be')) video = u.pathname.slice(1).split('/')[0];
  const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
  if (m) video = m[1];
  if (video && !/^[\w-]{11}$/.test(video)) video = undefined;
  return video || list ? { video, list } : null;
}

let api: Promise<void> | null = null;
function loadApi() {
  return (api ??= new Promise<void>((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      api = null;
      reject(new Error('Could not reach YouTube'));
    };
    document.head.append(s);
  }));
}

/**
 * Background music from a pasted YouTube link, played by a hidden YouTube player.
 * A single video loops; a playlist plays through and starts again.
 */
export class Music {
  private saved = stored<Saved>(KEY, { url: '', volume: 50, playing: false });
  private player: Promise<YTPlayer> | null = null;
  private single = false;
  /** status line for the menu */
  onStatus: (text: string) => void = () => {};

  get url() {
    return this.saved.url;
  }
  get volume() {
    return this.saved.volume;
  }

  /** On the next visit, the track that was playing starts again with the first click or key press. */
  resumeOnGesture() {
    if (!this.saved.playing || !this.saved.url) return;
    const go = () => {
      removeEventListener('keydown', go);
      removeEventListener('pointerdown', go);
      void this.play(this.saved.url);
    };
    addEventListener('keydown', go);
    addEventListener('pointerdown', go);
  }

  private getPlayer() {
    return (this.player ??= loadApi().then(
      () =>
        new Promise<YTPlayer>((resolve) => {
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none';
          const el = document.createElement('div');
          host.append(el);
          document.body.append(host);
          const p: YTPlayer = new window.YT!.Player(el, {
            width: 1,
            height: 1,
            playerVars: { autoplay: 1, controls: 0, playsinline: 1, disablekb: 1 },
            events: {
              onReady: () => {
                p.setVolume(this.saved.volume);
                resolve(p);
              },
              onStateChange: (e: { data: number }) => {
                if (e.data === 0 && this.single) {
                  p.seekTo(0, true);
                  p.playVideo();
                }
                if (e.data === 1) this.onStatus(`Playing: ${p.getVideoData().title || 'YouTube'}`);
              },
              onError: (e: { data: number }) => {
                const why: Record<number, string> = {
                  2: 'That link does not point at a video',
                  5: 'YouTube could not play this video here',
                  100: 'That video is gone or private',
                  101: "This video can't be played outside YouTube",
                  150: "This video can't be played outside YouTube",
                };
                this.onStatus(why[e.data] ?? `YouTube error ${e.data}`);
              },
            },
          });
        }),
    ));
  }

  async play(url: string) {
    const id = parseYouTube(url);
    if (!id) {
      this.onStatus('Paste a YouTube video or playlist link');
      return;
    }
    this.saved = { ...this.saved, url, playing: true };
    store(KEY, this.saved);
    this.onStatus('Loading…');
    try {
      const p = await this.getPlayer();
      this.single = !id.list;
      if (id.list) {
        p.loadPlaylist({ list: id.list, listType: 'playlist' });
        p.setLoop(true);
      } else p.loadVideoById(id.video!);
    } catch (err) {
      this.player = null;
      this.onStatus(err instanceof Error ? err.message : String(err));
    }
  }

  stop() {
    this.saved = { ...this.saved, playing: false };
    store(KEY, this.saved);
    void this.player?.then((p) => p.stopVideo()).catch(() => {});
    this.onStatus('Stopped');
  }

  setVolume(v: number) {
    this.saved = { ...this.saved, volume: v };
    store(KEY, this.saved);
    void this.player?.then((p) => p.setVolume(v)).catch(() => {});
  }
}
