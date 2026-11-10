// Motion helpers. Everything here degrades to an instant update when the viewer asks for
// reduced motion, and no animation is decorative: numbers ease so you can see which tile moved,
// and a feed line slides in once so you can see that it is the new one.

const reduceMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");

function prefersReducedMotion() {
  return Boolean(reduceMotionQuery?.matches);
}

// Avoids pointless DOM writes, which would otherwise restart CSS transitions every second.
function setText(element, text) {
  if (!element) return;
  const next = String(text);
  if (element.textContent !== next) element.textContent = next;
}

const lastNumber = new WeakMap();
const runningEase = new WeakMap();

const easeOutCubic = (p) => 1 - (1 - p) ** 3;

// Eases the element's displayed number from its previous value to `value`.
// `format` turns a number into the text actually shown.
function setNumber(element, value, format = (n) => String(Math.round(n))) {
  if (!element) return;
  const target = Number(value);
  if (!Number.isFinite(target)) {
    setText(element, format(0));
    return;
  }
  const previous = lastNumber.get(element);
  lastNumber.set(element, target);

  const existing = runningEase.get(element);
  if (existing) cancelAnimationFrame(existing);

  if (previous === undefined || previous === target || prefersReducedMotion()) {
    setText(element, format(target));
    return;
  }

  const start = performance.now();
  const duration = 420;
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const current = previous + (target - previous) * easeOutCubic(progress);
    setText(element, format(progress === 1 ? target : current));
    if (progress < 1) runningEase.set(element, requestAnimationFrame(step));
    else runningEase.delete(element);
  };
  runningEase.set(element, requestAnimationFrame(step));
}

// Plays the enter animation once. The class is removed again so a later re-append does not replay it.
function markNew(element) {
  if (!element || prefersReducedMotion()) return;
  element.classList.add("is-new");
  element.addEventListener("animationend", () => element.classList.remove("is-new"), { once: true });
}
