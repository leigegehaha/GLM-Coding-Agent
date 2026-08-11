# HTML Share PUT Status Separation

## Change Summary

`lobsterai-server` changes `PUT /api/html-shares/{shareId}` so it updates HTML share content only and refuses to update closed shares.

- `PUT /api/html-shares/{shareId}` requires the current share status to be `live`.
- `PUT /api/html-shares/{shareId}` returns `HTML_SHARE_FORBIDDEN` for `disabled` or `failed` shares before uploading or replacing files.
- `PUT /api/html-shares/{shareId}` no longer reopens a disabled share or updates its files.
- `GET /api/html-shares/source` now honors `includeDisabled=true` and can return the latest matching disabled share with its `status`.
- `PATCH /api/html-shares/{shareId}/status` remains the only API for opening or closing a share.
- `DELETE /api/html-shares/{shareId}` remains a legacy close-only path.

## Endpoint Details

### Update HTML Share Content

`PUT /api/html-shares/{shareId}`

Headers:

```http
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data
```

Form fields:

| Field | Required | Notes |
| --- | --- | --- |
| `title` | Yes | Share title. |
| `entryFile` | Yes | Entry HTML file in the archive. |
| `accessMode` | No | Currently code mode is used by Electron. |
| `sourceSha256` | Yes | Hash for the uploaded source. |
| `clientSourceKey` | No | Client-side source key for lookup. |
| `archive` | Yes | ZIP archive of HTML and assets. |

Success response is only returned for currently open shares:

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "shareId": "shr_xxxxxxxxxxxxxxxx",
    "url": "https://glmcoding.cn/s/shr_xxxxxxxxxxxxxxxx/",
    "status": "live",
    "moderationStatus": "pending",
    "updatedAt": "2026-06-02T12:00:00",
    "contentUpdatedAt": "2026-06-02T12:00:00"
  }
}
```

### Update HTML Share Status

`PATCH /api/html-shares/{shareId}/status`

Request body:

```json
{ "status": "live" }
```

or:

```json
{ "status": "disabled" }
```

### Get Share By Source

`GET /api/html-shares/source?sourceType=html_file&clientSourceKey=<key>&includeDisabled=true`

When `includeDisabled=true`, the server returns the latest matching share regardless of whether it is currently open or closed:

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "shareId": "shr_xxxxxxxxxxxxxxxx",
    "url": "https://glmcoding.cn/s/shr_xxxxxxxxxxxxxxxx/",
    "status": "disabled",
    "moderationStatus": "not_required",
    "updatedAt": "2026-06-02T12:00:00",
    "contentUpdatedAt": "2026-06-02T12:00:00"
  }
}
```

If `includeDisabled` is omitted or `false`, the endpoint keeps the old behavior and returns only `live` shares.

## Frontend Action Items

- The HTML preview page can use `GET /api/html-shares/source?...&includeDisabled=true` to show that the current file already has a closed share.
- Do not call `PUT /api/html-shares/{shareId}` while the returned share status is `disabled`.
- If the user wants to update a closed share, require them to open it first with `PATCH /status` and only then allow content update.
- For a user-visible update dialog containing both content changes and an availability switch, do not combine opening a closed share with content update in one submit action.
- For a live share that the user updates and then closes, call content `PUT` first, then call `PATCH /status` with `disabled`.
- For a standalone availability switch, call `PATCH /status` directly.
- Update `htmlShare.updateFromHtmlFile({ ..., status })` callers so a disabled share is reopened before content upload, or block the upload action until the share is already live.

## Auth Requirements

No auth change. Both endpoints require the Electron user JWT:

```http
Authorization: Bearer <accessToken>
```

## Notes & Caveats

- `PUT` cannot update a closed share and should not be used as an implicit reopen path.
- Reopen constraints remain enforced only by `PATCH /status` with `status: "live"`.
- Admin-disabled and moderation-rejected shares cannot be reopened by the user, so they also cannot be updated by `PUT`.
