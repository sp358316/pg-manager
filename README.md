# PG Manager Portal

Firebase-backed PG management portal for owner-created resident accounts, room/bed assignment, rent tracking, deposit records, resident payment submission, and manual admin payment approval.

## Run locally

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Copy `.env.example` to `.env` and fill Firebase values.

3. Start the app:

   ```powershell
   npm run dev
   ```

4. Open `http://127.0.0.1:3000`.

## Firebase setup

Create a Firebase project with Authentication and Firestore enabled.

Add one admin user in Firebase Authentication, then create this Firestore document:

Collection: `users`

Document ID: the Firebase Auth UID of the admin user

```json
{
  "role": "admin",
  "status": "active",
  "name": "PG Owner",
  "email": "admin@gmail.com"
}
```

The admin can then create resident accounts from the website. Residents receive the temporary password from the admin and can use "Forgot password?" to reset it through Gmail.

## Environment variables

Client config:

- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_APP_ID`

Server credential:

- `FIREBASE_SERVICE_ACCOUNT_JSON`, or
- `GOOGLE_APPLICATION_CREDENTIALS`
