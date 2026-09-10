# Homepage announcements

Scene Machine deployments can show one optional announcement at the top of
the homepage. An administrator can publish a short welcome, release note, or
help link without changing application code. Each browser profile can dismiss
the current content locally.

This is a single dismissible banner, not an inbox, modal, toast, scheduler,
targeting system, or mandatory acknowledgement.

## What users see

- The banner spans the top of the homepage above the hero content.
- It is one compact, non-wrapping row with the configured decorative emoji,
  inline Markdown, and a close button.
- Long rendered content is clipped with an ellipsis; the close control remains
  available. Authored line breaks become spaces for display, but remain part of
  the raw content used for the publication ID.
- The banner uses the existing primary theme color, white text, and underlined
  links. It remains usable with keyboard focus and in light or dark themes.
- Closing means “Dismiss this announcement”. It does not disable the document
  for other users.

The browser stores only the most recently dismissed response ID in
`localStorage`, scoped to the app origin. It is not synchronized to a Google
account or another browser. Clearing site data, using another browser/device,
or changing the content can make a message appear again. A legacy manually
assigned ID may be shown once during migration; current IDs are content-derived.

## Markdown and emoji limits

`markdown` is a non-empty string of at most 255 Unicode code points, including
Markdown source characters. The supported subset is inline emphasis, strong
emphasis, and explicit HTTP/HTTPS links. Raw HTML is escaped/inert; unsupported
syntax can remain literal. Image syntax never creates an `<img>` or fetches an
image and may degrade to a stray `!` plus a safe HTTP/HTTPS link. Disallowed
schemes are not navigable. Only an invalid document shape, enablement value, or
length makes the whole banner unavailable; the homepage continues to load.

The optional `emoji` field is a decorative string. The default is `⚠️` when the
field is missing, empty, not a string, or contains no emoji. The browser keeps up to three whole
emoji grapheme clusters, including flags, skin-tone combinations, ZWJ families,
and keycaps, and ignores surrounding non-emoji text. Emoji changes do not alter
the announcement identity because identity is based only on raw Markdown.

Examples of valid administrator-authored Markdown:

```markdown
Welcome to **Scene Machine**.
```

```markdown
New: move candidates between scenes. [Read the update](https://example.com/updates).
```

## Administrator publishing

Edit the existing document at this Firestore path:

`<GCP project> → <FIRESTORE_DB_UI database> → collection config → document announcement`

The document uses these fields:

```json
{
  "markdown": "Welcome to **Scene Machine**.",
  "enabled": true,
  "emoji": "⚠️"
}
```

- `markdown` is required, must be 1–255 Unicode code points, and determines
  the response ID.
- `enabled` is required and must be boolean. Set it to `false` to hide the
  current announcement without deleting it.
- `emoji` is optional. Use a short decorative string; omit it to use `⚠️`.
- A legacy stored `id` is ignored. Do not add or maintain a manual ID.
- Other fields may remain for operator metadata, but are not returned to the
  browser.

The API ID is the SHA-256 hash of the exact raw Markdown UTF-8 bytes:

- unchanged Markdown, including whitespace, keeps the same ID;
- any Markdown edit produces a new ID and can re-show the message to a browser
  that dismissed the previous content;
- restoring the exact old Markdown restores its old ID and is dismissed only
  when that ID is the browser's most recently dismissed ID;
- changing `enabled`, `emoji`, or metadata does not change the ID.

Use the existing permissions for the UI Firestore database. There is no new
admin UI, role, client Firestore SDK, or browser write endpoint.

## Deployment and redeployment

The deployment reads these configuration names:

- `ANNOUNCEMENT_MARKDOWN_FILE` — UTF-8 file containing the initial Markdown;
- `ANNOUNCEMENT_ENABLED` — `1` or `0` for the initial seed.

The default first seed uses `config/announcement.md` and
`ANNOUNCEMENT_ENABLED=1`. Before the first deployment, optionally edit those
values in `config.txt`; there is no custom emoji deployment variable.

There is no custom announcement-ID deployment variable. The seed helper
validates the file and flags before any cloud write and sends Markdown,
enablement, and the default emoji as a create-only Firestore request.

On first deployment, a successful create seeds the fixed
`config/announcement` document. If it already exists, the deployment accepts
the conflict and preserves the entire document, including edited Markdown,
disabled state, emoji, and operator metadata. A different failure must stop the
deployment rather than report success. Redeployment does not reset the welcome
text, enablement, emoji, or publication identity.

## API behavior

The app-only endpoint is `GET /api/announcement`. It uses the existing IAP/API
authentication and UI Firestore database. Successful and empty responses set
`Cache-Control: no-store`.

Valid enabled document:

```json
{
  "announcement": {
    "id": "<sha256-of-exact-raw-markdown>",
    "markdown": "Welcome to **Scene Machine**.",
    "emoji": "⚠️"
  }
}
```

Missing, disabled, malformed, overlong, or temporarily unavailable data returns
the normal empty shape:

```json
{"announcement": null}
```

The endpoint returns only the derived ID, validated Markdown, and effective
emoji. It does not expose arbitrary Firestore fields. A failed announcement
read must not prevent the homepage or project list from loading.

## Permissions, costs, and limits

Publishing requires the existing administrator permission to edit the UI
Firestore database. Reading is protected by the deployment's existing app/IAP
authentication. Announcement reads add a small Firestore read when the
homepage component mounts; the feature does not introduce a polling loop,
analytics event, generation request, or provider call. Markdown is intentionally
short and inline; there is no history, scheduling, audience targeting, rich
media, or account-wide dismissal synchronization.

## Troubleshooting

- **No banner:** check that the document exists, `enabled` is `true`, Markdown
  is non-empty and within 255 Unicode code points, and the app identity can
  read the endpoint.
- **Old text still appears:** reload the homepage. A browser keeps only its
  last dismissed ID; changing the exact Markdown creates a different ID.
- **Links or images look different:** only explicit HTTP/HTTPS inline links are
  supported. Raw HTML is inert, unsupported syntax may remain literal, image
  syntax never creates an image element or fetches media, and unsafe schemes
  are not navigable.
- **Redeploy changed an existing message:** verify that the deployment used
  the create-only seed path and that the Firestore document already existed;
  existing documents should be preserved rather than overwritten.
