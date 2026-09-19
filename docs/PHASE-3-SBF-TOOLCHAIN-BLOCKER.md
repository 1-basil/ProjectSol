# SBF/Anchor Toolchain Blocker — Investigation

Investigated after the oracle-adapter work, per instruction to check whether
this environment can obtain a compatible Solana platform-tools/Anchor
toolchain before claiming any runtime test result. Two distinct issues were
found and diagnosed; the first is now fixed, the second is not.

## Toolchain versions present

```
$ solana --version
solana-cli 4.2.1 (src:af73c061; feat:21b0d33a, client:Agave)

$ cargo-build-sbf --version
cargo-build-sbf 4.1.0
platform-tools v1.54

$ cargo --version
cargo 1.98.0

$ anchor --version
(anchor: command not found)
```

`anchor-lang`/`anchor-spl` 1.2.0 and `pyth-solana-receiver-sdk` 2.0.0 are
usable as plain Cargo dependencies without the `anchor` CLI — confirmed by
every `cargo check`/`cargo test` in this and the prior two commits.

## Issue 1 — corrupted platform-tools cache (now fixed)

**Reproduction (before the fix):**

```
$ cargo build-sbf --manifest-path programs/trading-vault/Cargo.toml --verbose
error: not a directory: 'C:\Users\Lenovo\.cache\solana\v1.54\platform-tools\rust\lib'
```

**Root cause.** `C:\Users\Lenovo\.cache\solana\v1.54\platform-tools\` contained
only a stale `tmp-platform-tools-windows-x86_64.tar.bz2` (184 MB) and nothing
else — a download that started (likely during this project's very first
`cargo build-sbf` attempt two sessions ago, which I let run silently for
~18 minutes with no output before stopping it) but was never renamed to its
final filename or extracted, leaving the cache directory in a state
`cargo-build-sbf` treats as "present but broken" rather than "absent" — it
does not re-download, it just fails immediately trying to use the missing
`rust/lib` directory.

**Fix applied:** deleted the corrupted cache directory (`rm -rf
C:\Users\Lenovo\.cache\solana\v1.54\platform-tools` — safe: this is a
build-tool cache, not project or user data, and the only consequence of
deleting it is a fresh download) and re-ran the same command. This time:

- Download completed cleanly: 568,191,303 bytes, at a real, non-throttled
  network speed (observed 70-170 MB per ~25s interval) — **this environment's
  network access to Solana's platform-tools distribution is not blocked**,
  which corrects an inference from the earlier silent-stall report.
- Extraction completed (thousands of files under `~/.rustup/toolchains/`
  and `~/.cache/solana/v1.54/platform-tools/`).
- Real compilation began, using the pinned toolchain
  `C:\Users\Lenovo\.rustup\toolchains\1.89.0-sbpf-solana-v1.54\bin\rustc.exe`.

This is genuine, durable progress: the toolchain is now correctly installed
on this machine, so a future `cargo build-sbf` skips straight to Issue 2
below rather than re-hitting the corrupted-cache failure.

## Issue 2 — no MSVC linker on this machine (unresolved, not a quick fix)

**Reproduction (current state, toolchain correctly installed):**

```
$ cargo build-sbf --manifest-path programs/trading-vault/Cargo.toml --verbose
...
error: linking with `link.exe` failed: exit code: 1
  = note: "link.exe" "/NOLOGO" ...
  = note: link: extra operand 'C:\...\build_script_build....o'
          Try 'link --help' for more information.
error: could not compile `proc-macro2` (build script) due to 1 previous error
error: could not compile `serde` (build script) due to 1 previous error
error: could not compile `borsh` (build script) due to 1 previous error
```

**Root cause, verified rather than guessed:**

```
$ which -a link.exe
/usr/bin/link.exe

$ where.exe link.exe
C:\Program Files\Git\usr\bin\link.exe

$ /usr/bin/link.exe
/usr/bin/link: missing operand
Try '/usr/bin/link --help' for more information.
```

The `link.exe` that resolves via `PATH` in this shell is **Git for Windows'
coreutils `link` utility** (a wrapper around the POSIX `link()` syscall, for
creating hard links) — not the Microsoft Visual C++ linker. Its own error
message ("missing operand" / "Try '... --help'") matches, word for word in
form, the "extra operand" error the build log shows: this is the same binary,
being handed linker command-line arguments it has no idea how to interpret.

This is not a fixable-by-PATH-reordering problem, because there is nothing
correct to reorder toward:

```
$ find "/c/Program Files" "/c/Program Files (x86)" -iname "link.exe"
/c/Program Files/Git/usr/bin/link.exe

$ find "/c/Program Files" "/c/Program Files (x86)" -iname "*visual studio*" -o -iname "*build tools*"
(no results)
```

**No Microsoft Visual Studio or Build Tools installation exists on this
machine at all.** The pinned SBF toolchain (`1.89.0-sbpf-solana-v1.54`) needs
a real MSVC `link.exe` to link *host-target* build scripts (`build.rs` for
`proc-macro2`, `serde`, `borsh`, and transitively everything depending on
them — which is nearly the whole dependency tree) — this is separate from
whatever linker actually produces the final on-chain `.so` for the
`sbpf-solana-solana` target, and fails before that stage is ever reached.
I also checked whether this specific pinned toolchain bundles its own
`rust-lld` as a self-contained fallback (some modern rustc builds do, which
would sidestep the missing-MSVC-linker problem entirely):

```
$ find ~/.rustup/toolchains/1.89.0-sbpf-solana-v1.54 -iname "*lld*"
(no results)
```

It does not. There is no low-risk, session-local workaround available.

**What would actually fix this:** installing the Microsoft C++ Build Tools
(Visual Studio Build Tools, "Desktop development with C++" workload) to
obtain a real `link.exe`. This is a multi-gigabyte, system-level Windows
installation — outside what I'll do without your explicit go-ahead, and
likely outside what's worth doing inside this sandboxed session even with
it, since it changes machine state well beyond this repository. Flagging it
as the concrete next step rather than attempting it silently.

## Net effect

- **Fixed:** the platform-tools cache; a future attempt no longer needs to
  redownload/re-extract.
- **Not fixed, root-caused:** SBF host-build-script linking has no real
  linker available on this machine.
- **Still true, for a different and more specific reason than previously
  stated:** no instruction in `programs/trading-vault` has executed under an
  actual Solana runtime, and none can, in this environment, until either
  MSVC Build Tools are installed or an alternative linker is configured and
  verified for this exact pinned toolchain.
- **Unaffected:** `cargo check` / `cargo test` (host `x86_64-pc-windows-msvc`
  target, default toolchain, not the pinned SBF one) continue to work
  exactly as in the prior two commits — they do not go through
  `cargo-build-sbf` or the pinned toolchain at all, which is why 94/94 Rust
  unit tests and 73/73 TypeScript tests remain a true, unaffected claim.
