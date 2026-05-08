# Social Publishing

Daily Social Publishing is the owned-channel lane for Pancake Robot. It plans, previews, validates, schedules, and eventually publishes daily posts to Instagram, Facebook Page, and YouTube without mixing those actions into reviewer, blog, radio, or playlist outreach.

## Modes

`dry_run`
- Default mode.
- Creates campaigns and platform posts in SQLite.
- Runs connector validation only.
- Never publishes externally.

Human approval mode
- Controlled by `DAILY_SOCIAL_REQUIRE_APPROVAL=true`.
- The planner builds today’s campaign and marks it `ready_for_review`.
- An operator approves before any publish attempt.

`live`
- Controlled by `SOCIAL_PUBLISH_MODE=live`.
- Still respects approval when enabled.
- Phase 1 only validates and preserves the live connector boundary.
- Actual API publishing remains a guarded TODO for Instagram, Facebook, and YouTube.

## Required Environment Variables

Core
- `SOCIAL_PUBLISH_MODE=dry_run|live`
- `SOCIAL_REQUIRE_APPROVAL=true|false`
- `PUBLIC_BASE_URL`
- `DAILY_SOCIAL_ENABLED=false|true`
- `DAILY_SOCIAL_TIMEZONE`
- `DAILY_SOCIAL_REQUIRE_APPROVAL=true|false`
- `DAILY_SOCIAL_PLATFORMS=instagram,facebook,youtube`
- `DAILY_SOCIAL_INSTAGRAM_TIME`
- `DAILY_SOCIAL_FACEBOOK_TIME`
- `DAILY_SOCIAL_YOUTUBE_TIME`

YouTube
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REDIRECT_URI`
- `YOUTUBE_REFRESH_TOKEN`
- `YOUTUBE_CHANNEL_ID`

Meta / Instagram / Facebook
- `META_GRAPH_VERSION`
- `META_APP_ID`
- `META_APP_SECRET`
- `META_PAGE_ID`
- `META_PAGE_ACCESS_TOKEN`
- `INSTAGRAM_IG_USER_ID`
- `FACEBOOK_PAGE_ID`
- `FACEBOOK_PAGE_ACCESS_TOKEN`

## YouTube Setup

1. Create a Google Cloud project and enable the YouTube Data API.
2. Create OAuth client credentials for the web app callback.
3. Capture and store a refresh token for the publishing account.
4. Set `YOUTUBE_CHANNEL_ID`.
5. Keep `madeForKids` explicit on every post. The worker rejects ambiguous values.

## Meta / Facebook / Instagram Setup

1. Create a Meta app with the Graph API products needed for Page and Instagram publishing.
2. Connect the Facebook Page and Instagram professional account.
3. Capture a Page access token with the required scopes.
4. Set `META_*`, `INSTAGRAM_IG_USER_ID`, and `FACEBOOK_*`.
5. For live posting, media URLs must be public HTTPS URLs. Localhost and private-network URLs are rejected.

## Safety Rules

- Owned social only.
- No reviewer blasts.
- No TikTok in this phase.
- Official APIs only.
- Do not log tokens or secrets.
- YouTube `madeForKids` must be explicit.

## Not Implemented Yet

- Live YouTube upload via `googleapis` `videos.insert`.
- Live Instagram container creation, status polling, and `media_publish`.
- Live Facebook `/feed`, `/photos`, and `/videos` posting.
- Retry/backoff beyond the current bounded failure handling.
- TikTok publishing.
