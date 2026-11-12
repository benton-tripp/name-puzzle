# Animation Exports

The repository includes a local tool for producing finished word-shape animations. It exports MP4 video, a looping GIF, a PNG poster, an SVG poster, and a JSON recipe. It does not add downloads or payment controls to the public website.

## Requirements

- Node.js 22 or later.
- FFmpeg with the `librsvg` SVG decoder and the `png`, `gif`, and `libx264` encoders.

There are no npm dependencies to install. FFmpeg is needed only for this optional export tool. Ordinary development, tests, and the website build continue to use Node alone.

Use your operating system's package manager or the downloads linked from [FFmpeg](https://ffmpeg.org/download.html). FFmpeg builds differ, so confirm SVG support before exporting:

```sh
ffmpeg -decoders
ffmpeg -encoders
```

Look for `librsvg` in the decoder list and the required names in the encoder list. A missing decoder is a build capability issue, not a missing font. The tool checks these capabilities before generating frames and reports the missing component.

If FFmpeg is not on your PATH, use `--ffmpeg "/path/to/ffmpeg"` or set `FFMPEG_PATH`. Windows executable paths with spaces are supported when quoted.

## Included Designs

| Preset | Arrangements | Appearance |
| --- | --- | --- |
| `birthday` | HAPPY / BIRTHDAY | Warm cream, colored pieces, confetti |
| `holidays` | HAPPY / HOLIDAYS | Deep teal, winter colors, snowflakes and stars |
| `new-year` | HAPPY / NEW YEAR | Navy, gold and silver colors, stars |

The presets are stored in `examples/animations/presets.json`. NEW YEAR uses the generator's two-line layout. HAPPY BIRTHDAY exceeds the 12-character limit as a single input, so the birthday design uses HAPPY and BIRTHDAY as its two arrangements.

Run from the repository root:

```sh
npm run export:animation -- --list-presets
npm run export:animation -- --preset birthday
npm run export:animation -- --preset holidays
npm run export:animation -- --preset new-year
```

By default, each design is written beneath `exports/`, which is ignored by Git. The standard output is a 1080 × 1080 MP4 at 30 frames per second and a 540-pixel-wide GIF at 15 frames per second. Both use a 5.6-second cycle: hold for 1.6 seconds, rearrange for 1.2 seconds, hold for 1.6 seconds, and return for 1.2 seconds.

The MP4 uses H.264 with a broadly compatible pixel format and no audio. It is designed for repeated playback, but the player must enable looping. The GIF contains an infinite-loop setting. GIF frame delays use hundredths of a second, so individual frame durations can vary slightly when the requested rate cannot be represented exactly.

## Adjust a Design

```sh
npm run export:animation -- --preset holidays --width 1920 --height 1080 --hold 2 --transition 1.5 --out exports/holidays-wide
npm run export:animation -- --first THANK --second YOU --theme birthday --seed 7 --out exports/thank-you
npm run export:animation -- --preset birthday --background "#fff9ef" --colors "#cf6c63,#629f95,#d2a252" --out exports/birthday-colors
```

Dimensions must be even numbers from 256 to 2160. The main frame rate can be 10 to 60. A pause can last 0.2 to 10 seconds and a transition 0.2 to 5 seconds. Large combinations are rejected before rendering. Use `--format mp4` or `--format gif` to produce only one animation format; both poster formats and the recipe are still included.

Use `--gif-width` and `--gif-fps` to control the smaller preview. These values cannot exceed the main width and frame rate. One supplied piece color creates a solid-color puzzle with visible piece boundaries. The output background is opaque. Transparent animation export is not part of this tool.

`--out` can point to a path containing spaces. A nonempty output directory is rejected unless `--force` is supplied. With `--force`, the tool replaces only files named for this design; unrelated files remain. Choose a new output directory when comparing variations. Rendering and encoding finish in temporary storage before output files are copied into place.

## Reproduce an Export

Each design includes a `.recipe.json` file containing the text, generator version, seed, shared-character option, theme, colors and timing options, dimensions, encoding environment, and a checksum of the generated geometry. Source-file checksums identify the exporter and generator used. When Git metadata is available, the recipe also records the commit and whether the working tree had changes.

```sh
npm run export:animation -- --recipe exports/happy-birthday/happy-birthday.recipe.json --out exports/birthday-reproduced
```

Reproduction checks the source files and regenerated geometry before exporting. A changed source file or unexpected geometry causes a clear error. `--recipe` can be combined with `--out`, `--ffmpeg`, and `--force`; use the normal preset/custom flags to make a new variation.

The configuration and sampled frames are deterministic for the same source and options. Different FFmpeg, librsvg, or codec versions can rasterize or encode differently, so the recipe is not a promise of byte-identical video across machines.

## Geometry and Visual Review

Exports use generator version 4 explicitly. The tool does not alter glyphs, piece shapes, existing generator output, or versioned website links. Each piece keeps its color and rigid shape. The two arrangements are centered by translation, with one shared scale throughout the clip. The fixed frame includes conservative bounds for every piece throughout its rotation and movement.

The export renderer rotates pieces around their own centers while translating between the two arrangements. Its motion is separate from the interactive board's timing. Pieces may overlap during a transition; this is a visual animation, not a collision-free physical assembly sequence.

Review both word arrangements, intermediate movement, looping, and the final GIF after changing a design. Grid edges and small pieces remain visible. The included cuts were selected from a small seed sample, not proven optimal. These files do not establish manufacturing suitability, mobile puzzle usability, or buyer demand.

## Development

```sh
npm test
npm run build
npm run export:animation -- --help
```

`scripts/lib/animation-renderer.mjs` supplies deterministic SVG frames. `scripts/lib/export-options.mjs` handles configuration and recipe validation. `scripts/export-animation.mjs` generates the puzzle, renders the frame sequence, invokes FFmpeg without a shell, and writes the result. The export files are excluded from the normal website build. No scheduled workflows, services, or paid APIs are required.
