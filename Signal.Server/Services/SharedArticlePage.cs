using System.Net;
using System.Text.Json;
using Signal.Server.Models;

namespace Signal.Server.Services;

public static class SharedArticlePage
{
    private static string Encode(string value) => WebUtility.HtmlEncode(value);

    public static string Render(SharedNewsArticle article, string homePath)
    {
        var paragraphs = JsonSerializer.Deserialize<string[]>(article.ParagraphsJson) ?? [];
        var description = paragraphs.FirstOrDefault() ?? article.Title;
        if (description.Length > 240) description = description[..240] + "…";
        var languageNote = article.Language.Length > 0
            ? $"<span>Translated · {Encode(LanguageName(article.Language))}</span>"
            : "";
        var notice = article.SummaryOnly
            ? "<aside>Headline and feed summary. The publisher did not provide full article text to Signal. Follow the original link to read the full story.</aside>"
            : "<aside>A saved reading view shared from Signal. "
                + (article.Language.Length > 0 ? "This translation is preserved in the language chosen by the person who shared it. " : "")
                + "Reporting belongs to the original publisher.</aside>";
        return Document(article.Title, article.Language.Length > 0 ? article.Language : "und", description, $"""
            <header><a class="brand" href="{Encode(homePath)}" lang="en">SIGNAL<span>Shared story</span></a></header>
            <main><article>
            <div class="meta" lang="en"><span>{Encode(article.Source)}</span>{languageNote}</div>
            <h1 id="story-title" dir="auto" data-audio-section="0">{Encode(article.Title)}</h1>
            {(article.Byline.Length > 0 ? $"<p class=\"byline\" dir=\"auto\">{Encode(article.Byline)}</p>" : "")}
            <div lang="en">{notice}</div>
            <section class="shared-audio" lang="en" aria-label="Listen to this story">
            <strong>Listen to this story</strong><p>Azure narration reads the saved story in its shared language.</p>
            <label for="story-voice">Voice</label><select id="story-voice" disabled><option value="">Default voice · loading choices…</option></select>
            <button id="listen-button" type="button">Play audio</button>
            <audio id="story-audio" controls preload="none" data-src="{Encode(homePath)}shared/{Encode(article.Id)}/audio" hidden aria-label="Story audio"></audio>
            <p id="audio-status" role="status" aria-live="polite"></p>
            </section>
            <script src="{Encode(homePath)}shared-story-audio.js?v=3" defer></script>
            <div class="body">{string.Join("\n", paragraphs.Select((text, index) => $"<p dir=\"auto\" data-audio-section=\"{index + 1}\">{Encode(text)}</p>"))}</div>
            <footer lang="en"><a href="{Encode(article.OriginalUrl)}" target="_blank" rel="noopener noreferrer">Read the original article ↗</a><p>Saved and shared with Signal</p></footer>
            <section id="story-comments" class="shared-comments" lang="en" aria-labelledby="comments-title"
                data-endpoint="{Encode(homePath)}api/shared/{Encode(article.Id)}/comments" data-home="{Encode(homePath)}">
            <h2 id="comments-title">Comments</h2>
            <p>Add your name or post anonymously. Comments also appear with this news story in Signal.</p>
            <form id="comment-form">
            <label for="comment-name">Your name (optional)</label>
            <input id="comment-name" name="name" type="text" maxlength="80" autocomplete="name" placeholder="Anonymous" aria-describedby="comment-name-hint">
            <p id="comment-name-hint" class="comment-hint">Leave blank to post as Anonymous. Your name will appear with your comment.</p>
            <label for="comment-body">Your comment</label>
            <textarea id="comment-body" name="body" rows="4" maxlength="2000" required placeholder="Share your thoughts…"></textarea>
            <p class="comment-hint">Up to 2,000 characters. No sign-in needed.</p>
            <button id="comment-submit" type="submit" disabled>Post comment</button>
            </form>
            <p id="comment-status" role="status" aria-live="polite"></p>
            <noscript><p>Enable JavaScript to read and leave comments.</p></noscript>
            <div class="comments-toolbar"><span id="comment-count"></span><button id="comments-refresh" type="button">Refresh comments</button></div>
            <button id="comments-older" type="button" hidden>Load older comments</button>
            <ol id="comment-list" aria-label="Story comments"></ol>
            </section>
            <script src="{Encode(homePath)}shared-story-comments.js?v=3" defer></script>
            </article></main>
            """);
    }

    public static string RenderMissing() => Document("Shared story unavailable", "en", "This shared story could not be found.",
        "<header><a class=\"brand\" href=\"/\">SIGNAL</a></header><main><h1>Shared story unavailable</h1><p>This link is incomplete or the story is no longer available.</p></main>");

    private static string LanguageName(string language) => language switch
    {
        "en" => "English", "zh-Hans" => "Chinese (Simplified)", "zh-Hant" => "Chinese (Traditional)",
        "ja" => "Japanese", "ko" => "Korean", "fr" => "French", "de" => "German", "es" => "Spanish",
        "it" => "Italian", "pt" => "Portuguese", "ar" => "Arabic", "hi" => "Hindi", _ => language,
    };

    private static string Document(string title, string language, string description, string body) => $$$"""
        <!doctype html>
        <html lang="{{{Encode(language)}}}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>{{{Encode(title)}}} — Signal</title><meta name="robots" content="noindex, nofollow">
        <meta name="description" content="{{{Encode(description)}}}"><meta property="og:type" content="article">
        <meta property="og:title" content="{{{Encode(title)}}}"><meta property="og:description" content="{{{Encode(description)}}}">
        <meta property="og:site_name" content="Signal"><meta name="color-scheme" content="light dark">
        <style>
        :root{color-scheme:light dark;--paper:#f7f4ed;--ink:#20201d;--muted:#6c6a62;--line:#d8d4c9;--accent:#bb312a}
        *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,sans-serif}
        header{border-bottom:1px solid var(--line);padding:1.4rem max(1.25rem,calc((100vw - 780px)/2))}
        a{color:var(--accent);text-underline-offset:4px}.brand{color:var(--ink);text-decoration:none;font-weight:850;letter-spacing:.18em;font-size:1.5rem}
        .brand span{display:block;font-size:.65rem;letter-spacing:.12em;color:var(--muted);margin-top:.3rem;text-transform:uppercase}
        main{max-width:780px;margin:auto;padding:2.5rem 1.25rem 3rem;overflow-wrap:anywhere}
        .meta{display:flex;flex-wrap:wrap;gap:1rem;color:var(--muted);font-size:.8rem}
        h1{font-family:Georgia,serif;font-size:clamp(2rem,5vw,3rem);line-height:1.17;font-weight:600;margin:1.1rem 0 1.5rem}
        .byline{color:var(--muted);font-size:.9rem}aside{font-size:.8rem;line-height:1.6;border-block:1px solid var(--line);padding:1rem 0;color:var(--muted)}
        .shared-audio{border:1px solid var(--line);padding:1.25rem;margin-top:1.5rem;border-radius:.5rem;font-size:.9rem}.shared-audio p{color:var(--muted);font-size:.8rem;line-height:1.6;margin:.5rem 0}
        .shared-audio button{font:inherit;background:var(--ink);color:var(--paper);border:0;border-radius:.3rem;padding:.65rem 1rem;cursor:pointer}.shared-audio button:disabled{opacity:.6;cursor:wait}
        .shared-audio audio{width:100%;margin-top:.6rem}.shared-audio [hidden]{display:none}
        .shared-audio label{display:block;margin:.8rem 0 .3rem}.shared-audio select{display:block;max-width:100%;width:100%;font:inherit;padding:.6rem;border:1px solid var(--line);border-radius:.3rem;background:var(--paper);color:var(--ink);margin-bottom:1rem}
        [data-audio-section]{border-radius:.2rem;scroll-margin-block:2rem}.audio-current{background:var(--highlight);outline:3px solid var(--highlight);box-shadow:-5px 0 0 var(--accent)}
        .body{font-family:Georgia,serif;font-size:1.15rem;line-height:1.85;margin-top:2rem}.body p{margin:0 0 1.4rem;white-space:pre-wrap}
        footer{border-top:1px solid var(--line);padding-top:1.5rem;margin-top:2.5rem;font-size:.85rem}footer p{color:var(--muted)}
        .shared-comments{border-top:1px solid var(--line);margin-top:2rem;padding-top:1.5rem}.shared-comments h2{font-family:Georgia,serif;font-size:1.6rem}.shared-comments>p,.comment-hint{color:var(--muted);font-size:.85rem;line-height:1.6}
        .shared-comments label{display:block;font-weight:600;margin:1rem 0 .5rem}.shared-comments input,.shared-comments textarea{display:block;width:100%;resize:vertical;min-height:7rem;padding:.8rem;font:inherit;border:1px solid var(--line);border-radius:.3rem;background:var(--paper);color:var(--ink)}
        .shared-comments input{min-height:0;resize:none}
        .shared-comments button{font:inherit;font-size:.85rem;padding:.65rem .9rem;border:1px solid var(--line);border-radius:.3rem;background:var(--paper);color:var(--ink);cursor:pointer}.shared-comments button:disabled{opacity:.6;cursor:wait}.shared-comments [hidden]{display:none}
        #comment-submit{background:var(--ink);color:var(--paper)}.shared-comments :focus-visible{outline:2px solid var(--accent);outline-offset:3px}.comments-toolbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:1.5rem 0 1rem;font-size:.85rem}
        #comment-list{list-style:none;padding:0;margin:1rem 0}#comment-list li{border-top:1px solid var(--line);padding:1rem 0}#comment-list p{white-space:pre-wrap;line-height:1.65;margin:.6rem 0 0}.comment-meta{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:baseline;font-size:.85rem}.comment-meta time{color:var(--muted);font-size:.75rem}
        .comment-story-link{display:inline-block;margin-top:.7rem;font-size:.8rem}
        @media print{#comment-form,.comments-toolbar,#comments-older,#comment-status{display:none}}
        :root{--highlight:#f5e2af}
        @media(prefers-color-scheme:dark){:root{--paper:#191a18;--ink:#edeae2;--muted:#aaa79f;--line:#3b3c36;--accent:#ef8176;--highlight:#51422a}}
        @media print{:root{--paper:white;--ink:black;--muted:#555;--line:#ccc}main{max-width:none;padding:1rem 0}header{padding:0 0 1rem}.shared-audio{display:none}.audio-current{background:none;outline:none;box-shadow:none}}
        </style></head><body>{{{body}}}</body></html>
        """;
}
