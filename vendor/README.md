This directory contains the optional compiled WebGPU runtime **without model
weights**, compressed with gzip (897,041 bytes). The decoded WASM is 6,491,148
bytes and is licensed under Apache License 2.0. See
`../public/licenses/MLC-WASM-APACHE-2.0.txt`, `../public/licenses/MLC-WASM-NOTICE.txt`,
`../docs/low-memory.md` and `../scripts/low-memory-runtime.json` for provenance,
limitations and pinned integrity hashes.

`npm run runtime:prepare` validates both hashes and prepares this runtime for
static hosting, entirely offline. Large model weight files remain outside Git.
