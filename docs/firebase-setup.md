# Set up family sync (Firebase, free)

About 10 minutes, once. Everything stays on Firebase's free **Spark** plan: no card needed. The free
daily limits (50,000 reads, 20,000 writes, 1 GB stored) are far more than a family uses.

1. **Create the project.** Go to [console.firebase.google.com](https://console.firebase.google.com), tap
   **Create a project**, name it (for example `our-meal-planner`), and turn Google Analytics off.
2. **Turn on Google sign-in.** In the left menu open **Build → Authentication → Get started**. Under
   **Sign-in method** choose **Google**, switch it on, pick your email as the support email, and **Save**.
3. **Allow the app's website.** Still in Authentication, open **Settings → Authorized domains → Add domain**
   and add `pulija1.github.io` (the GitHub Pages address). `localhost` is already there for testing.
4. **Create the database.** Open **Build → Firestore Database → Create database**. Pick a location close
   to you (it can't be changed later) and start in **production mode**.
5. **Lock it to the family.** In Firestore open the **Rules** tab, replace everything with the contents of
   [`firestore.rules`](../firestore.rules), and tap **Publish**.
6. **Get the web settings.** Open **Project settings** (the gear next to Project Overview) → **General** →
   **Your apps** → the **Web** icon (`</>`). Name it `Meal planner`, leave Hosting unticked, and
   **Register app**. Copy the `firebaseConfig = { … }` block it shows.
7. **Paste it into the app.** In [`public/firebase-config.js`](../public/firebase-config.js), replace
   `null` with that block and commit it to `main`. These values aren't secret: the rules from step 5 are
   what keep the data private. GitHub Pages redeploys in a minute or two.
8. **Start the family space.** On your phone open the app, tap **Sign in with Google**, then
   **Start our family space**. Everything already on that phone goes up to the cloud.
9. **Add the family.** Tap 👤 → **Family members**, type the other person's Google email and tap
   **Add to family**. They open the app on their phone and sign in with that account. The app shows who
   started the space and asks before joining (anyone can type any email into their own space, so it never
   joins one on its own). Data they already had on their phone is added to the family's: nothing is thrown
   away, and two phones' meals for the same day or names filled in on either phone are combined.

## What happens day to day

- Every change saves on its own and shows on the other phones within a second or two. The ☁ button at the
  top shows **Synced**, **Saving…** or **Offline**.
- With no signal (a store basement) the app keeps working from the copy on the phone, and catches up when
  the signal comes back. Two people changing the same list at the same time both keep their changes: ticks
  on different items, a quantity on one phone and a tick on the other, kitchen items, meals on the same day.
- On a shared phone, signing out keeps the lists on the phone. If a different Google account then signs in,
  the app offers to start fresh or use that family's lists, so one family's data never ends up in another's.
- **Export backup** (👤 Profile, or the Backup card on the Calendar) still downloads a file you keep.
- Removing someone in 👤 Profile stops their phone syncing right away. Their phone keeps its own copy.

## Checking it works (for developers)

`npm run test:firebase` runs the security rules tests and two-phone sync tests against the Firebase
emulator (needs Java 21). It never touches the real project.
