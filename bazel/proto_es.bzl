"""protobuf-es (TypeScript) codegen for meridian's proto contracts.

`proto_es` runs `protoc` with the @bufbuild/protoc-gen-es plugin over a single
`proto_library`, emitting one `<name>_pb.ts` per direct source. It is hermetic:

  - protoc comes from `@protobuf//:protoc`,
  - the plugin is a `js_binary` over `@bufbuild/protoc-gen-es`,
  - the schema is read from the proto_library's *transitive* descriptor sets
    (`--descriptor_set_in`), so there is no `-I` import-path juggling and the
    googleapis `field_behavior` import resolves straight from the descriptor set.

Only the direct sources are generated; imported descriptors (field_behavior,
the WKTs) are present in the descriptor set for parsing but not re-emitted.
"""

_PROTO_SUFFIX = ".proto"

def _proto_es_impl(ctx):
    proto_info = ctx.attr.proto[ProtoInfo]
    descriptor_sets = proto_info.transitive_descriptor_sets.to_list()

    # es_out is the directory protoc writes under; it appends each file's import
    # path (e.g. "proto/panel.proto" -> "<es_out>/proto/panel_pb.ts"). We declare
    # outputs at exactly that path so Bazel and protoc agree.
    es_out = "{bin}/{pkg}/{root}".format(
        bin = ctx.bin_dir.path,
        pkg = ctx.label.package,
        root = ctx.attr.out_root,
    )

    outs = []
    gen_paths = []

    def _emit(import_path):
        ts_rel = import_path[:-len(_PROTO_SUFFIX)] + "_pb.ts"
        outs.append(ctx.actions.declare_file("{root}/{ts}".format(
            root = ctx.attr.out_root,
            ts = ts_rel,
        )))
        gen_paths.append(import_path)

    for src in proto_info.direct_sources:
        _emit(src.short_path)  # e.g. "proto/panel.proto"

    # protobuf-es emits a *load-bearing* relative import to every non-WKT
    # imported file (it goes in the fileDesc(...) deps array), so those must be
    # generated too. WKTs (google/protobuf/*) come from @bufbuild/protobuf/wkt
    # and need no generation; only non-WKT imports (e.g. googleapis
    # field_behavior) are listed here. Their descriptors are already in the
    # descriptor set, so protoc generates them from --descriptor_set_in.
    for import_path in ctx.attr.also_generate:
        _emit(import_path)

    args = ctx.actions.args()
    args.add("--descriptor_set_in=" + ":".join([f.path for f in descriptor_sets]))
    args.add("--plugin=protoc-gen-es=" + ctx.executable.plugin.path)
    args.add("--es_out=" + es_out)
    args.add("--es_opt=target=ts")
    args.add("--es_opt=import_extension=js")
    args.add_all(gen_paths)

    ctx.actions.run(
        executable = ctx.executable._protoc,
        arguments = [args],
        inputs = depset(descriptor_sets),
        outputs = outs,
        tools = [ctx.executable.plugin],
        # protoc-gen-es is an aspect_rules_js js_binary invoked as a protoc
        # plugin subprocess; its launcher requires BAZEL_BINDIR in the env. Since
        # the action already runs from the execroot, "." is correct.
        env = {"BAZEL_BINDIR": "."},
        mnemonic = "ProtoEs",
        progress_message = "Generating protobuf-es TypeScript for %{label}",
    )
    return [DefaultInfo(files = depset(outs))]

proto_es = rule(
    implementation = _proto_es_impl,
    doc = "Generate protobuf-es TypeScript (.ts) for a proto_library's direct sources.",
    attrs = {
        "proto": attr.label(
            mandatory = True,
            providers = [ProtoInfo],
            doc = "The proto_library to generate TypeScript for.",
        ),
        "out_root": attr.string(
            default = "es",
            doc = "Package-relative root the generated tree is rooted at.",
        ),
        "also_generate": attr.string_list(
            default = [],
            doc = "Extra FDS import names (non-WKT imports such as " +
                  "google/api/field_behavior.proto) to also generate, since " +
                  "protobuf-es emits load-bearing relative imports to them.",
        ),
        "plugin": attr.label(
            # In //proto/es (a dev-only package) so //proto/BUILD.bazel — which
            # consumers load for the proto_library — never loads @npm.
            default = "//proto/es:protoc_gen_es",
            executable = True,
            cfg = "exec",
            doc = "The protoc-gen-es plugin (a js_binary).",
        ),
        "_protoc": attr.label(
            # Prebuilt protoc (//bazel:protoc_prebuilt.bzl) rather than
            # @protobuf//:protoc, so codegen never compiles protoc from source.
            default = "@meridian_protoc//:protoc",
            executable = True,
            cfg = "exec",
        ),
    },
)
