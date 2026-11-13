// Music: every usual way of sharing a YouTube link gives the right video or playlist id.
// Run with: node tools/dev/youtube-check.ts
import assert from 'node:assert/strict';
import { parseYouTube } from '../../src/audio/music.ts';

const id = 'dQw4w9WgXcQ';
assert.deepEqual(parseYouTube(`https://www.youtube.com/watch?v=${id}&t=30s`), { video: id, list: undefined });
assert.deepEqual(parseYouTube(`youtu.be/${id}?si=abc`), { video: id, list: undefined });
assert.deepEqual(parseYouTube(`https://youtube.com/shorts/${id}`), { video: id, list: undefined });
assert.deepEqual(parseYouTube(`https://music.youtube.com/watch?v=${id}&list=PL123`), { video: id, list: 'PL123' });
assert.deepEqual(parseYouTube('https://www.youtube.com/playlist?list=PLabc'), { video: undefined, list: 'PLabc' });
assert.deepEqual(parseYouTube(id), { video: id });
assert.equal(parseYouTube('https://vimeo.com/123'), null);
assert.equal(parseYouTube('https://evil-youtube.com/watch?v=' + id), null);
assert.equal(parseYouTube('not a link'), null);
console.log('youtube links ok');
