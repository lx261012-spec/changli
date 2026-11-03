"""Resident offline microphone transcription. Audio is never sent to a network service."""
import json
import os
from pathlib import Path
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
runtime, model_path = sys.argv[1:3]
sys.path.insert(0, runtime)
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

from opencc import OpenCC
to_simplified = OpenCC('t2s')


def waveform(path):
    import av
    import numpy as np
    chunks, count = [], 0
    with av.open(path) as container:
        if container.duration and container.duration / av.time_base > 121:
            raise ValueError('audio_too_long')
        resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
        for frame in container.decode(audio=0):
            for output in resampler.resample(frame):
                array = output.to_ndarray().reshape(-1)
                count += len(array)
                if count > 120 * 16000:
                    raise ValueError('audio_too_long')
                chunks.append(array)
        for output in resampler.resample(None):
            array = output.to_ndarray().reshape(-1)
            count += len(array)
            if count > 120 * 16000:
                raise ValueError('audio_too_long')
            chunks.append(array)
    if count < 1600:
        raise ValueError('audio_empty')
    return np.concatenate(chunks).astype(np.float32) / 32768.0


model = None
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        audio = waveform(request['path'])
        if model is None:
            from faster_whisper import WhisperModel
            model = WhisperModel(model_path, device='cpu', compute_type='int8', cpu_threads=4,
                                 num_workers=1, local_files_only=True)
        segments, info = model.transcribe(audio, language='zh', beam_size=3,
                                          condition_on_previous_text=False,
                                          vad_filter=True,
                                          vad_parameters={'min_silence_duration_ms': 300})
        text = to_simplified.convert(''.join(segment.text.strip() for segment in segments).strip())
        print(json.dumps({'id': request['id'], 'text': text, 'duration': round(len(audio) / 16000, 3),
                          'offline': True}, ensure_ascii=False), flush=True)
    except Exception as error:
        code = str(error) if str(error) in ('audio_too_long', 'audio_empty') else 'transcription_failed'
        print(json.dumps({'id': request.get('id'), 'error': code}), flush=True)
