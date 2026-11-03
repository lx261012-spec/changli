"""Persistent, offline Changli inference. JSON-lines on stdout; no WebUI changes."""
import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import time
import traceback

protocol = sys.stdout


def send(value):
    protocol.write(json.dumps(value, ensure_ascii=False) + "\n")
    protocol.flush()


def check(path, expected):
    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != expected:
        raise ValueError("Approved voice asset hash changed")


def main():
    config = json.loads(os.environ["CHANGLI_SPEECH_CONFIG"])
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        check(config["s1"], "e41c60b592a6f83bbf85c821000105acb491a646ce8b69f1afe0fd59e7015641")
        check(config["s2"], "859898b0fe84556792162d2fea37fdeabefa60e83c62df7c49bfa241c54e73dd")
        check(config["reference"], "8f1c9d1c61fac89673be2989a4d0463d526ba574eb8ed42114ee2a496ad614ce")
        os.environ.update(is_half="False", version="v2", language="zh_CN")
        sys.dont_write_bytecode = True
        sys.path.insert(0, config["runtime"])
        from runtime_bootstrap import activate as bootstrap
        repo = bootstrap()
        os.chdir(repo)
        from tools.portable_runtime import activate
        activate(change_cwd=True)
        import numpy as np
        import soundfile as sf
        import torch
        from TTS_infer_pack.TTS import TTS, TTS_Config
        torch.set_num_threads(6)
        inference = TTS_Config({"custom": {
            "version": "v2", "device": "cpu", "is_half": False,
            "t2s_weights_path": config["s1"], "vits_weights_path": config["s2"],
            "bert_base_path": str(repo / "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"),
            "cnhuhbert_base_path": str(repo / "GPT_SoVITS/pretrained_models/chinese-hubert-base"),
        }})
        Path(config["cache"]).mkdir(parents=True, exist_ok=True)
        inference.configs_path = str(Path(config["cache"]) / "tts_infer.yaml")
        tts = TTS(inference)
    load_ms = round((time.perf_counter() - started) * 1000)
    send({"ready": True, "loadMs": load_ms})
    for line in sys.stdin:
        row = {}
        try:
            row = json.loads(line)
            text = row["text"]
            if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                raise ValueError("Invalid text")
            started = time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr):
                chunks, rates = [], []
                for rate, audio in tts.run({
                    "text": text, "text_lang": "all_zh", "prompt_lang": "all_zh",
                    "ref_audio_path": config["reference"], "prompt_text": "此间当下，便是最好的时光了。",
                    "top_k": 15, "top_p": 1.0, "temperature": 1.0, "text_split_method": "cut1",
                    "batch_size": 1, "speed_factor": 1.0, "split_bucket": False,
                    "return_fragment": False, "fragment_interval": 0.3, "seed": 3698637367,
                    "parallel_infer": True, "use_cuda_graph": False, "use_flash_attention": False,
                    "repetition_penalty": 1.35, "sample_steps": 32, "cfg_rate": 0.0,
                    "super_sampling": False, "aux_ref_audio_paths": [],
                }):
                    chunks.append(audio)
                    rates.append(rate)
                if not chunks or set(rates) != {32000}:
                    raise ValueError("Invalid sample rate")
                audio = np.concatenate(chunks)
                if audio.ndim != 1 or not np.isfinite(audio).all() or not np.any(audio):
                    raise ValueError("Invalid waveform")
                output = io.BytesIO()
                sf.write(output, audio, 32000, format="WAV", subtype="PCM_16")
            send({"id": row["id"], "audio": base64.b64encode(output.getvalue()).decode("ascii"),
                  "seconds": len(audio) / 32000, "generationMs": round((time.perf_counter() - started) * 1000), "loadMs": load_ms})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            send({"id": row.get("id"), "error": "inference_failed"})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(file=sys.stderr)
        send({"fatal": "model_load_failed"})
        sys.exit(1)
