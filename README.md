# mend

mend applies an edit that an AI model wrote to a tree of text files, in whichever of the four
formats the model chose: a unified diff (its line numbers may be wrong), SEARCH/REPLACE blocks,
a V4A patch, or text-editor tool calls as JSON. It is an implementation of the bundled
[SPEC.md](SPEC.md), written sentence by sentence: three-tier line matching (exact,
trailing-whitespace-insensitive, indent-insensitive with re-indentation), per-format occurrence
choice, exact exit codes and output lines, and all-or-nothing writes — every file changes, or
none does.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` absent or `-` reads the patch from standard input. `--format` is one of `unified`,
`search-replace`, `v4a`, `json`, or `auto` (the default) to detect it. `--check` reports what
would change without writing; `--strict` matches lines exactly (tier 0 only).

## Layout

- `main.ts` — the CLI itself (Node 22, standard library alone).
- `runner.ts` — the kit's trial runner, kept as shipped.
- `check.ts` — runs the CLI over a practice set and compares exit code, output and file tree.
- `SPEC.md` — the specification mend implements.
