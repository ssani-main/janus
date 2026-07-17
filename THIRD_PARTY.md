# Third-Party Notices

This project embeds two open-source typefaces licensed under the [SIL Open Font License, Version 1.1](https://scripts.sil.org/OFL).

## Instrument Serif

**Copyright notice:**
> Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif)

**Family:** Instrument Serif  
**Version:** Version 1.000; ttfautohint (v1.8.4.7-5d5b);gftools[0.9.27]  
**License URL:** https://scripts.sil.org/OFL  

**Subsetting:** The original font (21032 bytes) was subset to printable ASCII and typographic punctuation (Unicode ranges U+0020–007E, U+00A0, U+00A9, U+00B7, U+2013, U+2014, U+2018, U+2019, U+201C, U+201D, U+2026, U+2192, U+2212), reducing it to 9996 bytes. This is a Modified Version under the OFL.

## Geist Mono

**Copyright notice:**
> Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)

**Family:** Geist Mono  
**Version:** Version 1.701  
**License URL:** https://openfontlicense.org  

**Subsetting:** The original font (23128 bytes) was subset to printable ASCII and typographic punctuation (Unicode ranges U+0020–007E, U+00A0, U+00A9, U+00B7, U+2013, U+2014, U+2018, U+2019, U+201C, U+201D, U+2026, U+2192, U+2212), reducing it to 14548 bytes. This is a Modified Version under the OFL.

## Embedding as Data URIs

Both fonts are embedded as base64-encoded data URIs in [`src/fonts.js`](./src/fonts.js). This ensures pages render with zero external requests — no CDN call, no visitor IP leaked to a third-party font host — consistent with this project's `Referrer-Policy: no-referrer` stance.

## OFL Compliance

- Neither font declares a Reserved Font Name, so the original family names are retained.
- The fonts are not sold separately; they ship bundled with this software.
- This notice is retained as required by the OFL.

For the complete OFL license text, see [https://scripts.sil.org/OFL](https://scripts.sil.org/OFL).
