# Vendor Icon Assets

This directory is a verbatim copy of [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons) used to render provider and model brand icons automatically.

| Item | Value |
|---|---|
| Upstream | `@lobehub/icons-static-svg` 1.102.0 |
| License | MIT (see `LICENSE` in this directory) |
| File count | 994 SVGs (full upstream set, including `-text` and `-brand` variants) |
| Generator | `scripts/gen-vendor-icons.mjs` |

## Variant Naming

- `<slug>.svg` — monochrome version (`fill="currentColor"`), adapts to text color and active theme;
- `<slug>-color.svg` — full-color brand variant;
- `<slug>-text.svg` / `<slug>-text-cn.svg` — horizontal icon + wordmark lockup;
- `<slug>-brand.svg` / `<slug>-brand-color.svg` — container-backed variant.

List rows use only the first two variants; the rest are kept for completeness.

## Dual-Track Contrast Classification (Dark / Light)

Color SVGs hardcode hex values that can become invisible on one theme polarity: e.g. OpenAI, Anthropic, and xAI marks are black (invisible on dark backgrounds), while OpenRouter's `#C8FF00` yields only 1.18:1 contrast on white (invisible on light backgrounds).
The manifest therefore records both `colorDarkSafe` and `colorLightSafe` for every color asset so the renderer chooses between always-color, dark-only-color, light-only-color, and always-mono.

Safety is evaluated by majority rule (`safe colors >= total / 2`): multi-color marks such as Google's four-color logo pass when most segments remain legible, whereas low-contrast monochrome color marks (e.g. OpenRouter / NVIDIA) fall back to monochrome.

Current distribution (357 base vendors):

| Classification | Count | Rendering Mode |
|---|---|---|
| Safe on both | 135 | Always color |
| Dark-safe only | 69 | Color on dark, mono on light |
| Light-safe only | 32 | Color on light, mono on dark |
| Safe on neither | 0 | Always mono |
| Mono-only variant | 121 | Always mono |

## Updating Assets

```bash
node scripts/gen-vendor-icons.mjs
```

The script downloads the configured package tarball, refreshes this directory, and regenerates `../vendorIconAssets.ts`.
Update `PACKAGE_VERSION` at the top of the generator script to bump upstream versions.
