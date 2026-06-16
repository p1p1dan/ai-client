---
name: vflow-test
description: "Test infrastructure creation and case generation: creates test scaffold (gtest / Qt Test / pytest + build integration) when no test directory exists, or generates unit test cases for specified classes/interfaces. Auto-used during implementation when no test infra is detected; user can also say 'add tests for XX' independently."
---

# vflow Test Infrastructure & Case Generation

Enforce "new code must have tests": scaffold first, cases second, real execution evidence last.

## Input Contract

- Mode A (scaffold): project root + build system type (CMake / qmake / VS project, auto-detected from project files)
- Mode B (generate cases): target class/interface source + header files
- `.vflow/config.json` (language, features.qt, build.test_command)

## Steps

### Mode A: Create Test Scaffold (first time only) [required·once]

1. Detect build system: CMakeLists.txt → CMake; *.pro → qmake; *.vcxproj/*.sln → VS
2. Framework selection: Qt project (features.qt=true) → Qt Test (zero extra dependencies); non-Qt C++ → gtest (fallback: doctest single-header if no package manager); Python → pytest
3. Create `tests/` directory (mirror source structure) + one smoke test (e.g. 1+1==2) + build integration (CMake: enable_testing + add_subdirectory; qmake: subdirs + QT+=testlib; VS: test project)
4. **Compile and run the smoke test** — confirm scaffold works. If it fails, fix until green. No half-finished scaffolds.
5. Write the test run command to config.json build.test_command

### Mode B: Generate Test Cases [required·repeatable]

1. Read target class/interface source, list public interface inventory
2. Design cases per interface: happy path ≥1 + edge cases (empty input / extreme values / invalid parameters) ≥1; for algorithms, add known-input → known-output sample assertions
3. Naming follows spec/common/testing.md: `behavior_condition_expected`
4. Write to corresponding location in tests/, **compile and run**, paste real output

## Output Template

"🧪 Test scaffold created: {framework} + {build system}, smoke test passed (output: ...)"
"🧪 Added {N} cases for {class}: {M} passed / {K} failed (output: ...)"

## Guardrails

- Never report completion without actually running the tests
- When tests fail: determine whether the test is wrong or the code has a bug — if it's a bug, report to user. Do not weaken assertions to force green.
- Tests needing image samples: place samples in tests/data/, never depend on machine-specific absolute paths
- Do not generate filler tests for trivial getter/setter methods with no logic
