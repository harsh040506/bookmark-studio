# Design

Bookmark Studio uses one small design system. Content comes first and the chrome stays out of the way. These rules keep new screens consistent with the rest of the app.

## Where it lives

| File | Contents |
| --- | --- |
| [`src/styles/tokens.css`](../src/styles/tokens.css) | Every colour, shadow, radius and easing, for light and dark |
| [`src/styles/ui.css`](../src/styles/ui.css) | The controls: toolbar buttons, menus, dialogs, inputs, segmented controls, switches, tooltips, toasts |
| [`src/styles/doc.css`](../src/styles/doc.css) | Long-form text |
| [`src/styles/app.css`](../src/styles/app.css) | App surfaces built from the tokens: sidebar, cards, list rows, detail panel, settings |
| [`src/components/ui/`](../src/components/ui) | The controls as React components (behaviour from Radix, visuals from `ui.css`) |
| [`src/components/icons.tsx`](../src/components/icons.tsx) | The icon set |

## The look

| | |
| --- | --- |
| Background | Warm paper `#faf9f5` in light, true black `#0b0b0b` in dark |
| Text | Near-black ink; secondary and tertiary greys are warm, never blue-grey |
| Accent | One blue, `#2a78d6`, used sparingly: focus, switches, checked state, selection |
| Primary button | Inverted ink (black on light, white on dark), never blue |
| Type | DM Sans for the interface (14 px), Newsreader at weight 400 for headings, JetBrains Mono for code |
| Weights | 400, 500 and 600 only |
| Icons | Hugeicons stroke-rounded, 16 px, 1.5 px stroke, `currentColor` |
| Borders | 1 px low-alpha hairlines, often drawn as an inset shadow so nothing shifts |
| Elevation | A 1 px ring plus a soft two-layer shadow; in dark mode the ring is a faint white line |
| Radii | 4 · 6 · 8 (controls) · 10 (menus, popovers) · 14 (dialogs) · 999 (pills, switches) |
| Motion | 120 ms colour changes and pop-ins, 180 ms dialogs; no bounces; respects reduced motion |

## Rules

- **Tokens only.** Never hard-code a colour in a component. Add a token to `tokens.css` or derive one with `color-mix()` from existing tokens.
- **Ghost by default.** Controls are transparent until hovered (5 % ink) or selected (10 % ink). Each toolbar gets at most one raised action.
- **Custom controls.** No native selects, checkboxes, alerts or confirms. Use the menu, checkbox, switch, segmented control and dialog components.
- **Composing something new:**
  - a card is `surface-2` with a ring and small shadow;
  - a badge is a 20 px pill;
  - a banner is a light status tint with matching text;
  - progress is a 4 px ink bar;
  - an empty state is a serif headline, one sentence and at most two actions.
- **Labels are sentence case.** Small labels are never uppercase or letter-spaced.
- **Every icon-only control** has an `aria-label` and a tooltip, and the tooltip shows its shortcut when it has one.
- **Keyboard focus** shows a 2 px accent ring with a paper gap; mouse clicks never show one.
- **Both themes** are checked for every change.
