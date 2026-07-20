#!/usr/bin/env python3
"""Version-lockstep gate for the published packages.

`@savvifi/meridian-schemas` and `@savvifi/meridian-proto-ts` are released as a
matched pair, and schemas has a hard runtime dependency on proto-ts. Because
both are 0.x, a caret range does NOT widen the way it does at 1.x: `^0.13.0`
means `>=0.13.0 <0.14.0`. So a schemas release whose dependency range was left
behind can never resolve the proto-ts it shipped alongside — npm installs a
SECOND, older copy instead.

That is not a cosmetic duplicate. protobuf-es generates nominal types, so two
copies of `PanelDescriptor` are mutually unassignable, and a consumer holding
both gets type errors it cannot fix from its own package.json. Exactly that
shipped in 0.14.0 and 0.15.0, where the release bumped the three `version`
fields but not the internal dependency.

This gate makes that unrepresentable: the three versions must agree, and the
dependency must pin the same one exactly.

Run: python3 tools/check_versions.py
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def module_version() -> str:
    text = (ROOT / "MODULE.bazel").read_text()
    match = re.search(r'version\s*=\s*"([^"]+)"', text)
    if not match:
        sys.exit("MODULE.bazel: no module version found")
    return match.group(1)


def main() -> int:
    module = module_version()
    proto = json.loads((ROOT / "proto" / "proto-ts.package.json").read_text())
    schemas = json.loads((ROOT / "schemas.package.json").read_text())
    dep = (schemas.get("dependencies") or {}).get("@savvifi/meridian-proto-ts")

    problems: list[str] = []
    if proto["version"] != module:
        problems.append(
            f"proto-ts.package.json version {proto['version']!r} != MODULE.bazel {module!r}"
        )
    if schemas["version"] != module:
        problems.append(
            f"schemas.package.json version {schemas['version']!r} != MODULE.bazel {module!r}"
        )
    if dep is None:
        problems.append("schemas.package.json does not depend on @savvifi/meridian-proto-ts")
    elif dep != module:
        problems.append(
            f"schemas.package.json depends on @savvifi/meridian-proto-ts {dep!r}, "
            f"which must be exactly {module!r} — the two packages are released as a "
            f"matched pair, and a 0.x caret range cannot reach a later minor"
        )

    if problems:
        print("Version lockstep check FAILED:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(
            "\nAll four must move together on a release: MODULE.bazel, "
            "proto/proto-ts.package.json, schemas.package.json, and the "
            "dependency schemas declares on proto-ts.",
            file=sys.stderr,
        )
        return 1

    print(f"version lockstep OK — all at {module}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
