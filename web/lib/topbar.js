// The slim top bar's one trick: at rest it is the page colour and says
// "Flock"; once the page's own heading (its h1) has scrolled up under the bar,
// the bar gets its blur and hairline and shows the page's title instead
// (class is-scrolled on the header, styled in style.css).
//
// It reads the h1 afresh on every check rather than observing one element:
// pages repaint themselves when their data arrives, which replaces the h1.
// Every browser part comes from `win`; nothing runs at import.

/** True when the heading's bottom edge is above the bar's bottom edge. */
export function headingIsUnder(top, main) {
  const h1 = main?.querySelector?.('h1');
  if (!h1?.getBoundingClientRect || !top?.getBoundingClientRect) return false;
  return h1.getBoundingClientRect().bottom <= top.getBoundingClientRect().bottom;
}

/**
 * Keeps is-scrolled on `top` up to date while the page scrolls.
 * Returns check(): call it after a page change (the new page starts at the top).
 */
export function watchScroll(win, top, main) {
  let queued = false;
  const check = () => {
    queued = false;
    top?.classList?.toggle('is-scrolled', headingIsUnder(top, main));
  };
  const later = () => {
    if (queued) return;
    queued = true;
    if (typeof win?.requestAnimationFrame === 'function') win.requestAnimationFrame(check);
    else check();
  };
  win?.addEventListener?.('scroll', later, { passive: true });
  win?.addEventListener?.('resize', later, { passive: true });
  return later;
}
