# BookForge Security Notes

## Subresource Integrity (SRI)

BookForge loads several large dependencies from public CDNs (`esm.sh`,
`unpkg.com`, `cdnjs.cloudflare.com`, `jsdelivr.net`, `accounts.google.com`).
To protect against supply-chain or man-in-the-middle attacks, the app now
verifies every external resource against known SHA-384 hashes.

Hashes are stored in `docs/js/constants.js` under `CDN_SRI` and are checked
at runtime by `docs/js/secure-loader.js`.

### Updating dependencies or hashes

After changing any CDN URL or version, regenerate the hashes:

```bash
npm run security:generate-sri
```

This writes the new hashes into `docs/js/constants.js`. Commit that file.

**Do not deploy to production with empty `null` hash entries.** The loader will
warn in the console but still load the resource, which is only acceptable for
local development.

## Content Security Policy (CSP)

The CSP in `docs/index.html` has been tightened so that `script-src` no longer
requires `'unsafe-inline'`. Inline initialization logic was moved to
`docs/js/sw-register.js`, which is loaded as a same-origin script.

`style-src` still allows `'unsafe-inline'` because Google Identity Services
injects inline styles for its sign-in popups.

## OAuth Client ID

`GOOGLE_CLIENT_ID` is embedded in `docs/js/gdrive.js`. This is normal for
client-side OAuth. Ensure the Google Cloud Console project restricts the
authorized JavaScript origins to only the domains you deploy on.

## Memory / File Size Guards

Uploads and Google Drive downloads are capped at `MAX_FILE_SIZE` (1 GB by
default, see `docs/js/constants.js`) to prevent the browser from running out of
memory while parsing large media files.
