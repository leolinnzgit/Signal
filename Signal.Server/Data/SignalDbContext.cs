using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Models;

namespace Signal.Server.Data;

public sealed class SignalDbContext(DbContextOptions<SignalDbContext> options)
    : IdentityDbContext<ApplicationUser>(options);
