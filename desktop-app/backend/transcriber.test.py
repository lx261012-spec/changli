"""Exercise the real worker with recorded audio decoding and controlled ASR segments."""
import io
import json
from pathlib import Path
import runpy
import sys
import types

root = Path(__file__).resolve().parents[1]
workspace = root.parent
samples = [
    ('幫我打開qq音樂', '帮我打开qq音乐'),
    ('長离幫我打開QQ音樂', '长离帮我打开QQ音乐'),
    ('歡迎使用錄音輸入，今天的天氣很好。GPT 6.1，123！', '欢迎使用录音输入，今天的天气很好。GPT 6.1，123！'),
]
texts = iter(text for text, _ in samples)
class Model:
    def __init__(self, *args, **kwargs):
        assert kwargs['local_files_only'] is True
    def transcribe(self, audio, **kwargs):
        return [types.SimpleNamespace(text=next(texts))], None
module = types.ModuleType('faster_whisper')
module.WhisperModel = Model
sys.modules['faster_whisper'] = module
class Output(io.StringIO):
    def reconfigure(self, **kwargs):
        pass
output = Output()
sys.argv = [str(root / 'backend/transcriber.py'), str(workspace / 'work/audio-runtime'), str(workspace / 'work/audio-models/faster-whisper-small')]
sys.stdin = io.StringIO('\n'.join(json.dumps({'id': str(i), 'path': str(root / 'wallpaper/media/T01.wav')}) for i in range(len(samples)))+'\n')
original_stdout = sys.stdout
sys.stdout = output
try:
    runpy.run_path(sys.argv[0], run_name='__main__')
finally:
    sys.stdout = original_stdout
results = [json.loads(line) for line in output.getvalue().splitlines()]
assert len(results) == len(samples), results
for i, (result, (_, expected)) in enumerate(zip(results, samples)):
    assert result.get('text') == expected, result
    assert result['id'] == str(i) and result['offline'] is True
    assert result['duration'] > 0
print(json.dumps({'passed': True, 'cases': len(samples), 'converter': 'real installed OpenCC t2s', 'audioDecode': 'real recorded WAV', 'recognitionModel': 'controlled segment fixture'}, ensure_ascii=False))
