import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { updateInstalledAppBadge } from "../app/app-badge";
import { prepareProfilePhoto } from "../app/profile-photo";
import NewsDashboard, { type ArticleHistoryPage, type ArticleStore, type NewsPreferences, type NewsSummary, type PreferencesStore, type PushNotificationStore, type PushSubscriptionPayload, type TopicBriefing, type TopicRefreshStore } from "../app/NewsDashboard";

type SessionUser = {
  email: string;
  displayName: string;
  profilePhotoUrl: string | null;
};

type EmailDeliveryStatus = {
  mode: "gmailOAuth" | "localFile" | "smtp";
  connected: boolean;
  email: string | null;
};

type AuthView = "login" | "register" | "forgot" | "reset" | "resend";

let csrfToken = "";

async function getCsrfToken(force = false) {
  if (csrfToken && !force) return csrfToken;
  const response = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("Could not start a secure session. Refresh and try again.");
  const data = await response.json() as { token: string };
  csrfToken = data.token;
  return csrfToken;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const token = await getCsrfToken();
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-XSRF-TOKEN": token,
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({})) as { error?: string; detail?: string };
  if (!response.ok) throw new Error(data.error || data.detail || "The request could not be completed.");
  return data as T;
}

async function postForm<T>(path: string, body: FormData): Promise<T> {
  const token = await getCsrfToken();
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-XSRF-TOKEN": token },
    body,
  });
  const data = await response.json().catch(() => ({})) as { error?: string; detail?: string };
  if (!response.ok) throw new Error(data.error || data.detail || "The upload could not be completed.");
  return data as T;
}

async function deleteJson<T>(path: string, body?: unknown): Promise<T> {
  const token = await getCsrfToken();
  const response = await fetch(path, {
    method: "DELETE",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-XSRF-TOKEN": token,
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({})) as { error?: string; detail?: string };
  if (!response.ok) throw new Error(data.error || data.detail || "The request could not be completed.");
  return data as T;
}

const sqlitePreferencesStore: PreferencesStore = {
  async load() {
    const response = await fetch("/api/preferences", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as {
      error?: string;
      detail?: string;
      exists: boolean;
      preferences: NewsPreferences;
    };
    if (!response.ok) throw new Error(data.error || data.detail || "Could not load your saved settings.");
    return { exists: data.exists, preferences: data.preferences };
  },
  async save(preferences) {
    const data = await postJson<{ preferences: NewsPreferences }>("/api/preferences", preferences);
    return data.preferences;
  },
  async resolveFeed(feed, existingFeeds) {
    return postJson<{
      feed: string;
      added: boolean;
      duplicateOf: string | null;
      feeds: string[];
    }>("/api/preferences/rss-feed", { feed, existingFeeds });
  },
};

const sqliteArticleStore: ArticleStore = {
  async load(query = {}) {
    const params = new URLSearchParams({
      offset: String(query.offset ?? 0),
      limit: String(query.limit ?? 50),
    });
    if (query.search) params.set("search", query.search);
    if (query.bookmarksOnly) params.set("bookmarksOnly", "true");
    if (query.topic) params.set("topic", query.topic);
    if (query.provider) params.set("provider", query.provider);
    const response = await fetch(`/api/articles?${params.toString()}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as Partial<ArticleHistoryPage> & {
      error?: string;
      detail?: string;
    };
    if (!response.ok) throw new Error(data.error || data.detail || "Could not load article history.");
    return data as ArticleHistoryPage;
  },
  async sync(articles) {
    return postJson<ArticleHistoryPage>("/api/articles/sync", { articles: articles.slice(0, 500) });
  },
  async setBookmark(url, bookmarked) {
    await postJson("/api/articles/bookmark", { url, bookmarked });
  },
  async setRead(url) {
    await postJson("/api/articles/read", { url });
  },
};

const sqliteTopicRefreshStore: TopicRefreshStore = {
  async load(topic) {
    const params = new URLSearchParams();
    if (topic) params.set("topic", topic);
    const response = await fetch(`/api/topic-refresh${params.size > 0 ? `?${params.toString()}` : ""}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as TopicBriefing & {
      error?: string;
      detail?: string;
    };
    if (!response.ok) throw new Error(data.error || data.detail || "Could not load the current briefing.");
    return data;
  },
  async refresh(topic) {
    return postJson<TopicBriefing>("/api/topic-refresh", { topic: topic ?? null });
  },
  async markViewed(topic) {
    await postJson("/api/topic-refresh/viewed", { topic });
  },
};

const webPushNotificationStore: PushNotificationStore = {
  async getPublicKey() {
    const response = await fetch("/api/push/public-key", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as {
      publicKey?: string;
      error?: string;
      detail?: string;
    };
    if (!response.ok || !data.publicKey)
      throw new Error(data.error || data.detail || "Could not start phone notifications.");
    return data.publicKey;
  },
  async subscribe(subscription: PushSubscriptionPayload) {
    await postJson("/api/push/subscription", subscription);
  },
  async unsubscribe(endpoint: string) {
    await deleteJson("/api/push/subscription", { endpoint });
  },
  async sendTest() {
    const data = await postJson<{ message: string }>("/api/push/test");
    return data.message;
  },
};

async function sendNewsSummary(summary: NewsSummary) {
  const data = await postJson<{ message: string }>("/api/news-summary", summary);
  return data.message;
}

export default function AuthApp() {
  const query = new URLSearchParams(window.location.search);
  const initialAuth = query.get("auth");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [view, setView] = useState<AuthView>(initialAuth === "reset" ? "reset" : "login");
  const [notice, setNotice] = useState(() => {
    if (initialAuth === "confirmed") return "Your email is confirmed. You can sign in now.";
    if (initialAuth === "confirmation-failed") return "That confirmation link is invalid or expired.";
    return "";
  });
  const [accountOpen, setAccountOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let currentVersion = "";

    async function checkVersion() {
      try {
        const response = await fetch("/api/app-version", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok || cancelled) return;
        const data = await response.json() as { version?: string };
        if (!data.version) return;
        if (!currentVersion) {
          currentVersion = data.version;
        } else if (data.version !== currentVersion) {
          window.location.reload();
        }
      } catch {
        // A temporary network gap should not interrupt the active briefing.
      }
    }

    void checkVersion();
    const interval = window.setInterval(() => void checkVersion(), 60_000);
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, []);

  useEffect(() => {
    void fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (response.ok) {
          setUser(await response.json() as SessionUser);
        } else {
          void updateInstalledAppBadge(0);
        }
      })
      .finally(() => setCheckingSession(false));
  }, []);

  async function signOut() {
    try {
      if ("serviceWorker" in navigator) {
        try {
          const registration = await navigator.serviceWorker.ready;
          const subscription = await registration.pushManager.getSubscription();
          if (subscription) {
            await webPushNotificationStore.unsubscribe(subscription.endpoint);
            await subscription.unsubscribe();
          }
        } catch {
          // Signing out should continue even if the push service is unavailable.
        }
      }
      await postJson<void>("/api/auth/logout");
    } finally {
      csrfToken = "";
      void updateInstalledAppBadge(0);
      setUser(null);
      setAccountOpen(false);
      setNotice("You’re signed out.");
      setView("login");
      window.history.replaceState({}, "", "/");
    }
  }

  if (checkingSession) return <AuthLoading />;

  if (user && initialAuth !== "reset") {
    return (
      <>
        <NewsDashboard
          user={{ displayName: user.displayName, email: user.email, fullName: null, isLocalPreview: false, profilePhotoUrl: user.profilePhotoUrl }}
          onSignOut={() => void signOut()}
          onManageAccount={() => setAccountOpen(true)}
          preferencesStore={sqlitePreferencesStore}
          articleStore={sqliteArticleStore}
          summarySender={sendNewsSummary}
          refreshStore={sqliteTopicRefreshStore}
          pushNotificationStore={webPushNotificationStore}
        />
        {accountOpen && (
          <AccountPanel
            user={user}
            onUserUpdated={setUser}
            onClose={() => setAccountOpen(false)}
            onSignedOut={() => void signOut()}
          />
        )}
      </>
    );
  }

  return (
    <AuthScreen
      view={view}
      notice={notice}
      resetEmail={query.get("email") ?? ""}
      resetCode={query.get("code") ?? ""}
      onViewChange={(next) => { setView(next); setNotice(""); }}
      onNotice={setNotice}
      onSignedIn={(nextUser) => {
        csrfToken = "";
        setUser(nextUser);
        setNotice("");
        window.history.replaceState({}, "", "/");
      }}
    />
  );
}

function AuthLoading() {
  return (
    <main className="auth-shell auth-loading" aria-label="Checking your session">
      <span className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>SIGNAL</span>
      <span className="auth-spinner" aria-hidden="true" />
    </main>
  );
}

type AuthScreenProps = {
  view: AuthView;
  notice: string;
  resetEmail: string;
  resetCode: string;
  onViewChange: (view: AuthView) => void;
  onNotice: (message: string) => void;
  onSignedIn: (user: SessionUser) => void;
};

function AuthScreen(props: AuthScreenProps) {
  return (
    <main className="auth-shell">
      <section className="auth-intro">
        <a className="brand" href="/" aria-label="Signal home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          SIGNAL
        </a>
        <div>
          <p className="eyebrow">Your interests, continuously monitored</p>
          <h1>Stay current on<br /><em>what matters.</em></h1>
          <p>Build one private briefing from the topics and publishers you trust.</p>
        </div>
        <p className="auth-security-note"><span className="pulse" />Secure email account access</p>
      </section>
      <section className="auth-card" aria-live="polite">
        {props.notice && <p className="auth-notice" role="status">{props.notice}</p>}
        {props.view === "login" && <LoginForm {...props} />}
        {props.view === "register" && <RegisterForm {...props} />}
        {props.view === "forgot" && <EmailActionForm {...props} mode="forgot" />}
        {props.view === "resend" && <EmailActionForm {...props} mode="resend" />}
        {props.view === "reset" && <ResetPasswordForm {...props} />}
      </section>
    </main>
  );
}

function LoginForm({ onSignedIn, onViewChange, onNotice }: AuthScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); onNotice("");
    try {
      const user = await postJson<SessionUser>("/api/auth/login", { email, password, rememberMe });
      onSignedIn(user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.");
    } finally { setBusy(false); }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <AuthHeading kicker="Welcome back" title="Sign in to Signal" />
      <AuthError message={error} />
      <AuthInput label="Email address" type="email" value={email} onChange={setEmail} autoComplete="email" />
      <AuthInput label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
      <label className="auth-checkbox"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />Keep me signed in</label>
      <button className="auth-submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <div className="auth-links">
        <button type="button" onClick={() => onViewChange("forgot")}>Forgot password?</button>
        <button type="button" onClick={() => onViewChange("resend")}>Resend confirmation</button>
      </div>
      <p className="auth-switch">New to Signal? <button type="button" onClick={() => onViewChange("register")}>Create an account</button></p>
    </form>
  );
}

function RegisterForm({ onViewChange, onNotice }: AuthScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirmPassword) { setError("The passwords do not match."); return; }
    setBusy(true); setError("");
    try {
      const result = await postJson<{ message: string }>("/api/auth/register", { email, password });
      onNotice(result.message); onViewChange("login");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the account.");
    } finally { setBusy(false); }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <AuthHeading kicker="Start your briefing" title="Create an account" />
      <AuthError message={error} />
      <AuthInput label="Email address" type="email" value={email} onChange={setEmail} autoComplete="email" />
      <AuthInput label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" minLength={12} />
      <AuthInput label="Confirm password" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" minLength={12} />
      <p className="password-hint">Use at least 12 characters with uppercase, lowercase, a number and a symbol.</p>
      <button className="auth-submit" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
      <p className="auth-switch">Already registered? <button type="button" onClick={() => onViewChange("login")}>Sign in</button></p>
    </form>
  );
}

function EmailActionForm(props: AuthScreenProps & { mode: "forgot" | "resend" }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isReset = props.mode === "forgot";

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await postJson<{ message: string }>(
        isReset ? "/api/auth/forgot-password" : "/api/auth/resend-confirmation",
        { email },
      );
      props.onNotice(result.message); props.onViewChange("login");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the email.");
    } finally { setBusy(false); }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <AuthHeading kicker="Account recovery" title={isReset ? "Reset your password" : "Confirm your email"} />
      <p className="auth-explainer">{isReset ? "We’ll email a secure password-reset link if the account exists." : "We’ll send a fresh confirmation link if the account is waiting for one."}</p>
      <AuthError message={error} />
      <AuthInput label="Email address" type="email" value={email} onChange={setEmail} autoComplete="email" />
      <button className="auth-submit" disabled={busy}>{busy ? "Sending…" : "Send email"}</button>
      <p className="auth-switch"><button type="button" onClick={() => props.onViewChange("login")}>Back to sign in</button></p>
    </form>
  );
}

function ResetPasswordForm(props: AuthScreenProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!props.resetEmail || !props.resetCode) { setError("This password-reset link is incomplete."); return; }
    if (password !== confirmPassword) { setError("The passwords do not match."); return; }
    setBusy(true); setError("");
    try {
      const result = await postJson<{ message: string }>("/api/auth/reset-password", {
        email: props.resetEmail, code: props.resetCode, newPassword: password,
      });
      props.onNotice(result.message); props.onViewChange("login"); window.history.replaceState({}, "", "/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reset the password.");
    } finally { setBusy(false); }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <AuthHeading kicker="Secure account recovery" title="Choose a new password" />
      <AuthError message={error} />
      <AuthInput label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" minLength={12} />
      <AuthInput label="Confirm new password" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" minLength={12} />
      <p className="password-hint">Use at least 12 characters with uppercase, lowercase, a number and a symbol.</p>
      <button className="auth-submit" disabled={busy}>{busy ? "Resetting…" : "Reset password"}</button>
    </form>
  );
}

function AccountPanel({
  user,
  onUserUpdated,
  onClose,
  onSignedOut,
}: {
  user: SessionUser;
  onUserUpdated: (user: SessionUser) => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMessage, setPhotoMessage] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [delivery, setDelivery] = useState<EmailDeliveryStatus | null>(null);

  useEffect(() => {
    void fetch("/api/email/status", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (response.ok) setDelivery(await response.json() as EmailDeliveryStatus);
      });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) { setError("The new passwords do not match."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await postJson<{ message: string }>("/api/auth/change-password", { currentPassword, newPassword });
      setMessage(result.message); setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the password.");
    } finally { setBusy(false); }
  }

  async function selectProfilePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setPhotoBusy(true);
    setPhotoMessage("");
    setPhotoError("");
    try {
      const photo = await prepareProfilePhoto(file);
      const form = new FormData();
      form.append("photo", photo, "profile-photo.jpg");
      const result = await postForm<{ profilePhotoUrl: string }>("/api/auth/profile-photo", form);
      onUserUpdated({ ...user, profilePhotoUrl: result.profilePhotoUrl });
      setPhotoMessage("Your profile picture has been updated.");
    } catch (caught) {
      setPhotoError(caught instanceof Error ? caught.message : "The profile picture could not be updated.");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removeProfilePhoto() {
    setPhotoBusy(true);
    setPhotoMessage("");
    setPhotoError("");
    try {
      await deleteJson("/api/auth/profile-photo");
      onUserUpdated({ ...user, profilePhotoUrl: null });
      setPhotoMessage("Your profile picture has been removed.");
    } catch (caught) {
      setPhotoError(caught instanceof Error ? caught.message : "The profile picture could not be removed.");
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <div className="account-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="account-panel" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <button className="account-close" type="button" onClick={onClose} aria-label="Close account settings">×</button>
        <p className="eyebrow">Account settings</p>
        <h2 id="account-title">Your Signal account</h2>
        <p className="account-email">Signed in as <strong>{user.email}</strong></p>
        <section className="account-photo-settings" aria-labelledby="profile-photo-title">
          <span className="account-photo-preview" aria-hidden="true">
            {user.profilePhotoUrl
              ? <img src={user.profilePhotoUrl} alt="" />
              : user.displayName.charAt(0).toUpperCase()}
          </span>
          <div>
            <h3 id="profile-photo-title">Profile picture</h3>
            <p>Take a photo or choose one from this device. Signal crops and resizes it before upload.</p>
            <div className="account-photo-actions">
              <label className={photoBusy ? "account-photo-action busy" : "account-photo-action"}>
                Take photo
                <input
                  className="account-photo-input"
                  type="file"
                  accept="image/*"
                  capture="user"
                  disabled={photoBusy}
                  onChange={(event) => void selectProfilePhoto(event)}
                />
              </label>
              <label className={photoBusy ? "account-photo-action busy" : "account-photo-action"}>
                Choose photo
                <input
                  className="account-photo-input"
                  type="file"
                  accept="image/*"
                  disabled={photoBusy}
                  onChange={(event) => void selectProfilePhoto(event)}
                />
              </label>
              {user.profilePhotoUrl && (
                <button type="button" disabled={photoBusy} onClick={() => void removeProfilePhoto()}>Remove</button>
              )}
            </div>
            {photoBusy && <p className="account-photo-status" role="status">Preparing photo…</p>}
            {photoMessage && <p className="account-photo-status success" role="status">{photoMessage}</p>}
            {photoError && <p className="account-photo-status error" role="alert">{photoError}</p>}
          </div>
        </section>
        <div className="email-delivery" aria-live="polite">
          <span className={delivery?.connected ? "delivery-dot connected" : "delivery-dot"} aria-hidden="true" />
          <div>
            <strong>{delivery?.connected ? "Gmail API connected" : "Local email delivery"}</strong>
            <p>{delivery?.connected && delivery.email
              ? `Account emails are sent securely through ${delivery.email}.`
              : "Account emails are currently written to Signal's local mail-drop."}</p>
          </div>
        </div>
        <form className="auth-form compact" onSubmit={submit}>
          <h3>Change password</h3>
          {message && <p className="auth-notice" role="status">{message}</p>}
          <AuthError message={error} />
          <AuthInput label="Current password" type="password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
          <AuthInput label="New password" type="password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" minLength={12} />
          <AuthInput label="Confirm new password" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" minLength={12} />
          <button className="auth-submit" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
        </form>
        <button className="account-signout" type="button" onClick={onSignedOut}>Sign out of Signal</button>
      </section>
    </div>
  );
}

function AuthHeading({ kicker, title }: { kicker: string; title: string }) {
  return <header className="auth-heading"><p>{kicker}</p><h2>{title}</h2></header>;
}

function AuthError({ message }: { message: string }) {
  return message ? <p className="auth-error" role="alert">{message}</p> : null;
}

type AuthInputProps = {
  label: string;
  type: "email" | "password";
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  minLength?: number;
};

function AuthInput({ label, type, value, onChange, autoComplete, minLength }: AuthInputProps) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} minLength={minLength} maxLength={type === "email" ? 254 : 128} required />
    </label>
  );
}
