# gremlin

Self-improving browser-agent QA. A landing page for the gremlin project — built at OpenFire 2026.

## Run it

The page is static, with no build step:

```bash
python3 -m http.server 4173
```

Open http://localhost:4173.

## Structure

| File | Purpose |
| --- | --- |
| `index.html` | Page markup and copy |
| `styles.css` | Design tokens, layout, responsive rules |
| `script.js` | Hero terminal animation, scroll reveals, nav, email form |
| `favicon.svg` | Brand mark |

No framework or dependencies. Fonts load from Google Fonts with system fallbacks.

## Notes

- The hero terminal is a scripted demo of a gremlin run — replace `RUN` in `script.js` when the real CLI output is settled.
- Metrics in the results strip and the early-access form are placeholders; wire them to real data and a form endpoint before launch.
- `prefers-reduced-motion` is respected: the terminal renders statically and reveals are disabled.
