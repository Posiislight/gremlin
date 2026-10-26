/* gremlin landing page interactions */
(() => {
  "use strict";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Header ---------- */
  const header = document.querySelector(".site-header");
  const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- Mobile nav ---------- */
  const toggle = document.getElementById("nav-toggle");
  const links = document.getElementById("nav-links");

  if (toggle && links) {
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      links.classList.toggle("is-open", !open);
    });

    links.addEventListener("click", (event) => {
      if (event.target.closest("a")) {
        toggle.setAttribute("aria-expanded", "false");
        links.classList.remove("is-open");
      }
    });
  }

  /* ---------- Scroll reveal ---------- */
  const revealables = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reducedMotion) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealables.forEach((el, index) => {
      el.style.transitionDelay = `${Math.min(index % 4, 3) * 70}ms`;
      io.observe(el);
    });
  } else {
    revealables.forEach((el) => el.classList.add("is-visible"));
  }

  /* ---------- Pointer spotlight ---------- */
  const spotlight = document.getElementById("spotlight");
  if (spotlight && !reducedMotion && window.matchMedia("(pointer: fine)").matches) {
    let raf = 0;
    window.addEventListener(
      "pointermove",
      (event) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          const x = (event.clientX / window.innerWidth - 0.5) * 60;
          const y = (event.clientY / window.innerHeight - 0.5) * 40;
          spotlight.style.transform = `translateX(calc(-50% + ${x}px)) translateY(${y}px)`;
          raf = 0;
        });
      },
      { passive: true }
    );
  }

  /* ---------- Hero terminal ---------- */
  const termBody = document.getElementById("terminal-body");
  const heuristicCount = document.getElementById("heuristic-count");
  const runCount = document.getElementById("run-count");

  const step = (html, cls = "") => ({ html, cls });

  const RUN = [
    step("$ ", "c-prompt"),
    step('gremlin run "checkout with a saved card"', "c-type-line"),
    step("\n\n"),
    step("→ ", "c-accent"),
    step("memory loaded   ", "c-dim"),
    step("214 heuristics\n"),
    step("→ ", "c-accent"),
    step("planning        ", "c-dim"),
    step("8 steps · 1.2s\n\n"),
    step("✓ ", "c-ok"),
    step("explore         ", "c-dim"),
    step("/checkout → /cart → /payment\n"),
    step("✓ ", "c-ok"),
    step("apply coupon    ", "c-dim"),
    step("LAUNCH20\n"),
    step("! ", "c-warn"),
    step("finding filed   ", "c-dim"),
    step("checkout.total-negative\n"),
    step("  ↳ total renders as −$12.40 · repro 3/3\n"),
    step("  ↳ video · dom snapshot · network log\n\n"),
    step("⟳ ", "c-accent"),
    step("writing heuristic\n"),
    step("  checkout.total-negative\n\n"),
    step("✓ ", "c-ok"),
    step("re-verified     ", "c-dim"),
    step("0.9s · 1 bug, 7 passed\n"),
    step("$ ", "c-prompt"),
  ];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const renderRun = () => {
    if (!termBody) return;
    termBody.innerHTML = RUN.map(
      (part) => `<span class="${part.cls}">${part.html}</span>`
    ).join("") + '<span class="c-type"></span>';
  };

  const typeRun = async () => {
    termBody.innerHTML = "";
    const cursor = document.createElement("span");
    cursor.className = "c-type";
    termBody.appendChild(cursor);

    for (const part of RUN) {
      const span = document.createElement("span");
      span.className = part.cls;
      termBody.insertBefore(span, cursor);

      if (part.cls === "c-type-line") {
        for (let i = 0; i < part.html.length; i++) {
          span.textContent += part.html[i];
          await sleep(16);
        }
        continue;
      }

      span.innerHTML = part.html;
      const isPrompt = part.cls === "c-prompt";
      await sleep(isPrompt ? 130 : part.html.trim() === "" ? 190 : 160);
    }

    await sleep(5200);
  };

  const loopTerminal = async () => {
    if (!termBody) return;
    if (reducedMotion) {
      renderRun();
      return;
    }

    let run = 1208;
    let heuristics = 42;

    for (;;) {
      await typeRun();
      run += 1;
      heuristics += 1;
      if (runCount) runCount.textContent = run.toLocaleString("en-US");
      if (heuristicCount) heuristicCount.textContent = heuristics;

      // wipe, hold briefly, then start again
      await sleep(900);
      termBody.style.opacity = "0";
      await sleep(400);
      termBody.style.opacity = "";
    }
  };

  if (termBody) {
    // only animate when the hero is on screen
    if ("IntersectionObserver" in window) {
      const heroIO = new IntersectionObserver(
        (entries) => {
          const visible = entries.some((entry) => entry.isIntersecting);
          if (visible && !heroIO.started) {
            heroIO.started = true;
            loopTerminal();
          }
        },
        { threshold: 0.25 }
      );
      heroIO.observe(termBody);
      termBody.style.transition = "opacity 0.4s ease";
    } else {
      loopTerminal();
    }
  }

  /* ---------- Heuristic snippet ---------- */
  const snippet = document.getElementById("heuristic-snippet");
  if (snippet) {
    snippet.innerHTML = [
      '<span class="c"># .gremlin/heuristics/checkout.yaml</span>',
      '<span class="k">id</span>: checkout.total-negative',
      '<span class="k">learned</span>: <span class="v">2026-10-26T18:42:11Z</span>',
      '<span class="k">from_run</span>: runs/2026-10-26-1842',
      '<span class="k">confidence</span>: <span class="v">0.97</span>',
      '<span class="k">assert</span>:',
      '  <span class="k">total</span> &gt;= <span class="v">0</span>',
      '  <span class="k">when</span>: coupon.amount &lt; <span class="v">0</span>',
      '<span class="k">replay</span>: steps/apply-coupon.replay',
    ].join("\n");
  }

  /* ---------- Early access form ---------- */
  const form = document.getElementById("access-form");
  const email = document.getElementById("email");
  const note = document.getElementById("form-note");

  if (form && email && note) {
    const defaultNote = note.textContent;

    const setNote = (message, state) => {
      note.textContent = message;
      note.classList.remove("is-error", "is-success");
      if (state) note.classList.add(`is-${state}`);
    };

    email.addEventListener("input", () => {
      email.classList.remove("is-invalid");
      if (note.classList.contains("is-error")) setNote(defaultNote, null);
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = email.value.trim();
      const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

      if (!valid) {
        email.classList.add("is-invalid");
        email.setAttribute("aria-invalid", "true");
        setNote("That email doesn't look right. Try again?", "error");
        email.focus();
        return;
      }

      email.removeAttribute("aria-invalid");
      email.classList.remove("is-invalid");
      setNote("You're on the list. We'll be in touch before the next run.", "success");
      form.reset();
      const button = form.querySelector("button");
      if (button) {
        button.textContent = "Requested";
        button.disabled = true;
        button.style.opacity = "0.7";
      }
    });
  }
})();
