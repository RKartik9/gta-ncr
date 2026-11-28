"""
What the street shouts, spoken: every line below, in every voice, as public/sounds/lines/<voice>/<kind>-<n>.mp3,
and public/sounds/lines/index.json for the game (src/hud/shouts.ts) to know what there is.

The voices are AI4Bharat's Indic Parler-TTS (https://huggingface.co/ai4bharat/indic-parler-tts, Apache 2.0): a
neural voice told in words how to say each line (angry and shouting, terrified, casual), by one of its Hindi
speakers, so a line comes out with feeling instead of read aloud. Rohit and Aman for the men, Divya and Rani for
the women, and a couple more of each made by a shift in pitch: eight people in all.

    python3.14 -m venv .venv-tts && .venv-tts/bin/pip install torch soundfile git+https://github.com/huggingface/parler-tts.git
    .venv-tts/bin/python tools/voices/make-lines.py

Needs ffmpeg on the PATH. The model (~3.5 GB) is downloaded by Hugging Face the first time. A few seconds a line on
an Apple or CUDA GPU, slower on a processor alone. Run it again after changing a line, a voice or the shaping;
pass a voice id (m1, w2...) to remake only that voice.
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import soundfile
import torch
from parler_tts import ParlerTTSForConditionalGeneration
from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "sounds" / "lines"
MODEL = "ai4bharat/indic-parler-tts"

# In Devanagari, so they are said as Delhi says them.
LINES = {
    "angry": [
        "अबे साले!", "अंधा है क्या?", "ओए! देख के चला!", "तेरे बाप की सड़क है क्या?", "अबे गधे!", "कमीने!",
        "उल्लू के पट्ठे!", "अबे चूतिये!", "भोसड़ीके!", "हरामखोर!", "पागल है क्या बे?", "गाड़ी चलानी नहीं आती?",
        "तेरी माँ की!", "बहन के टक्के!", "लाइसेंस कहाँ से मिला बे?", "अबे ओ हीरो!",
    ],
    "panic": [
        "भागो!", "बचाओ!", "गोली चल रही है!", "हे भगवान!", "पुलिस को बुलाओ!", "अरे बाप रे!", "मार देगा!",
        "भागो भाई, भागो!", "मम्मी!", "ये पागल है!", "हटो, हटो!",
    ],
    "gawk": [
        "मार साले को!", "अरे छोड़ो उसे!", "ओए होए!", "वीडियो बना, वीडियो!", "पुलिस बुलाओ कोई!", "देख देख देख!",
        "अरे भाई भाई भाई!", "धोएगा आज!", "छोड़ दे यार!",
    ],
    "fight": [
        "आजा!", "तेरा बाप कौन है?", "औकात में रह!", "जानता नहीं मैं कौन हूँ?", "चल निकल!", "आज तू गया साले!",
        "हाथ कैसे उठाया?", "तुझे तो मैं!", "बहुत चर्बी है तुझमें!", "रुक तू!",
    ],
    # walked into
    "bump": [
        "अबे! धक्का क्यों मारा?", "देख के नहीं चल सकता?", "ओए! अंधा है क्या?", "साले, आँखें नहीं हैं?",
        "हट बे!", "तमीज़ नहीं है क्या?", "अबे चूतिये, देख के!", "भाई, ज़रा देख के चलो!", "क्या बदतमीज़ी है!",
        "तेरी तो!",
    ],
    # walked past
    "passby": [
        "क्या देख रहा है?", "भाई साहब, साइड दो!", "ये कौन है बे?", "बड़ा हीरो बन रहा है।", "ओए, सुन!",
        "क्या हाल है भाई?", "नमस्ते जी।", "आज बड़ी गर्मी है यार।", "चाय पीने चलें?", "भैया, मेट्रो किधर है?",
        "अरे वाह, क्या स्टाइल है!", "ज़्यादा मत अकड़!",
    ],
    # a rifle in the player's hands
    "armed": [
        "अरे! इसके पास बंदूक है!", "भाई, बंदूक नीचे कर!", "पुलिस! पुलिस!", "मत मारो भाई!", "भागो, बंदूक है!",
        "अरे बाप रे, बंदूक!",
    ],
}

# How each kind is said: Indic Parler-TTS takes this in words, with the speaker's name in front.
SAID = {
    "angry": "shouts angrily and aggressively at a fast pace, very loud and expressive, with a lot of anger in the voice.",
    "bump": "shouts angrily and rudely at a fast pace, loud and very expressive, clearly irritated.",
    "fight": "shouts in a loud, threatening, aggressive voice at a fast pace, very expressive.",
    "panic": "screams in a terrified, panicked voice at a very fast pace, very loud and highly expressive, full of fear.",
    "armed": "cries out in a frightened, panicked voice at a fast pace, loud and highly expressive, full of fear.",
    "gawk": "shouts excitedly at a fast pace, loud and very expressive, surprised and thrilled.",
    "passby": "speaks casually in a conversational tone at a moderate pace, natural and expressive.",
}
CLOSE = " The recording is very high quality, close up and clear, with no background noise."

# Each voice: the speaker, and semitones up or down to make another person of them.
VOICES = [
    ("m1", "Rohit", 0.0), ("m2", "Aman", 0.0), ("m3", "Rohit", -2.5), ("m4", "Aman", 2.0), ("m5", "Rohit", 2.0),
    ("w1", "Divya", 0.0), ("w2", "Rani", 0.0), ("w3", "Divya", 2.0),
]


def main():
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is needed on the PATH")
    only = set(sys.argv[1:])
    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    model = ParlerTTSForConditionalGeneration.from_pretrained(MODEL).to(device)
    tokens = AutoTokenizer.from_pretrained(MODEL)
    words = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)
    rate_hz = model.config.sampling_rate
    if not only:
        shutil.rmtree(OUT, ignore_errors=True)
    for vid, speaker, semitones in VOICES:
        if only and vid not in only:
            continue
        shutil.rmtree(OUT / vid, ignore_errors=True)
        (OUT / vid).mkdir(parents=True)
        torch.manual_seed(sum(map(ord, vid)))
        for kind, lines in LINES.items():
            said = words(f"{speaker} {SAID[kind]}{CLOSE}", return_tensors="pt").to(device)
            for n, text in enumerate(lines, 1):
                prompt = tokens(text, return_tensors="pt").to(device)
                # now and then it rambles on or says nothing: a short line is a second or two, so try again
                for attempt in range(4):
                    audio = model.generate(
                        input_ids=said.input_ids, attention_mask=said.attention_mask,
                        prompt_input_ids=prompt.input_ids, prompt_attention_mask=prompt.attention_mask,
                    ).cpu().numpy().squeeze()
                    seconds = len(audio) / rate_hz
                    if 0.35 < seconds < 0.5 + len(text) * 0.12:
                        break
                    print(f"  {vid} {kind}-{n}: {seconds:.1f} s, again")
                rate = 2 ** (semitones / 12)
                with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
                    soundfile.write(tmp.name, audio, rate_hz)
                    # up or down in pitch at the same speed; silence trimmed off both ends; levelled loud, as a
                    # voice raised in the street is
                    shape = (
                        f"asetrate={rate_hz}*{rate:.4f},aresample=44100,atempo={1 / rate:.4f},highpass=f=90,"
                        "silenceremove=start_periods=1:start_threshold=-42dB,areverse,"
                        "silenceremove=start_periods=1:start_threshold=-42dB,areverse,"
                        "loudnorm=I=-13:TP=-1:LRA=9"
                    )
                    subprocess.run(
                        ["ffmpeg", "-loglevel", "error", "-y", "-i", tmp.name, "-af", shape, "-ac", "1", "-ar", "44100",
                         "-c:a", "libmp3lame", "-b:a", "64k", str(OUT / vid / f"{kind}-{n}.mp3")],
                        check=True,
                    )
            print(f"{vid} {kind}: {len(lines)} lines", flush=True)
    index = {
        "voices": [{"id": vid, "woman": vid.startswith("w")} for vid, *_ in VOICES],
        "lines": {kind: len(lines) for kind, lines in LINES.items()},
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n")


if __name__ == "__main__":
    main()
