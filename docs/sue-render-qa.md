# Sue one-off render QA

Run the Sue Mother’s Day/adult dedication flow with the Sue brand profile:

```bash
BRAND_PROFILE_PATH=config/brand-profiles/my-new-brand.json \
MINIMAX_USE_FREE_MODEL=false \
MINIMAX_MUSIC_MODEL=music-2.6 \
node src/orchestrator.js --new "title: Eighteen Years of You — slow Mother's Day adult dedication ballad for Sue"
```

## Provider payload gate

Before MiniMax is called, the music generator writes:

```text
output/songs/<song-id>/provider-lyrics-sanitization.json
```

That report lists each removed non-lyric fragment with line number, reason, and original content.

Lyrics sent to MiniMax must contain only singable lyric lines. The payload must not contain section labels, bracketed notes, stage directions, markdown, emoji, parenthetical production notes, prompt artifacts, or cues such as vocals start, music slows, drop it, sfx, spoken, or sound effect.

For the Sue profile, forbidden contamination includes kids-song and legacy brand artifacts such as claps, robot sounds, Pancake Robot references, pancake references, call-and-response, action cues, and novelty sections.

If forbidden contamination is detected, rendering stops before the provider call with:

```text
Brand contamination blocked lyrics
```

## Sue/adult ballad style handling

When the topic/profile/prompt says ballad, slow, Mother’s Day, Sue, or adult dedication, the provider prompt is biased toward:

- slow heartfelt adult dedication ballad
- 72-82 BPM
- piano-led arrangement
- gentle strings
- warm intimate lead vocal
- no dance beat
- no call-and-response
- no children's-song energy
- no novelty sound effects

## QA expectations

- Run `npm test` before a paid render.
- Review `pre-render-qa.json` and `provider-lyrics-sanitization.json`.
- Do not render if sanitizer logs forbidden contamination or residual non-lyric payload issues.
- If the sanitizer removed stage directions or prompt artifacts, fix the lyricist output upstream, while keeping the provider payload protected.
