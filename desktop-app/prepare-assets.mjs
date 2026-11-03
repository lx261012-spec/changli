import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = new URL('./', import.meta.url);
// A short resonant board strike, synthesized locally without external recordings.
const rate = 44100, count = Math.floor(rate * .17), wav = Buffer.alloc(44 + count * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
let seed = 871;
for (let n = 0; n < count; n++) {
  const t = n / rate; seed = (1664525 * seed + 1013904223) >>> 0;
  const attack = Math.min(1, t / .0015);
  const tone = Math.sin(t * 2 * Math.PI * 1310) * Math.exp(-t * 47) + .42 * Math.sin(t * 2 * Math.PI * 2460) * Math.exp(-t * 68);
  const impact = (seed / 0xffffffff * 2 - 1) * Math.exp(-t * 520) * .65;
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, (tone + impact) * attack * .18)) * 32767), 44 + n * 2);
}
writeFileSync(new URL('assets/click.wav', root), wav);
// Wallpaper integration is maintained as source, not rewritten during packaging.
const files = readdirSync(new URL('assets/', root)).filter(name=>!name.endsWith('.json')).map(name=>{
  const buffer = readFileSync(new URL('assets/'+name,root));
  return {name,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')};
});
writeFileSync(new URL('assets/manifest.json',root),JSON.stringify({created:'2026-10-28',files},null,2));
console.log('Prepared desktop-only copy and '+files.length+' assets.');
