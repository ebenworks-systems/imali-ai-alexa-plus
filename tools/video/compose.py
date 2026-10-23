#!/usr/bin/env python3
"""Puts the voices and captions on the recorded film.

    python3 tools/video/compose.py

Reads submission/work/film-raw.mp4 and its events from record.cjs, and the takes from narrate.py. Each take starts
at the moment its event was marked during the recording. An assistant take that would run into the next voice is
sped up a little (at most 12%) and the speed-up is reported. The narrator's lines are captioned on a light card at
the foot of the picture; the owner's and assistant's words are already on the screen. The .srt carries every spoken
line, the owner's and the assistant's labelled, for the video platform's captions. Writes
submission/imali-ai-alexa-plus-demo.mp4 and .srt, with the sound brought to -16 LUFS.
"""
import json, os, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORK = os.path.join(ROOT, "submission", "work")
SCRIPT = json.load(open(os.path.join(os.path.dirname(__file__), "script.json")))
LENGTHS = json.load(open(os.path.join(WORK, "takes", "lengths.json")))
EVENTS = json.load(open(os.path.join(WORK, "film-raw.events.json")))
OUT = os.path.join(ROOT, "submission", "imali-ai-alexa-plus-demo.mp4")
CAPTIONS = {b["narrator"]: b["caption"] for s in SCRIPT["scenes"] for b in s["beats"] if "narrator" in b}
OWNER = {b["owner"]: b["say"] for s in SCRIPT["scenes"] for b in s["beats"] if "owner" in b}
REPLIES_FILE = os.path.join(WORK, "replies.json")


def stamp(t, sep):
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}" if sep == "." else f"{int(h):02d}:{int(m):02d}:{s:06.3f}".replace(".", ",")


def timeline():
    voiced = [e for e in EVENTS["events"] if e["label"].split(":")[0] in ("owner", "assistant", "narrator")]
    out = []
    for i, e in enumerate(voiced):
        kind, tid = e["label"].split(":", 1)
        length = LENGTHS[tid]
        nxt = voiced[i + 1]["t"] if i + 1 < len(voiced) else e["t"] + length + 5
        room = nxt - e["t"] - 0.15
        tempo = 1.0
        if length > room and kind == "assistant":
            tempo = min(1.12, length / room)
            length = length / tempo
        out.append({"id": tid, "kind": kind, "start": round(e["t"] + 0.05, 3), "end": round(e["t"] + 0.05 + length, 3), "tempo": round(tempo, 3), "overlap": round(max(0.0, length - room), 2)})
    return out


def ass(lines, w, h):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Sofia Sans,40,&H00131414,&H00131414,&H00FAFBFC,&H10FFFFFF,0,0,0,0,100,100,0,0,3,18,0,2,240,240,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    body = "".join(f"Dialogue: 0,{stamp(l['start'], '.')},{stamp(l['end'] + 0.3, '.')},Cap,,0,0,0,,{CAPTIONS[l['id']]}\n" for l in lines if l["kind"] == "narrator")
    return head + body


def main():
    lines = timeline()
    w, h = EVENTS["width"], EVENTS["height"]
    film = os.path.join(WORK, "film-raw.mp4")
    total = max(EVENTS["seconds"], lines[-1]["end"] + 1.5)
    captions = "/tmp/imali-ai-alexa-plus-captions.ass"  # a path with no spaces or brackets, for the filter graph
    open(captions, "w").write(ass(lines, w, h))
    replies = {r["id"]: r["text"] for r in json.load(open(REPLIES_FILE))}
    said = {"owner": lambda i: f"Rudo: {OWNER[i]}", "assistant": lambda i: f"Assistant: {replies[i]}", "narrator": lambda i: CAPTIONS[i]}
    with open(OUT.replace(".mp4", ".srt"), "w") as srt:
        for n, l in enumerate(lines, 1):
            # Each cue ends before the next begins.
            end = min(l["end"] + 0.3, lines[n]["start"] - 0.05) if n < len(lines) else l["end"] + 0.3
            srt.write(f"{n}\n{stamp(l['start'], ',')} --> {stamp(end, ',')}\n{said[l['kind']](l['id'])}\n\n")
    inputs, filters = ["-i", film], []
    for i, l in enumerate(lines, 1):
        inputs += ["-i", os.path.join(WORK, "takes", f"{l['id']}.wav")]
        ms = int(l["start"] * 1000)
        tempo = f"atempo={l['tempo']}," if l["tempo"] != 1.0 else ""
        filters.append(f"[{i}:a]{tempo}adelay={ms}|{ms}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(1, len(lines) + 1))
    filters.append(f"{mix}amix=inputs={len(lines)}:normalize=0:dropout_transition=0,apad=whole_dur={total:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[aud]")
    filters.append(f"[0:v]tpad=stop_mode=clone:stop_duration={max(0, total - EVENTS['seconds']) + 0.1:.3f},ass={captions}[vid]")
    subprocess.check_call(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "[vid]", "-map", "[aud]",
                           "-t", f"{total:.3f}", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
                           "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", OUT])
    print(f"{OUT}: {total:.1f} s, {len(lines)} voice lines")
    for l in lines:
        flag = f"  tempo {l['tempo']}" if l["tempo"] != 1.0 else ""
        flag += f"  OVERLAP {l['overlap']} s" if l["overlap"] > 0 else ""
        print(f"  {l['start']:6.1f}-{l['end']:6.1f}  {l['kind']:9} {l['id']}{flag}")


if __name__ == "__main__":
    main()
