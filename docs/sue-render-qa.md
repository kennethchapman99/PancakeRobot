# Sue render QA

Run the one-off Sue render with the Sue profile:

```bash
BRAND_PROFILE_PATH=config/brand-profiles/my-new-brand.json \
MINIMAX_USE_FREE_MODEL=false \
MINIMAX_MUSIC_MODEL=music-2.6 \
node src/orchestrator.js --new "title: Eighteen Years of You — slow Mother's Day adult dedication ballad for Sue"
```

Before a paid render, review:

- `pre-render-qa.json`
- `provider-lyrics-sanitization.json`

Provider lyrics must be singable lines only.

If unsafe brand leakage is detected, generation stops before the provider call with:

```text
Brand contamination blocked lyrics
```

Sue/adult ballad style expectations:

- 72-82 BPM
- piano-led
- gentle strings
- warm intimate vocal
- no dance beat
- no call-and-response
- no kids-song energy
