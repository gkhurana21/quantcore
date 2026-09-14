#!/usr/bin/env bash
# Compile the C++ pricing core to WebAssembly for the browser engine.
#
#   source ~/emsdk/emsdk_env.sh
#   ./scripts/build-wasm.sh
#
# Same sources as the native library (core/src/black_scholes.cpp, core/src/monte_carlo.cpp)
# plus bindings/quantcore_wasm.cpp, built as a standalone module with no JavaScript glue.
# Writes dashboard/public/wasm/quantcore.wasm and quantcore.json — compiler version, flags,
# and the size and SHA-256 of the module and of every source. Both files are committed, so
# the dashboard build never needs Emscripten. CI rebuilds with the compiler version recorded
# in the manifest and fails if the output differs; the unit tests fail if a source changes
# without a rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v em++ >/dev/null || { echo "em++ not found — run: source ~/emsdk/emsdk_env.sh" >&2; exit 1; }

OUT_DIR=dashboard/public/wasm
SOURCES=(core/src/black_scholes.cpp core/src/monte_carlo.cpp core/src/monte_carlo_portfolio.cpp bindings/quantcore_wasm.cpp)
HEADERS=(core/include/quantcore/black_scholes.hpp core/include/quantcore/monte_carlo.hpp
         core/include/quantcore/monte_carlo_portfolio.hpp)
FLAGS=(-std=c++17 -O3 -msimd128 -fno-exceptions -fno-rtti -Wall -Wextra -Wpedantic -Werror
       --no-entry -sSTANDALONE_WASM -sFILESYSTEM=0 -sSTACK_SIZE=65536 -sINITIAL_MEMORY=1048576
       -sALLOW_MEMORY_GROWTH=0)

mkdir -p "$OUT_DIR"
em++ "${FLAGS[@]}" -Icore/include "${SOURCES[@]}" -o "$OUT_DIR/quantcore.wasm"

VERSION=$(em++ --version | head -1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
node - "$OUT_DIR" "$VERSION" "${FLAGS[*]}" "${SOURCES[@]}" "${HEADERS[@]}" <<'EOF'
const { createHash } = require('crypto');
const { readFileSync, writeFileSync } = require('fs');
const [outDir, emscripten, flags, ...files] = process.argv.slice(2);
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const wasm = readFileSync(`${outDir}/quantcore.wasm`);
const manifest = {
  abi: 2,
  emscripten,
  flags: flags.split(' '),
  bytes: wasm.length,
  sha256: sha256(wasm),
  sources: files.map(path => ({ path, sha256: sha256(readFileSync(path)) })),
};
writeFileSync(`${outDir}/quantcore.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`quantcore.wasm · ${wasm.length} bytes · emscripten ${emscripten} · sha256 ${manifest.sha256.slice(0, 16)}…`);
EOF
