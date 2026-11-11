(() => {
  const audio = document.getElementById("story-audio");
  const button = document.getElementById("listen-button");
  const browserButton = document.getElementById("browser-read-button");
  const copyButton = document.getElementById("copy-analysis-link");
  const shareButton = document.getElementById("share-analysis-btn");
  const status = document.getElementById("audio-status");
  const voice = document.getElementById("story-voice");
  const sections = [...document.querySelectorAll("[data-audio-section]")];

  let timing = { starts: [], sections: [], complete: false };
  let current = null;
  let revision = 0;
  let timer;
  let azureAvailable = false;
  let browserSpeaking = false;
  let browserRunId = 0;

  function highlightElement(section) {
    if (section === current) return;
    if (current) {
      current.classList.remove("audio-current");
      current.removeAttribute("aria-current");
    }
    current = section || null;
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

  function highlightFromTiming() {
    if (!audio) return;
    let section = null;
    if (!audio.paused && !audio.ended && !audio.error) {
      for (let index = 0; index < timing.starts.length; index++) {
        if (timing.starts[index] > audio.currentTime) break;
        section = sections[timing.sections[index]] || null;
      }
    }
    highlightElement(section);
  }

  function stopBrowserSpeech() {
    browserRunId++;
    browserSpeaking = false;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (browserButton) {
      browserButton.textContent = "Read in browser";
      browserButton.setAttribute("aria-pressed", "false");
    }
    highlightElement(null);
  }

  function stopTiming() {
    revision++;
    clearTimeout(timer);
    timing = { starts: [], sections: [], complete: false };
    highlightFromTiming();
  }

  function stopAzureAudio() {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    stopTiming();
    if (button) {
      button.hidden = false;
      button.disabled = false;
      button.textContent = azureAvailable ? "Play Azure audio" : "Read aloud";
    }
  }

  function cleanSpokenText(raw) {
    return (raw || "")
      .replace(/\[S\d+\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function startBrowserReadAloud() {
    if (!("speechSynthesis" in window)) {
      if (status) status.textContent = "Browser speech is not supported on this device.";
      return;
    }

    if (browserSpeaking) {
      stopBrowserSpeech();
      if (status) status.textContent = "Stopped browser reading.";
      return;
    }

    stopAzureAudio();
    const run = ++browserRunId;
    browserSpeaking = true;
    const lang = document.documentElement.lang && document.documentElement.lang !== "und"
      ? document.documentElement.lang
      : "en-NZ";

    if (browserButton) {
      browserButton.textContent = "Stop reading";
      browserButton.setAttribute("aria-pressed", "true");
    }
    if (status) status.textContent = "Reading aloud using your device voice…";

    const items = sections
      .map((el) => ({ el, text: cleanSpokenText(el.textContent) }))
      .filter((item) => item.text.length > 0);

    let index = 0;
    function speakNext() {
      if (run !== browserRunId || !browserSpeaking) return;
      if (index >= items.length) {
        stopBrowserSpeech();
        if (status) status.textContent = "Finished reading analysis.";
        return;
      }

      const item = items[index++];
      highlightElement(item.el);
      const utterance = new SpeechSynthesisUtterance(item.text);
      utterance.lang = lang;
      utterance.onend = () => {
        if (run === browserRunId && browserSpeaking) speakNext();
      };
      utterance.onerror = () => {
        if (run === browserRunId && browserSpeaking) {
          stopBrowserSpeech();
          if (status) status.textContent = "Browser speech stopped unexpectedly.";
        }
      };
      window.speechSynthesis.speak(utterance);
    }

    window.speechSynthesis.cancel();
    speakNext();
  }

  if (copyButton) {
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        copyButton.textContent = "✓ Link copied";
        setTimeout(() => { copyButton.textContent = "📋 Copy link"; }, 1800);
      } catch {
        copyButton.textContent = "Copy failed";
      }
    });
  }

  if (shareButton) {
    if (typeof navigator.share !== "function") {
      shareButton.hidden = true;
    } else {
      shareButton.addEventListener("click", async () => {
        try {
          await navigator.share({ title: document.title, url: location.href });
        } catch {
          // User cancelled share sheet.
        }
      });
    }
  }

  if (browserButton) {
    if (!("speechSynthesis" in window)) {
      browserButton.hidden = true;
    } else {
      browserButton.addEventListener("click", startBrowserReadAloud);
    }
  }

  if (!audio || !button || !status || !voice) return;

  function failed() {
    stopTiming();
    button.hidden = false;
    button.disabled = false;
    button.textContent = azureAvailable ? "Try Azure audio again" : "Try audio again";
    status.textContent = "Azure audio is unavailable right now — you can still use Read in browser.";
  }

  async function pollTiming(url, run) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Timings unavailable");
      const loaded = await response.json();
      if (run !== revision) return;
      if (Array.isArray(loaded.starts) && Array.isArray(loaded.sections)) timing = loaded;
      highlightFromTiming();
    } catch {
      if (run !== revision) return;
    }
    if (run === revision && !timing.complete) timer = setTimeout(() => pollTiming(url, run), 2000);
  }

  function playAzure() {
    if (!azureAvailable) {
      startBrowserReadAloud();
      return;
    }
    stopBrowserSpeech();
    stopTiming();
    const run = revision;
    const source = new URL(audio.dataset.src, location.href);
    if (voice.value) source.searchParams.set("voice", voice.value);
    const metadata = new URL(source);
    metadata.pathname += "/timing";
    button.disabled = true;
    status.textContent = "Preparing Azure narration…";
    audio.hidden = false;
    audio.src = source.href;
    audio.load();
    pollTiming(metadata.href, run);
    audio.play().catch(() => { if (run === revision) failed(); });
  }

  button.addEventListener("click", playAzure);
  voice.addEventListener("change", () => {
    const resume = !!audio.getAttribute("src") && (!audio.paused || button.disabled);
    stopAzureAudio();
    status.textContent = "Voice changed. Press Play Azure audio to listen.";
    if (resume) playAzure();
  });

  audio.addEventListener("playing", () => {
    button.hidden = true;
    button.disabled = false;
    status.textContent = "Playing shared analysis with Azure narration.";
    highlightFromTiming();
  });

  audio.addEventListener("pause", () => {
    highlightFromTiming();
    if (!audio.error && audio.currentTime > 0 && !audio.ended) status.textContent = "Paused. Press play to continue.";
  });

  for (const event of ["timeupdate", "seeking", "seeked"]) {
    audio.addEventListener(event, highlightFromTiming);
  }

  audio.addEventListener("ended", () => {
    highlightFromTiming();
    status.textContent = "End of analysis. Press play to listen again.";
  });

  audio.addEventListener("error", failed);
  window.addEventListener("pagehide", () => {
    clearTimeout(timer);
    revision++;
    stopBrowserSpeech();
  });

  fetch(`${audio.dataset.src}/voices`, { signal: AbortSignal.timeout(10000) })
    .then(response => {
      if (!response.ok) throw new Error("Voices unavailable");
      return response.json();
    })
    .then(catalog => {
      azureAvailable = Array.isArray(catalog.voices) && catalog.voices.length > 0;
      voice.replaceChildren();
      for (const item of catalog.voices || []) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = `${item.name} · ${item.language} · ${item.gender}`;
        voice.append(option);
      }
      if (catalog.selected) voice.value = catalog.selected;
      voice.disabled = !azureAvailable;
      if (azureAvailable) button.textContent = "Play Azure audio";
    })
    .catch(() => {
      azureAvailable = false;
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Browser speech fallback ready";
      voice.replaceChildren(option);
      voice.disabled = true;
      button.textContent = "Read aloud (browser)";
    });
})();
