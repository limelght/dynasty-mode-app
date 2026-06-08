# Dynasty Mode Deploy Notes

## Current build

- App version badge target: `vs.0.4.0-dev-2026-06-08-08`

## Current architecture

- Frontend: static app hosted on Firebase Hosting
- Auth: Firebase Authentication (email/password)
- Database: Firestore
- Notifications backend: Firebase Functions processing `notificationJobs`

## Local prerequisites

1. Install Firebase CLI
2. Use Node `22` locally for Functions work (`nvm use` if you have `nvm`)
3. Run `firebase login`
4. Run `firebase use dynastyhq-app`
5. In `functions/`, run `npm install`

## Deploy sequence

1. `firebase deploy --only firestore:rules`
2. `cd functions && npm install`
3. `firebase deploy --only functions`
4. `firebase deploy --only hosting`

## Required environment for notifications

Create `functions/.env` from `functions/.env.example` before deploying live notification channels.

### Email

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

### Telegram

- `TELEGRAM_BOT_TOKEN`

### WhatsApp

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`

### Web push

- `WEB_PUSH_SUBJECT`
- `WEB_PUSH_PUBLIC_KEY`
- `WEB_PUSH_PRIVATE_KEY`

## Product truth

The app currently contains a local fallback path so core league flows can keep moving when Firestore is blocked. The production target is to make Firestore the source of truth, then keep the local path only as graceful offline support if it still earns its keep.

Current product surface now includes league governance flows:
- archive / end / reinstate league
- promote member to co-commissioner
- commissioner handoff
- co-commissioner self-drop

League lifecycle transitions now also write backend-friendly metadata and a `statusHistory` audit trail so archived leagues can be reinstated cleanly by the commissioner and reflected consistently in Firestore.

## Deployment status

- Firestore rules have been deployed successfully to `dynastyhq-app`.
- Hosting has been deployed successfully to `https://dynastyhq-app.web.app`.
- Functions have now been deployed successfully on Node `22`.
- Live health endpoint: `https://us-central1-dynastyhq-app.cloudfunctions.net/health`
- Current live backend status reports readiness for `email`, `push`, `discord`, `telegram`, and `whatsapp`.
- Frontend now surfaces backend notification readiness and stores browser push subscriptions in user profiles when Web Push is configured.
- Web Push VAPID keys have been established locally in `functions/.env`. SMTP still needs real credentials for email readiness. Telegram requires a bot token. WhatsApp requires Meta business credentials and is not a no-cost channel in production.
- Telegram now includes an account-linking flow: the app can generate a one-time link code and the `telegramWebhook` function can attach a Telegram chat to a user profile when the bot receives `/start dynasty_<code>`.
- Backend setup endpoints now exist for provider diagnostics:
  - `health` returns per-channel readiness plus missing env keys
  - `verifyEmailTransport` verifies SMTP connectivity when configured
  - `setupTelegramWebhook` calls Telegram `setWebhook` when bot credentials are present
- Backoffice access now supports admin-only email OTP with:
  - `startAdminAccessChallenge`
  - `verifyAdminAccessChallenge`
  - `sendAdminTestNotification`
- Set `ADMIN_EMAILS` in `functions/.env` to the comma-separated admin account list that should be allowed to unlock the backoffice panel.
