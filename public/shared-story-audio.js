(() => {
  const audio = document.getElementById("story-audio");
  const button = document.getElementById("listen-button");
  const status = document.getElementById("audio-status");
  if (!audio || !button || !status) return;

  function failed() {
    button.hidden = false;
    button.disabled = false;
    button.textContent = "Try audio again";
    status.textContent = "Audio could not be loaded. Please try again shortly.";
  }
  button.addEventListener("click", () => {
    button.disabled = true;
    status.textContent = "Preparing Azure audio…";
    audio.hidden = false;
    audio.src = audio.dataset.src;
    audio.load();
    audio.play().catch(failed);
  });
  audio.addEventListener("playing", () => {
    button.hidden = true;
    button.disabled = false;
    status.textContent = "Playing the saved story with Azure narration.";
  });
  audio.addEventListener("pause", () => {
    if (!audio.error && audio.currentTime > 0 && !audio.ended) status.textContent = "Paused. Press play to continue.";
  });
  audio.addEventListener("ended", () => { status.textContent = "End of story. Press play to listen again."; });
  audio.addEventListener("error", failed);
})();
