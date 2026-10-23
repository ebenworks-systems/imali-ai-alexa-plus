#!/usr/bin/env python3
"""Makes the film's voice takes with Murf: the owner's and narrator's lines from script.json, and the
assistant's lines from the replies the recording captured (submission/work/replies.json).

    MURF_API_KEY=... python3 tools/video/narrate.py            # owner and narrator lines
    MURF_API_KEY=... python3 tools/video/narrate.py --replies  # the assistant's lines, after record.cjs
    MURF_API_KEY=... python3 tools/video/narrate.py o4 n6      # ask again for named takes

Takes and their lengths go to submission/work/takes/ (ignored by git). The key is read from the environment
and never printed.
"""
import json, os, re, subprocess, sys, time, urllib.error, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORK = os.path.join(ROOT, "submission", "work")
TAKES = os.path.join(WORK, "takes")
SCRIPT = json.load(open(os.path.join(os.path.dirname(__file__), "script.json")))
VOICES = SCRIPT["voices"]


def murf(text, voice):
    body = {"voiceId": voice["voiceId"], "style": voice["style"], "text": text, "format": "WAV", "sampleRate": 24000, "channelType": "MONO", "modelVersion": "GEN2"}
    req = urllib.request.Request("https://api.murf.ai/v1/speech/generate", data=json.dumps(body).encode(), method="POST",
                                 headers={"api-key": os.environ["MURF_API_KEY"], "Content-Type": "application/json", "Accept": "application/json"})
    for attempt in range(3):
        try:
            d = json.loads(urllib.request.urlopen(req, timeout=90).read())
            return urllib.request.urlopen(d["audioFile"], timeout=90).read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == 2:
                raise SystemExit(f"Murf {e.code}")
            time.sleep(3)


def duration(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).decode().strip())


def trimmed(src, dst):
    """Cut leading and trailing silence so the gaps are the ones the film chooses."""
    subprocess.check_call(["ffmpeg", "-v", "error", "-y", "-i", src, "-af",
                           "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse",
                           "-ar", "48000", "-ac", "1", dst])


def spoken(text):
    """Money the way a person says it: $12.30 as 12 dollars 30, $5.00 as 5 dollars."""
    text = re.sub(r"\$(\d+)\.00\b", r"\1 dollars", text)
    return re.sub(r"\$(\d+)\.(\d\d)\b", lambda m: f"{m.group(1)} dollars {int(m.group(2))}", text)


def lines(replies):
    for scene in SCRIPT["scenes"]:
        for beat in scene["beats"]:
            if "owner" in beat:
                yield beat["owner"], beat["say"], VOICES["owner"]
            elif "narrator" in beat:
                yield beat["narrator"], beat["say"], VOICES["narrator"]
    for r in replies:
        yield r["id"], spoken(r["text"]), VOICES["assistant"]


if __name__ == "__main__":
    args = sys.argv[1:]
    with_replies = "--replies" in args
    only = {a for a in args if not a.startswith("--")}
    replies = json.load(open(os.path.join(WORK, "replies.json"))) if with_replies else []
    os.makedirs(TAKES, exist_ok=True)
    path = os.path.join(TAKES, "lengths.json")
    lengths = json.load(open(path)) if os.path.exists(path) else {}
    for tid, text, voice in lines(replies):
        raw, wav = os.path.join(TAKES, f"{tid}.raw.wav"), os.path.join(TAKES, f"{tid}.wav")
        is_reply = tid.startswith("a-")
        if (only and tid in only) or not os.path.exists(wav) or (is_reply and with_replies and not only):
            open(raw, "wb").write(murf(text, voice))
            trimmed(raw, wav)
        lengths[tid] = round(duration(wav), 3)
        print(f"{tid:8} {lengths[tid]:6.2f} s  {text[:70]}")
    json.dump(lengths, open(path, "w"), indent=1)
