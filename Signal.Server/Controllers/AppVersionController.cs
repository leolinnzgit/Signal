using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Signal.Server.Controllers;

[ApiController]
[AllowAnonymous]
[Route("api/app-version")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class AppVersionController(IWebHostEnvironment environment) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new { version = GetVersion() });

    private string GetVersion()
    {
        var assemblyPath = Assembly.GetExecutingAssembly().Location;
        var indexPath = Path.Combine(environment.WebRootPath, "index.html");
        var assemblyVersion = System.IO.File.GetLastWriteTimeUtc(assemblyPath).Ticks;
        var clientVersion = System.IO.File.Exists(indexPath)
            ? System.IO.File.GetLastWriteTimeUtc(indexPath).Ticks
            : 0;
        return $"{assemblyVersion}-{clientVersion}";
    }
}
