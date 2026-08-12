using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Models;

namespace Signal.Server.Data;

public sealed class SignalDbContext(DbContextOptions<SignalDbContext> options)
    : IdentityDbContext<ApplicationUser>(options)
{
    public DbSet<UserNewsPreferences> UserNewsPreferences => Set<UserNewsPreferences>();

    public DbSet<StoredNewsArticle> StoredNewsArticles => Set<StoredNewsArticle>();

    public DbSet<TopicRefreshState> TopicRefreshStates => Set<TopicRefreshState>();

    public DbSet<UserPushSubscription> UserPushSubscriptions => Set<UserPushSubscription>();

    public DbSet<UserProfilePhoto> UserProfilePhotos => Set<UserProfilePhoto>();

    public DbSet<NewsComment> NewsComments => Set<NewsComment>();

    public DbSet<FriendRelationship> FriendRelationships => Set<FriendRelationship>();

    public DbSet<DirectMessage> DirectMessages => Set<DirectMessage>();

    public DbSet<UserPresence> UserPresences => Set<UserPresence>();

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
            preferences.Property(item => item.TickerOverridesJson).IsRequired();
            preferences.Property(item => item.WeatherLocationJson).IsRequired();
            preferences.Property(item => item.SecondaryTimeZoneJson).IsRequired();
            preferences.Property(item => item.TrendRegionsJson).IsRequired();
            preferences.Property(item => item.StoryTitleSize).HasMaxLength(16).IsRequired();
            preferences.Property(item => item.TopicHeaderSize).HasMaxLength(16).IsRequired();
            preferences.HasOne(item => item.User)
                .WithOne()
                .HasForeignKey<UserNewsPreferences>(item => item.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<StoredNewsArticle>(article =>
        {
            article.ToTable("StoredNewsArticles");
            article.HasKey(item => item.Id);
            article.Property(item => item.UserId).HasMaxLength(450);
            article.Property(item => item.Url).HasMaxLength(2048).IsRequired();
            article.Property(item => item.Title).HasMaxLength(500).IsRequired();
            article.Property(item => item.Source).HasMaxLength(256).IsRequired();
            article.Property(item => item.Summary).HasMaxLength(4000).IsRequired();
            article.Property(item => item.ImageUrl).HasMaxLength(2048).IsRequired();
            article.Property(item => item.TopicsJson).IsRequired();
            article.Property(item => item.ProvidersJson).IsRequired();
            article.HasIndex(item => new { item.UserId, item.Url }).IsUnique();
            article.HasIndex(item => new { item.UserId, item.IsBookmarked, item.LastSeenAtUtc });
            article.HasOne(item => item.User)
                .WithMany()
                .HasForeignKey(item => item.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<TopicRefreshState>(state =>
        {
            state.ToTable("TopicRefreshStates");
            state.HasKey(item => new { item.UserId, item.TopicKey });
            state.Property(item => item.UserId).HasMaxLength(450);
            state.Property(item => item.TopicKey).HasMaxLength(80);
            state.Property(item => item.Topic).HasMaxLength(80).IsRequired();
            state.Property(item => item.LastError).HasMaxLength(1000).IsRequired();
            state.HasIndex(item => item.NextRefreshAtUtc);
            state.HasOne(item => item.User)
                .WithMany()
                .HasForeignKey(item => item.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<UserPushSubscription>(subscription =>
        {
            subscription.ToTable("UserPushSubscriptions");
            subscription.HasKey(item => item.Id);
            subscription.Property(item => item.UserId).HasMaxLength(450);
            subscription.Property(item => item.Endpoint).HasMaxLength(4096).IsRequired();
            subscription.Property(item => item.P256Dh).HasMaxLength(256).IsRequired();
            subscription.Property(item => item.Auth).HasMaxLength(128).IsRequired();
            subscription.HasIndex(item => item.Endpoint).IsUnique();
            subscription.HasIndex(item => item.UserId);
            subscription.HasOne(item => item.User)
                .WithMany()
                .HasForeignKey(item => item.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<UserProfilePhoto>(photo =>
        {
            photo.ToTable("UserProfilePhotos");
            photo.HasKey(item => item.UserId);
            photo.Property(item => item.UserId).HasMaxLength(450);
            photo.Property(item => item.ImageBytes).IsRequired();
            photo.HasOne(item => item.User)
                .WithOne()
                .HasForeignKey<UserProfilePhoto>(item => item.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<NewsComment>(comment =>
        {
            comment.ToTable("NewsComments");
            comment.HasKey(item => item.Id);
            comment.Property(item => item.ArticleUrl).HasMaxLength(2048).IsRequired();
            comment.Property(item => item.ArticleTitle).HasMaxLength(500).IsRequired();
            comment.Property(item => item.UserId).HasMaxLength(450).IsRequired();
            comment.Property(item => item.Body).HasMaxLength(2000).IsRequired();
            comment.HasIndex(item => new { item.ArticleUrl, item.CreatedAtUtc });
            comment.HasIndex(item => item.UserId);
            comment.HasOne(item => item.User)
                .WithMany()
                .HasForeignKey(item => item.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<FriendRelationship>(relationship =>
        {
            relationship.ToTable("FriendRelationships");
            relationship.HasKey(item => item.Id);
            relationship.Property(item => item.UserOneId).HasMaxLength(450).IsRequired();
            relationship.Property(item => item.UserTwoId).HasMaxLength(450).IsRequired();
            relationship.Property(item => item.RequestedByUserId).HasMaxLength(450).IsRequired();
            relationship.Property(item => item.Status).HasMaxLength(16).IsRequired();
            relationship.HasIndex(item => new { item.UserOneId, item.UserTwoId }).IsUnique();
            relationship.HasIndex(item => new { item.Status, item.UpdatedAtUtc });
        });

        builder.Entity<DirectMessage>(message =>
        {
            message.ToTable("DirectMessages");
            message.HasKey(item => item.Id);
            message.Property(item => item.SenderUserId).HasMaxLength(450).IsRequired();
            message.Property(item => item.RecipientUserId).HasMaxLength(450).IsRequired();
            message.Property(item => item.Body).HasMaxLength(2000).IsRequired();
            message.Property(item => item.SharedArticleTitle).HasMaxLength(300).IsRequired();
            message.Property(item => item.SharedArticleUrl).HasMaxLength(2048).IsRequired();
            message.Property(item => item.SharedArticleSource).HasMaxLength(200).IsRequired();
            message.HasIndex(item => new { item.SenderUserId, item.RecipientUserId, item.CreatedAtUtc });
            message.HasIndex(item => new { item.RecipientUserId, item.ReadAtUtc });
        });

        builder.Entity<UserPresence>(presence =>
        {
            presence.ToTable("UserPresences");
            presence.HasKey(item => item.UserId);
            presence.Property(item => item.UserId).HasMaxLength(450);
            presence.HasIndex(item => item.LastSeenAtUtc);
            presence.HasOne(item => item.User)
                .WithOne()
                .HasForeignKey<UserPresence>(item => item.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });
    }
}
