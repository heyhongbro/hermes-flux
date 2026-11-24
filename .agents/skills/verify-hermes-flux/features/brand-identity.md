# Brand identity (Bauhaus Origami Swift)

Hermes Flux uses the **Bauhaus Origami Swift** across OS launchers, splashes, cold boot transitions, gateway connecting, history loading skeletons, empty new-session canvases, and the About panel—enforcing a strict variant split so icons never double-print the app title while non-icon surfaces always carry brand identity cleanly.

## Sub-features

- `cold-boot-splash` renders the inline pure-vector floating Bauhaus Swift (`variant="mark"`, `motion="fly"`) and `HERMES FLUX` wordmark centered inside `.flux-boot-splash` with `env(safe-area-inset-*)` and favicons (`hermes-flux-icon.svg`, `favicon-32.png`) before `index.ts` mounts.
- `loading-flight` renders `<BrandSwiftMark variant="mark" motion="fly" />` inside `ConversationSkeleton` (`aria-hidden`, zero text) and `connecting` views.
- `empty-canvas-badge` renders `<BrandSwiftMark variant="badge" motion="glide" />` (with `#152854` `FLUX` wordmark) on empty new sessions and onboarding hero cards.
- `about-variant-a` renders `<BrandSwiftMark variant="icon" motion="static" />` (Variant A, no `FLUX` text) beside the `Hermes Flux` heading in Settings → About.
- `hidden-compositor-release` pauses all `.flux-brand-swift` keyframe animations and resets `.flux-brand-swift__rotor` `will-change: auto` whenever `:root[data-app-hidden="true"]`, `:root[data-page-hidden="true"]`, or `prefers-reduced-motion: reduce` activates.

## How to get to it (user POV)

- Launch desktop cold boot before JS mounts (see `.flux-boot-splash`), or switch to a loading/empty session in light or dark skin (`obsidian-gold` / `ayu-light`), or open **Settings → About**.

## Driving it with brand-identity-visual

Preconditions:

- `node scripts/verify/control-flux.mjs doctor` passes.
- `npm run build && npm run build:mobile:assets` has been run.

- **Run `node scripts/verify/brand-identity-visual.mjs`.**
- **Verify cold boot splash (`index.html` pre-mount)** in both desktop (`1280×800`) and mobile (`390×844`) viewports: `.flux-boot-splash` fills viewport cleanly, favicons are wired, `document.documentElement.scrollWidth <= window.innerWidth`, and the flying swift animates strictly via GPU transforms.
- **Verify dark (`obsidian-gold`) and light (`ayu-light`) runtime React scenes**: real `ConversationSkeleton` (`data-brand-variant="mark"` + `data-brand-motion="fly"`), real `ConversationMessageList` empty session (`data-brand-variant="badge"` + `data-brand-motion="glide"` + `FLUX`), and real `SettingsModal` About panel (`data-brand-variant="icon"` + no `FLUX`).
- **Verify hidden-state compositor release**: toggle `document.documentElement.dataset.appHidden = 'true'` and assert `getComputedStyle(rotor).animationPlayState === 'paused'` and `getComputedStyle(rotor).willChange === 'auto'`.
- **Proof.** `screenshot.png`, `boot-splash.png`, `scenes-dark.png`, `scenes-light.png`, and `evidence.json` (`status: 'PASSED'`) are persisted under `artifacts/verification/brand-identity/`.

## Gotchas

- Never place `@media (prefers-reduced-motion: reduce)` after the existing unified block at the end of `packages/ui/src/styles/conversation.css`; `activity-indicator-preference.test.mjs` locates `lastIndexOf('@media (prefers-reduced-motion: reduce)')`.
- `ConversationSkeleton` is `aria-hidden="true"` and must remain completely text-free so `loading-skeleton.test.mjs` never mistakes a loading canvas for an empty session.
