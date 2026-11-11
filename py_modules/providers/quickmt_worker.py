# providers/quickmt_worker.py
# Subprocess worker for quickmt-ja-en (Japanese -> English, CTranslate2 +
# SentencePiece). Runs in the bundled Python, which has ctranslate2 and
# sentencepiece; talks JSON lines over stdin/stdout:
#   {"cmd": "load", "model_dir": "..."}            -> {"ok": true}
#   {"cmd": "translate", "texts": ["..."]}         -> {"ok": true, "translations": [...]}
#   {"cmd": "shutdown"}                            -> {"ok": true}

import json
import os
import re
import sys

# Sentence ends: split here so each model input stays short (the model was
# trained on sentences; long OCR paragraphs drift)
_SENTENCE_END = re.compile(r"(?<=[。！？!?])")


def prepare(text):
    """OCR boxes keep the game's line breaks. Japanese has no spaces between
    words, so lines are joined directly; returns the sentences to translate."""
    joined = "".join(line.strip() for line in text.splitlines())
    return [s for s in (p.strip() for p in _SENTENCE_END.split(joined)) if s]


class QuickMT:
    def __init__(self, model_dir, threads=4):
        import ctranslate2
        import sentencepiece as spm
        self.translator = ctranslate2.Translator(
            model_dir, device="cpu", compute_type="int8",
            inter_threads=1, intra_threads=threads,
        )
        self.src = spm.SentencePieceProcessor(os.path.join(model_dir, "src.spm.model"))
        self.tgt = spm.SentencePieceProcessor(os.path.join(model_dir, "tgt.spm.model"))

    def translate(self, texts, beam_size=2):
        pieces, owner = [], []
        for i, text in enumerate(texts):
            for sentence in prepare(text):
                pieces.append(self.src.encode(sentence, out_type=str))
                owner.append(i)
        out = [[] for _ in texts]
        if pieces:
            results = self.translator.translate_batch(
                pieces,
                beam_size=beam_size,
                max_decoding_length=256,
                max_input_length=512,
                no_repeat_ngram_size=4,
                max_batch_size=16,
            )
            for i, result in zip(owner, results):
                hyp = result.hypotheses[0] if result.hypotheses else []
                out[i].append(self.tgt.decode(hyp).strip())
        # A box with nothing translatable comes back unchanged
        return [" ".join(p for p in parts if p) or texts[i] for i, parts in enumerate(out)]


def main():
    engine = None

    def send(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            send({"ok": False, "error": "Invalid JSON"})
            continue
        command = cmd.get("cmd")
        try:
            if command == "load":
                engine = QuickMT(cmd["model_dir"], int(cmd.get("threads", 4)))
                engine.translate(["こんにちは"])  # warm-up
                send({"ok": True})
            elif command == "translate":
                if engine is None:
                    send({"ok": False, "error": "No model loaded"})
                else:
                    send({"ok": True, "translations": engine.translate(cmd.get("texts", []))})
            elif command == "shutdown":
                send({"ok": True})
                break
            else:
                send({"ok": False, "error": f"Unknown command: {command}"})
        except Exception as e:
            send({"ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
