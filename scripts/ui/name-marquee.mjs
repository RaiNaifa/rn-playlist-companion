export function decorateNames(element) {
  for (const label of element.querySelectorAll(
    ".directory-list .sound > header > label.ellipsis, .currently-playing .sound > header > label.ellipsis, .directory-list .playlist > .playlist-header > label.playlist-name.ellipsis",
  )) {
    if (label.dataset.rnMarqueeReady) continue;
    label.dataset.rnMarqueeReady = "true";
    label.addEventListener("pointerenter", () => {
      if (label.scrollWidth <= label.clientWidth + 2) return;
      const name = label.textContent;
      const strip = document.createElement("span");
      strip.className = "rn-marquee-strip";
      const first = document.createElement("span");
      first.className = "rn-marquee-copy";
      first.textContent = name;
      const repeat = first.cloneNode(true);
      repeat.setAttribute("aria-hidden", "true");
      strip.append(first, repeat);
      label.replaceChildren(strip);
      label.classList.add("rn-marquee");
    });
    label.addEventListener("pointerleave", () => {
      if (!label.classList.contains("rn-marquee")) return;
      label.replaceChildren(label.querySelector(".rn-marquee-copy")?.textContent ?? "");
      label.classList.remove("rn-marquee");
    });
  }
}
