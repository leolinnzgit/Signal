const account = document.querySelector("#account");
const signin = document.querySelector("#signin");
const approve = document.querySelector("#approve");
const code = document.querySelector("#code");
const result = document.querySelector("#result");
let authenticated = false;
let submitting = false;
const initial = new URL(location.href).searchParams.get("code") || "";
code.value = initial.replace(/[^A-Z2-9]/gi, "").slice(0, 8).toUpperCase().replace(/^(.{4})(.+)$/, "$1-$2");
history.replaceState(null, "", location.pathname);
async function checkSignIn() {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Sign in to Signal to approve your watch.");
    const user = await response.json();
    authenticated = true;
    account.textContent = "Approve as " + user.email;
    signin.hidden = true;
  } catch {
    authenticated = false;
    account.textContent = "Sign in to Signal to approve your watch.";
    signin.hidden = false;
  }
  approve.disabled = !authenticated || submitting;
}
document.querySelector("#recheck").addEventListener("click", checkSignIn);
document.querySelector("#approval").addEventListener("submit", async event => {
  event.preventDefault();
  if (!authenticated || submitting) return;
  const normalized = code.value.replace(/[^A-Z2-9]/gi, "").toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(normalized)) { result.textContent = "Enter the eight characters displayed on your watch."; return; }
  submitting = true; approve.disabled = true; result.textContent = "Approving your watch…";
  try {
    const csrf = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
    if (!csrf.ok) throw new Error("Sign in again, then retry.");
    const token = (await csrf.json()).token;
    if (!token) throw new Error("Sign in again, then retry.");
    const response = await fetch("/api/watch/pairing/approve", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
      body: JSON.stringify({ code: normalized })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not approve this code. Sign in again or start a new connection on your watch.");
    result.textContent = "Watch approved. Your watch will connect in a few seconds.";
    document.querySelector("#approval").hidden = true;
  } catch (error) {
    result.textContent = error.message;
    result.classList.add("error");
    submitting = false; approve.disabled = !authenticated;
  }
});
checkSignIn();
