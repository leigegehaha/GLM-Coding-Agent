# HTML Share Moderation

## Change Summary

`lobsterai-server` now starts asynchronous content moderation after an HTML share is created or updated.

Shares are still returned as usable links immediately. The server records `moderationStatus` and may later disable a share if any submitted text or image file is rejected by moderation.

## Endpoint Details

### Create Share

`POST /api/html-shares`

Auth: existing logged-in user auth.

Response `data` now includes:

```json
{
  "shareId": "shr_xxx",
  "url": "https://glmcoding.cn/s/shr_xxx/",
  "accessMode": "public",
  "shareCode": null,
  "shareCodeUnavailable": false,
  "status": "live",
  "moderationStatus": "pending",
  "createdAt": "2026-05-29T10:00:00",
  "updatedAt": "2026-05-29T10:00:00",
  "contentUpdatedAt": "2026-05-29T10:00:00"
}
```

### Update Share

`PUT /api/html-shares/{shareId}`

Response shape matches create. Updating content resets `moderationStatus` to `pending` when moderation is enabled.

### List/Get Share

`GET /api/html-shares/my`

List items now include `moderationStatus`.

`GET /api/html-shares/{shareId}`

The returned share object includes moderation fields from the server model:

- `moderationStatus`
- `moderationModel`
- `moderationCheckedAt`
- `moderationReason`

### Public Share Access

`GET /s/{shareId}/`

If a share is later rejected by moderation, the server disables it and returns an HTML notice instead of serving the original content:

```text
该分享因内容安全原因已关闭，无法继续访问。
```

## Frontend Action Items

Display the share URL immediately after create/update as before.

Optionally surface moderation progress in share management UI:

- `pending`: content moderation is running
- `passed`: moderation passed
- `review` or `error`: moderation needs attention or retry
- `rejected`: share was closed by moderation
- `not_required`: moderation is disabled on the server

If the user opens a rejected public share URL, the server-rendered notice page is already provided. The client does not need to render this state for public access.

## Auth Requirements

No auth requirement changes.

Create/update/list/get still use the existing logged-in user flow. Public `/s/{shareId}/` access remains public or share-code protected according to `accessMode`.

## Notes & Caveats

Moderation is asynchronous. A share can be visible for a short window before being rejected.

Any rejected text file or image file disables the whole HTML share. The server records file-level details for admin/audit use, but public pages do not expose the triggering file or category.

Image moderation uses server-uploaded NOS URLs only. The server does not fetch user-supplied external image URLs for moderation.
