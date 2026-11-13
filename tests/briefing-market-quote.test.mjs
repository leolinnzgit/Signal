import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { selectBriefingMarketTopics } from "../app/useBriefingMarketQuote.ts";

test("selectBriefingMarketTopics ignores an unrelated selected dashboard topic so quotes do not stick", () => {
  assert.deepEqual(
    selectBriefingMarketTopics(
      ["Microsoft"],
      "NVIDIA",
      "Microsoft 365 Outage Disrupts Outlook, Exchange Online and Teams",
    ),
    ["microsoft"],
  );

  assert.deepEqual(
    selectBriefingMarketTopics(
      ["Science"],
      "NVIDIA",
      "Researchers report a discovery",
    ),
    ["science"],
  );
});

test("selectBriefingMarketTopics prioritizes topics matching the headline title ahead of secondary tags", () => {
  assert.deepEqual(
    selectBriefingMarketTopics(
      ["NVIDIA", "Microsoft"],
      "NVIDIA",
      "Microsoft 365 Outage Disrupts Outlook, Exchange Online and Teams",
    ),
    ["microsoft", "nvidia"],
  );

  assert.deepEqual(
    selectBriefingMarketTopics(
      ["Science", "Apple"],
      undefined,
      "Apple research update",
    ),
    ["apple", "science"],
  );

  assert.deepEqual(
    selectBriefingMarketTopics(
      ["Microsoft", "Alphabet"],
      undefined,
      "GOOGL rises after cloud earnings",
      { Alphabet: "GOOGL:NASDAQ" },
    ),
    ["alphabet", "microsoft"],
  );
});

test("selectBriefingMarketTopics still breaks ties using preferredTopic within the article's topics", () => {
  assert.deepEqual(
    selectBriefingMarketTopics(
      ["Microsoft", "NVIDIA"],
      "NVIDIA",
      "NVIDIA and Microsoft expand AI partnership",
    ),
    ["nvidia", "microsoft"],
  );

  assert.deepEqual(
    selectBriefingMarketTopics(
      ["Science", "NVIDIA"],
      "NVIDIA",
      "Chipmakers rally on AI demand",
    ),
    ["nvidia", "science"],
  );
});

test("HeadlinePlayer and NewsDashboard pass headline context and scope marketTopic to matching queues", async () => {
  const playerSource = await readFile(new URL("../app/HeadlinePlayer.tsx", import.meta.url), "utf8");
  assert.match(playerSource, /useBriefingMarketQuote\(\s*article\?\.topics \?\? \[\],\s*article \? marketTopic : undefined,\s*tickerOverrides,\s*article\?\.title,/);

  const dashboardSource = await readFile(new URL("../app/NewsDashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboardSource, /headlineQueue\.every\(\(item\) => item\.topics\.some\(/);
});
