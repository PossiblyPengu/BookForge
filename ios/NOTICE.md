# Third-party software and data in the Pageturner app

- **Readium swift-toolkit** — BSD-3-Clause. Reads EPUB, PDF and CBZ, and drives read-aloud with the system voices.
- **sherpa-onnx** (k2-fsa) — Apache-2.0. Runs the neural voices on the device. Pulled in as a Swift package; its
  prebuilt libraries include **ONNX Runtime** (MIT) and **espeak-ng** (GPL-3.0-or-later) as the text-to-phoneme step.
- **espeak-ng phoneme data** (`Resources/espeak-ng-data`) — GPL-3.0-or-later, from the espeak-ng project, in the form
  sherpa-onnx's own Piper voice packages carry it. Bundled so the neural voices can turn text into sounds.
- **Piper voices** — downloaded by the user at run time from <https://huggingface.co/rhasspy/piper-voices> (the repository
  is MIT; each voice has its own licence in its `MODEL_CARD`, most are permissive, some are CC-BY or non-commercial).
  `Pageturner/Neural/NeuralVoices.json` lists them, pinned to one commit of that repository.
- **ZIPFoundation** (Readium's fork) — MIT.

Pageturner is a personal, sideloaded app. If you pass an IPA on to others, the GPL-covered parts above come with
an obligation to offer their source; the source of everything else in the app is this repository.
