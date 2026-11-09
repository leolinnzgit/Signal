import React from "react";
import { createRoot } from "react-dom/client";
import ArticleEntities from "../app/ArticleEntities";
import ArticleKeyPhrases from "../app/ArticleKeyPhrases";

const article = { url: "https://example.com/analysis-check", title: "Research expands", paragraphs: ["Researchers published a substantial new report on science and technology today."] };
createRoot(document.getElementById("root")!).render(<React.StrictMode><main>
  <ArticleEntities {...article} followedTopics={[]} onFollow={() => {}} onOpenTopic={() => {}} />
  <ArticleKeyPhrases {...article} />
</main></React.StrictMode>);
