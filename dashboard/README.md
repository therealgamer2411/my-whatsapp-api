# Media First WhatsApp Secretary Dashboard

Installable Arabic PWA for managing the WhatsApp secretary worker.

## Deployment
This directory is deployed as its own Vercel project with Root Directory set to `dashboard`.

## Security model
- Gemini API key is entered as a password field and sent directly to the WhatsApp worker over HTTPS.
- The dashboard does not save Gemini API key or ADMIN_TOKEN in browser storage.
- Non-secret preferences and worker URL are kept locally on the device.
- The worker stores runtime configuration in its local `.env` file and returns only redacted settings.
- Keep the worker behind HTTPS, use a long random ADMIN_TOKEN, and allow only the exact dashboard origin in DASHBOARD_ORIGINS.

## Worker
The WhatsApp Web session is a persistent process. It must run on a computer or always-on host, not as a short-lived Vercel Function. Set the dashboard's Worker URL to the HTTPS endpoint of that process.

In the worker's `.env`:
- `ADMIN_TOKEN` — strong random value.
- `DASHBOARD_ORIGINS` — exact Vercel dashboard origin, no wildcard.
- `HOST=0.0.0.0` only when protected behind a TLS reverse proxy or private tunnel.

Then set the same token in the dashboard's connection screen. Configure a public HTTPS URL or private VPN tunnel; never expose the worker port directly without TLS and access controls.
