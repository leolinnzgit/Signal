(() => {
  const section = document.getElementById("story-comments");
  if (!section) return;
  const endpoint = section.dataset.endpoint;
  const home = section.dataset.home;
  const list = document.getElementById("comment-list");
  const form = document.getElementById("comment-form");
  const body = document.getElementById("comment-body");
  const submit = document.getElementById("comment-submit");
  const status = document.getElementById("comment-status");
  const older = document.getElementById("comments-older");
  const refresh = document.getElementById("comments-refresh");
  const count = document.getElementById("comment-count");
  let firstId;
  let total = 0;
  let busy = false;

  async function read(response) {
    if (response.status === 429) throw new Error("Too many requests. Please wait a minute and try again.");
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "Comments are unavailable right now. Please try again.");
    }
    return response.json();
  }

  function render(comment) {
    const item = document.createElement("li");
    const header = document.createElement("div");
    header.className = "comment-meta";
    const name = document.createElement("strong");
    name.textContent = "Anonymous";
    const time = document.createElement("time");
    time.dateTime = comment.createdAt;
    time.textContent = new Date(comment.createdAt).toLocaleString();
    const text = document.createElement("p");
    text.dir = "auto";
    text.textContent = comment.body;
    header.append(name, time);
    item.append(header, text);
    return item;
  }

  function updateCount() {
    count.textContent = `${total} ${total === 1 ? "comment" : "comments"}`;
  }

  async function load(previous = false) {
    if (busy) return;
    busy = true;
    older.disabled = refresh.disabled = submit.disabled = true;
    status.textContent = "Loading comments…";
    try {
      const page = await read(await fetch(endpoint + (previous ? `?beforeId=${firstId}` : ""), { credentials: "same-origin", cache: "no-store" }));
      if (!previous) list.replaceChildren();
      const items = page.comments.map(render);
      if (previous) list.prepend(...items); else list.append(...items);
      firstId = page.comments[0]?.id ?? firstId;
      total = page.total;
      older.hidden = !page.hasMore;
      updateCount();
      status.textContent = total ? "" : "No comments yet. Be the first to comment.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      older.disabled = refresh.disabled = submit.disabled = false;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!body.value.trim()) {
      status.textContent = "Write a comment first.";
      body.focus();
      return;
    }
    busy = true;
    submit.disabled = older.disabled = refresh.disabled = true;
    body.readOnly = true;
    status.textContent = "Posting comment…";
    try {
      const csrf = await read(await fetch(`${home}api/auth/csrf`, { credentials: "same-origin", cache: "no-store" }));
      if (!csrf.token) throw new Error("Please refresh this page before posting your comment.");
      const comment = await read(await fetch(endpoint, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": csrf.token },
        body: JSON.stringify({ body: body.value.trim() }),
      }));
      list.append(render(comment));
      firstId ??= comment.id;
      total++;
      updateCount();
      body.value = "";
      status.textContent = "Comment posted anonymously. It also appears with this story in Signal.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      body.readOnly = false;
      submit.disabled = older.disabled = refresh.disabled = false;
    }
  });
  older.addEventListener("click", () => void load(true));
  refresh.addEventListener("click", () => void load());
  void load();
})();
