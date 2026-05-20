# DistroKid Selector Capture

Login uses the hardened auth script, not codegen:

```bash
npm run distrokid:save-auth
npm run distrokid:check-auth
```

Codegen is only for selector capture after `.auth/distrokid.json` exists.

```bash
npx playwright codegen --browser=chromium --load-storage=.auth/distrokid.json https://distrokid.com/new/
```

Walk the form once and copy the generated Playwright code. Do not click final submit, done, finalize, release, upload-to-stores, continue-and-submit, save-and-submit, submit-release, or send-to-stores buttons.

Paste the generated code back into Claude Code and ask it to update:

```text
config/distrokid/field-map.local.json
```

`field-map.local.json` is ignored by git because DistroKid selectors can be account/UI specific.

Recommended capture flow:

1. Open the upload page with saved auth using the command above.
2. Click/fill artist, release title, track title, genre, language, explicit, lyrics, release date, made-for-kids/COPPA, AI disclosure, audio upload, and cover upload controls.
3. Stop before any final submit path.
4. Copy the recorder output.
5. Ask Claude Code to map the selectors into `config/distrokid/field-map.local.json`.

If Google login fails during codegen, you are using codegen for the wrong step. Run `npm run distrokid:save-auth` first; that script launches Chrome with the automation flag stripped.
