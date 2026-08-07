import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { updateInstalledAppBadge } from "../app/app-badge";
import { prepareProfilePhoto } from "../app/profile-photo";
import NewsDashboard, { type ArticleHistoryPage, type ArticleStore, type FollowedArticle, type NewsPreferences, type NewsSummary, type PreferencesStore, type PushNotificationStore, type PushSubscriptionPayload, type TopicBriefing, type TopicRefreshStore } from "../app/NewsDashboard";

type SessionUser = {
  email: string;
  displayName: string;
  profilePhotoUrl: string | null;
  googleConnected: boolean;
  hasPassword: boolean;
};

type EmailDeliveryStatus = {
  mode: "gmailOAuth" | "localFile" | "smtp";
  connected: boolean;
  email: string | null;
};

type CommentAuthor = {
  userId: string;
  name: string;
  profilePhotoUrl: string;
};

type NewsComment = {
  id: number;
  articleUrl: string;
  articleTitle: string;
  body: string;
  createdAt: string;
  author: CommentAuthor;
  canDelete: boolean;
  friendshipState: "self" | "none" | "outgoing" | "incoming" | "friends";
};

type CommentPage = {
  comments: NewsComment[];
  total: number;
  hasMore: boolean;
};

type LatestCommentsPage = { comments: NewsComment[]; newCount: number };
type DiscussionArticle = Pick<FollowedArticle, "url" | "title" | "source">;

type SocialUser = {
  userId: string;
  name: string;
  profilePhotoUrl: string;
  unreadMessages: number;
  isOnline: boolean;
  lastSeenAt: string | null;
};

type FriendSummary = { relationshipId: number; user: SocialUser };
type FriendRequestSummary = { relationshipId: number; user: SocialUser; createdAt: string };

type SocialOverview = {
  friends: FriendSummary[];
  incomingRequests: FriendRequestSummary[];
  outgoingRequests: FriendRequestSummary[];
  unreadMessages: number;
};

type UserSearchResult = {
  user: SocialUser;
  friendshipState: "none" | "outgoing" | "incoming" | "friends";
  relationshipId: number | null;
};

type FriendActionResult = {
  relationshipId: number;
  friendshipState: "none" | "outgoing" | "incoming" | "friends";
  message: string;
};

type DirectMessage = {
  id: number;
  body: string;
  createdAt: string;
  readAt: string | null;
  isMine: boolean;
};

type MessagePage = { messages: DirectMessage[]; hasMore: boolean };

const CHAT_EMOJIS = [
  "😀", "😂", "😊", "😍", "🥳", "😎", "🤔", "😢",
  "😮", "😡", "👍", "👎", "👏", "🙌", "🙏", "💪",
  "❤️", "💯", "🔥", "✨", "🎉", "✅", "👀", "💬",
  "☕", "🌏", "📰", "🚀", "🤖", "📈", "💡", "🤣",
];

let messageAudioContext: AudioContext | null = null;
let lastMessageToneAt = 0;

function unlockMessageAudio() {
  const AudioContextType = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextType) return;
  messageAudioContext ??= new AudioContextType();
  if (messageAudioContext.state === "suspended") void messageAudioContext.resume();
}

function playMessageTone() {
  const context = messageAudioContext;
  if (!context || context.state !== "running") return;
  const now = Date.now();
  if (now - lastMessageToneAt < 10_000) return;
  lastMessageToneAt = now;
  const start = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.16, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
  gain.connect(context.destination);

  const first = context.createOscillator();
  first.type = "sine";
  first.frequency.setValueAtTime(659.25, start);
  first.connect(gain);
  first.start(start);
  first.stop(start + 0.15);

  const second = context.createOscillator();
  second.type = "sine";
  second.frequency.setValueAtTime(880, start + 0.16);
  second.connect(gain);
  second.start(start + 0.16);
  second.stop(start + 0.34);
}

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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  const data = await response.json().catch(() => ({})) as { error?: string; detail?: string };
  if (!response.ok) throw new Error(data.error || data.detail || "The request could not be completed.");
  return data as T;
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

async function putJson<T>(path: string, body?: unknown): Promise<T> {
  const token = await getCsrfToken();
  const response = await fetch(path, {
    method: "PUT",
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
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [view, setView] = useState<AuthView>(initialAuth === "reset" ? "reset" : "login");
  const [notice, setNotice] = useState(() => {
    if (initialAuth === "confirmed") return "Your email is confirmed. You can sign in now.";
    if (initialAuth === "confirmation-failed") return "That confirmation link is invalid or expired.";
    if (initialAuth === "google-existing") return "This email already has a Signal account. Sign in with your password, then connect Google in Account settings.";
    if (initialAuth === "google-unverified") return "Google did not provide a verified email address.";
    if (initialAuth === "google-locked") return "This account is temporarily locked. Try again later.";
    if (initialAuth === "google-error") return "Google sign-in could not be completed. Please try again.";
    return "";
  });
  const [accountOpen, setAccountOpen] = useState(initialAuth?.startsWith("google-") === true);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [latestCommentsOpen, setLatestCommentsOpen] = useState(false);
  const [latestComments, setLatestComments] = useState<NewsComment[]>([]);
  const [latestCommentUnread, setLatestCommentUnread] = useState(0);
  const [discussionArticle, setDiscussionArticle] = useState<DiscussionArticle | null>(null);
  const [socialUnread, setSocialUnread] = useState(0);
  const lastSeenCommentId = useRef(0);
  const latestCommentsOpenRef = useRef(false);
  const socialUnreadRef = useRef(0);
  const socialSummaryInitialized = useRef(false);

  useEffect(() => { latestCommentsOpenRef.current = latestCommentsOpen; }, [latestCommentsOpen]);

  useEffect(() => {
    if (!user) return;
    const unlock = () => unlockMessageAudio();
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, [user]);

  function updateSocialUnread(count: number) {
    if (socialSummaryInitialized.current && count > socialUnreadRef.current) playMessageTone();
    socialUnreadRef.current = count;
    socialSummaryInitialized.current = true;
    setSocialUnread(count);
  }

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
    if (!user) {
      setSocialUnread(0);
      socialUnreadRef.current = 0;
      socialSummaryInitialized.current = false;
      return;
    }
    let cancelled = false;
    async function loadSocialSummary() {
      try {
        const overview = await getJson<SocialOverview>("/api/social");
        if (!cancelled) updateSocialUnread(overview.unreadMessages);
      } catch {
        // Social availability should not interrupt the news briefing.
      }
    }
    void loadSocialSummary();
    const interval = window.setInterval(() => void loadSocialSummary(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [user]);

  useEffect(() => {
    if (!user) {
      setLatestComments([]);
      setLatestCommentUnread(0);
      lastSeenCommentId.current = 0;
      return;
    }
    let cancelled = false;
    async function loadLatestComments() {
      try {
        const params = new URLSearchParams({ limit: "12" });
        if (lastSeenCommentId.current > 0) params.set("afterId", String(lastSeenCommentId.current));
        const page = await getJson<LatestCommentsPage>(`/api/comments/latest?${params.toString()}`);
        if (cancelled) return;
        setLatestComments(page.comments);
        const newestId = page.comments[0]?.id ?? lastSeenCommentId.current;
        if (lastSeenCommentId.current === 0 || latestCommentsOpenRef.current) {
          lastSeenCommentId.current = newestId;
          setLatestCommentUnread(0);
        } else {
          setLatestCommentUnread(page.newCount);
        }
      } catch {
        // Comment activity should not interrupt the main briefing.
      }
    }
    void loadLatestComments();
    const interval = window.setInterval(() => void loadLatestComments(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [user]);

  function openLatestComments() {
    setAccountOpen(false);
    setCommunityOpen(false);
    setDiscussionArticle(null);
    setLatestCommentsOpen(true);
    latestCommentsOpenRef.current = true;
    lastSeenCommentId.current = latestComments[0]?.id ?? lastSeenCommentId.current;
    setLatestCommentUnread(0);
  }

  useEffect(() => {
    void fetch("/api/auth/providers", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (response.ok) {
          const providers = await response.json() as { google?: boolean };
          setGoogleAvailable(providers.google === true);
        }
      });

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
      try { await deleteJson<void>("/api/social/presence"); } catch { /* Presence will expire automatically. */ }
      await postJson<void>("/api/auth/logout");
    } finally {
      csrfToken = "";
      void updateInstalledAppBadge(0);
      setUser(null);
      setAccountOpen(false);
      setCommunityOpen(false);
      setLatestCommentsOpen(false);
      setLatestComments([]);
      setLatestCommentUnread(0);
      setDiscussionArticle(null);
      setSocialUnread(0);
      socialUnreadRef.current = 0;
      socialSummaryInitialized.current = false;
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
          onManageAccount={() => { setCommunityOpen(false); setLatestCommentsOpen(false); setDiscussionArticle(null); setAccountOpen(true); }}
          onOpenCommunity={() => { setAccountOpen(false); setLatestCommentsOpen(false); setDiscussionArticle(null); setCommunityOpen(true); }}
          onOpenLatestComments={openLatestComments}
          onOpenDiscussion={(article) => { setAccountOpen(false); setCommunityOpen(false); setLatestCommentsOpen(false); setDiscussionArticle(article); }}
          communityUnreadCount={socialUnread}
          latestCommentUnreadCount={latestCommentUnread}
          preferencesStore={sqlitePreferencesStore}
          articleStore={sqliteArticleStore}
          summarySender={sendNewsSummary}
          refreshStore={sqliteTopicRefreshStore}
          pushNotificationStore={webPushNotificationStore}
        />
        {accountOpen && (
          <AccountPanel
            user={user}
            googleAvailable={googleAvailable}
            googleStatus={initialAuth}
            onUserUpdated={setUser}
            onClose={() => {
              setAccountOpen(false);
              if (initialAuth?.startsWith("google-")) window.history.replaceState({}, "", "/");
            }}
            onSignedOut={() => void signOut()}
          />
        )}
        {discussionArticle && (
          <DiscussionPanel
            article={discussionArticle}
            onClose={() => setDiscussionArticle(null)}
            onOpenCommunity={() => { setDiscussionArticle(null); setCommunityOpen(true); }}
          />
        )}
        {latestCommentsOpen && (
          <LatestCommentsPanel
            comments={latestComments}
            onClose={() => { setLatestCommentsOpen(false); latestCommentsOpenRef.current = false; }}
            onOpenDiscussion={(comment) => {
              setLatestCommentsOpen(false);
              latestCommentsOpenRef.current = false;
              setDiscussionArticle({ url: comment.articleUrl, title: comment.articleTitle, source: "Signal community" });
            }}
          />
        )}
        {communityOpen && (
          <CommunityPanel
            onClose={() => setCommunityOpen(false)}
            onUnreadChange={updateSocialUnread}
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
      googleAvailable={googleAvailable}
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

function formatSocialTime(value: string) {
  const date = new Date(value);
  const differenceMinutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (differenceMinutes < 1) return "Just now";
  if (differenceMinutes < 60) return `${differenceMinutes}m ago`;
  if (differenceMinutes < 1_440) return `${Math.round(differenceMinutes / 60)}h ago`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function formatPresence(user: SocialUser) {
  if (user.isOnline) return "Online";
  if (!user.lastSeenAt) return "Offline";
  return `Last seen ${formatSocialTime(user.lastSeenAt)}`;
}

function SocialAvatar({
  user,
  showInitial = true,
}: {
  user: { name: string; profilePhotoUrl: string };
  showInitial?: boolean;
}) {
  return (
    <span className="social-avatar" aria-hidden="true">
      {showInitial ? user.name.charAt(0).toUpperCase() : null}
      <img src={user.profilePhotoUrl} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />
    </span>
  );
}

type AuthScreenProps = {
  view: AuthView;
  notice: string;
  resetEmail: string;
  resetCode: string;
  googleAvailable: boolean;
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

function LoginForm({ onSignedIn, onViewChange, onNotice, googleAvailable }: AuthScreenProps) {
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
      {googleAvailable && (
        <>
          <a className="google-signin" href="/api/auth/google">
            <span aria-hidden="true">G</span>
            Continue with Google
          </a>
          <div className="auth-divider"><span>or use your email</span></div>
        </>
      )}
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

function CommunityPanel({
  onClose,
  onUnreadChange,
}: {
  onClose: () => void;
  onUnreadChange: (count: number) => void;
}) {
  const [overview, setOverview] = useState<SocialOverview | null>(null);
  const [selectedFriend, setSelectedFriend] = useState<FriendSummary | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [messagesHaveMore, setMessagesHaveMore] = useState(false);
  const [conversationMinimized, setConversationMinimized] = useState(false);
  const [email, setEmail] = useState("");
  const [searchResult, setSearchResult] = useState<UserSearchResult | null>(null);
  const [messageBody, setMessageBody] = useState("");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const messageInput = useRef<HTMLTextAreaElement | null>(null);
  const latestConversationMessageId = useRef(0);

  async function loadOverview(showLoading = false) {
    if (showLoading) setLoading(true);
    try {
      const next = await getJson<SocialOverview>("/api/social");
      setOverview(next);
      onUnreadChange(next.unreadMessages);
      if (selectedFriend) {
        const refreshed = next.friends.find((friend) => friend.user.userId === selectedFriend.user.userId) ?? null;
        setSelectedFriend(refreshed);
      }
    } catch (caught) {
      if (showLoading) setError(caught instanceof Error ? caught.message : "Friends could not be loaded.");
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function initialLoad() {
      try {
        const next = await getJson<SocialOverview>("/api/social");
        if (!cancelled) {
          setOverview(next);
          onUnreadChange(next.unreadMessages);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Friends could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialLoad();
    const interval = window.setInterval(() => { if (!cancelled) void loadOverview(); }, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  async function loadMessages(friend: FriendSummary, beforeId?: number, quiet = false) {
    if (!quiet) setConversationLoading(true);
    try {
      const params = new URLSearchParams({ friendUserId: friend.user.userId, limit: "50" });
      if (beforeId) params.set("beforeId", String(beforeId));
      const page = await getJson<MessagePage>(`/api/social/messages?${params.toString()}`);
      if (!beforeId) {
        const newestId = page.messages.at(-1)?.id ?? 0;
        if (quiet && latestConversationMessageId.current > 0
          && page.messages.some((message) => message.id > latestConversationMessageId.current && !message.isMine)) {
          playMessageTone();
        }
        latestConversationMessageId.current = newestId;
      }
      setMessages((current) => beforeId ? [...page.messages, ...current] : page.messages);
      setMessagesHaveMore(page.hasMore);
      if (!beforeId) {
        setOverview((current) => current ? {
          ...current,
          unreadMessages: Math.max(0, current.unreadMessages - friend.user.unreadMessages),
          friends: current.friends.map((item) => item.user.userId === friend.user.userId
            ? { ...item, user: { ...item.user, unreadMessages: 0 } }
            : item),
        } : current);
        onUnreadChange(Math.max(0, (overview?.unreadMessages ?? 0) - friend.user.unreadMessages));
      }
    } catch (caught) {
      if (!quiet) setError(caught instanceof Error ? caught.message : "Messages could not be loaded.");
    } finally {
      if (!quiet) setConversationLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedFriend || conversationMinimized) return;
    latestConversationMessageId.current = 0;
    void loadMessages(selectedFriend);
    const interval = window.setInterval(() => void loadMessages(selectedFriend, undefined, true), 8_000);
    return () => window.clearInterval(interval);
  }, [selectedFriend?.user.userId, conversationMinimized]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    setBusy(true); setError(""); setNotice(""); setSearchResult(null);
    try {
      setSearchResult(await getJson<UserSearchResult>(`/api/social/users?email=${encodeURIComponent(email.trim())}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That user could not be found.");
    } finally { setBusy(false); }
  }

  async function requestFriend(userId: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await postJson<FriendActionResult>("/api/social/friends/request", { userId });
      setNotice(result.message);
      setSearchResult((current) => current && current.user.userId === userId
        ? { ...current, friendshipState: result.friendshipState, relationshipId: result.relationshipId }
        : current);
      await loadOverview();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The friend request could not be sent.");
    } finally { setBusy(false); }
  }

  async function acceptFriend(relationshipId: number) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await postJson<FriendActionResult>(`/api/social/friends/${relationshipId}/accept`);
      setNotice(result.message);
      await loadOverview();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The friend request could not be accepted.");
    } finally { setBusy(false); }
  }

  async function removeRelationship(relationshipId: number) {
    setBusy(true); setError(""); setNotice("");
    try {
      await deleteJson(`/api/social/friends/${relationshipId}`);
      setSearchResult((current) => current?.relationshipId === relationshipId
        ? { ...current, friendshipState: "none", relationshipId: null }
        : current);
      setSelectedFriend((current) => {
        if (current?.relationshipId === relationshipId) {
          setConversationMinimized(false);
          return null;
        }
        return current;
      });
      setNotice("Friend request removed.");
      await loadOverview();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That request could not be updated.");
    } finally { setBusy(false); }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!selectedFriend || !messageBody.trim()) return;
    setBusy(true); setError("");
    try {
      const message = await postJson<DirectMessage>("/api/social/messages", {
        recipientUserId: selectedFriend.user.userId,
        body: messageBody,
      });
      setMessages((current) => [...current, message]);
      latestConversationMessageId.current = Math.max(latestConversationMessageId.current, message.id);
      setMessageBody("");
      setEmojiPickerOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your message could not be sent.");
    } finally { setBusy(false); }
  }

  function insertEmoji(emoji: string) {
    const input = messageInput.current;
    const start = input?.selectionStart ?? messageBody.length;
    const end = input?.selectionEnd ?? start;
    const next = `${messageBody.slice(0, start)}${emoji}${messageBody.slice(end)}`;
    if (next.length > 2000) return;
    setMessageBody(next);
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  const activeFriend = selectedFriend
    ? overview?.friends.find((friend) => friend.user.userId === selectedFriend.user.userId) ?? selectedFriend
    : null;

  return (
    <div
      className={selectedFriend
        ? `social-backdrop conversation-floating-backdrop${conversationMinimized ? " conversation-minimized-backdrop" : ""}`
        : "social-backdrop"}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      {activeFriend && conversationMinimized ? (
        <button
          type="button"
          className="conversation-minimized-button"
          onClick={() => setConversationMinimized(false)}
          aria-label={`Restore conversation with ${activeFriend.user.name}`}
          title={`Open conversation with ${activeFriend.user.name}`}
        >
          <SocialAvatar user={activeFriend.user} />
          <span className={activeFriend.user.isOnline ? "conversation-minimized-glyph online" : "conversation-minimized-glyph"} aria-hidden="true">●</span>
          {activeFriend.user.unreadMessages > 0 && (
            <span className="conversation-minimized-unread">{Math.min(activeFriend.user.unreadMessages, 99)}</span>
          )}
        </button>
      ) : (
      <section className="community-panel" role="dialog" aria-modal="true" aria-labelledby="community-title">
        <header className="social-panel-header">
          <div>
            <p className="eyebrow">Signal community</p>
            <h2 id="community-title">{selectedFriend ? selectedFriend.user.name : "Friends & messages"}</h2>
            {activeFriend && (
              <small className={activeFriend.user.isOnline ? "conversation-presence online" : "conversation-presence"}>
                <i aria-hidden="true" />{formatPresence(activeFriend.user)}
              </small>
            )}
          </div>
          <div className="social-panel-controls">
            {selectedFriend && (
              <button className="social-minimize" type="button" onClick={() => { setEmojiPickerOpen(false); setConversationMinimized(true); }} aria-label="Minimize conversation" title="Minimize conversation">−</button>
            )}
            <button className="social-close" type="button" onClick={onClose} aria-label="Close friends and messages">×</button>
          </div>
        </header>
        {selectedFriend ? (
          <div className="conversation-view">
            <button className="conversation-back" type="button" onClick={() => { setEmojiPickerOpen(false); setConversationMinimized(false); setSelectedFriend(null); setMessages([]); }}>← All friends</button>
            {error && <p className="social-error" role="alert">{error}</p>}
            {messagesHaveMore && messages.length > 0 && (
              <button className="social-load-more" type="button" disabled={conversationLoading} onClick={() => void loadMessages(selectedFriend, messages[0].id)}>
                {conversationLoading ? "Loading…" : "Load earlier messages"}
              </button>
            )}
            <ol className="message-list" aria-live="polite">
              {conversationLoading && messages.length === 0 ? (
                <li className="social-empty">Loading messages…</li>
              ) : messages.length === 0 ? (
                <li className="social-empty">No messages yet. Say hello.</li>
              ) : messages.map((message) => (
                <li key={message.id} className={message.isMine ? "mine" : "theirs"}>
                  <p>{message.body}</p>
                  <time dateTime={message.createdAt}>{formatSocialTime(message.createdAt)}</time>
                </li>
              ))}
            </ol>
            <form className="message-composer" onSubmit={sendMessage}>
              <textarea ref={messageInput} value={messageBody} onChange={(event) => setMessageBody(event.target.value)} placeholder={`Message ${selectedFriend.user.name}…`} maxLength={2000} rows={3} aria-label={`Message ${selectedFriend.user.name}`} />
              <div className="message-emoji-row">
                <button
                  type="button"
                  className="message-emoji-trigger"
                  onClick={() => setEmojiPickerOpen((current) => !current)}
                  aria-expanded={emojiPickerOpen}
                  aria-label="Choose an emoji"
                  title="Add emoji"
                >
                  ☺
                </button>
                {emojiPickerOpen && (
                  <div className="social-emoji-picker message-emoji-picker" role="group" aria-label="Emojis">
                    {CHAT_EMOJIS.map((emoji) => (
                      <button type="button" key={emoji} onClick={() => insertEmoji(emoji)} aria-label={`Add ${emoji}`}>{emoji}</button>
                    ))}
                  </div>
                )}
              </div>
              <div className="message-composer-footer"><span>{messageBody.length}/2000</span><button type="submit" disabled={busy || !messageBody.trim()}>{busy ? "Sending…" : "Send"}</button></div>
            </form>
          </div>
        ) : (
          <div className="community-overview">
            <form className="friend-search" onSubmit={search}>
              <label htmlFor="friend-email">Find a Signal user by exact email</label>
              <div><input id="friend-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="friend@example.com" maxLength={254} required /><button type="submit" disabled={busy}>Find</button></div>
            </form>
            {error && <p className="social-error" role="alert">{error}</p>}
            {notice && <p className="social-notice" role="status">{notice}</p>}
            {searchResult && (
              <div className="social-person search-result">
                <SocialAvatar user={searchResult.user} />
                <div><strong>{searchResult.user.name}</strong><small>Signal user</small></div>
                {searchResult.friendshipState === "none" && <button type="button" disabled={busy} onClick={() => void requestFriend(searchResult.user.userId)}>Add friend</button>}
                {searchResult.friendshipState === "outgoing" && <span>Request sent</span>}
                {searchResult.friendshipState === "incoming" && <span>Request received below</span>}
                {searchResult.friendshipState === "friends" && <button type="button" onClick={() => {
                  const friend = overview?.friends.find((item) => item.user.userId === searchResult.user.userId);
                  if (friend) setSelectedFriend(friend);
                }}>Message</button>}
              </div>
            )}
            {loading ? <p className="social-empty">Loading friends…</p> : (
              <>
                {(overview?.incomingRequests.length ?? 0) > 0 && (
                  <section className="social-section">
                    <h3>Requests</h3>
                    {overview!.incomingRequests.map((request) => (
                      <div className="social-person" key={request.relationshipId}>
                        <SocialAvatar user={request.user} />
                        <div><strong>{request.user.name}</strong><small>Wants to be friends</small></div>
                        <div className="social-person-actions"><button type="button" disabled={busy} onClick={() => void acceptFriend(request.relationshipId)}>Accept</button><button type="button" disabled={busy} onClick={() => void removeRelationship(request.relationshipId)}>Decline</button></div>
                      </div>
                    ))}
                  </section>
                )}
                <section className="social-section">
                  <h3>Friends</h3>
                  {(overview?.friends.length ?? 0) === 0 ? <p className="social-empty">No friends yet. Find someone by email or add them from a comment.</p> : overview!.friends.map((friend) => (
                    <button className="social-person friend" type="button" key={friend.relationshipId} onClick={() => { setEmojiPickerOpen(false); setConversationMinimized(false); setSelectedFriend(friend); }}>
                      <SocialAvatar user={friend.user} />
                      <span>
                        <strong>{friend.user.name}</strong>
                        <small className={friend.user.isOnline ? "friend-presence online" : "friend-presence"}>
                          <i aria-hidden="true" />
                          {friend.user.unreadMessages > 0
                            ? `${friend.user.unreadMessages} unread · ${friend.user.isOnline ? "Online" : "Offline"}`
                            : formatPresence(friend.user)}
                        </small>
                      </span>
                      <span className="social-person-arrow">→</span>
                    </button>
                  ))}
                </section>
                {(overview?.outgoingRequests.length ?? 0) > 0 && (
                  <section className="social-section">
                    <h3>Sent requests</h3>
                    {overview!.outgoingRequests.map((request) => (
                      <div className="social-person" key={request.relationshipId}>
                        <SocialAvatar user={request.user} />
                        <div><strong>{request.user.name}</strong><small>Waiting for acceptance</small></div>
                        <button type="button" disabled={busy} onClick={() => void removeRelationship(request.relationshipId)}>Cancel</button>
                      </div>
                    ))}
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </section>
      )}
    </div>
  );
}

function LatestCommentsPanel({
  comments,
  onClose,
  onOpenDiscussion,
}: {
  comments: NewsComment[];
  onClose: () => void;
  onOpenDiscussion: (comment: NewsComment) => void;
}) {
  return (
    <div className="social-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="latest-comments-panel" role="dialog" aria-modal="true" aria-labelledby="latest-comments-title">
        <header className="social-panel-header">
          <div>
            <p className="eyebrow">Signal community</p>
            <h2 id="latest-comments-title">Latest comments</h2>
          </div>
          <button className="social-close" type="button" onClick={onClose} aria-label="Close latest comments">×</button>
        </header>
        {comments.length === 0 ? (
          <p className="social-empty">No comments have been posted yet.</p>
        ) : (
          <ol className="latest-comments-list">
            {comments.map((comment) => (
              <li key={comment.id}>
                <button type="button" onClick={() => onOpenDiscussion(comment)} aria-label={`Open discussion for ${comment.articleTitle}`}>
                  <SocialAvatar user={comment.author} showInitial={false} />
                  <span className="latest-comment-copy">
                    <span><strong>{comment.author.name}</strong><time dateTime={comment.createdAt}>{formatSocialTime(comment.createdAt)}</time></span>
                    <b>{comment.articleTitle}</b>
                    <em>{comment.body}</em>
                  </span>
                  <span className="social-person-arrow" aria-hidden="true">→</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function DiscussionPanel({
  article,
  onClose,
  onOpenCommunity,
}: {
  article: DiscussionArticle;
  onClose: () => void;
  onOpenCommunity: () => void;
}) {
  const [comments, setComments] = useState<NewsComment[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [friendBusy, setFriendBusy] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [commentEmojiPickerOpen, setCommentEmojiPickerOpen] = useState(false);
  const [newCommentCount, setNewCommentCount] = useState(0);
  const [error, setError] = useState("");
  const latestCommentId = useRef(0);
  const commentList = useRef<HTMLOListElement | null>(null);
  const commentInput = useRef<HTMLTextAreaElement | null>(null);

  async function loadComments(beforeId?: number) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ url: article.url, limit: "50" });
      if (beforeId) params.set("beforeId", String(beforeId));
      const page = await getJson<CommentPage>(`/api/comments?${params.toString()}`);
      setComments((current) => beforeId ? [...page.comments, ...current] : page.comments);
      if (!beforeId) latestCommentId.current = page.comments.at(-1)?.id ?? 0;
      setTotal(page.total);
      setHasMore(page.hasMore);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Comments could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    latestCommentId.current = 0;
    setNewCommentCount(0);
    void loadComments();
  }, [article.url]);

  useEffect(() => {
    let cancelled = false;
    async function refreshLatestComments() {
      try {
        const params = new URLSearchParams({ url: article.url, limit: "50" });
        const page = await getJson<CommentPage>(`/api/comments?${params.toString()}`);
        if (cancelled) return;
        const newestId = page.comments.at(-1)?.id ?? latestCommentId.current;
        const newlyArrived = page.comments.filter((comment) => comment.id > latestCommentId.current && !comment.canDelete);
        if (newlyArrived.length > 0) setNewCommentCount((current) => current + newlyArrived.length);
        latestCommentId.current = Math.max(latestCommentId.current, newestId);
        setComments((current) => {
          const merged = new Map(current.map((comment) => [comment.id, comment]));
          for (const comment of page.comments) merged.set(comment.id, comment);
          return Array.from(merged.values()).sort((left, right) => left.id - right.id);
        });
        setTotal(page.total);
        setHasMore((current) => current || page.hasMore);
      } catch {
        // Keep the current discussion visible and retry quietly on the next interval.
      }
    }
    const interval = window.setInterval(() => void refreshLatestComments(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [article.url]);

  function showLatestComment() {
    setNewCommentCount(0);
    commentList.current?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError("");
    try {
      const comment = await postJson<NewsComment>("/api/comments", {
        articleUrl: article.url,
        articleTitle: article.title,
        body,
      });
      setComments((current) => [...current, comment]);
      latestCommentId.current = Math.max(latestCommentId.current, comment.id);
      setTotal((current) => current + 1);
      setBody("");
      setCommentEmojiPickerOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your comment could not be posted.");
    } finally {
      setBusy(false);
    }
  }

  function insertCommentEmoji(emoji: string) {
    const input = commentInput.current;
    const start = input?.selectionStart ?? body.length;
    const end = input?.selectionEnd ?? start;
    const next = `${body.slice(0, start)}${emoji}${body.slice(end)}`;
    if (next.length > 2000) return;
    setBody(next);
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  async function removeComment(commentId: number) {
    setBusy(true);
    setError("");
    try {
      await deleteJson(`/api/comments/${commentId}`);
      setComments((current) => current.filter((comment) => comment.id !== commentId));
      setTotal((current) => Math.max(0, current - 1));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That comment could not be removed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveComment(event: FormEvent, commentId: number) {
    event.preventDefault();
    if (!editingBody.trim()) return;
    setBusy(true);
    setError("");
    try {
      const updated = await putJson<NewsComment>(`/api/comments/${commentId}`, { body: editingBody });
      setComments((current) => current.map((comment) => comment.id === commentId ? updated : comment));
      setEditingId(null);
      setEditingBody("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That comment could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function addFriend(authorId: string) {
    setFriendBusy((current) => new Set(current).add(authorId));
    setError("");
    try {
      const result = await postJson<FriendActionResult>("/api/social/friends/request", { userId: authorId });
      setComments((current) => current.map((comment) => comment.author.userId === authorId
        ? { ...comment, friendshipState: result.friendshipState }
        : comment));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The friend request could not be sent.");
    } finally {
      setFriendBusy((current) => {
        const next = new Set(current);
        next.delete(authorId);
        return next;
      });
    }
  }

  return (
    <div className="social-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="discussion-panel" role="dialog" aria-modal="true" aria-labelledby="discussion-title">
        <header className="social-panel-header">
          <div>
            <p className="eyebrow">Public discussion</p>
            <h2 id="discussion-title">Comments</h2>
          </div>
          <button className="social-close" type="button" onClick={onClose} aria-label="Close comments">×</button>
        </header>
        <div className="discussion-article">
          <span>{article.source}</span>
          <h3>{article.title}</h3>
          <a href={article.url} target="_blank" rel="noreferrer">Open article ↗</a>
        </div>
        <form className="comment-composer" onSubmit={submit}>
          <label htmlFor="new-comment">Join the discussion</label>
          <textarea
            ref={commentInput}
            id="new-comment"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Share a thoughtful comment…"
            maxLength={2000}
            rows={4}
          />
          <div className="comment-emoji-row">
            <button
              type="button"
              className="comment-emoji-trigger"
              onClick={() => setCommentEmojiPickerOpen((current) => !current)}
              aria-expanded={commentEmojiPickerOpen}
              aria-label="Choose an emoji"
              title="Add emoji"
            >
              ☺
            </button>
            {commentEmojiPickerOpen && (
              <div className="social-emoji-picker comment-emoji-picker" role="group" aria-label="Emojis">
                {CHAT_EMOJIS.map((emoji) => (
                  <button type="button" key={emoji} onClick={() => insertCommentEmoji(emoji)} aria-label={`Add ${emoji}`}>{emoji}</button>
                ))}
              </div>
            )}
          </div>
          <div className="comment-composer-footer"><span>{body.length}/2000</span><button type="submit" disabled={busy || !body.trim()}>{busy ? "Posting…" : "Post comment"}</button></div>
        </form>
        {error && <p className="social-error" role="alert">{error}</p>}
        <div className="comment-list-heading"><strong>{total} {total === 1 ? "comment" : "comments"}</strong></div>
        {newCommentCount > 0 && (
          <button className="new-comments-notice" type="button" onClick={showLatestComment} aria-live="polite">
            {newCommentCount} new {newCommentCount === 1 ? "comment" : "comments"} — view latest ↓
          </button>
        )}
        {hasMore && comments.length > 0 && (
          <button className="social-load-more" type="button" disabled={loading} onClick={() => void loadComments(comments[0].id)}>
            {loading ? "Loading…" : "Load earlier comments"}
          </button>
        )}
        {loading && comments.length === 0 ? (
          <p className="social-empty">Loading comments…</p>
        ) : comments.length === 0 ? (
          <p className="social-empty">No comments yet. Start the conversation.</p>
        ) : (
          <ol className="comment-list" ref={commentList}>
            {comments.map((comment) => (
              <li key={comment.id}>
                {!comment.canDelete && comment.friendshipState === "none" ? (
                  <button
                    type="button"
                    className="comment-author-avatar"
                    disabled={friendBusy.has(comment.author.userId)}
                    onClick={() => void addFriend(comment.author.userId)}
                    aria-label={`Add ${comment.author.name} as a friend`}
                    title={`Add ${comment.author.name} as a friend`}
                  >
                    <SocialAvatar user={comment.author} showInitial={false} />
                  </button>
                ) : (
                  <SocialAvatar user={comment.author} showInitial={false} />
                )}
                <div>
                  <header><strong>{comment.author.name}</strong><time dateTime={comment.createdAt}>{formatSocialTime(comment.createdAt)}</time></header>
                  {editingId === comment.id ? (
                    <form className="comment-edit-form" onSubmit={(event) => void saveComment(event, comment.id)}>
                      <textarea
                        value={editingBody}
                        onChange={(event) => setEditingBody(event.target.value)}
                        maxLength={2000}
                        rows={4}
                        aria-label="Edit comment"
                        autoFocus
                      />
                      <div>
                        <span>{editingBody.length}/2000</span>
                        <button type="button" disabled={busy} onClick={() => { setEditingId(null); setEditingBody(""); }}>Cancel</button>
                        <button type="submit" disabled={busy || !editingBody.trim()}>{busy ? "Saving…" : "Save"}</button>
                      </div>
                    </form>
                  ) : (
                    <p>{comment.body}</p>
                  )}
                  <div className="comment-actions">
                    {comment.canDelete && editingId !== comment.id && (
                      <>
                        <button type="button" disabled={busy} onClick={() => { setEditingId(comment.id); setEditingBody(comment.body); }}>Edit</button>
                        <button type="button" disabled={busy} onClick={() => void removeComment(comment.id)}>Delete</button>
                      </>
                    )}
                    {!comment.canDelete && comment.friendshipState === "none" && (
                      <button type="button" disabled={friendBusy.has(comment.author.userId)} onClick={() => void addFriend(comment.author.userId)}>
                        {friendBusy.has(comment.author.userId) ? "Sending…" : "Add friend"}
                      </button>
                    )}
                    {comment.friendshipState === "outgoing" && <span>Friend request sent</span>}
                    {comment.friendshipState === "friends" && <span>Friends</span>}
                    {comment.friendshipState === "incoming" && <button type="button" onClick={onOpenCommunity}>Review friend request</button>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function AccountPanel({
  user,
  googleAvailable,
  googleStatus,
  onUserUpdated,
  onClose,
  onSignedOut,
}: {
  user: SessionUser;
  googleAvailable: boolean;
  googleStatus: string | null;
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
      const result = user.hasPassword
        ? await postJson<{ message: string }>("/api/auth/change-password", { currentPassword, newPassword })
        : await postJson<{ message: string }>("/api/auth/set-password", { newPassword });
      setMessage(result.message); setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      if (!user.hasPassword) onUserUpdated({ ...user, hasPassword: true });
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
        {googleAvailable && (
          <section className="google-account-settings" aria-labelledby="google-account-title">
            <span className="google-account-mark" aria-hidden="true">G</span>
            <div>
              <h3 id="google-account-title">Google sign-in</h3>
              <p>{user.googleConnected
                ? "Google is connected to this Signal account."
                : "Connect the Google account with the same email address for quicker sign-in."}</p>
              {googleStatus === "google-linked" && <p className="google-account-status success" role="status">Google sign-in is connected.</p>}
              {googleStatus === "google-link-failed" && <p className="google-account-status error" role="alert">That Google account could not be connected.</p>}
              {googleStatus === "google-link-email-mismatch" && <p className="google-account-status error" role="alert">Choose the Google account that uses {user.email}.</p>}
              {googleStatus === "google-unverified" && <p className="google-account-status error" role="alert">Google did not return a verified email address.</p>}
              {googleStatus === "google-existing" && <p className="google-account-status error" role="alert">Signal lost the account-link request. Please try Connect Google again.</p>}
              {googleStatus === "google-error" && <p className="google-account-status error" role="alert">Google could not complete the connection. Please try again.</p>}
              {!user.googleConnected && <a className="google-account-action" href="/api/auth/google">Connect Google</a>}
            </div>
          </section>
        )}
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
          <h3>{user.hasPassword ? "Change password" : "Add password sign-in"}</h3>
          {message && <p className="auth-notice" role="status">{message}</p>}
          <AuthError message={error} />
          {user.hasPassword && <AuthInput label="Current password" type="password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />}
          <AuthInput label="New password" type="password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" minLength={12} />
          <AuthInput label="Confirm new password" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" minLength={12} />
          <button className="auth-submit" disabled={busy}>{busy ? "Saving…" : user.hasPassword ? "Change password" : "Add password"}</button>
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
