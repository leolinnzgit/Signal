import { chatGPTSignOutPath, requireChatGPTUser } from "./chatgpt-auth";
import NewsDashboard from "./NewsDashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");

  return (
    <NewsDashboard
      user={user}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}
