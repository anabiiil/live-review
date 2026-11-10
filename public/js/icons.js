// Inline SVG icons, built with DOM APIs (no markup strings).
// Most shapes are adapted from Lucide (https://lucide.dev), ISC License:
//   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
//   All other copyright (c) for Lucide are held by Lucide Contributors 2022.
//   Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is
//   hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
// `mark` (the product mark: a sheet with a highlighter tab in its margin) is LiveReview's own.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @typedef {[tag:'path'|'circle'|'rect'|'line'|'polyline', attrs:Record<string, string|number>][]} IconParts */

/** @type {Record<string, IconParts>} */
export const ICONS = {
  mark: [
    ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }],
    ['path', { d: 'M15 3v18' }],
    ['rect', { x: 15, y: 8, width: 6, height: 5, class: 'mark-tab' }],
  ],
  bell: [
    ['path', { d: 'M10.268 21a2 2 0 0 0 3.464 0' }],
    ['path', { d: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326' }],
  ],
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
  'git-branch': [
    ['line', { x1: 6, x2: 6, y1: 3, y2: 15 }],
    ['circle', { cx: 18, cy: 6, r: 3 }],
    ['circle', { cx: 6, cy: 18, r: 3 }],
    ['path', { d: 'M18 9a9 9 0 0 1-9 9' }],
  ],
  'git-commit': [
    ['circle', { cx: 12, cy: 12, r: 3 }],
    ['line', { x1: 3, x2: 9, y1: 12, y2: 12 }],
    ['line', { x1: 15, x2: 21, y1: 12, y2: 12 }],
  ],
  'file-diff': [
    ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
    ['path', { d: 'M9 10h6' }],
    ['path', { d: 'M12 13V7' }],
    ['path', { d: 'M9 17h6' }],
  ],
  message: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]],
  'log-out': [
    ['path', { d: 'm16 17 5-5-5-5' }],
    ['path', { d: 'M21 12H9' }],
    ['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }],
  ],
  shield: [
    ['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }],
  ],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  x: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
};

/**
 * An icon element. Decorative (aria-hidden) unless a label is given.
 * @param {keyof typeof ICONS} name
 * @param {{label?:string, size?:number, class?:string}} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, { label, size, class: cls } = {}) {
  const svg = /** @type {SVGSVGElement} */ (document.createElementNS(SVG_NS, 'svg'));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `icon icon-${name}${cls ? ` ${cls}` : ''}`);
  if (size) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}
