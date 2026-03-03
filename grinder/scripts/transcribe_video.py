#!/usr/bin/env python3
"""
High-quality speaker-aware transcription for a video file using WhisperX.

Outputs:
- JSON with segments and word-level timings
- TXT with speaker labels
- SRT with speaker labels

Requires:
- python3
- pip install "whisperx" torch
- A Hugging Face token for diarization: export HUGGINGFACE_HUB_TOKEN=...
"""

import argparse
import json
import os
from datetime import timedelta


def format_ts(seconds: float) -> str:
    td = timedelta(seconds=max(0.0, seconds))
    total_seconds = int(td.total_seconds())
    ms = int((td.total_seconds() - total_seconds) * 1000)
    hh = total_seconds // 3600
    mm = (total_seconds % 3600) // 60
    ss = total_seconds % 60
    return f"{hh:02}:{mm:02}:{ss:02},{ms:03}"


def write_txt(path, segments):
    with open(path, "w", encoding="utf-8") as f:
        for seg in segments:
            speaker = seg.get("speaker", "SPEAKER_00")
            start = seg.get("start", 0.0)
            end = seg.get("end", 0.0)
            text = seg.get("text", "").strip()
            f.write(f"[{format_ts(start)} - {format_ts(end)}] {speaker}: {text}\n")


def write_srt(path, segments):
    with open(path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, 1):
            speaker = seg.get("speaker", "SPEAKER_00")
            start = format_ts(seg.get("start", 0.0))
            end = format_ts(seg.get("end", 0.0))
            text = seg.get("text", "").strip()
            f.write(f"{i}\n{start} --> {end}\n{speaker}: {text}\n\n")

def write_dialogue(path, segments):
    lines = []
    current_speaker = None
    current_text = []
    for seg in segments:
        text = seg.get("text", "").strip()
        if not text:
            continue
        speaker = seg.get("speaker", "SPEAKER_00")
        if speaker != current_speaker:
            if current_text:
                lines.append(f"{current_speaker}: {' '.join(current_text)}")
            current_speaker = speaker
            current_text = [text]
        else:
            current_text.append(text)
    if current_text:
        lines.append(f"{current_speaker}: {' '.join(current_text)}")

    with open(path, "w", encoding="utf-8") as f:
        for line in lines:
            f.write(line + "\n")


def main():
    parser = argparse.ArgumentParser(description="Speaker-aware transcription with WhisperX")
    parser.add_argument("input", help="Path to the input video/audio file")
    parser.add_argument("--output-dir", default="transcripts", help="Output directory")
    parser.add_argument("--model", default="large-v3", help="Whisper model size")
    parser.add_argument("--device", default=None, help="cuda or cpu (default: auto)")
    parser.add_argument("--compute-type", default=None, help="float16 on GPU, int8 on CPU (default: auto)")
    parser.add_argument("--language", default=None, help="Force language (e.g. en, ru), or auto-detect")
    parser.add_argument("--min-speakers", type=int, default=None)
    parser.add_argument("--max-speakers", type=int, default=None)
    parser.add_argument("--prefetch", action="store_true", help="Download models and exit")
    parser.add_argument("--no-prefetch", action="store_true", help="Skip warmup downloads")
    parser.add_argument("--cache-dir", default=None, help="Where to store model caches")
    args = parser.parse_args()

    if args.cache_dir:
        cache_dir = os.path.abspath(args.cache_dir)
        os.makedirs(cache_dir, exist_ok=True)
        os.environ.setdefault("HF_HOME", cache_dir)
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(cache_dir, "hub"))
        os.environ.setdefault("TRANSFORMERS_CACHE", os.path.join(cache_dir, "transformers"))
        os.environ.setdefault("TORCH_HOME", os.path.join(cache_dir, "torch"))

    import whisperx
    try:
        import torch
        # Pyannote models may fail with weights_only=True in torch>=2.6.
        # Override to False unless explicitly set by caller.
        _orig_torch_load = torch.load
        def _torch_load_compat(*args, **kwargs):
            if "weights_only" not in kwargs or kwargs["weights_only"] is None:
                kwargs["weights_only"] = False
            return _orig_torch_load(*args, **kwargs)
        torch.load = _torch_load_compat
    except Exception:
        torch = None

    os.makedirs(args.output_dir, exist_ok=True)
    base_name = os.path.splitext(os.path.basename(args.input))[0]

    device = args.device
    if device is None:
        if torch and torch.cuda.is_available():
            device = "cuda"
        else:
            device = "cpu"

    compute_type = args.compute_type
    if compute_type is None:
        compute_type = "float16" if device == "cuda" else "int8"

    model = None
    align_model = None
    align_metadata = None
    diarize_model = None
    hf_token = os.environ.get("HUGGINGFACE_HUB_TOKEN")

    if not args.no_prefetch:
        print("Preparing models (first run will download caches)...")
        model = whisperx.load_model(
            args.model,
            device,
            compute_type=compute_type,
            language=args.language,
        )
        if args.language:
            align_model, align_metadata = whisperx.load_align_model(
                language_code=args.language,
                device=device,
            )
        if hf_token and hasattr(whisperx, "DiarizationPipeline"):
            diarize_model = whisperx.DiarizationPipeline(use_auth_token=hf_token, device=device)
        elif not hf_token:
            print("HUGGINGFACE_HUB_TOKEN is not set; diarization will be skipped.")
        else:
            print("WhisperX DiarizationPipeline not available; diarization will be skipped.")

        if args.prefetch:
            print("Prefetch complete.")
            return

    print("Loading audio...")
    audio = whisperx.load_audio(args.input)

    if model is None:
        model = whisperx.load_model(
            args.model,
            device,
            compute_type=compute_type,
            language=args.language,
        )

    print("Transcribing...")
    result = model.transcribe(audio, batch_size=16)

    # Align for better timestamps
    if result.get("segments"):
        print("Aligning segments...")
        if align_model is None or align_metadata is None:
            align_model, align_metadata = whisperx.load_align_model(
                language_code=result.get("language", args.language or "en"),
                device=device,
            )
        result = whisperx.align(result["segments"], align_model, align_metadata, audio, device)

    # Diarization (speaker labels)
    if hf_token and hasattr(whisperx, "DiarizationPipeline"):
        if diarize_model is None:
            diarize_model = whisperx.DiarizationPipeline(use_auth_token=hf_token, device=device)
        print("Diarizing speakers...")
        diarize_segments = diarize_model(
            audio,
            min_speakers=args.min_speakers,
            max_speakers=args.max_speakers,
        )
        result = whisperx.assign_word_speakers(diarize_segments, result)
    elif not hf_token:
        print("HUGGINGFACE_HUB_TOKEN is not set; diarization will be skipped.")
    else:
        print("WhisperX DiarizationPipeline not available; diarization will be skipped.")

    json_path = os.path.join(args.output_dir, f"{base_name}.json")
    txt_path = os.path.join(args.output_dir, f"{base_name}.txt")
    srt_path = os.path.join(args.output_dir, f"{base_name}.srt")
    dialogue_path = os.path.join(args.output_dir, f"{base_name}.dialogue.txt")

    print("Writing outputs...")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    segments = result.get("segments", [])
    write_txt(txt_path, segments)
    write_srt(srt_path, segments)
    write_dialogue(dialogue_path, segments)

    print("Done:")
    print("-", json_path)
    print("-", txt_path)
    print("-", srt_path)
    print("-", dialogue_path)


if __name__ == "__main__":
    main()
