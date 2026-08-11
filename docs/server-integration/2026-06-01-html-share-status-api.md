# HTML Share Status API

## Change Summary

`lobsterai-server` adds a user-facing API to toggle an HTML share between open and closed states.

New endpoint:

- `PATCH /api/html-shares/{shareId}/status`

Existing close endpoint remains supported:

- `DELETE /api/html-shares/{shareId}`

The new endpoint can reopen a share only when the share is still legally recoverable. Shares disabled by an admin or rejected by content moderation cannot be reopened by the user.

## Endpoint Details

### Update HTML Share Status

`PATCH /api/html-shares/{shareId}/status`

Headers:

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Request body:

```json
{
  "status": "live"
}
```

or:

```json
{
  "status": "disabled"
}
```

Success response:

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "shareId": "shr_xxxxxxxxxxxxxxxx",
    "url": "https://glmcoding.cn/s/shr_xxxxxxxxxxxxxxxx/",
    "status": "live",
    "moderationStatus": "not_required",
    "updatedAt": "2026-06-01T12:00:00",
    "disabledAt": null,
    "disabledReason": null
  }
}
```

Allowed target statuses:

| status | Meaning |
| --- | --- |
| `live` | Open the share. |
| `disabled` | Close the share. |

## Frontend Action Items

- Use `PATCH /api/html-shares/{shareId}/status` for share open/close toggles.
- Send `{ "status": "disabled" }` when the user closes a share.
- Send `{ "status": "live" }` when the user reopens a share.
- Continue accepting `DELETE /api/html-shares/{shareId}` as a legacy close path if existing code already uses it.
- If the server returns `41304`, show that the share cannot be reopened.
- If the server returns `41311`, show that the active share limit has been reached and the user must close another share first.
- Refresh the local share list item with the response `status`, `disabledAt`, and `disabledReason`.

## Auth Requirements

No auth change. The endpoint requires the logged-in Electron user JWT:

```http
Authorization: Bearer <accessToken>
```

Users can only update their own shares. The server returns `HTML_SHARE_NOT_FOUND` for missing shares or shares owned by another user.

## Notes & Caveats

- `live -> disabled` is allowed for the owner.
- `disabled -> disabled` is idempotent.
- `live -> live` is idempotent.
- `disabled -> live` requires an active subscription and available active-share quota.
- A share disabled by admin cannot be reopened by the user.
- A share rejected by content moderation cannot be reopened by the user.
- `failed` shares cannot be toggled by this endpoint.
