using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Services;

internal static class WordLookupChecks
{
    public static async Task RunAsync()
    {
        RunSelectionNormalizationChecks();
        await RunEnglishDictionaryAndFallbackChecksAsync();
        await RunChineseTranslatorAndFallbackChecksAsync();
        await RunUnavailableAndControllerChecksAsync();
        Console.WriteLine("Word lookup passed normalization, English dictionary + AI fallback, Chinese translator + dictionary senses + AI fallback, caching, and controller checks.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void RunSelectionNormalizationChecks()
    {
        Assert(WordLookupService.NormalizeSelection("  \"resilience,”  ") == "resilience", "Did not strip surrounding quotes/punctuation.");
        Assert(WordLookupService.NormalizeSelection("co-operation's") == "co-operation's", "Did not preserve hyphens/apostrophes.");
        Assert(WordLookupService.NormalizeSelection("central bank rate") == "central bank rate", "Did not allow short multi-word phrase.");
        Assert(WordLookupService.NormalizeSelection("通貨膨脹") == "通貨膨脹", "Did not allow CJK selection.");
        Assert(WordLookupService.NormalizeSelection("") == "", "Accepted empty string.");
        Assert(WordLookupService.NormalizeSelection("123456") == "", "Accepted pure digits.");
        Assert(WordLookupService.NormalizeSelection("...---!!!") == "", "Accepted punctuation only.");
        Assert(WordLookupService.NormalizeSelection("first\nsecond") == "", "Accepted multiline selection.");
        Assert(WordLookupService.NormalizeSelection("one two three four five six seven") == "", "Accepted more than 6 words.");
        Assert(WordLookupService.NormalizeSelection(new string('a', 81)) == "", "Accepted selection longer than 80 chars.");
        Assert(WordLookupService.IsSingleAsciiWord("inflation"), "Expected single ASCII word.");
        Assert(!WordLookupService.IsSingleAsciiWord("central bank"), "Multi-word phrase should not be single ASCII word.");
    }

    private static async Task RunEnglishDictionaryAndFallbackChecksAsync()
    {
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var dictHandler = new MockDictionaryHandler();
        var translatorHandler = new MockTranslatorHandler();
        var foundryHandler = new MockFoundryHandler();

        using var dictClient = new HttpClient(dictHandler);
        using var translatorClient = new HttpClient(translatorHandler);
        using var foundryClient = new HttpClient(foundryHandler);

        var factory = new RoutingClientFactory(new Dictionary<string, HttpClient>
        {
            [WordLookupService.DictionaryHttpClientName] = dictClient,
            [AzureTranslatorService.HttpClientName] = translatorClient,
            [MicrosoftFoundryService.HttpClientName] = foundryClient,
        });

        var translator = new AzureTranslatorService(
            Options.Create(new AzureTranslatorOptions()),
            factory,
            cache);
        var foundry = new MicrosoftFoundryService(
            Options.Create(new MicrosoftFoundryOptions
            {
                Endpoint = "https://signal-test.services.ai.azure.com/",
                Key = "test-foundry-api-key-1234567890",
                Deployment = "gpt-4.1-mini",
            }),
            factory,
            NullLogger<MicrosoftFoundryService>.Instance);

        var service = new WordLookupService(
            translator,
            foundry,
            factory,
            cache,
            NullLogger<WordLookupService>.Instance);

        var first = await service.LookupAsync("resilience", "english", null, CancellationToken.None);
        Assert(first.Available && first.Source == "Dictionary", "Single English word did not use Dictionary.");
        Assert(first.Phonetic == "/ɹɪˈzɪliəns/", "Phonetic was not parsed.");
        Assert(first.Meanings.Length == 1 && first.Meanings[0].PartOfSpeech == "noun", "Meaning partOfSpeech mismatch.");
        Assert(first.Meanings[0].Definitions[0].Contains("recover quickly", StringComparison.Ordinal), "Definition missing.");
        Assert(first.Meanings[0].Synonyms?.Contains("toughness") == true, "Synonyms missing.");
        Assert(dictHandler.Calls == 1 && foundryHandler.Calls == 0, "Unexpected call counts for dictionary hit.");

        // Repeat lookup should hit cache
        var cached = await service.LookupAsync("Resilience", "english", null, CancellationToken.None);
        Assert(cached.Available && dictHandler.Calls == 1, "Repeated English dictionary lookup was not cached.");

        // Dictionary 404 should fall back to Microsoft Foundry
        dictHandler.ReturnNotFoundFor.Add("stagflation");
        var aiWord = await service.LookupAsync("stagflation", "english", "Economists warned of stagflation.", CancellationToken.None);
        Assert(aiWord.Available && aiWord.Source == "Signal AI", "Dictionary 404 did not fall back to Signal AI.");
        Assert(aiWord.Meanings[0].Definitions[0].Contains("Persistent high inflation", StringComparison.Ordinal), "Foundry definition missing.");
        Assert(foundryHandler.Calls == 1, "Foundry should have been called once.");

        // Multi-word phrase skips dictionary and goes directly to Foundry
        var phrase = await service.LookupAsync("quantitative easing", "english", "The central bank ended quantitative easing.", CancellationToken.None);
        Assert(phrase.Available && phrase.Source == "Signal AI" && dictHandler.Calls == 2 && foundryHandler.Calls == 2,
            "Multi-word English lookup did not route directly to Foundry.");
    }

    private static async Task RunChineseTranslatorAndFallbackChecksAsync()
    {
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var dictHandler = new MockDictionaryHandler();
        var translatorHandler = new MockTranslatorHandler();
        var foundryHandler = new MockFoundryHandler();

        using var dictClient = new HttpClient(dictHandler);
        using var translatorClient = new HttpClient(translatorHandler);
        using var foundryClient = new HttpClient(foundryHandler);

        var factory = new RoutingClientFactory(new Dictionary<string, HttpClient>
        {
            [WordLookupService.DictionaryHttpClientName] = dictClient,
            [AzureTranslatorService.HttpClientName] = translatorClient,
            [MicrosoftFoundryService.HttpClientName] = foundryClient,
        });

        var translator = new AzureTranslatorService(
            Options.Create(new AzureTranslatorOptions
            {
                Key = "fake-test-key-not-a-credential",
                Region = "australiaeast",
            }),
            factory,
            cache);
        var foundry = new MicrosoftFoundryService(
            Options.Create(new MicrosoftFoundryOptions
            {
                Endpoint = "https://signal-test.services.ai.azure.com/",
                Key = "test-foundry-api-key-1234567890",
                Deployment = "gpt-4.1-mini",
            }),
            factory,
            NullLogger<MicrosoftFoundryService>.Instance);

        var service = new WordLookupService(
            translator,
            foundry,
            factory,
            cache,
            NullLogger<WordLookupService>.Instance);

        var zh = await service.LookupAsync("inflation", "chinese", null, CancellationToken.None);
        Assert(zh.Available && zh.Source == "Azure Translator", "Chinese lookup did not use Azure Translator.");
        Assert(zh.ChineseSimplified == "通货膨胀" && zh.ChineseTraditional == "通貨膨脹", "Simplified/Traditional Chinese mismatch.");
        Assert(zh.ChineseSenses.Length == 1 && zh.ChineseSenses[0].PartOfSpeech == "noun", "Chinese dictionary sense missing.");
        Assert(translatorHandler.TranslateCalls == 1 && translatorHandler.DictionaryCalls == 1, "Expected 1 translate + 1 dictionary lookup call.");

        // Repeat lookup hits cache
        _ = await service.LookupAsync("Inflation", "chinese", null, CancellationToken.None);
        Assert(translatorHandler.TranslateCalls == 1 && translatorHandler.DictionaryCalls == 1, "Chinese lookup was not cached.");

        // Dictionary lookup 404 still succeeds with primary translation
        translatorHandler.FailDictionary = true;
        var phraseZh = await service.LookupAsync("tariff", "chinese", null, CancellationToken.None);
        Assert(phraseZh.Available && phraseZh.ChineseSimplified == "关税" && phraseZh.ChineseSenses.Length == 0,
            "Chinese lookup failed when optional dictionary lookup returned 404.");

        // Fallback to Foundry when Azure Translator is disabled
        using var fallbackCache = new MemoryCache(new MemoryCacheOptions());
        var disabledTranslator = new AzureTranslatorService(Options.Create(new AzureTranslatorOptions()), factory, fallbackCache);
        var fallbackService = new WordLookupService(disabledTranslator, foundry, factory, fallbackCache, NullLogger<WordLookupService>.Instance);
        var aiZh = await fallbackService.LookupAsync("inflation", "chinese", "Inflation cooled in October.", CancellationToken.None);
        Assert(aiZh.Available && aiZh.Source == "Signal AI" && aiZh.ChineseSimplified == "通货膨胀" && aiZh.Pinyin == "tōng huò péng zhàng",
            "Chinese AI fallback did not parse simplified, traditional, and pinyin.");
    }

    private static async Task RunUnavailableAndControllerChecksAsync()
    {
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var dictHandler = new MockDictionaryHandler { ReturnNotFoundFor = { "obscureword" } };
        using var dictClient = new HttpClient(dictHandler);
        var factory = new RoutingClientFactory(new Dictionary<string, HttpClient>
        {
            [WordLookupService.DictionaryHttpClientName] = dictClient,
            [AzureTranslatorService.HttpClientName] = dictClient,
            [MicrosoftFoundryService.HttpClientName] = dictClient,
        });

        var disabledTranslator = new AzureTranslatorService(Options.Create(new AzureTranslatorOptions()), factory, cache);
        var disabledFoundry = new MicrosoftFoundryService(
            Options.Create(new MicrosoftFoundryOptions()),
            factory,
            NullLogger<MicrosoftFoundryService>.Instance);

        var service = new WordLookupService(
            disabledTranslator,
            disabledFoundry,
            factory,
            cache,
            NullLogger<WordLookupService>.Instance);

        var missingEn = await service.LookupAsync("obscureword", "english", null, CancellationToken.None);
        Assert(!missingEn.Available && !string.IsNullOrWhiteSpace(missingEn.Reason), "Unavailable English result missing reason.");

        var missingZh = await service.LookupAsync("obscureword", "chinese", null, CancellationToken.None);
        Assert(!missingZh.Available && missingZh.Reason.Contains("Azure Translator", StringComparison.Ordinal),
            "Unavailable Chinese result missing reason.");

        var controller = new WordLookupController(service, NullLogger<WordLookupController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };

        var badMode = await controller.Lookup(new WordLookupController.WordLookupRequest("test", "french"), CancellationToken.None);
        Assert(badMode is BadRequestObjectResult, "Controller accepted unsupported mode.");

        var badWord = await controller.Lookup(new WordLookupController.WordLookupRequest("12345", "english"), CancellationToken.None);
        Assert(badWord is BadRequestObjectResult, "Controller accepted invalid word.");
    }

    private sealed class RoutingClientFactory(IReadOnlyDictionary<string, HttpClient> map) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => map[name];
    }

    private sealed class MockDictionaryHandler : HttpMessageHandler
    {
        public int Calls;
        public HashSet<string> ReturnNotFoundFor { get; } = new(StringComparer.OrdinalIgnoreCase);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            var word = request.RequestUri!.Segments.Last().Trim('/');
            if (ReturnNotFoundFor.Contains(word))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            }

            const string payload = """
                [
                  {
                    "word": "resilience",
                    "phonetic": "/ɹɪˈzɪliəns/",
                    "meanings": [
                      {
                        "partOfSpeech": "noun",
                        "definitions": [
                          {
                            "definition": "The capacity to recover quickly from difficulties; toughness.",
                            "example": "Economic resilience helped the region rebound."
                          }
                        ],
                        "synonyms": ["toughness", "adaptability"]
                      }
                    ]
                  }
                ]
                """;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class MockTranslatorHandler : HttpMessageHandler
    {
        public int TranslateCalls;
        public int DictionaryCalls;
        public bool FailDictionary;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            var text = body.RootElement[0].GetProperty("text").GetString() ?? "";

            if (path.EndsWith("dictionary/lookup", StringComparison.OrdinalIgnoreCase))
            {
                DictionaryCalls++;
                if (FailDictionary) return new HttpResponseMessage(HttpStatusCode.NotFound);

                var dictJson = JsonSerializer.Serialize(new[]
                {
                    new
                    {
                        normalizedSource = text,
                        displaySource = text,
                        translations = new[]
                        {
                            new
                            {
                                normalizedTarget = "通货膨胀",
                                displayTarget = "通货膨胀",
                                posTag = "NOUN",
                                backTranslations = new[]
                                {
                                    new { displayText = "inflation" },
                                    new { displayText = "price rise" },
                                },
                            },
                        },
                    },
                });
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(dictJson, Encoding.UTF8, "application/json"),
                };
            }

            TranslateCalls++;
            var (simp, trad) = text.Equals("tariff", StringComparison.OrdinalIgnoreCase)
                ? ("关税", "關稅")
                : ("通货膨胀", "通貨膨脹");
            var translateJson = JsonSerializer.Serialize(new[]
            {
                new
                {
                    translations = new[]
                    {
                        new { text = simp, to = "zh-Hans" },
                        new { text = trad, to = "zh-Hant" },
                    },
                },
            });
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(translateJson, Encoding.UTF8, "application/json"),
            };
        }
    }

    private sealed class MockFoundryHandler : HttpMessageHandler
    {
        public int Calls;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            var systemPrompt = body.RootElement.GetProperty("messages")[0].GetProperty("content").GetString() ?? "";

            var innerJson = systemPrompt.Contains("Chinese", StringComparison.OrdinalIgnoreCase)
                ? """
                  {
                    "simplified": "通货膨胀",
                    "traditional": "通貨膨脹",
                    "pinyin": "tōng huò péng zhàng",
                    "contextNote": "Used in macroeconomic reporting for rising consumer prices.",
                    "senses": [
                      { "partOfSpeech": "noun", "translation": "通胀", "backTranslations": ["inflation"] }
                    ]
                  }
                  """
                : """
                  {
                    "word": "stagflation",
                    "phonetic": "/stæɡˈfleɪʃən/",
                    "contextNote": "Commonly discussed in central-bank policy coverage.",
                    "meanings": [
                      {
                        "partOfSpeech": "noun",
                        "definitions": ["Persistent high inflation combined with high unemployment and stagnant demand."],
                        "example": "Analysts warned of renewed stagflation.",
                        "synonyms": ["economic stagnation"]
                      }
                    ]
                  }
                  """;

            var response = JsonSerializer.Serialize(new
            {
                model = "gpt-4.1-mini",
                choices = new[]
                {
                    new { message = new { content = innerJson } },
                },
                usage = new { prompt_tokens = 20, completion_tokens = 30, total_tokens = 50 },
            });
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(response, Encoding.UTF8, "application/json"),
            };
        }
    }
}
