# Social Publishing

Daily Social Publishing is the owned-channel lane for Pancake Robot. It plans, previews, validates, schedules, and eventually publishes daily posts to Instagram, Facebook Page, and YouTube without mixing those actions into reviewer, blog, radio, or playlist outreach.

## Modes

`dry_run`
- Default mode.
- Creates campaigns and platform posts in SQLite.
- Runs connector validation only.
- Builds or reuses the YouTube MP4 asset locally when the YouTube post starts from an image.
- Never publishes externally.

Human approval mode
- Controlled by `DAILY_SOCIAL_REQUIRE_APPROVAL=true`.
- The planner builds today’s campaign and marks it `ready_for_review`.
- An operator approves before any publish attempt.

`live`
- Controlled by `SOCIAL_PUBLISH_MODE=live`.
- Still respects approval when enabled.
- YouTube live upload is implemented.
- YouTube uploads default to `private`.
- Instagram and Facebook still stop at validated dry-run boundaries.

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
- `YOUTUBE_TOKEN_PATH` optional local token cache used by the built-in auth flow
- `YOUTUBE_DEFAULT_PRIVACY_STATUS=private`
- `YOUTUBE_RENDER_FORCE=false`

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
2. Create OAuth client credentials for a web application.
3. Add `http://localhost:3737/api/auth/youtube/callback` as an authorized redirect URI.
4. Set `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_REDIRECT_URI`.
5. Run `./bin/pancakerobot web`, open `/marketing/social`, and click `Connect YouTube`.
6. The callback flow stores a refresh token at `YOUTUBE_TOKEN_PATH` and records the connected channel ID and title there.
7. Keep `madeForKids` explicit on every post. The worker rejects ambiguous values.
8. Install ffmpeg before generating YouTube assets:

```bash
brew install ffmpeg
```

## YouTube MP4 Asset Builder

YouTube does not accept image-only uploads. The social pipeline now treats a YouTube image post as input art and renders a YouTube-ready MP4 before dry-run or live publish.

Input preference
- Source audio: mastered audio first, then original/generated song audio.
- Source image: campaign/social image first, then release-kit cover art, then song cover/image.

Output
- `output/songs/<SONG_ID>/marketing/youtube/youtube_video.mp4`
- 1920x1080
- H.264 video
- AAC audio
- Full song length
- Static image or looping GIF visual converted into MP4

Dry-run behavior
- Builds or reuses the YouTube MP4.
- Validates that the asset is a video file.
- Shows the video path, source audio, source image, and privacy setting on `/marketing/social`.
- Does not call the YouTube API.

Live behavior
- Builds or reuses the YouTube MP4.
- Uploads the local MP4 through the YouTube API.
- Defaults `privacyStatus` to `private`.

`PUBLIC_BASE_URL` is not required for YouTube local uploads. It still matters for Meta/Instagram/Facebook, where live posting needs public HTTPS media URLs.

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
- YouTube default upload privacy is private.

## Not Implemented Yet

- Live Instagram container creation, status polling, and `media_publish`.
- Live Facebook `/feed`, `/photos`, and `/videos` posting.
- Retry/backoff beyond the current bounded failure handling.
- TikTok publishing.
