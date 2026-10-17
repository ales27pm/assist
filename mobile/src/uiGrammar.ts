/** Stable geometry and type across every appearance; colors live in appearance.tsx. */
export const uiGrammar = {
  unit: 4,
  gutter: 24,
  touchTarget: 44,
  composer: { height: 52, maxHeight: 144, border: 1 },
  icon: { size: 24, stroke: 2 },
  radius: { control: 12, bubble: 16, pill: 24 },
  harmony: {
    phi: (1 + Math.sqrt(5)) / 2,
    space: { small: 8, medium: 13, large: 21, section: 34 },
  },
  type: {
    caption: { fontSize: 12, lineHeight: 18 },
    label: { fontSize: 14, lineHeight: 20 },
    body: { fontSize: 16, lineHeight: 24 },
    navigation: { fontSize: 24, lineHeight: 32 },
    title: { fontSize: 28, lineHeight: 36 },
    display: { fontSize: 34, lineHeight: 42 },
  },
} as const;
