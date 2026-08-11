# HTML Share Code-Only Access

## Change Summary

`lobsterai-server` no longer accepts `public` for HTML share creation or update. HTML shares now support share-code access only.

Affected endpoints:

- `POST /api/html-shares`
- `PUT /api/html-shares/{shareId}`

The `accessMode` form field is now optional. If omitted, the server defaults to `code`. If the client sends `accessMode=public`, the server returns an error.

## Endpoint Details

### Create HTML Share

`POST /api/html-shares`

Headers:

```http
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data
```

Request form fields:

| Field | Required | Notes |
| --- | --- | --- |
| `sourceType` | yes | Existing values unchanged, such as `html_file`. |
| `sessionId` | no | Unchanged. |
| `artifactId` | no | Unchanged. |
| `title` | yes | Unchanged. |
| `entryFile` | yes | Unchanged. |
| `accessMode` | no | Omit or send `code`. Do not send `public`. |
| `sourceSha256` | yes | Unchanged. |
| `clientSourceKey` | no | Unchanged. |
| `archive` | yes | ZIP archive. |

Success response example:

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "shareId": "shr_xxxxxxxxxxxxxxxx",
    "url": "https://glmcoding.cn/s/shr_xxxxxxxxxxxxxxxx/",
    "accessMode": "code",
    "shareCode": "K7Q9P2",
    "shareCodeUnavailable": false,
    "status": "live"
  }
}
```

If `accessMode=public` is sent:

```json
{
  "code": 41310,
  "message": "仅支持分享码模式",
  "data": null
}
```

### Update HTML Share

`PUT /api/html-shares/{shareId}`

Same form fields and behavior as create. Omit `accessMode` or send `code`.

## Frontend Action Items

- Remove the public/share-code access mode selector from the HTML share dialog.
- Always create/update using share-code mode.
- Prefer omitting `accessMode`; sending `accessMode: "code"` is also valid.
- Remove code paths that pass `HtmlShareAccessMode.Public` to `createFromHtmlFile` or `updateFromHtmlFile`.
- Ensure the success UI always displays/copies both the share URL and `shareCode` when present.
- Existing legacy shares with `accessMode: "public"` may still appear from lookup/list APIs; updating them should use code mode so the server returns a new share code.

## Auth Requirements

No auth change. These endpoints still require the logged-in Electron user JWT:

```http
Authorization: Bearer <accessToken>
```

## Notes & Caveats

- `accessMode=public` is now rejected with error code `41310`.
- `accessMode` remains in responses for compatibility, but new successful create/update responses should be `code`.
- Portal share management only lists, opens, and disables shares; no Portal action is required for this API change.
