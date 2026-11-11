# Project Instructions

## Scope

Word Shapes is a static browser prototype for words, names, and short phrases, hosted on GitHub Pages during development and testing. Preserve that architecture unless the owner requests a change. Generation belongs in the Web Worker. Do not add a server, paid API, account system, analytics, or scheduled workflow as part of routine maintenance.

## Writing

Use natural, direct, literal language in interface text, documentation, comments, and responses. Avoid decorative metaphors, exaggerated claims, formulaic introductions, filler, and repeated conclusions. Do not use em dashes in prose. Keep answers concise without removing necessary technical detail. Use consistent title capitalization and only the formatting needed for readability.

Verify factual claims and references. Preserve meaningful distinctions between a valid geometric result, usable interaction, measured performance, and commercial viability. Do not imply that this prototype has established demand or profitability. Review new and changed content before finishing.

## Commits

All commits must use the repository owner's verified Git identity. Confirm the authenticated account and inspect the resulting commit's author and committer. Do not add coauthor trailers or service attribution. Use short commit messages that describe the actual change.

## Geometry and Sharing

- Every target cell must be covered exactly once.
- Each piece must be connected by shared cell edges.
- The same piece must retain its shape in both arrangements.
- Poses are translations and quarter turns around the local origin. Rotating a unit cell requires the corner offsets used in the geometry tests.
- Preserve deterministic generation for each version, seed, and option set. Do not silently change the output for existing versioned links. Changes to fixed glyphs or search rules require a new generator version.
- Keep glyph data fixed across browsers and retain its license notices.

## Validation and Publication

Run `npm test` and `npm run build`. Verify the interface in a browser when available, including generation, rearrangement, manual play, keyboard controls, invalid inputs, and shared links. Check a narrow layout as well as desktop. Report verification limits accurately.

Publish through the existing GitHub Pages workflow. Inspect checks and deployment results, then verify the public page and its `version.json` against the published commit. Do not add scheduled runs. Preserve any user changes that appear while work is in progress.
