(() => {
  const root = document.documentElement;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // The page is visible by default. A missing/blocked script never hides content.
  if (motion.matches) return;

  let finished = false;
  let deadline;
  const animations = [];
  function reveal(immediate = false) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    if (immediate === true) root.classList.add('intro-skipped');
    root.classList.remove('intro-pending');
    // Keep the completed drawing intact as the white screen fades away.
    animations.forEach((animation) => {
      try { animation.finish(); } catch { animation.cancel(); }
    });
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onFocus, true);
    motion.removeEventListener('change', onMotionChange);
  }
  function onKey(event) {
    if (event.key === 'Tab' || event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') reveal(true);
  }
  function onFocus(event) {
    if (!event.target.closest('#cookie-intro')) reveal(true);
  }
  function onMotionChange() { reveal(true); }

  // This guard is independent of the SVG and its animation promises.
  deadline = setTimeout(reveal, 3200);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocus, true);
  motion.addEventListener('change', onMotionChange, { once: true });
  root.classList.add('intro-pending');

  document.addEventListener('DOMContentLoaded', () => {
    if (finished) return;
    const overlay = document.querySelector('#cookie-intro');
    const paths = [...document.querySelectorAll('.cookie-drawing path')];
    if (!overlay || !paths.length || !Element.prototype.animate) {
      reveal();
      return;
    }
    overlay.querySelector('.intro-skip')?.addEventListener('click', () => reveal(true));
    try {
      paths.forEach((path, index) => {
        path.setAttribute('pathLength', '1');
        const outer = index === 0;
        const duration = outer ? 1000 : 460;
        const delay = outer ? 70 : 670 + (index - 1) * 85;
        animations.push(path.animate(
          [{ strokeDashoffset: '1' }, { strokeDashoffset: '0' }],
          { duration, delay, easing: 'cubic-bezier(.4,0,.25,1)', fill: 'forwards' },
        ));
      });
      Promise.all(animations.map((animation) => animation.finished))
        .then(() => { if (!finished) setTimeout(reveal, 170); })
        .catch(reveal);
    } catch {
      reveal();
    }
  }, { once: true });
})();
