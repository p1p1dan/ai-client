# Test fixtures for vflow resource preparation

## p1p1dan-vflow-fixture.tgz

A real `@p1p1dan/vflow` npm pack output (copied from version 0.5.1) used by
`scripts/__tests__/prepare-vflow-resources.test.ts` and
`scripts/__tests__/assert-vflow-resources.test.ts` to exercise extraction and
template validation without hitting the network.

If the upstream package structure changes in a way that breaks parsing, refresh
this fixture by running `npm pack @p1p1dan/vflow --registry=https://npm.pkg.github.com`
against an authenticated `~/.npmrc` and replacing this file.
