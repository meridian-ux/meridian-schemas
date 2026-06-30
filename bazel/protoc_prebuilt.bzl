"""Prebuilt protoc fetcher — so the protobuf-es codegen never compiles protoc.

meridian registers apple_support's CC toolchain (for the Swift renderer) as the
top-ranked CC toolchain. On a host with Command Line Tools only (no full Xcode)
that toolchain cannot build the protoc C++ binary — the Xcode version resolves
to 'None' and the build crashes. `proto_es` (//bazel:proto_es.bzl) needs only
protoc-the-binary, so we fetch the official prebuilt release and expose it as
`@meridian_protoc//:protoc`.

Self-contained on purpose: ONLY `proto_es` consumes this protoc. The Java /
Rust / Swift proto toolchains are untouched and there is no repo-wide
proto-toolchain-resolution flag. Pinned to the protoc release matching the root
module's protobuf version.
"""

_VERSION = "33.4"

# protoc release asset (url suffix, sha256) keyed by (os, cpu).
_ASSETS = {
    ("mac", "aarch64"): (
        "osx-aarch_64",
        "726297dcfed58592fd35620a5a6246ae020c39e88f3fd4cb1827df7bcf3dfcf1",
    ),
    ("mac", "x86_64"): (
        "osx-x86_64",
        "a49bec10d039e902d3b43e49938c42526f90011467609864fa6386ac4014da58",
    ),
    ("linux", "x86_64"): (
        "linux-x86_64",
        "c0040ea9aef08fdeb2c74ca609b18d5fdbfc44ea0042fcfbfb38860d35f7dd66",
    ),
    ("linux", "aarch64"): (
        "linux-aarch_64",
        "15aa988f4a6090636525ec236a8e4b3aab41eef402751bd5bb2df6afd9b7b5a5",
    ),
}

def _host_key(rctx):
    os_name = rctx.os.name.lower()
    arch = rctx.os.arch.lower()
    if os_name.startswith("mac") or "darwin" in os_name:
        os_key = "mac"
    elif os_name.startswith("linux"):
        os_key = "linux"
    else:
        fail("meridian_protoc: unsupported OS %r" % rctx.os.name)
    if arch in ("aarch64", "arm64"):
        arch_key = "aarch64"
    elif arch in ("x86_64", "amd64", "x64"):
        arch_key = "x86_64"
    else:
        fail("meridian_protoc: unsupported CPU %r" % rctx.os.arch)
    return (os_key, arch_key)

_BUILD = """\
load("@bazel_skylib//rules:native_binary.bzl", "native_binary")

# The prebuilt protoc binary, runnable as an executable target.
native_binary(
    name = "protoc",
    src = "bin/protoc",
    out = "protoc",
    visibility = ["//visibility:public"],
)
"""

def _repo_impl(rctx):
    key = _host_key(rctx)
    suffix, sha = _ASSETS[key]
    rctx.download_and_extract(
        url = "https://github.com/protocolbuffers/protobuf/releases/download/v{v}/protoc-{v}-{s}.zip".format(
            v = _VERSION,
            s = suffix,
        ),
        sha256 = sha,
    )
    rctx.file("BUILD.bazel", _BUILD)

_meridian_protoc_repo = repository_rule(
    implementation = _repo_impl,
    doc = "Downloads the prebuilt protoc release for the host platform.",
)

def _ext_impl(_mctx):
    _meridian_protoc_repo(name = "meridian_protoc")

protoc_prebuilt = module_extension(
    implementation = _ext_impl,
    doc = "Exposes @meridian_protoc//:protoc — a prebuilt protoc for codegen.",
)
