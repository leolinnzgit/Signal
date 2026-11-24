using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed record ExtractedLocation(string Name, double Latitude, double Longitude);

public sealed record NewsMapArticle(
    string Id,
    string Kind,
    string Title,
    string LocationName,
    string Source,
    string Summary,
    string Url,
    string ImageUrl,
    string[] Topics,
    DateTime PublishedAtUtc,
    double Latitude,
    double Longitude,
    double? DistanceKm,
    bool IsRead,
    bool IsBookmarked);

public sealed record NewsMapResponse(
    NewsMapArticle[] Articles,
    int PendingCount,
    int TotalChecked,
    DateTime CheckedAtUtc,
    string? Warning = null);

public sealed partial class NewsLocationService(
    IHttpClientFactory clients,
    IMemoryCache cache,
    IOptions<AzureMapsOptions> mapsOptions,
    ILogger<NewsLocationService> logger,
    MicrosoftFoundryService? foundry = null,
    AzureLanguageEntityService? entityService = null)
{
    public const string GeocodeHttpClientName = "news-location-geocode";
    private const int ExtractionBatchSize = 20;
    private const int GeocodeConcurrency = 4;

    private static readonly ConcurrentDictionary<string, SemaphoreSlim> UserLocks = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _geocodeSemaphore = new(GeocodeConcurrency, GeocodeConcurrency);

    private static readonly HashSet<string> RejectedLocationTerms = new(StringComparer.OrdinalIgnoreCase)
    {
        "world", "global", "earth", "international", "worldwide", "online", "internet",
        "cyberspace", "space", "none", "null", "n/a", "na", "unknown", "various",
        "multiple", "anywhere", "everywhere", "nowhere", "unspecified", "remote",
        "planet", "globe", "universe"
    };

    private static readonly HashSet<string> PublisherSuffixKeywords = new(StringComparer.OrdinalIgnoreCase)
    {
        "news", "times", "post", "herald", "tribune", "globe", "chronicle", "journal",
        "telegraph", "guardian", "observer", "standard", "gazette", "mail", "mirror",
        "monitor", "press", "wire", "radio", "tv", "online", "digital", "media",
        "reuters", "bloomberg", "ap", "afp", "bbc", "cnn", "cnbc", "rnz", "stuff",
        "1news", "newshub", "abc", "nbc", "cbs", "fox", "npr", "pbs", "dw", "scmp",
        "associated press", "financial times", "wall street journal"
    };

    private static readonly string[] CityBearingPublishers =
    [
        "The New York Times", "New York Times", "The Washington Post", "Washington Post",
        "Sydney Morning Herald", "The Sydney Morning Herald", "South China Morning Post",
        "Los Angeles Times", "Chicago Tribune", "Boston Globe", "The Boston Globe",
        "Otago Daily Times", "NZ Herald", "New Zealand Herald", "The New Zealand Herald",
        "The Straits Times", "Straits Times", "The Japan Times", "Japan Times",
        "Taipei Times", "Miami Herald", "Dallas Morning News", "San Francisco Chronicle",
        "Philadelphia Inquirer", "London Evening Standard", "Evening Standard",
        "Manchester Evening News", "The Seattle Times", "Seattle Times",
        "The Denver Post", "Denver Post", "Houston Chronicle", "Bangkok Post",
        "The Manila Times", "Manila Times", "The Korea Herald", "Korea Herald",
        "The Korea Times", "Korea Times", "The Jerusalem Post", "Jerusalem Post",
        "Times of Israel", "The Moscow Times", "Moscow Times", "Kyiv Independent",
        "The Kyiv Independent", "Toronto Star", "The Globe and Mail"
    ];

    private sealed record GazetteerEntry(
        string CanonicalName,
        double Latitude,
        double Longitude,
        int Specificity, // 3 = city/landmark, 2 = region/state/waterway, 1 = country
        string[] LatinAliases,
        string[] UppercaseOnlyAliases,
        string[] CjkAliases);

    private static readonly GazetteerEntry[] BuiltInPlaces =
    [
        // New Zealand cities & landmarks
        new("Auckland, New Zealand", -36.8485, 174.7633, 3, ["Auckland", "Tāmaki Makaurau", "Tamaki Makaurau"], [], ["奥克兰"]),
        new("Wellington, New Zealand", -41.2865, 174.7762, 3, ["Wellington", "Te Whanganui-a-Tara"], [], ["惠灵顿"]),
        new("Christchurch, New Zealand", -43.5321, 172.6362, 3, ["Christchurch", "Ōtautahi", "Otautahi"], [], ["基督城", "克赖斯特彻奇"]),
        new("Hamilton, New Zealand", -37.7870, 175.2793, 3, ["Hamilton, New Zealand", "Hamilton, NZ", "Kirikiriroa"], [], ["汉密尔顿"]),
        new("Tauranga, New Zealand", -37.6878, 176.1651, 3, ["Tauranga"], [], ["陶朗加"]),
        new("Dunedin, New Zealand", -45.8788, 170.5028, 3, ["Dunedin", "Ōtepoti", "Otepoti"], [], ["但尼丁"]),
        new("Queenstown, New Zealand", -45.0312, 168.6626, 3, ["Queenstown"], [], ["皇后镇"]),
        new("Rotorua, New Zealand", -38.1368, 176.2497, 3, ["Rotorua"], [], ["罗托鲁瓦"]),
        new("Napier, New Zealand", -39.4928, 176.9120, 3, ["Napier"], [], []),
        new("Hastings, New Zealand", -39.6381, 176.8492, 3, ["Hastings, New Zealand", "Hastings, NZ"], [], []),
        new("Palmerston North, New Zealand", -40.3523, 175.6082, 3, ["Palmerston North"], [], []),
        new("Nelson, New Zealand", -41.2706, 173.2840, 3, ["Nelson, New Zealand", "Nelson, NZ"], [], []),
        new("New Plymouth, New Zealand", -39.0556, 174.0752, 3, ["New Plymouth"], [], []),
        new("Whangārei, New Zealand", -35.7275, 174.3166, 3, ["Whangārei", "Whangarei"], [], []),
        new("Invercargill, New Zealand", -46.4132, 168.3538, 3, ["Invercargill"], [], []),
        new("Gisborne, New Zealand", -38.6623, 178.0176, 3, ["Gisborne"], [], []),
        new("Taupō, New Zealand", -38.6857, 176.0702, 3, ["Taupō", "Taupo"], [], []),
        new("Cook Strait, New Zealand", -41.23, 174.48, 2, ["Cook Strait"], [], ["库克海峡"]),
        new("Waikato, New Zealand", -37.78, 175.28, 2, ["Waikato"], [], ["怀卡托"]),
        new("Canterbury, New Zealand", -43.53, 172.0, 2, ["Canterbury"], [], ["坎特伯雷"]),
        new("Otago, New Zealand", -45.4, 169.8, 2, ["Otago"], [], ["奥塔哥"]),
        new("Northland, New Zealand", -35.5, 173.9, 2, ["Northland"], [], []),
        new("Southland, New Zealand", -46.0, 168.2, 2, ["Southland"], [], []),
        new("Taranaki, New Zealand", -39.2, 174.1, 2, ["Taranaki"], [], []),
        new("Hawke's Bay, New Zealand", -39.5, 176.8, 2, ["Hawke's Bay", "Hawkes Bay"], [], []),
        new("Bay of Plenty, New Zealand", -37.8, 176.5, 2, ["Bay of Plenty"], [], []),
        new("New Zealand", -41.2865, 174.7762, 1, ["New Zealand", "Aotearoa"], ["NZ"], ["新西兰"]),

        // Australia & Pacific
        new("Sydney, Australia", -33.8688, 151.2093, 3, ["Sydney"], [], ["悉尼"]),
        new("Melbourne, Australia", -37.8136, 144.9631, 3, ["Melbourne"], [], ["墨尔本"]),
        new("Canberra, Australia", -35.2809, 149.1300, 3, ["Canberra"], [], ["堪培拉"]),
        new("Brisbane, Australia", -27.4698, 153.0251, 3, ["Brisbane"], [], ["布里斯班"]),
        new("Perth, Australia", -31.9505, 115.8605, 3, ["Perth"], [], ["珀斯"]),
        new("Adelaide, Australia", -34.9285, 138.6007, 3, ["Adelaide"], [], ["阿德莱德"]),
        new("Hobart, Australia", -42.8821, 147.3272, 3, ["Hobart"], [], []),
        new("Darwin, Australia", -12.4634, 130.8456, 3, ["Darwin, Australia"], [], []),
        new("Australia", -25.2744, 133.7751, 1, ["Australia"], [], ["澳大利亚", "澳洲"]),
        new("Suva, Fiji", -18.1416, 178.4419, 3, ["Suva"], [], []),
        new("Fiji", -17.7134, 178.0650, 1, ["Fiji"], [], ["斐济"]),
        new("Samoa", -13.7590, -172.1046, 1, ["Samoa"], [], ["萨摩亚"]),
        new("Tonga", -21.1789, -175.1982, 1, ["Tonga"], [], ["汤加"]),
        new("Papua New Guinea", -6.3150, 143.9555, 1, ["Papua New Guinea"], [], ["巴布亚新几内亚"]),

        // North America
        new("Washington, D.C., United States", 38.9072, -77.0369, 3, ["Washington, D.C.", "Washington DC", "Washington, DC"], [], ["华盛顿"]),
        new("New York City, United States", 40.7128, -74.0060, 3, ["New York City", "New York", "Manhattan", "Brooklyn"], [], ["纽约"]),
        new("Los Angeles, United States", 34.0522, -118.2437, 3, ["Los Angeles"], [], ["洛杉矶"]),
        new("San Francisco, United States", 37.7749, -122.4194, 3, ["San Francisco"], [], ["旧金山", "三藩市"]),
        new("Silicon Valley, United States", 37.3875, -122.0575, 3, ["Silicon Valley", "San Jose", "Palo Alto", "Mountain View", "Cupertino"], [], ["硅谷"]),
        new("Chicago, United States", 41.8781, -87.6298, 3, ["Chicago"], [], ["芝加哥"]),
        new("Boston, United States", 42.3601, -71.0589, 3, ["Boston"], [], ["波士顿"]),
        new("Seattle, United States", 47.6062, -122.3321, 3, ["Seattle"], [], ["西雅图"]),
        new("Austin, United States", 30.2672, -97.7431, 3, ["Austin, Texas", "Austin, TX"], [], ["奥斯汀"]),
        new("Houston, United States", 29.7604, -95.3698, 3, ["Houston"], [], ["休斯敦"]),
        new("Miami, United States", 25.7617, -80.1918, 3, ["Miami"], [], ["迈阿密"]),
        new("Atlanta, United States", 33.7490, -84.3880, 3, ["Atlanta"], [], ["亚特兰大"]),
        new("Denver, United States", 39.7392, -104.9903, 3, ["Denver"], [], ["丹佛"]),
        new("Philadelphia, United States", 39.9526, -75.1652, 3, ["Philadelphia"], [], ["费城"]),
        new("Detroit, United States", 42.3314, -83.0458, 3, ["Detroit"], [], ["底特律"]),
        new("Las Vegas, United States", 36.1699, -115.1398, 3, ["Las Vegas"], [], ["拉斯维加斯"]),
        new("Honolulu, United States", 21.3069, -157.8583, 3, ["Honolulu", "Maui"], [], ["檀香山"]),
        new("California, United States", 36.7783, -119.4179, 2, ["California"], [], ["加利福尼亚", "加州"]),
        new("Texas, United States", 31.9686, -99.9018, 2, ["Texas"], [], ["得克萨斯", "德州"]),
        new("Florida, United States", 27.6648, -81.5158, 2, ["Florida"], [], ["佛罗里达"]),
        new("Alaska, United States", 64.2008, -149.4937, 2, ["Alaska"], [], ["阿拉斯加"]),
        new("Hawaii, United States", 19.8968, -155.5828, 2, ["Hawaii"], [], ["夏威夷"]),
        new("United States", 39.8283, -98.5795, 1, ["United States", "United States of America"], ["US", "U.S.", "USA", "U.S.A."], ["美国"]),
        new("Ottawa, Canada", 45.4215, -75.6972, 3, ["Ottawa"], [], ["渥太华"]),
        new("Toronto, Canada", 43.6532, -79.3832, 3, ["Toronto"], [], ["多伦多"]),
        new("Vancouver, Canada", 49.2827, -123.1207, 3, ["Vancouver"], [], ["温哥华"]),
        new("Montreal, Canada", 45.5017, -73.5673, 3, ["Montreal", "Montréal"], [], ["蒙特利尔"]),
        new("Canada", 56.1304, -106.3468, 1, ["Canada"], [], ["加拿大"]),
        new("Mexico City, Mexico", 19.4326, -99.1332, 3, ["Mexico City"], [], ["墨西哥城"]),
        new("Mexico", 23.6345, -102.5528, 1, ["Mexico"], [], ["墨西哥"]),

        // South & Central America
        new("Brasília, Brazil", -15.7975, -47.8919, 3, ["Brasília", "Brasilia"], [], []),
        new("São Paulo, Brazil", -23.5505, -46.6333, 3, ["São Paulo", "Sao Paulo"], [], ["圣保罗"]),
        new("Rio de Janeiro, Brazil", -22.9068, -43.1729, 3, ["Rio de Janeiro"], [], ["里约热内卢"]),
        new("Brazil", -14.2350, -51.9253, 1, ["Brazil"], [], ["巴西"]),
        new("Buenos Aires, Argentina", -34.6037, -58.3816, 3, ["Buenos Aires"], [], ["布宜诺斯艾利斯"]),
        new("Argentina", -38.4161, -63.6167, 1, ["Argentina"], [], ["阿根廷"]),
        new("Santiago, Chile", -33.4489, -70.6693, 3, ["Santiago, Chile"], [], []),
        new("Chile", -35.6751, -71.5430, 1, ["Chile"], [], ["智利"]),
        new("Bogotá, Colombia", 4.7110, -74.0721, 3, ["Bogotá", "Bogota"], [], []),
        new("Colombia", 4.5709, -74.2973, 1, ["Colombia"], [], ["哥伦比亚"]),
        new("Lima, Peru", -12.0464, -77.0428, 3, ["Lima, Peru"], [], []),
        new("Peru", -9.1900, -75.0152, 1, ["Peru"], [], ["秘鲁"]),
        new("Caracas, Venezuela", 10.4806, -66.9036, 3, ["Caracas"], [], []),
        new("Venezuela", 6.4238, -66.5897, 1, ["Venezuela"], [], ["委内瑞拉"]),
        new("Panama Canal, Panama", 9.08, -79.68, 2, ["Panama Canal"], [], ["巴拿马运河"]),
        new("Panama", 8.5380, -80.7821, 1, ["Panama"], [], ["巴拿马"]),
        new("Cuba", 21.5218, -77.7812, 1, ["Cuba", "Havana"], [], ["古巴"]),

        // Europe
        new("London, United Kingdom", 51.5072, -0.1276, 3, ["London"], [], ["伦敦"]),
        new("Edinburgh, United Kingdom", 55.9533, -3.1883, 3, ["Edinburgh"], [], ["爱丁堡"]),
        new("Manchester, United Kingdom", 53.4808, -2.2426, 3, ["Manchester"], [], ["曼彻斯特"]),
        new("Belfast, United Kingdom", 54.5973, -5.9301, 3, ["Belfast"], [], []),
        new("Scotland, United Kingdom", 56.4907, -4.2026, 2, ["Scotland"], [], ["苏格兰"]),
        new("United Kingdom", 55.3781, -3.4360, 1, ["United Kingdom", "Britain", "Great Britain", "England"], ["UK", "U.K."], ["英国"]),
        new("Dublin, Ireland", 53.3498, -6.2603, 3, ["Dublin"], [], ["都柏林"]),
        new("Ireland", 53.1424, -7.6921, 1, ["Ireland"], [], ["爱尔兰"]),
        new("Paris, France", 48.8566, 2.3522, 3, ["Paris"], [], ["巴黎"]),
        new("France", 46.2276, 2.2137, 1, ["France"], [], ["法国"]),
        new("Berlin, Germany", 52.5200, 13.4050, 3, ["Berlin"], [], ["柏林"]),
        new("Munich, Germany", 48.1351, 11.5820, 3, ["Munich"], [], ["慕尼黑"]),
        new("Frankfurt, Germany", 50.1109, 8.6821, 3, ["Frankfurt"], [], ["法兰克福"]),
        new("Germany", 51.1657, 10.4515, 1, ["Germany"], [], ["德国"]),
        new("Rome, Italy", 41.9028, 12.4964, 3, ["Rome"], [], ["罗马"]),
        new("Milan, Italy", 45.4642, 9.1900, 3, ["Milan"], [], ["米兰"]),
        new("Italy", 41.8719, 12.5674, 1, ["Italy"], [], ["意大利"]),
        new("Madrid, Spain", 40.4168, -3.7038, 3, ["Madrid"], [], ["马德里"]),
        new("Barcelona, Spain", 41.3874, 2.1686, 3, ["Barcelona"], [], ["巴塞罗那"]),
        new("Spain", 40.4637, -3.7492, 1, ["Spain"], [], ["西班牙"]),
        new("Lisbon, Portugal", 38.7223, -9.1393, 3, ["Lisbon"], [], ["里斯本"]),
        new("Portugal", 39.3999, -8.2245, 1, ["Portugal"], [], ["葡萄牙"]),
        new("Brussels, Belgium", 50.8503, 4.3517, 3, ["Brussels"], [], ["布鲁塞尔"]),
        new("Belgium", 50.5039, 4.4699, 1, ["Belgium"], [], ["比利时"]),
        new("Amsterdam, Netherlands", 52.3676, 4.9041, 3, ["Amsterdam"], [], ["阿姆斯特丹"]),
        new("The Hague, Netherlands", 52.0705, 4.3007, 3, ["The Hague"], [], ["海牙"]),
        new("Netherlands", 52.1326, 5.2913, 1, ["Netherlands"], [], ["荷兰"]),
        new("Zurich, Switzerland", 47.3769, 8.5417, 3, ["Zurich", "Zürich"], [], ["苏黎世"]),
        new("Geneva, Switzerland", 46.2044, 6.1432, 3, ["Geneva"], [], ["日内瓦"]),
        new("Davos, Switzerland", 46.8027, 9.8360, 3, ["Davos"], [], ["达沃斯"]),
        new("Switzerland", 46.8182, 8.2275, 1, ["Switzerland"], [], ["瑞士"]),
        new("Vienna, Austria", 48.2082, 16.3738, 3, ["Vienna"], [], ["维也纳"]),
        new("Austria", 47.5162, 14.5501, 1, ["Austria"], [], ["奥地利"]),
        new("Warsaw, Poland", 52.2297, 21.0122, 3, ["Warsaw"], [], ["华沙"]),
        new("Poland", 51.9194, 19.1451, 1, ["Poland"], [], ["波兰"]),
        new("Stockholm, Sweden", 59.3293, 18.0686, 3, ["Stockholm"], [], ["斯德哥尔摩"]),
        new("Sweden", 60.1282, 18.6435, 1, ["Sweden"], [], ["瑞典"]),
        new("Oslo, Norway", 59.9139, 10.7522, 3, ["Oslo"], [], ["奥斯陆"]),
        new("Norway", 60.4720, 8.4689, 1, ["Norway"], [], ["挪威"]),
        new("Copenhagen, Denmark", 55.6761, 12.5683, 3, ["Copenhagen"], [], ["哥本哈根"]),
        new("Denmark", 56.2639, 9.5018, 1, ["Denmark"], [], ["丹麦"]),
        new("Greenland", 71.7069, -42.6043, 2, ["Greenland"], [], ["格陵兰"]),
        new("Helsinki, Finland", 60.1699, 24.9384, 3, ["Helsinki"], [], ["赫尔辛基"]),
        new("Finland", 61.9241, 25.7482, 1, ["Finland"], [], ["芬兰"]),
        new("Athens, Greece", 37.9838, 23.7275, 3, ["Athens"], [], ["雅典"]),
        new("Greece", 39.0742, 21.8243, 1, ["Greece"], [], ["希腊"]),
        new("Prague, Czechia", 50.0755, 14.4378, 3, ["Prague"], [], ["布拉格"]),
        new("Budapest, Hungary", 47.4979, 19.0402, 3, ["Budapest"], [], ["布达佩斯"]),
        new("Hungary", 47.1625, 19.5033, 1, ["Hungary"], [], ["匈牙利"]),
        new("Kyiv, Ukraine", 50.4501, 30.5234, 3, ["Kyiv", "Kiev"], [], ["基辅"]),
        new("Kharkiv, Ukraine", 49.9935, 36.2304, 3, ["Kharkiv"], [], ["哈尔科夫"]),
        new("Odesa, Ukraine", 46.4825, 30.7233, 3, ["Odesa", "Odessa"], [], ["敖德萨"]),
        new("Crimea", 45.3453, 34.4997, 2, ["Crimea"], [], ["克里米亚"]),
        new("Ukraine", 48.3794, 31.1656, 1, ["Ukraine"], [], ["乌克兰"]),
        new("Moscow, Russia", 55.7558, 37.6173, 3, ["Moscow"], [], ["莫斯科"]),
        new("St. Petersburg, Russia", 59.9311, 30.3609, 3, ["St. Petersburg", "Saint Petersburg"], [], ["圣彼得堡"]),
        new("Russia", 61.5240, 105.3188, 1, ["Russia"], [], ["俄罗斯"]),
        new("Istanbul, Türkiye", 41.0082, 28.9784, 3, ["Istanbul"], [], ["伊斯坦布尔"]),
        new("Ankara, Türkiye", 39.9334, 32.8597, 3, ["Ankara"], [], ["安卡拉"]),
        new("Türkiye", 38.9637, 35.2433, 1, ["Türkiye", "Turkiye", "in Turkey"], [], ["土耳其"]),

        // Middle East & Africa
        new("Jerusalem", 31.7683, 35.2137, 3, ["Jerusalem"], [], ["耶路撒冷"]),
        new("Tel Aviv, Israel", 32.0853, 34.7818, 3, ["Tel Aviv"], [], ["特拉维夫"]),
        new("Gaza Strip", 31.3547, 34.3088, 2, ["Gaza Strip", "Gaza City", "Gaza", "Rafah"], [], ["加沙"]),
        new("West Bank", 31.9466, 35.3027, 2, ["West Bank"], [], ["约旦河西岸"]),
        new("Israel", 31.0461, 34.8516, 1, ["Israel"], [], ["以色列"]),
        new("Tehran, Iran", 35.6892, 51.3890, 3, ["Tehran"], [], ["德黑兰"]),
        new("Strait of Hormuz", 26.5667, 56.2500, 2, ["Strait of Hormuz"], [], ["霍尔木兹海峡"]),
        new("Iran", 32.4279, 53.6880, 1, ["Iran"], [], ["伊朗"]),
        new("Beirut, Lebanon", 33.8938, 35.5018, 3, ["Beirut"], [], ["贝鲁特"]),
        new("Lebanon", 33.8547, 35.8623, 1, ["Lebanon"], [], ["黎巴嫩"]),
        new("Damascus, Syria", 33.5138, 36.2765, 3, ["Damascus"], [], ["大马士革"]),
        new("Syria", 34.8021, 38.9968, 1, ["Syria"], [], ["叙利亚"]),
        new("Baghdad, Iraq", 33.3152, 44.3661, 3, ["Baghdad"], [], ["巴格达"]),
        new("Iraq", 33.2232, 43.6793, 1, ["Iraq"], [], ["伊拉克"]),
        new("Riyadh, Saudi Arabia", 24.7136, 46.6753, 3, ["Riyadh"], [], ["利雅得"]),
        new("Saudi Arabia", 23.8859, 45.0792, 1, ["Saudi Arabia"], [], ["沙特阿拉伯", "沙特"]),
        new("Dubai, United Arab Emirates", 25.2048, 55.2708, 3, ["Dubai"], [], ["迪拜"]),
        new("Abu Dhabi, United Arab Emirates", 24.4539, 54.3773, 3, ["Abu Dhabi"], [], ["阿布扎比"]),
        new("United Arab Emirates", 23.4241, 53.8478, 1, ["United Arab Emirates"], ["UAE"], ["阿联酋"]),
        new("Doha, Qatar", 25.2854, 51.5310, 3, ["Doha"], [], ["多哈"]),
        new("Qatar", 25.3548, 51.1839, 1, ["Qatar"], [], ["卡塔尔"]),
        new("Red Sea", 20.0, 38.0, 2, ["Red Sea", "Bab el-Mandeb"], [], ["红海"]),
        new("Yemen", 15.5527, 48.5164, 1, ["Yemen", "Sanaa"], [], ["也门"]),
        new("Suez Canal, Egypt", 30.5852, 32.2654, 2, ["Suez Canal"], [], ["苏伊士运河"]),
        new("Cairo, Egypt", 30.0444, 31.2357, 3, ["Cairo"], [], ["开罗"]),
        new("Egypt", 26.8206, 30.8025, 1, ["Egypt"], [], ["埃及"]),
        new("Amman, Jordan", 31.9454, 35.9284, 3, ["Amman"], [], ["安曼"]),
        new("Jordan", 30.5852, 36.2384, 1, ["in Jordan", "Jordanian"], [], ["约旦"]),
        new("Johannesburg, South Africa", -26.2041, 28.0473, 3, ["Johannesburg"], [], ["约翰内斯堡"]),
        new("Cape Town, South Africa", -33.9249, 18.4241, 3, ["Cape Town"], [], ["开普敦"]),
        new("South Africa", -30.5595, 22.9375, 1, ["South Africa"], [], ["南非"]),
        new("Lagos, Nigeria", 6.5244, 3.3792, 3, ["Lagos"], [], ["拉各斯"]),
        new("Nigeria", 9.0820, 8.6753, 1, ["Nigeria"], [], ["尼日利亚"]),
        new("Nairobi, Kenya", -1.2921, 36.8219, 3, ["Nairobi"], [], ["内罗毕"]),
        new("Kenya", -0.0236, 37.9062, 1, ["Kenya"], [], ["肯尼亚"]),
        new("Sudan", 12.8628, 30.2176, 1, ["Sudan", "Khartoum"], [], ["苏丹"]),
        new("Ethiopia", 9.1450, 40.4897, 1, ["Ethiopia", "Addis Ababa"], [], ["埃塞俄比亚"]),

        // Asia
        new("Beijing, China", 39.9042, 116.4074, 3, ["Beijing"], [], ["北京"]),
        new("Shanghai, China", 31.2304, 121.4737, 3, ["Shanghai"], [], ["上海"]),
        new("Shenzhen, China", 22.5431, 114.0579, 3, ["Shenzhen"], [], ["深圳"]),
        new("Guangzhou, China", 23.1291, 113.2644, 3, ["Guangzhou"], [], ["广州"]),
        new("Hangzhou, China", 30.2741, 120.1551, 3, ["Hangzhou"], [], ["杭州"]),
        new("Chengdu, China", 30.5728, 104.0668, 3, ["Chengdu"], [], ["成都"]),
        new("Wuhan, China", 30.5928, 114.3055, 3, ["Wuhan"], [], ["武汉"]),
        new("Hong Kong", 22.3193, 114.1694, 3, ["Hong Kong"], [], ["香港"]),
        new("Macau", 22.1987, 113.5439, 3, ["Macau", "Macao"], [], ["澳门"]),
        new("South China Sea", 12.0, 114.0, 2, ["South China Sea"], [], ["南海"]),
        new("Taiwan Strait", 24.5, 119.5, 2, ["Taiwan Strait"], [], ["台湾海峡"]),
        new("China", 35.8617, 104.1954, 1, ["China"], [], ["中国"]),
        new("Taipei, Taiwan", 25.0330, 121.5654, 3, ["Taipei"], [], ["台北"]),
        new("Taiwan", 23.6978, 120.9605, 1, ["Taiwan"], [], ["台湾"]),
        new("Tokyo, Japan", 35.6762, 139.6503, 3, ["Tokyo"], [], ["东京"]),
        new("Osaka, Japan", 34.6937, 135.5023, 3, ["Osaka"], [], ["大阪"]),
        new("Kumamoto, Japan", 32.8032, 130.7079, 3, ["Kumamoto"], [], ["熊本"]),
        new("Japan", 36.2048, 138.2529, 1, ["Japan"], [], ["日本"]),
        new("Seoul, South Korea", 37.5665, 126.9780, 3, ["Seoul"], [], ["首尔"]),
        new("South Korea", 35.9078, 127.7669, 1, ["South Korea"], [], ["韩国"]),
        new("Pyongyang, North Korea", 39.0392, 125.7625, 3, ["Pyongyang"], [], ["平壤"]),
        new("North Korea", 40.3399, 127.5101, 1, ["North Korea"], [], ["朝鲜"]),
        new("Singapore", 1.3521, 103.8198, 3, ["Singapore"], [], ["新加坡"]),
        new("New Delhi, India", 28.6139, 77.2090, 3, ["New Delhi", "Delhi"], [], ["新德里"]),
        new("Mumbai, India", 19.0760, 72.8777, 3, ["Mumbai"], [], ["孟买"]),
        new("Bengaluru, India", 12.9716, 77.5946, 3, ["Bengaluru", "Bangalore"], [], ["班加罗尔"]),
        new("India", 20.5937, 78.9629, 1, ["India"], [], ["印度"]),
        new("Islamabad, Pakistan", 33.6844, 73.0479, 3, ["Islamabad"], [], []),
        new("Pakistan", 30.3753, 69.3451, 1, ["Pakistan"], [], ["巴基斯坦"]),
        new("Kabul, Afghanistan", 34.5553, 69.2075, 3, ["Kabul"], [], []),
        new("Afghanistan", 33.9391, 67.7100, 1, ["Afghanistan"], [], ["阿富汗"]),
        new("Jakarta, Indonesia", -6.2088, 106.8456, 3, ["Jakarta"], [], ["雅加达"]),
        new("Indonesia", -0.7893, 113.9213, 1, ["Indonesia"], [], ["印度尼西亚", "印尼"]),
        new("Bangkok, Thailand", 13.7563, 100.5018, 3, ["Bangkok"], [], ["曼谷"]),
        new("Thailand", 15.8700, 100.9925, 1, ["Thailand"], [], ["泰国"]),
        new("Hanoi, Vietnam", 21.0278, 105.8342, 3, ["Hanoi"], [], ["河内"]),
        new("Vietnam", 14.0583, 108.2772, 1, ["Vietnam"], [], ["越南"]),
        new("Manila, Philippines", 14.5995, 120.9842, 3, ["Manila"], [], ["马尼拉"]),
        new("Philippines", 12.8797, 121.7740, 1, ["Philippines"], [], ["菲律宾"]),
        new("Kuala Lumpur, Malaysia", 3.1390, 101.6869, 3, ["Kuala Lumpur"], [], ["吉隆坡"]),
        new("Malaysia", 4.2105, 101.9758, 1, ["Malaysia"], [], ["马来西亚"]),
        new("Myanmar", 21.9162, 95.9560, 1, ["Myanmar"], [], ["缅甸"]),
        new("Bangladesh", 23.6850, 90.3563, 1, ["Bangladesh", "Dhaka"], [], ["孟加拉国"]),
        new("Republic of Georgia", 42.3154, 43.3569, 1, ["Republic of Georgia", "Tbilisi"], [], ["格鲁吉亚"]),
    ];

    private static readonly Dictionary<string, GazetteerEntry> BuiltInLookup = BuildLookup();

    private static Dictionary<string, GazetteerEntry> BuildLookup()
    {
        var map = new Dictionary<string, GazetteerEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in BuiltInPlaces)
        {
            map.TryAdd(entry.CanonicalName, entry);
            foreach (var alias in entry.LatinAliases)
                map.TryAdd(alias, entry);
            foreach (var alias in entry.UppercaseOnlyAliases)
                map.TryAdd(alias, entry);
            foreach (var alias in entry.CjkAliases)
                map.TryAdd(alias, entry);
        }
        return map;
    }

    public async Task<NewsMapResponse> GetMappedNewsAsync(
        SignalDbContext database,
        string userId,
        double? userLat,
        double? userLon,
        string? topicFilter,
        int limit,
        CancellationToken cancellationToken)
    {
        var hasUserLocation = userLat.HasValue && userLon.HasValue && EarthquakeFeed.ValidLocation(userLat.Value, userLon.Value);
        var normalizedTopic = string.IsNullOrWhiteSpace(topicFilter) ? "" : topicFilter.Trim();
        var clampedLimit = Math.Clamp(limit, 1, 120);

        var userLock = UserLocks.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await userLock.WaitAsync(cancellationToken);
        int pendingCount = 0;
        int totalChecked = 0;
        string? warning = null;
        List<StoredNewsArticle> deduplicated;

        try
        {
            var cutoff = DateTime.UtcNow.AddDays(-14);
            var recent = await database.StoredNewsArticles
                .Where(item => item.UserId == userId && item.PublishedAtUtc >= cutoff)
                .OrderByDescending(item => item.PublishedAtUtc)
                .Take(120)
                .ToListAsync(cancellationToken);

            if (recent.Count < 20)
            {
                recent = await database.StoredNewsArticles
                    .Where(item => item.UserId == userId)
                    .OrderByDescending(item => item.PublishedAtUtc)
                    .Take(120)
                    .ToListAsync(cancellationToken);
            }

            deduplicated = DeduplicateArticles(recent);
            if (normalizedTopic.Length > 0)
            {
                deduplicated = deduplicated
                    .Where(item => DeserializeList(item.TopicsJson)
                        .Any(t => string.Equals(t, normalizedTopic, StringComparison.OrdinalIgnoreCase)))
                    .ToList();
            }

            totalChecked = deduplicated.Count;
            var unextracted = deduplicated
                .Where(item => item.LocationExtractedAtUtc is null)
                .ToArray();

            if (unextracted.Length > 0)
            {
                var toProcess = unextracted.Take(30).ToArray();
                try
                {
                    await ExtractAndSaveAsync(database, toProcess, TimeSpan.FromSeconds(10), cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "News location extraction encountered an issue for user {UserId}.", userId);
                    warning = "Some story locations are still loading.";
                }

                pendingCount = deduplicated.Count(item => item.LocationExtractedAtUtc is null);
            }
        }
        finally
        {
            userLock.Release();
        }

        var mapped = deduplicated
            .Where(item => !string.IsNullOrWhiteSpace(item.LocationName)
                && item.LocationLatitude.HasValue
                && item.LocationLongitude.HasValue
                && EarthquakeFeed.ValidLocation(item.LocationLatitude.Value, item.LocationLongitude.Value))
            .Take(clampedLimit)
            .Select(item =>
            {
                var lat = item.LocationLatitude!.Value;
                var lon = item.LocationLongitude!.Value;
                double? distanceKm = hasUserLocation
                    ? EarthquakeFeed.DistanceKm(userLat!.Value, userLon!.Value, lat, lon)
                    : null;
                return new NewsMapArticle(
                    Id: $"news:{item.Id}",
                    Kind: "news",
                    Title: item.Title,
                    LocationName: item.LocationName,
                    Source: item.Source,
                    Summary: item.Summary,
                    Url: item.Url,
                    ImageUrl: item.ImageUrl,
                    Topics: DeserializeList(item.TopicsJson),
                    PublishedAtUtc: DateTime.SpecifyKind(item.PublishedAtUtc, DateTimeKind.Utc),
                    Latitude: lat,
                    Longitude: lon,
                    DistanceKm: distanceKm,
                    IsRead: item.IsRead,
                    IsBookmarked: item.IsBookmarked);
            })
            .ToArray();

        return new NewsMapResponse(mapped, pendingCount, totalChecked, DateTime.UtcNow, warning);
    }

    public async Task<int> ExtractAndSaveAsync(
        SignalDbContext database,
        IReadOnlyList<StoredNewsArticle> articles,
        TimeSpan timeBudget,
        CancellationToken cancellationToken)
    {
        var pending = articles.Where(item => item.LocationExtractedAtUtc is null).ToList();
        if (pending.Count == 0) return 0;

        using var budgetCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (timeBudget > TimeSpan.Zero)
            budgetCts.CancelAfter(timeBudget);

        var updatedCount = 0;
        var now = DateTime.UtcNow;

        foreach (var batch in pending.Chunk(ExtractionBatchSize))
        {
            if (budgetCts.IsCancellationRequested) break;

            string?[] extractedNames;
            bool transientFailure;
            try
            {
                (extractedNames, transientFailure) = await ExtractLocationsForBatchAsync(batch, budgetCts.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                break;
            }

            if (transientFailure)
            {
                // Fallback already attempted inside ExtractLocationsForBatchAsync when possible;
                // if still marked transient, do not stamp LocationExtractedAtUtc.
                continue;
            }

            var resolved = new ExtractedLocation?[batch.Length];
            var tasks = Enumerable.Range(0, batch.Length).Select(async index =>
            {
                var name = NormalizeLocationName(extractedNames[index]);
                if (name is null) return;
                resolved[index] = await GeocodeAsync(name, budgetCts.Token);
            });

            try
            {
                await Task.WhenAll(tasks);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // Partial results within batch may still be valid if resolved before timeout.
            }

            for (var i = 0; i < batch.Length; i++)
            {
                var article = batch[i];
                var geo = resolved[i];
                if (geo is not null && EarthquakeFeed.ValidLocation(geo.Latitude, geo.Longitude))
                {
                    article.LocationName = geo.Name.Length > 160 ? geo.Name[..160] : geo.Name;
                    article.LocationLatitude = geo.Latitude;
                    article.LocationLongitude = geo.Longitude;
                }
                else
                {
                    article.LocationName = "";
                    article.LocationLatitude = null;
                    article.LocationLongitude = null;
                }
                article.LocationExtractedAtUtc = now;
                updatedCount++;
            }
        }

        if (updatedCount > 0)
        {
            await database.SaveChangesAsync(cancellationToken);
        }

        return updatedCount;
    }

    private async Task<(string?[] Locations, bool TransientFailure)> ExtractLocationsForBatchAsync(
        IReadOnlyList<StoredNewsArticle> batch,
        CancellationToken cancellationToken)
    {
        var results = new string?[batch.Count];

        // Tier 1: Microsoft Foundry LLM batch extraction
        if (foundry is { Enabled: true })
        {
            try
            {
                var items = batch.Select((article, index) => new
                {
                    id = index,
                    title = StripPublisherAttribution(article.Title, article.Source),
                    summary = StripKnownPublishers(article.Summary).Length > 350
                        ? StripKnownPublishers(article.Summary)[..350]
                        : StripKnownPublishers(article.Summary),
                    source = article.Source
                }).ToArray();

                var messages = new[]
                {
                    new FoundryMessage(
                        "system",
                        """
                        You extract the single main geographic location where each news story primarily takes place.
                        Rules:
                        - Return a JSON object: {"items":[{"id":0,"location":"City, Country"}]}
                        - Include one entry for every input id.
                        - Use standardized English place names, e.g. "Auckland, New Zealand", "Kyiv, Ukraine", "Washington, D.C., United States", or "China" if only a country is clear.
                        - Set "location" to null if the story has no clear primary geographic location (e.g. general software/AI product launches, health advice, broad global market commentary, or purely abstract topics).
                        - NEVER extract a location from the publisher or newspaper name (e.g. "New York Times", "Washington Post", "Sydney Morning Herald", "South China Morning Post", "NZ Herald", "Otago Daily Times").
                        """),
                    new FoundryMessage(
                        "user",
                        JsonSerializer.Serialize(new { articles = items }))
                };

                var chat = await foundry.CompleteChatAsync(
                    messages,
                    new FoundryChatOptions(Temperature: 0.1, MaxTokens: 1400, JsonObjectResponse: true, Deployment: null),
                    cancellationToken);

                var parsed = ParseFoundryBatchResponse(chat.Content);
                if (parsed.Count > 0)
                {
                    for (var i = 0; i < batch.Count; i++)
                    {
                        parsed.TryGetValue(i.ToString(CultureInfo.InvariantCulture), out results[i]);
                    }
                    return (results, false);
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Foundry batch location extraction fell back to NER/heuristics.");
            }
        }

        // Tier 2: Azure AI Language Entity Recognition (up to 8 articles per batch)
        if (entityService is { Enabled: true })
        {
            for (var i = 0; i < batch.Count; i++)
            {
                if (i < 8)
                {
                    var article = batch[i];
                    var cleanedTitle = StripPublisherAttribution(article.Title, article.Source);
                    var cleanedSummary = StripKnownPublishers(article.Summary);
                    var text = string.IsNullOrWhiteSpace(cleanedSummary)
                        ? cleanedTitle
                        : $"{cleanedTitle}\n\n{cleanedSummary}";

                    if (text.Length >= 30)
                    {
                        try
                        {
                            var ner = await entityService.ExtractEntitiesAsync(text, cancellationToken);
                            if (ner.Available)
                            {
                                var bestLoc = PickBestNerLocation(ner.Entities, cleanedTitle, article.Source);
                                if (bestLoc is not null)
                                {
                                    results[i] = bestLoc;
                                    continue;
                                }
                            }
                        }
                        catch (OperationCanceledException)
                        {
                            throw;
                        }
                        catch (Exception ex)
                        {
                            logger.LogDebug(ex, "Azure NER location fallback skipped for article.");
                        }
                    }
                }

                results[i] = ExtractHeuristicLocation(batch[i].Title, batch[i].Summary, batch[i].Source);
            }
            return (results, false);
        }

        // Tier 3: Deterministic heuristic gazetteer extractor
        for (var i = 0; i < batch.Count; i++)
        {
            results[i] = ExtractHeuristicLocation(batch[i].Title, batch[i].Summary, batch[i].Source);
        }
        return (results, false);
    }

    private static string? PickBestNerLocation(
        RecognizedEntity[] entities,
        string cleanedTitle,
        string source)
    {
        var candidates = entities
            .Where(e => string.Equals(e.Category, "Location", StringComparison.OrdinalIgnoreCase)
                && e.ConfidenceScore >= 0.72)
            .Select(e => new { Entity = e, Normalized = NormalizeLocationName(e.Text) })
            .Where(x => x.Normalized is not null
                && !string.Equals(x.Normalized, source, StringComparison.OrdinalIgnoreCase)
                && !source.Contains(x.Normalized, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(x =>
            {
                var score = x.Entity.ConfidenceScore;
                if (cleanedTitle.Contains(x.Entity.Text, StringComparison.OrdinalIgnoreCase)) score += 0.35;
                if (string.Equals(x.Entity.Subcategory, "GPE", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(x.Entity.Subcategory, "City", StringComparison.OrdinalIgnoreCase)) score += 0.2;
                else if (string.Equals(x.Entity.Subcategory, "CountryRegion", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(x.Entity.Subcategory, "State", StringComparison.OrdinalIgnoreCase)) score += 0.1;
                return score;
            })
            .ToArray();

        return candidates.FirstOrDefault()?.Normalized;
    }

    public async Task<ExtractedLocation?> GeocodeAsync(string locationName, CancellationToken cancellationToken)
    {
        var normalized = NormalizeLocationName(locationName);
        if (normalized is null) return null;

        if (TryLookupBuiltIn(normalized, out var builtIn) && builtIn is not null)
            return builtIn;

        var cacheKey = $"news-geocode:{normalized.ToLowerInvariant()}";
        if (cache.TryGetValue(cacheKey, out CachedGeocodeEntry? cached) && cached is not null)
            return cached.Location;

        await _geocodeSemaphore.WaitAsync(cancellationToken);
        try
        {
            if (cache.TryGetValue(cacheKey, out cached) && cached is not null)
                return cached.Location;

            ExtractedLocation? result = null;
            SplitLocationQuery(normalized, out var primary, out var qualifier);

            // 1. Open-Meteo Geocoding API
            try
            {
                var client = clients.CreateClient(GeocodeHttpClientName);
                var openMeteoUrl = $"https://geocoding-api.open-meteo.com/v1/search?name={Uri.EscapeDataString(primary)}&count=10&language=en&format=json";
                using var request = new HttpRequestMessage(HttpMethod.Get, openMeteoUrl);
                request.Headers.Accept.ParseAdd("application/json");
                using var response = await client.SendAsync(request, cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    var raw = await response.Content.ReadAsStringAsync(cancellationToken);
                    result = ParseOpenMeteoGeocodeResponse(raw, normalized, qualifier);
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
            {
                logger.LogDebug(ex, "Open-Meteo geocoding failed for {Location}.", normalized);
            }

            // 2. Azure Maps Geocoding fallback if configured
            if (result is null && mapsOptions.Value.Enabled)
            {
                try
                {
                    var client = clients.CreateClient(GeocodeHttpClientName);
                    var azureUrl = $"https://atlas.microsoft.com/geocode?api-version=2025-01-01&query={Uri.EscapeDataString(normalized)}";
                    using var request = new HttpRequestMessage(HttpMethod.Get, azureUrl);
                    request.Headers.Add("subscription-key", mapsOptions.Value.SubscriptionKey.Trim());
                    request.Headers.Accept.ParseAdd("application/json");
                    using var response = await client.SendAsync(request, cancellationToken);
                    if (response.IsSuccessStatusCode)
                    {
                        var raw = await response.Content.ReadAsStringAsync(cancellationToken);
                        result = ParseAzureMapsGeocodeResponse(raw, normalized);
                    }
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
                {
                    logger.LogDebug(ex, "Azure Maps geocoding failed for {Location}.", normalized);
                }
            }

            cache.Set(
                cacheKey,
                new CachedGeocodeEntry(result),
                result is not null ? TimeSpan.FromHours(24) : TimeSpan.FromMinutes(30));
            return result;
        }
        finally
        {
            _geocodeSemaphore.Release();
        }
    }

    public static bool TryLookupBuiltIn(string query, out ExtractedLocation? location)
    {
        var normalized = NormalizeLocationName(query);
        if (normalized is null)
        {
            location = null;
            return false;
        }

        if (BuiltInLookup.TryGetValue(normalized, out var direct))
        {
            location = new ExtractedLocation(direct.CanonicalName, direct.Latitude, direct.Longitude);
            return true;
        }

        SplitLocationQuery(normalized, out var primary, out var qualifier);
        if (qualifier is not null && BuiltInLookup.TryGetValue(primary, out var primaryMatch))
        {
            if (primaryMatch.CanonicalName.Contains(qualifier, StringComparison.OrdinalIgnoreCase)
                || MatchesCountryAlias(primaryMatch.CanonicalName, qualifier))
            {
                location = new ExtractedLocation(primaryMatch.CanonicalName, primaryMatch.Latitude, primaryMatch.Longitude);
                return true;
            }
        }

        location = null;
        return false;
    }

    public static string StripPublisherAttribution(string title, string source)
    {
        var cleaned = StripKnownPublishers(title ?? "");
        var trimmedSource = (source ?? "").Trim();

        // Remove trailing " - Publisher", " | Publisher", " — Publisher"
        var separatorMatch = TrailingAttributionRegex().Match(cleaned);
        if (separatorMatch.Success)
        {
            var suffix = separatorMatch.Groups["pub"].Value.Trim();
            var matchesSource = trimmedSource.Length >= 2
                && (suffix.Contains(trimmedSource, StringComparison.OrdinalIgnoreCase)
                    || trimmedSource.Contains(suffix, StringComparison.OrdinalIgnoreCase));
            var looksLikePublisher = PublisherSuffixKeywords.Any(kw =>
                ContainsWord(suffix, kw, ignoreCase: true));

            if (matchesSource || looksLikePublisher)
            {
                cleaned = cleaned[..separatorMatch.Index].Trim();
            }
        }

        if (trimmedSource.Length >= 4)
        {
            cleaned = Regex.Replace(
                cleaned,
                Regex.Escape(trimmedSource),
                " ",
                RegexOptions.IgnoreCase,
                TimeSpan.FromMilliseconds(200));
        }

        return CollapseSpaces(cleaned);
    }

    private static string StripKnownPublishers(string text)
    {
        var result = text ?? "";
        foreach (var publisher in CityBearingPublishers)
        {
            if (result.Contains(publisher, StringComparison.OrdinalIgnoreCase))
            {
                result = Regex.Replace(
                    result,
                    Regex.Escape(publisher),
                    " ",
                    RegexOptions.IgnoreCase,
                    TimeSpan.FromMilliseconds(200));
            }
        }
        return CollapseSpaces(result);
    }

    public static string? NormalizeLocationName(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        var cleaned = raw.Trim().Trim('"', '\'', '“', '”', '‘', '’', '(', ')');
        cleaned = cleaned.TrimEnd(',', ';', ':', '!', '?').Trim();
        if (cleaned.EndsWith('.') && !(cleaned.Length >= 3 && char.IsLetter(cleaned[^2]) && cleaned[^3] == '.'))
            cleaned = cleaned.TrimEnd('.');
        cleaned = CollapseSpaces(cleaned);

        if (cleaned.Length is < 2 or > 120) return null;
        if (cleaned.Any(char.IsControl)) return null;
        if (RejectedLocationTerms.Contains(cleaned)) return null;
        if (cleaned.All(c => char.IsDigit(c) || char.IsPunctuation(c) || char.IsWhiteSpace(c))) return null;

        if (cleaned.Equals("U.S.", StringComparison.OrdinalIgnoreCase)
            || cleaned.Equals("U.S", StringComparison.OrdinalIgnoreCase)
            || cleaned.Equals("USA", StringComparison.OrdinalIgnoreCase)
            || cleaned.Equals("U.S.A.", StringComparison.OrdinalIgnoreCase)
            || cleaned.Equals("U.S.A", StringComparison.OrdinalIgnoreCase))
            return "United States";

        if (cleaned.Equals("U.K.", StringComparison.OrdinalIgnoreCase)
            || cleaned.Equals("U.K", StringComparison.OrdinalIgnoreCase)
            || cleaned.Equals("UK", StringComparison.OrdinalIgnoreCase))
            return "United Kingdom";

        return cleaned;
    }

    public static string? ExtractHeuristicLocation(string title, string summary, string source)
    {
        var cleanTitle = StripPublisherAttribution(title, source);
        var cleanSummary = StripKnownPublishers(summary ?? "");
        if (!string.IsNullOrWhiteSpace(source) && source.Trim().Length >= 4)
        {
            cleanSummary = Regex.Replace(
                cleanSummary,
                Regex.Escape(source.Trim()),
                " ",
                RegexOptions.IgnoreCase,
                TimeSpan.FromMilliseconds(200));
        }

        var datelineText = "";
        var datelineMatch = DatelineRegex().Match(cleanSummary.TrimStart());
        if (datelineMatch.Success)
        {
            datelineText = datelineMatch.Groups["place"].Value.Trim();
        }

        GazetteerEntry? best = null;
        double bestScore = 0;

        foreach (var entry in BuiltInPlaces)
        {
            var titleHits = CountPlaceMatches(cleanTitle, entry, out var titleEarliest);
            var summaryHits = CountPlaceMatches(cleanSummary, entry, out var summaryEarliest);
            var datelineHits = datelineText.Length > 0 ? CountPlaceMatches(datelineText, entry, out _) : 0;

            if (titleHits == 0 && summaryHits == 0 && datelineHits == 0)
                continue;

            var score = (titleHits * 8.0 * entry.Specificity)
                + (datelineHits * 14.0 * entry.Specificity)
                + (summaryHits * 3.0 * entry.Specificity);

            // Slight boost for earlier appearance in the title/summary
            if (titleHits > 0) score += Math.Max(0, 2.0 - titleEarliest / 100.0);
            else if (summaryHits > 0) score += Math.Max(0, 1.0 - summaryEarliest / 200.0);

            if (score > bestScore
                || (Math.Abs(score - bestScore) < 0.001 && best is not null && entry.Specificity > best.Specificity))
            {
                bestScore = score;
                best = entry;
            }
        }

        return best?.CanonicalName;
    }

    public static Dictionary<string, string?> ParseFoundryBatchResponse(string rawJson)
    {
        var output = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(rawJson)) return output;

        var trimmed = rawJson.Trim();
        if (trimmed.StartsWith("```", StringComparison.Ordinal))
        {
            var firstNewline = trimmed.IndexOf('\n');
            if (firstNewline >= 0) trimmed = trimmed[(firstNewline + 1)..];
            var lastFence = trimmed.LastIndexOf("```", StringComparison.Ordinal);
            if (lastFence >= 0) trimmed = trimmed[..lastFence];
            trimmed = trimmed.Trim();
        }

        try
        {
            using var doc = JsonDocument.Parse(trimmed);
            var root = doc.RootElement;
            JsonElement itemsElement;
            if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("items", out var prop) && prop.ValueKind == JsonValueKind.Array)
            {
                itemsElement = prop;
            }
            else if (root.ValueKind == JsonValueKind.Array)
            {
                itemsElement = root;
            }
            else
            {
                return output;
            }

            foreach (var item in itemsElement.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                if (!item.TryGetProperty("id", out var idEl)) continue;

                var idKey = idEl.ValueKind switch
                {
                    JsonValueKind.Number => idEl.GetRawText(),
                    JsonValueKind.String => (idEl.GetString() ?? "").Trim(),
                    _ => ""
                };
                if (idKey.Length == 0) continue;

                string? loc = null;
                if (item.TryGetProperty("location", out var locEl) && locEl.ValueKind == JsonValueKind.String)
                {
                    loc = NormalizeLocationName(locEl.GetString());
                }
                output[idKey] = loc;
            }
        }
        catch (JsonException)
        {
            return [];
        }

        return output;
    }

    public static ExtractedLocation? ParseOpenMeteoGeocodeResponse(
        string rawJson,
        string originalQuery,
        string? qualifier = null)
    {
        if (string.IsNullOrWhiteSpace(rawJson)) return null;

        try
        {
            using var doc = JsonDocument.Parse(rawJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("results", out var results)
                || results.ValueKind != JsonValueKind.Array)
                return null;

            var candidates = new List<(string Name, double Lat, double Lon, long Population, bool MatchesQualifier)>();
            foreach (var item in results.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                if (!item.TryGetProperty("latitude", out var latEl) || !latEl.TryGetDouble(out var lat)) continue;
                if (!item.TryGetProperty("longitude", out var lonEl) || !lonEl.TryGetDouble(out var lon)) continue;
                if (!EarthquakeFeed.ValidLocation(lat, lon)) continue;

                var name = item.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? (n.GetString() ?? "").Trim() : "";
                var country = item.TryGetProperty("country", out var c) && c.ValueKind == JsonValueKind.String ? (c.GetString() ?? "").Trim() : "";
                var countryCode = item.TryGetProperty("country_code", out var cc) && cc.ValueKind == JsonValueKind.String ? (cc.GetString() ?? "").Trim() : "";
                var admin1 = item.TryGetProperty("admin1", out var a1) && a1.ValueKind == JsonValueKind.String ? (a1.GetString() ?? "").Trim() : "";
                var pop = item.TryGetProperty("population", out var p) && p.TryGetInt64(out var pv) ? pv : 0L;

                var matchesQualifier = true;
                if (!string.IsNullOrWhiteSpace(qualifier))
                {
                    var q = qualifier.Trim();
                    matchesQualifier =
                        country.Equals(q, StringComparison.OrdinalIgnoreCase)
                        || countryCode.Equals(q, StringComparison.OrdinalIgnoreCase)
                        || admin1.Equals(q, StringComparison.OrdinalIgnoreCase)
                        || MatchesCountryAlias(country, q)
                        || country.Contains(q, StringComparison.OrdinalIgnoreCase)
                        || admin1.Contains(q, StringComparison.OrdinalIgnoreCase);
                }

                var displayName = !string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(country) && !name.Equals(country, StringComparison.OrdinalIgnoreCase)
                    ? $"{name}, {country}"
                    : (!string.IsNullOrEmpty(name) ? name : originalQuery);

                candidates.Add((displayName, lat, lon, pop, matchesQualifier));
            }

            if (candidates.Count == 0) return null;

            var best = candidates
                .Where(c => c.MatchesQualifier)
                .OrderByDescending(c => c.Population)
                .FirstOrDefault();

            if (best == default)
            {
                if (!string.IsNullOrWhiteSpace(qualifier)) return null;
                best = candidates.OrderByDescending(c => c.Population).First();
            }

            return new ExtractedLocation(best.Name, best.Lat, best.Lon);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static ExtractedLocation? ParseAzureMapsGeocodeResponse(string rawJson, string displayName = "")
    {
        if (string.IsNullOrWhiteSpace(rawJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(rawJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("features", out var features)
                || features.ValueKind != JsonValueKind.Array)
                return null;

            foreach (var feature in features.EnumerateArray())
            {
                if (feature.ValueKind != JsonValueKind.Object
                    || !feature.TryGetProperty("geometry", out var geometry)
                    || geometry.ValueKind != JsonValueKind.Object
                    || !geometry.TryGetProperty("coordinates", out var coords)
                    || coords.ValueKind != JsonValueKind.Array
                    || coords.GetArrayLength() < 2)
                    continue;

                if (!coords[0].TryGetDouble(out var lon) || !coords[1].TryGetDouble(out var lat))
                    continue;
                if (!EarthquakeFeed.ValidLocation(lat, lon))
                    continue;

                var label = displayName;
                if (string.IsNullOrWhiteSpace(label)
                    && feature.TryGetProperty("properties", out var props)
                    && props.TryGetProperty("address", out var addr)
                    && addr.TryGetProperty("formattedAddress", out var formatted)
                    && formatted.ValueKind == JsonValueKind.String)
                {
                    label = formatted.GetString() ?? "";
                }

                return new ExtractedLocation(string.IsNullOrWhiteSpace(label) ? "Location" : label.Trim(), lat, lon);
            }

            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static List<StoredNewsArticle> DeduplicateArticles(IReadOnlyList<StoredNewsArticle> items)
    {
        var seenStoryKeys = new HashSet<string>(StringComparer.Ordinal);
        var seenHeadlineKeys = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<StoredNewsArticle>(items.Count);

        foreach (var item in items)
        {
            var storyKey = ArticleIdentity.GetStoryUrlKey(item.Url);
            var headlineKey = ArticleIdentity.GetHeadlineKey(item.Title);

            if ((storyKey.Length > 0 && !seenStoryKeys.Add(storyKey))
                || (headlineKey.Length > 0 && !seenHeadlineKeys.Add(headlineKey)))
            {
                continue;
            }

            result.Add(item);
        }

        return result;
    }

    private static string[] DeserializeList(string json)
    {
        try { return JsonSerializer.Deserialize<string[]>(json) ?? []; }
        catch (JsonException) { return []; }
    }

    private static void SplitLocationQuery(string normalized, out string primary, out string? qualifier)
    {
        var commaIndex = normalized.IndexOf(',');
        if (commaIndex > 0)
        {
            primary = normalized[..commaIndex].Trim();
            var rest = normalized[(commaIndex + 1)..].Trim();
            qualifier = rest.Length > 0 ? rest : null;
        }
        else
        {
            primary = normalized;
            qualifier = null;
        }
    }

    private static bool MatchesCountryAlias(string country, string qualifier)
    {
        var q = qualifier.Trim().ToLowerInvariant();
        var c = country.Trim().ToLowerInvariant();
        return (q is "us" or "u.s." or "usa" && c is "united states" or "united states of america")
            || (q is "uk" or "u.k." or "britain" && c is "united kingdom")
            || (q is "nz" && c is "new zealand")
            || (q is "uae" && c is "united arab emirates");
    }

    private static int CountPlaceMatches(string text, GazetteerEntry entry, out int earliestIndex)
    {
        earliestIndex = int.MaxValue;
        if (string.IsNullOrWhiteSpace(text)) return 0;

        var total = 0;
        foreach (var alias in entry.LatinAliases)
        {
            total += CountWordOccurrences(text, alias, ignoreCase: true, ref earliestIndex);
        }
        foreach (var alias in entry.UppercaseOnlyAliases)
        {
            total += CountWordOccurrences(text, alias, ignoreCase: false, ref earliestIndex);
        }
        foreach (var alias in entry.CjkAliases)
        {
            var idx = 0;
            while ((idx = text.IndexOf(alias, idx, StringComparison.Ordinal)) >= 0)
            {
                total++;
                if (idx < earliestIndex) earliestIndex = idx;
                idx += alias.Length;
            }
        }
        return total;
    }

    private static int CountWordOccurrences(string text, string alias, bool ignoreCase, ref int earliestIndex)
    {
        var count = 0;
        var comparison = ignoreCase ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var idx = 0;
        while ((idx = text.IndexOf(alias, idx, comparison)) >= 0)
        {
            var beforeOk = idx == 0 || !char.IsLetterOrDigit(text[idx - 1]);
            var end = idx + alias.Length;
            var afterOk = end >= text.Length || !char.IsLetterOrDigit(text[end]);
            if (beforeOk && afterOk)
            {
                count++;
                if (idx < earliestIndex) earliestIndex = idx;
            }
            idx += alias.Length;
        }
        return count;
    }

    private static bool ContainsWord(string text, string word, bool ignoreCase)
    {
        var dummy = int.MaxValue;
        return CountWordOccurrences(text, word, ignoreCase, ref dummy) > 0;
    }

    private static string CollapseSpaces(string value) =>
        string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    private sealed record CachedGeocodeEntry(ExtractedLocation? Location);

    [GeneratedRegex(@"\s+(?:-|–|—|\|)\s+(?<pub>[^-|–—|]{2,60})$", RegexOptions.Compiled)]
    private static partial Regex TrailingAttributionRegex();

    [GeneratedRegex(@"^(?<place>[A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ\s,'.-]{1,40})\s*(?:\([^)]{2,30}\)\s*)?(?:—|–|-|:)", RegexOptions.Compiled)]
    private static partial Regex DatelineRegex();
}
