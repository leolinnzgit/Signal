const account = document.querySelector("#account");
const signin = document.querySelector("#signin");
const approve = document.querySelector("#approve");
const code = document.querySelector("#code");
const result = document.querySelector("#result");
let authenticated = false;
let submitting = false;
const parameters = new URL(location.href).searchParams;
const phone = parameters.get("device") === "phone";
const initial = parameters.get("code") || "";
if (phone) {
  document.querySelector("h1").textContent = "Connect your phone companion.";
  document.querySelector("h1 + p").textContent = "Approve the code shown in the Signal phone companion. It will keep phone news alerts working and hand them to SignalWatch when your watch is ready.";
  document.querySelector('label[for="code"]').textContent = "Code displayed in your phone companion";
  approve.textContent = "Approve this phone companion";
  const label = document.createElement("label");
  label.innerHTML = '<input id="replace-browser" type="checkbox" checked> Use the phone companion for news alerts from this browser. Other devices and disaster alerts keep their existing delivery.';
  approve.before(label);
}
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
    let browserEndpoint = null;
    if (phone && document.querySelector("#replace-browser").checked) {
      const registration = await navigator.serviceWorker?.getRegistration("/");
      browserEndpoint = (await registration?.pushManager.getSubscription())?.endpoint || null;
      if (!browserEndpoint) throw new Error("Open this link in the browser where this phone receives Signal news alerts. If you do not use browser alerts, untick the checkbox and approve again.");
    }
    const response = await fetch("/api/watch/pairing/approve", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
      body: JSON.stringify({ code: normalized, browserEndpoint })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not approve this code. Sign in again or start a new connection on your watch.");
    result.textContent = phone ? "Phone companion approved. Return to the app to finish enabling notifications. Browser alerts remain active until the companion confirms delivery." : "Watch approved. Your watch will connect in a few seconds.";
    document.querySelector("#approval").hidden = true;
  } catch (error) {
    result.textContent = error.message;
    result.classList.add("error");
    submitting = false; approve.disabled = !authenticated;
  }
});
checkSignIn();
