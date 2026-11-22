[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hizarukuro/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hizarukuro/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built with make.fun — referral code c23ct4sn

# mend

`mend` is one command-line tool that applies the edits AI models write, in four formats, to a tree of text
files: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit objects. It finds the lines each edit
names at the first of three matching tiers (exact, trailing-whitespace-insensitive, indentation-insensitive),
writes every change or none, and prints what it changed or why it failed, with the exit codes `SPEC.md`
specifies. `SPEC.md` is the whole specification.

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Node 22 and its standard library alone. The working directory is the root of the tree; `PATCH` is the patch
file (absent or `-` reads standard input). `--format` is one of `unified`, `search-replace`, `v4a`, `json` or
the default `auto`; `--check` reports without writing; `--strict` matches lines exactly (tier 0 only).

## The files

- `main.ts`: the CLI. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's trial runner, kept as it is.
- `check.ts`: runs the practice set on your own machine:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the specification.
- `LICENSE`: MIT.
