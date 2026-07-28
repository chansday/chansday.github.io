const navToggle = document.getElementById("navToggle");
const navLinks = document.getElementById("navLinks");

navToggle.addEventListener("click", () => {
  navLinks.classList.toggle("open");
});

const sections = document.querySelectorAll(".section");

if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );
  sections.forEach((section) => revealObserver.observe(section));
} else {
  sections.forEach((section) => section.classList.add("in-view"));
}

// Only the game currently scrolled into view should receive keyboard input,
// since multiple keyboard-driven games share the page and all listen on document.
const kbTargets = document.querySelectorAll(".kb-target");

if ("IntersectionObserver" in window) {
  const kbObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        entry.target.classList.toggle("kb-active", entry.isIntersecting);
      });
    },
    { threshold: 0.5 }
  );
  kbTargets.forEach((el) => kbObserver.observe(el));
} else {
  kbTargets.forEach((el) => el.classList.add("kb-active"));
}
