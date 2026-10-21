import { chatGPTSignOutPath, requireChatGPTUser } from "./chatgpt-auth";
import Link from "next/link";
import NewsDashboard from "./NewsDashboard";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams: Promise<{ preview?: string }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const user = await requireChatGPTUser("/");
  const { preview } = await searchParams;

  if (user.isLocalPreview && preview === "signed-out") {
    return <LocalPreviewSignedOut />;
  }

  return (
    <NewsDashboard
      user={user}
      signOutPath={
        user.isLocalPreview
          ? "/?preview=signed-out"
          : chatGPTSignOutPath("/")
      }
    />
  );
}

function LocalPreviewSignedOut() {
  return (
    <main className="preview-auth-shell">
      <section className="preview-auth-card" aria-labelledby="preview-auth-title">
        <Link className="brand" href="/" aria-label="Signal home">
          <img className="brand-mark" src="/icons/signal-medallion-64.png" alt="" aria-hidden="true" />
          SIGNAL
        </Link>
        <p className="preview-auth-eyebrow">Local development</p>
        <h1 id="preview-auth-title">You’re signed out.</h1>
        <p>
          ChatGPT sign-in is provided by Sites on the hosted URL and cannot run
          on localhost. You can re-enter this development build with its local
          preview identity.
        </p>
        <Link className="preview-auth-action" href="/">Sign in to local preview</Link>
        <small className="preview-auth-note">
          This local preview does not use your ChatGPT account.
        </small>
      </section>
    </main>
  );
}
