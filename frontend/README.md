# TenderFlow frontend

A dependency-free single-page app: three files, no build step, no package manager.
Open `index.html` in a browser and it runs.

## Running it

1. Start the backend (see `../backend/README.md`). It listens on
   `http://localhost:8000`.
2. Open `index.html` directly — double-clicking works. No web server is needed.

Opening from `file://` means the browser sends `Origin: null`, so the backend's
`CORS_ORIGINS` includes `null` on purpose. Serving these files over HTTP instead
is fine too; just add that origin to `CORS_ORIGINS` in the backend `.env`.

## Pointing at a different backend

`API_BASE` defaults to `http://localhost:8000/api`. To override it without
editing `script.js`, set the global before the script loads:

```html
<script>window.TENDERFLOW_API_BASE = 'https://tenders.example.com/api';</script>
```

## Layout

| File | What's in it |
| --- | --- |
| `index.html` | Page shell and every modal. The SPA swaps content into `#contentArea`. |
| `script.js` | Everything else: auth, the API client, routing, and one render function per page. |
| `style.css` | Design tokens as CSS custom properties, then component styles. |

There is no framework. Pages are rendered with template literals into
`innerHTML`, so anything interpolated from the API must go through `escapeHtml`
or `escapeAttr` first.

## Who sees what

The sidebar is built from a per-role config in `script.js`. Three predicates
decide access, and they are not interchangeable:

- `isVendor` — outside the company; sees only the vendor portal.
- `isEmployee` — on the payroll but with no back-office function. Raises tender
  requests and tracks their own, nothing more.
- `isStaff` — the roles that run the tender process. Mirrors `STAFF_ROLES` in
  `backend/app/core/deps.py`; treating an employee as staff here just buys them
  a screen of 403s.
