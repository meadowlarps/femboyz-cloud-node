The regular and bold DejaVu Sans fonts are bundled for consistent OG card rendering
without font downloads. They contain only the Latin, Cyrillic, and ellipsis
characters emitted by the card's text sanitizer. See LICENSE.txt.

To reproduce each subset from the upstream font using FontTools:

```sh
pyftsubset DejaVuSans.ttf --output-file=DejaVuSans.ttf --unicodes=U+0020-017F,U+0400-045F,U+2026 --no-hinting
pyftsubset DejaVuSans-Bold.ttf --output-file=DejaVuSans-Bold.ttf --unicodes=U+0020-017F,U+0400-045F,U+2026 --no-hinting
```

The compact logo embedded in `../../../upload/ogLogo.ts` comes from the existing
`mail/branding/login-logo.png`, resized to 192px wide and encoded as PNG using
Sharp. The OG renderer requires PNG rather than the site's WebP assets.
