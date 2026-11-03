import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ModelError } from './model.mjs';

export const careLines = JSON.parse(readFileSync(new URL('../assets/care-lines.json', import.meta.url), 'utf8'));
export const careEntryLines = JSON.parse(readFileSync(new URL('../assets/care-entry-lines.json', import.meta.url), 'utf8'));

export function readCareAudio(directory, line) {
  try {
    if (!directory || !/^C\d{2}_[a-z]+_(entry|duration)\.wav$/.test(line.filename)) throw new Error('Invalid resource');
    const audio = readFileSync(join(directory, line.filename));
    if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || createHash('sha256').update(audio).digest('hex') !== line.sha256) throw new Error('Invalid audio');
    return audio;
  } catch { throw new ModelError('主动关心录音暂不可用，文字已保留；可稍后重试播放。', 'care_audio_unavailable', 503); }
}
