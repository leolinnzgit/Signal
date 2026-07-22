using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Models;

namespace Signal.Server.Data;

public sealed class SignalDbContext(DbContextOptions<SignalDbContext> options)
    : IdentityDbContext<ApplicationUser>(options)
{
    public DbSet<UserNewsPreferences> UserNewsPreferences => Set<UserNewsPreferences>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<UserNewsPreferences>(preferences =>
        {
            preferences.ToTable("UserNewsPreferences");
            preferences.HasKey(item => item.UserId);
            preferences.Property(item => item.UserId).HasMaxLength(450);
            preferences.Property(item => item.TopicsJson).IsRequired();
            preferences.Property(item => item.RssFeedsJson).IsRequired();
            preferences.HasOne(item => item.User)
                .WithOne()
                .HasForeignKey<UserNewsPreferences>(item => item.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });
    }
}
