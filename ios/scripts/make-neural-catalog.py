#!/usr/bin/env python3
"""Build Pageturner/Neural/NeuralVoices.json — the neural voices the app can download.

The voices are Piper's (https://huggingface.co/rhasspy/piper-voices), the same set the web
app offers. The file is pinned to one commit of that repository so every download URL
and checksum stays valid; run this again (with a newer --revision) to take new voices.
Voices that need a phonemizer other than espeak-ng (Chinese pinyin, Hebrew, Japanese,
Lithuanian, Thai, Ukrainian "text") are left out: the on-device engine can't speak them.

    python3 ios/scripts/make-neural-catalog.py [--revision <commit>] [--out <file>]
"""
import argparse, concurrent.futures, json, urllib.parse, urllib.request

REPO = "https://huggingface.co/rhasspy/piper-voices"
PINNED = "c10ece1aade47bb51c153c893d14e5bf8e5b7117"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pageturner-catalog"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--revision", default=PINNED)
    ap.add_argument("--out", default="ios/Pageturner/Neural/NeuralVoices.json")
    args = ap.parse_args()
    base = f"{REPO}/resolve/{args.revision}/"
    voices = json.loads(get(base + "voices.json"))

    def phoneme_type(key):
        path = next(p for p in voices[key]["files"] if p.endswith(".onnx.json"))
        return json.loads(get(base + urllib.parse.quote(path))).get("phoneme_type")  # None in older voices: espeak

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        types = dict(zip(voices, pool.map(phoneme_type, voices)))

    out, skipped = [], []
    for key in sorted(voices):
        v = voices[key]
        if types[key] not in (None, "espeak"):
            skipped.append(f"{key} ({types[key]})")
            continue
        files = {name.rsplit(".", 1)[-1] if name.endswith(".onnx") else "json": (name, meta)
                 for name, meta in v["files"].items() if name.endswith((".onnx", ".onnx.json"))}
        onnx, config = files["onnx"], files["json"]
        out.append({
            "key": key,
            "name": v["name"],
            "lang": v["language"]["code"],
            "langName": v["language"]["name_english"],
            "country": v["language"].get("country_english", ""),
            "quality": v["quality"],
            "speakers": v["num_speakers"],
            "onnx": {"path": onnx[0], "size": onnx[1]["size_bytes"], "md5": onnx[1]["md5_digest"]},
            "config": {"path": config[0], "size": config[1]["size_bytes"], "md5": config[1]["md5_digest"]},
        })
    doc = {"repo": REPO, "revision": args.revision, "voices": out}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"{len(out)} voices written to {args.out}; left out: {', '.join(skipped) or 'none'}")


main()
