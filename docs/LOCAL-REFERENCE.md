# Offline SDK reference

## Source-only integration status

This change contains scripts and guidance only. The private frozen reference archives and notices are not included in this repository.
Reference acquisition and notice review remain required before a new checkout can execute the offline reference commands.
Four missing upstream notices block publication of the full private vendor tree. Do not publish it as a workaround.
The historical c9e results below remain separate from the subsequently qualified 878 runtime artifact.

The reference rebuilds the TypeScript package from source with prebuilt Rust outputs. It does not compile Rust. `build` preserves the historical reference experiment; release candidates must use `build-release` to include reviewed notices for the bundled dependencies.

Run on Linux x86_64 with Linux user namespaces enabled, GNU tar, xz, coreutils, Git and a compatible glibc.
The separately retained private qualification reference supplies Node 24.22.3, npm 11.19.1, locked npm archives and seven WASM outputs.
The kernel, glibc, Git and extraction tools remain external prerequisites. Their complete operating-system image is not vendored.

## Build

```sh
scripts/reference.sh build
```

The command extracts the pinned Node distribution, then enters an isolated user and network namespace.
It clears the environment, creates a fresh home and uses an empty npm cache.
It validates every input hash, installs local archives with lifecycle scripts disabled, compiles TypeScript, checks all three type configurations and packs the package.
The original package manifest and lockfile are restored before compilation and packaging. No source manifest changes escape the scratch directory.
The command never fetches WASM, invokes Cargo, uploads a release or calls a model.

Read `output/reference-*/receipt.json` for the artifact path and hashes. Each run creates a separate directory.
The reference rejects changed source inputs, missing archives, corrupted archives and a mismatched WASM fingerprint.
A missing dependency fails the offline install. There is no online fallback.

## Update the reference

Acquisition is a separate, online operation. Review the dependency change and the Rust release before acquisition.

```sh
node scripts/reference.mjs capture /absolute/path/to/reviewed-nanocode-wasm.tgz
```

Capture refuses to replace an existing reference manifest. Archive the previous reference before an intentional replacement.
It downloads the exact package-lock resolutions, checks their Subresource Integrity values and records source URLs, sizes, licenses and SHA-256 hashes.
It also downloads the Node distribution with its pinned upstream SHA-256. The Node archive includes its license notices.
The npm tarballs are preserved byte-for-byte, including any license files present upstream. Some archives contain no license or notice text. Their SPDX declarations are not redistribution notice coverage: acquire and review the exact version's missing upstream notices separately before publishing these archives. The manifest records the lockfile's license declarations, not a legal audit.
The reviewed WASM archive remains a prebuilt dependency. Its embedded manifest binds each output to the package's Rust-input fingerprint.
That fingerprint and a file hash are integrity bindings, not a public build attestation or proof of Rust source reproducibility.

The private frozen reference contains every npm lock entry, including other platforms' optional binaries.
Only Linux x86_64 installation, compilation and packaging have been executed here. This does not qualify other build hosts.
Do not replace the archives with a copied node_modules directory. Do not commit credentials, caches or generated output.

## Verified epoch

Two archived cold builds with the original reference runner at source c9e92eb906d19b958553e2ee85f57319579d4976 equal the published build-c9e92eb package:

```text
bytes: 36243134
sha256: d49dd74581f2c5d8f44d4c6e440bd9b99e0a1edd9208f14844dcf40e7343bf2b
```

The private c9e reference records 365 npm lock entries and 356 unique archives. Their combined archive size is 595796196 bytes.
Node and WASM add approximately 65 MiB. No individual archive exceeds GitHub's 100 MiB file limit.
This package build uses a prebuilt Rust reference. A complete Rust source build still requires separate sources and toolchain qualification.
Publication remains a separate, explicitly authorized operation. The existing online release script is not the offline entrypoint.

## Notice coverage and no-build publication

Before publishing the vendored dependency tree, require the exact-version notice mapping to pass:

```sh
node scripts/reference.mjs verify-redistribution
```

This hashes `vendor/reference/notices/coverage.json` against this exact reference epoch, requires one reviewed covered mapping per locked package and checks each notice file's hash. Missing or uncertain notices block publication. A named license file is not by itself a legal review.

Build and publish are separate. The legacy `scripts/release.mjs` remains an online build-and-release path; do not use it as the local reference publisher. For a new source epoch, capture and review its reference, then run `scripts/reference.sh build-release`. It inserts deterministic `dist/THIRD-PARTY-NOTICES.json` containing the reviewed notices for actually bundled dependencies. This intentionally changes package bytes relative to the historical notice-incomplete c9e artifact; the two original receipts remain untouched. No new release build was qualified by writing this script. Once that new build and its receipt have passed, use:

```sh
node scripts/reference-publish.mjs --verify /absolute/artifact-directory /absolute/receipt.json
node scripts/reference-publish.mjs --upload /absolute/artifact-directory /absolute/receipt.json
```

The publisher never builds, installs dependencies, invokes Cargo or calls a model. Verification privately copies the artifact and receipt, then checks current source HEAD, exact captured input hashes, WASM fingerprint/output hashes, package source files, exact included bundled-notice bytes, receipt conditions and archive hash. The historical c9e artifact lacks the containers notice and intentionally fails release verification. The receipt is a trusted local build attestation, not independent compilation proof. Upload additionally requires exact included notices for the bundled runtime dependencies, clean committed package source inputs and a pushed source commit. Private untracked reference archives do not become release assets or require publication. It does not publish the vendor tree: the separate all-dependency redistribution gate can remain blocked without blocking a correctly noticed runtime package. Only an explicit release-tag 404 permits creation; an existing tag must resolve to the same source. Both branches download the public archive and compare exact bytes. Any failed or uncertain create/upload stops; inspect the remote before a new attempt. No overwrite, automatic retry or fallback build occurs.

Later source epochs deliberately fail the frozen c9e reference guard. Preserve this reference and its two cold-build receipts; capture and qualify a separate reviewed reference after intended source changes land. Never bypass or broaden the source hash guard to bless a new candidate.
