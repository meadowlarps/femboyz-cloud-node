# Branding sources

`login-logo.png` is the original 488×498 PNG supplied by the user:
https://femboyz.cloud/422TLHWY/0 (saved 2026-10-19).

`logo.webp` and `favicon.webp` are copies of the existing site assets.

`app-logo.webp` is `login-logo.png` scaled to 128px for webmail's header logo
(`APP_LOGO_*_URL`), which shows it at 32×32:
`magick login-logo.png -resize 128x128 -quality 90 app-logo.webp`.
