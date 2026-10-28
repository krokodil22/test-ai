This directory contains the optional compiled WebGPU runtime **without model
weights**, compressed with gzip (897,041 bytes). The decoded WASM is 6,491,148
bytes and is licensed under Apache License 2.0. See
`../public/licenses/MLC-WASM-APACHE-2.0.txt`, `../public/licenses/MLC-WASM-NOTICE.txt`,
`../docs/low-memory.md` and `../scripts/low-memory-runtime.json` for provenance,
limitations and pinned integrity hashes.

`npm run runtime:prepare` validates both hashes and prepares this runtime for
static hosting, entirely offline. Large model weight files remain outside Git.

The Qwen2.5 0.5B runtime is also bundled without model weights (756,983 bytes
gzip, 4,837,816 bytes decoded). Its profile and integrity hashes are pinned in
`../scripts/light-model-source.json`. MLC LLM / TVM / Emscripten / Binaryen
versions match the 4B economy toolchain; compilation overrides are prefill 256,
max batch size 1 and context 2048. It is prepared by `npm run model:download:light`.
The runtime ABI and all 267 weight parameter names, shapes and dtypes were
verified with the pinned WebLLM loader; GPU generation is unverified here.
