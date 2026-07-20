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
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          SIGNAL
        </Link>
        <p className="preview-auth-eyebrow">Local development</p>
        <h1 id="preview-auth-title">You’re signed out.</h1>
        <p>
          Hosted authentication is provided by Sites. This local screen lets you
          test the signed-out state without impersonating the production identity
          provider.
        </p>
        <Link className="preview-auth-action" href="/">Enter local preview</Link>
      </section>
    </main>
  );
}
