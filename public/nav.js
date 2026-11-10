// Sidebar navigation: the highlight follows the section you are looking at.
//
// It used to be a class hard-coded on one link in the markup, so the box sat on "Overview" however
// far you scrolled. The decision of which section is current is a pure function so it can be
// tested without a browser; everything else here is the DOM glue around it.

// `tops` are the sections' distances from the top of the document, in order. Returns the index of
// the section that should be highlighted.
function currentSectionIndex(tops, { scrollY, viewportHeight, documentHeight, offset = 150 }) {
  if (!tops.length) return -1;
  // A section becomes current once its top passes just under the top edge of the window.
  const marker = scrollY + offset;
  let current = 0;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] <= marker) current = i;
  }
  // At the very bottom the last section wins, even when its top never reaches the marker —
  // otherwise the final item could never be highlighted on a short page.
  if (viewportHeight + scrollY >= documentHeight - 4) current = tops.length - 1;
  return current;
}

function setupNav() {
  const targets = [...document.querySelectorAll(".nav-link")]
    .map((link) => ({ link, section: document.querySelector(link.getAttribute("href")) }))
    .filter((entry) => entry.section);
  if (!targets.length) return () => {};

  const topOf = (section) => section.getBoundingClientRect().top + window.scrollY;
  targets.sort((a, b) => topOf(a.section) - topOf(b.section));

  const highlight = (index) => {
    targets.forEach((entry, i) => entry.link.classList.toggle("active", i === index));
  };

  const sync = () => {
    highlight(currentSectionIndex(targets.map((entry) => topOf(entry.section)), {
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    }));
  };

  // Immediate feedback on a click; the scroll that follows keeps it honest.
  targets.forEach((entry, index) => entry.link.addEventListener("click", () => highlight(index)));

  let frame = 0;
  const queue = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  sync();
  return sync;
}
