(() => {
  const audio = document.getElementById("story-audio");
  const button = document.getElementById("listen-button");
  const status = document.getElementById("audio-status");
  const voice = document.getElementById("story-voice");
  if (!audio || !button || !status || !voice) return;
  const sections = [...document.querySelectorAll("[data-audio-section]")];
  let timing = { starts: [], sections: [], complete: false };
  let current = null;
  let revision = 0;
  let timer;

  function highlight() {
    let section = null;
    if (!audio.paused && !audio.ended && !audio.error) {
      for (let index = 0; index < timing.starts.length; index++) {
        if (timing.starts[index] > audio.currentTime) break;
        section = sections[timing.sections[index]] || null;
      }
    }
    if (section === current) return;
    if (current) {
      current.classList.remove("audio-current");
      current.removeAttribute("aria-current");
    }
    current = section;
    if (current) {
      current.classList.add("audio-current");
      current.setAttribute("aria-current", "true");
      const bounds = current.getBoundingClientRect();
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      if (bounds.top < 32 || bounds.bottom > viewportHeight - 32) {
        current.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
          block: "start",
          inline: "nearest",
        });
      }
    }
  }

  function stopTiming() {
    revision++;
    clearTimeout(timer);
    timing = { starts: [], sections: [], complete: false };
    highlight();
  }

  function failed() {
    stopTiming();
    button.hidden = false;
    button.disabled = false;
    button.textContent = "Try audio again";
    status.textContent = "Audio could not be loaded. Please try again shortly.";
  }

  async function pollTiming(url, run) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Timings unavailable");
      const loaded = await response.json();
      if (run !== revision) return;
      if (Array.isArray(loaded.starts) && Array.isArray(loaded.sections)) timing = loaded;
      highlight();
    } catch {
      if (run !== revision) return;
    }
    if (run === revision && !timing.complete) timer = setTimeout(() => pollTiming(url, run), 2000);
  }

  function play() {
    stopTiming();
    const run = revision;
    const source = new URL(audio.dataset.src, location.href);
    if (voice.value) source.searchParams.set("voice", voice.value);
    const metadata = new URL(source);
    metadata.pathname += "/timing";
    button.disabled = true;
    status.textContent = "Preparing Azure audio…";
    audio.hidden = false;
    audio.src = source.href;
    audio.load();
    pollTiming(metadata.href, run);
    audio.play().catch(() => { if (run === revision) failed(); });
  }

  button.addEventListener("click", play);
  voice.addEventListener("change", () => {
    const resume = !!audio.getAttribute("src") && (!audio.paused || button.disabled);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    stopTiming();
    button.hidden = false;
    button.disabled = false;
    button.textContent = "Play audio";
    status.textContent = "Voice changed. Press Play audio to listen.";
    if (resume) play();
  });
  audio.addEventListener("playing", () => {
    button.hidden = true;
    button.disabled = false;
    status.textContent = "Playing the saved story with Azure narration.";
    highlight();
  });
  audio.addEventListener("pause", () => {
    highlight();
    if (!audio.error && audio.currentTime > 0 && !audio.ended) status.textContent = "Paused. Press play to continue.";
  });
  for (const event of ["timeupdate", "seeking", "seeked"]) audio.addEventListener(event, highlight);
  audio.addEventListener("ended", () => {
    highlight();
    status.textContent = "End of story. Press play to listen again.";
  });
  audio.addEventListener("error", failed);
  window.addEventListener("pagehide", () => { clearTimeout(timer); revision++; });

  fetch(`${audio.dataset.src}/voices`, { signal: AbortSignal.timeout(10000) })
    .then(response => {
      if (!response.ok) throw new Error("Voices unavailable");
      return response.json();
    })
    .then(catalog => {
      voice.replaceChildren();
      for (const item of catalog.voices) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = `${item.name} · ${item.language} · ${item.gender}`;
        voice.append(option);
      }
      voice.value = catalog.selected;
      voice.disabled = false;
    })
    .catch(() => {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Default voice · other choices unavailable";
      voice.replaceChildren(option);
      voice.disabled = true;
    });
})();
