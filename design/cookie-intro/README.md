# Cookie entrance artwork

Archived artwork from the previous entrance. The current site opens directly with a CSS text reveal and does not load or animate this cookie.

Generated with Higgsfield Recraft V4.1 in native vector mode. One generation, completed 2026-10-05 UTC. The prompt and original SVG are retained alongside the asset. Raw request/response metadata and preview PNGs are local working files and are not committed.

[Original Higgsfield result](https://d8j0ntlcm91z4.cloudfront.net/user_3JZGg2SBLH2gNxiJUqrD74CVfJ1/hf_20261005_022325_692030b7-a507-419d-b04b-eb9eb0344b22.svg)

## Files
- `cookie-generated-original.svg`: untouched native generated SVG, 2048 x 2048 viewBox, 39 paths. It contains black and white filled geometry rendering line artwork, plus two negligible gray artifacts.
- `cookie-contour.svg`: archived animation adaptation. One outer path, nine outlined chip paths and three crack contours; 13 stroke paths total. Every path's d attribute is exactly the corresponding black path in the original. No hand-drawn replacement and no raster tracing were used. White interior/face detail shapes and two gray artifacts were omitted, fill removed, explicit black strokes added, metadata/title/IDs/pathLength set, and preserveAspectRatio corrected to xMidYMid meet. The final viewBox is cropped to cubic-curve geometry bounds plus approximately 8% padding on every side (square aspect), and the background rectangle is removed.
- `*.svg.png`: local Quick Look visual previews only, not source artwork.
- `asset-check.json`: geometry, path-count and file-integrity audit.

## Reference and differences
The user's cookie photograph was visually inspected. Recraft V4.1 is prompt-only, so the photo was not uploaded: its intact, irregular round shape, chunky chips and prominent round central chip were described in the prompt. The output is an original simplified interpretation, not an exact photographic contour trace. The prompt requested eight chips; the result has nine, within the requested approximate six-to-nine range. The three crack paths retain the original narrow closed contour geometry, so their strokes follow both sides of each crack rather than a recovered centerline.

## Animation handoff
Target `.cookie-stroke` or IDs `cookie-outer`, `cookie-chip-01` through `cookie-chip-09`, and `cookie-crack-01` through `cookie-crack-03`. All paths have pathLength="1", allowing stroke-dasharray="1" and stroke-dashoffset from 1 to 0. Inline SVG is needed to animate child paths through page CSS/JS. The animation asset is transparent so the white page supplies its background. No HTML, CSS, JavaScript or backend code has been changed here.

The source is a true vector SVG and remains resolution-independent. The actual SVG canvas is 2048 x 2048 even though provider response params also list width/height 1024. The file itself, rather than response metadata, was inspected.

Final animation viewBox: `299.4070 302.7333 1448.1256 1448.1256`. At a 220px square CSS size the cookie measures approximately 189.7px tall. Every original generated contour d is unchanged. Cracks retain narrow closed outline geometry.
