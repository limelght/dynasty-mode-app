# Dynasty Mode Deploy Notes

## Current architecture

- Frontend: static app hosted on Firebase Hosting
- Auth: Firebase Authentication (email/password)
- Database: Firestore
- Notifications backend: Firebase Functions processing `notificationJobs`

## Local prerequisites

1. Install Firebase CLI
2. Run `firebase login`
3. Run `firebase use dynastyhq-app`
4. In `functions/`, run `npm install`

## Deploy sequence

1. `firebase deploy --only firestore:rules`
2. `cd functions && npm install`
3. `firebase deploy --only functions`
4. `firebase deploy --only hosting`

## Required environment for notifications

### Email

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

### SMS

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

### Web push

- `WEB_PUSH_SUBJECT`
- `WEB_PUSH_PUBLIC_KEY`
- `WEB_PUSH_PRIVATE_KEY`

## Product truth

The app currently contains a local fallback path so core league flows can keep moving when Firestore is blocked. The production target is to make Firestore the source of truth, then keep the local path only as graceful offline support if it still earns its keep.
