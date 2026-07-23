using Signal.Server.Services;

var cases = new (string Text, string Topic, bool Expected)[]
{
    ("New Zealand economy faces a slower recovery", "New Zealand economy", true),
    ("Economy outlook improves across New Zealand", "New Zealand economy", true),
    ("New species discovered near Australia", "New Zealand economy", false),
    ("New AI regulation proposed for health systems", "AI regulation", true),
    ("Regulation changes affect local councils", "AI regulation", false),
    ("AI tools reshape software development", "AI", true),
    ("Painting exhibition opens downtown", "AI", false),
    ("UK election campaign enters its final week", "UK", true),
    ("Ukraine election reporting continues", "UK", false),
};

foreach (var (text, topic, expected) in cases)
{
    var actual = TopicMatcher.Matches(text, topic);
    if (actual != expected)
        throw new InvalidOperationException($"Expected '{topic}' against '{text}' to be {expected}, but got {actual}.");
}

Console.WriteLine($"Topic matcher passed {cases.Length} relevance checks.");
