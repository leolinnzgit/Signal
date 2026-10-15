"""Add one feed to an existing Signal account without replacing its settings."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from urllib.parse import urlsplit


def feed_key(value):
    url = urlsplit(value)
    return (url.hostname or "").lower().removeprefix("www."), url.path.rstrip("/"), url.query


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--email", required=True)
    parser.add_argument("--feed", required=True)
    args = parser.parse_args()
    url = urlsplit(args.feed)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
        parser.error("The feed must be an HTTPS URL without credentials or a fragment.")

    database = args.database.resolve(strict=True)
    with sqlite3.connect(database.as_uri() + "?mode=rw", uri=True, timeout=30) as connection:
        connection.row_factory = sqlite3.Row
        account = connection.execute(
            "SELECT Id FROM AspNetUsers WHERE NormalizedEmail = ?",
            (args.email.upper(),),
        ).fetchall()
        if len(account) != 1:
            raise ValueError("Choose exactly one existing account by email.")
        user_id = account[0]["Id"]

        # SQLite's backup API includes committed WAL data while the site stays online.
        backup_directory = database.parent / "backups"
        backup_directory.mkdir(exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
        backup = backup_directory / f"signal-before-feed-update-{stamp}.db"
        with sqlite3.connect(backup) as destination:
            connection.backup(destination)

        # Re-read under the write lock so simultaneous preference saves are preserved.
        connection.execute("BEGIN IMMEDIATE")
        before = connection.execute(
            "SELECT * FROM UserNewsPreferences WHERE UserId = ?", (user_id,)
        ).fetchone()
        if before is None:
            raise ValueError("The account has no saved news preferences.")
        feeds = json.loads(before["RssFeedsJson"])
        if any(feed_key(feed) == feed_key(args.feed) for feed in feeds):
            print(json.dumps({"added": False, "feed": args.feed, "feedCount": len(feeds)}))
            return
        if len(feeds) >= 30:
            raise ValueError("The account already has the maximum 30 publisher feeds.")
        feeds.append(args.feed)
        now = datetime.now(timezone.utc).isoformat()
        connection.execute(
            "UPDATE UserNewsPreferences SET RssFeedsJson = ?, UpdatedAtUtc = ? WHERE UserId = ?",
            (json.dumps(feeds, separators=(",", ":")), now, user_id),
        )
        if before["RefreshMinutes"] != 0:
            connection.execute(
                "UPDATE TopicRefreshStates SET NextRefreshAtUtc = ? WHERE UserId = ?",
                (now, user_id),
            )
        after = connection.execute(
            "SELECT * FROM UserNewsPreferences WHERE UserId = ?", (user_id,)
        ).fetchone()
        for column in before.keys():
            if column not in ("RssFeedsJson", "UpdatedAtUtc") and before[column] != after[column]:
                raise RuntimeError(f"An unrelated preference changed: {column}")
        if json.loads(after["RssFeedsJson"]) != feeds:
            raise RuntimeError("The saved feed list did not match the requested update.")
        connection.commit()
        print(json.dumps({"added": True, "feed": args.feed, "feedCount": len(feeds), "backup": str(backup)}))


if __name__ == "__main__":
    main()
