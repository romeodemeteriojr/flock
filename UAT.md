# Flock acceptance checklist (UAT)

This is a click-by-click test you do by hand, with your own eyes. You do not
need to be a programmer. Everything uses **made-up demo people**, so nothing you
click can hurt your real church data.

A computer program already checks that the buttons and pages are wired up
correctly. This checklist is for what only a person can judge: does it make
sense, is it readable, is it comfortable on a phone.

**How to use it:** do the scenarios in order. For each step, check that what
you see matches **You should see**. Then tick **Pass** or **Fail**. If something
fails, jump to [How to report a problem](#how-to-report-a-problem) at the
bottom and write it down before you go on.

Allow about 90 minutes for everything. You can stop after any scenario.

---

## Part A: Getting ready

### A1. Start the demo on your laptop

1. Open a terminal in the Flock folder. (Mac: Terminal. Windows: PowerShell.)
2. Type this and press Enter. It makes a new demo database file called
   `demo.db` and fills it with fake people, teams and services:

   ```
   node bin/flock.js demo --db demo.db
   ```

3. Flock prints something like this. **Save the invite link privately. It works
   once, for 7 days.**

   ```
   Demo data added: 13 people, 4 teams, 8 services, 4 blockouts.
   Everything here is fake.
   Admin email: demo-admin@example.com
   Invite link (works once, for 7 days): http://localhost:8080/#/welcome?token=<one-time-token>
   ```

4. Start Flock:

   ```
   node bin/flock.js serve --db demo.db
   ```

5. You should see the line `flock is running at http://localhost:8080`. Leave
   this window open. (If it says the port is already in use, press Ctrl+C and
   start again with a different port. Mac: `FLOCK_PORT=3000 node bin/flock.js serve --db demo.db`.
   Windows PowerShell: `$env:FLOCK_PORT=3000; node bin/flock.js serve --db demo.db`.
   Then use `3000` instead of `8080` everywhere below.)
6. Open a web browser (Chrome, Safari, Firefox or Edge) and go to
   **http://localhost:8080**.

You should see a page called **Log in to Flock** with an Email box and a
Password box.

**Starting over:** press Ctrl+C in the terminal to stop Flock. Delete the files
`demo.db`, `demo.db-wal` and `demo.db-shm` (whichever exist) from the Flock
folder. Then do A1 again. The demo refuses to run on a database that already
has people in it. That is on purpose.

### A2. The demo people

| Name | Email (the login) | Can log in with |
| --- | --- | --- |
| Demo Admin (a scheduler) | `demo-admin@example.com` | choose a password using the invite printed in A1 |
| Demo Alice, Bob, Carol, Dave, Erin, Frank, Grace, Heidi, Ivan, Judy, Mallory, Niaj | `demo.alice@example.com`, `demo.bob@example.com`, and so on | nothing yet. Make an invite on People, or add your own person in scenario 3 |

The demo has four teams (Band, Sound, Kids, Greeters) and eight "Sunday
service" dates at 10:00 am, starting next Sunday. Some positions are filled,
some are waiting for an answer, some were declined, and some are empty.

### A3. Open Flock on a phone (same Wi-Fi)

Do this part when you reach scenario 9. You need the laptop's address on your
home or church network.

1. **Find the laptop's address.** Mac: open Terminal and type
   `ipconfig getifaddr en0` (if it prints nothing, try `en1`). Windows: open
   PowerShell, type `ipconfig`, and look for **IPv4 Address**. It looks like
   `192.168.1.20`.
2. Make sure the phone is on the **same Wi-Fi** as the laptop. A "guest" Wi-Fi
   often blocks this, so use the main one.
3. On the phone, open the browser and go to `http://192.168.1.20:8080`
   (use your own number).
4. If the laptop asks whether to allow "node" to accept connections, choose
   **Allow**.

You should see the same Log in page on the phone. If you do not, see
"The phone cannot open the page" under [Troubleshooting](#troubleshooting).

Over plain `http://` the password is not protected on the network. That is fine
for a trial with made-up passwords on your own Wi-Fi. Do not do this with real
passwords.

---

## Part B: The scheduler

Use the laptop. Keep the terminal window open.

### 1. Join with an invite and change a password voluntarily

1. Go to http://localhost:8080. You should see **Log in to Flock**, with no menu.
2. Click **Log in** without typing anything: **Please type your email and password.**
3. Try `demo-admin@example.com` with a password you have not chosen. It must say
   **Wrong email or password**, not let someone claim the account.
4. Open the invite link printed in A1. **Welcome to Flock** should show the
   email `demo-admin@example.com`. Try mismatched passwords: **The two passwords are
   not the same.** Try `short`: the message should require at least 8 characters.
5. Choose your own password twice, such as `my own password 1`, and click
   **Choose password** twice quickly. You should be logged in once, on
   **My schedule**, with **Logged in as Demo Admin** and the menu.
   The address should end in `#/`, with no token left in it.
6. In a private window open the same invite again. It must say the link was
   used or expired and offer a link to log in. Log in with the password you chose.
7. On the original page click the key button at the top (**Change my password**).
   The page should have Current password, New password and confirmation fields.
   Try a missing current password, a short new password, mismatches and an
   unchanged password. Each should show a plain message without leaving the page.
8. Choose a different valid password and save it. You should return to
   **My schedule** with **Your new password is saved.** The private window's old
   session should no longer work; the newly chosen password should log in.

**Remember the latest password.** Use it for the rest of this checklist.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 2. Wrong password and lockout

1. Click **Log out** (top right). You should be on the Log in page.
2. Type `demo-admin` and a wrong password, and click **Log in**, five times in a row.
   You should see **Wrong email or password** each time (the fifth try may
   already say it is locked).
3. Now type the **correct** password. You should still be refused, with
   **Too many tries. Please wait a few minutes.** That is the lockout working.
4. Wait about 5 minutes (go and make a cup of tea). Try the correct password
   again. You should be in.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 3. Add a person

1. Click **People** in the menu. You should see Demo Admin and the twelve other
   demo people, each with a coloured circle with initials, **Volunteer** or
   **Scheduler**, and buttons.
2. Click **Add person**. In the Name box type `Pat Example`, and in the Email
   box `pat.example@example.com`.
3. Clear the name and click the **Add person** button inside the form. You should
   see **Please type a name.**
4. Type `Pat Example` again (and the email) and click **Add person** (try double-clicking it).
5. You should see **Invite for Pat Example**, a message containing Pat's
   email and a one-time link, and **Copy message**. Click it and save the
   message privately. Only one Pat Example should have been added; their row
   says **Not joined yet**. A localhost warning means this link only works on
   the laptop: use the laptop's network address from A3 and **Copy new invite**
   before sending the message to a phone.
6. Click **Done**. The invite box should disappear. Making another invite
   cancels the previous link.
7. Add `Quinn Example` (`quinn.example@example.com`) the same way and save
   their invite message privately.
8. Try adding a third person named `Someone Else` but with the email
   `pat.example@example.com`. You should see **That email is already used by
   someone else.** Click Cancel.
9. Type `quinn` in the **Search by name or email** box. Only Quinn Example
   should stay in the list.
10. Add `Gran Example` with no email. You should see **Gran Example is added.
   Without an email they cannot log in, but you can schedule them.** and the
   row says **No email, cannot log in**.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 4. Add a team and positions

1. Click **Teams** (on a phone: **More**, then **Teams**).
2. Click **Add team** with the box empty. You should see **Please type a name.**
3. Type `Ushers` and click **Add team**. You should see **Team added.** and a
   new **Ushers** card saying **No positions yet.**
4. On the Ushers card click **Add position**, type `Door`, and click
   **Add position**. You should see **Position added.** and **Door** with
   **Nobody is qualified yet**.
5. Try **Rename** on Door and then **Cancel**. Nothing should change.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 5. Say who can do the new position

1. Go to **People**. On Pat Example's row click **What can they do?**.
2. You should see a list of every position, grouped by team, with tick boxes.
   Tick **Door** and click **Save**. You should see **Saved what Pat Example can do.**
3. Do the same for Quinn Example.
4. Go back to **Teams**. Door should now say **2 people can do this**.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 6. Create a service date

1. Click **Services**. You should see **Add a service** and the eight demo
   Sundays under **Upcoming services**.
2. Leave the Date empty and click **Add service**. You should see
   **Please pick a date.**
3. Pick a date about **two weeks from today**. Set the time to 9:00 am and the
   title to `Practice service`. Under **Ushers**, tick **Door** and set
   **How many Door** to `1`. Under **Greeters**, tick **Welcome** (also `1`).
4. Click **Add service** (try double-clicking). You should see **Service added
   for** that date, and the new service in the list: **Practice service**, with
   **Greeters: Welcome. Ushers: Door.** Only one should be added.
5. On the new service click **Repeat for more weeks**, type `2`, and click
   **Repeat**. You should see **Added 2 more services.** Now there are three
   Practice services, one week apart.
6. Try to add a service with **How many Door** set to `0`. You should see
   **How many Door? Please type a number from 1 to 20.** and what you typed is
   still there.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 7. Assign volunteers

1. Click **Schedule**. You should see a grid of the next 8 weeks. On a phone it
   becomes cards. Each position shows a person with a word such as **Confirmed**,
   **Waiting for answer** or **Declined**, or **Nobody yet**.
2. Find the first Practice service. Click its **Door** position (Nobody yet).
3. A panel opens: **Who could do this**, with Pat Example and Quinn Example,
   each with reasons such as "Has never served". The cursor should be on the
   panel's heading.
4. Click **Assign** next to Pat Example. You should see **Pat Example is now on
   Door ... Waiting for their answer.** and the panel closes.
5. Do the same for the **second** and **third** Practice service, again with
   Pat Example. (Pat should be offered each time.)
6. Click Pat's name in the first service. The panel should offer **Remove
   person**. Click it, then **No, go back**. Nothing changes.
7. Open the second service's Door again and also look at the tabs **Only people
   trained for this** and **Show people not trained for this**. Both should
   work.
8. Press the **Escape** key while a panel is open. It should close.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 8. Gaps, suggestions and reminders

1. Click **Gaps**. You should see **Next 4 weeks** and five counts: **Nobody yet,
   Said no, Hasn't answered, Now away, No longer active**. Below, each kind has
   a list that says what to do.
2. Find the **Welcome (Greeters)** gap in the first Practice service. Click it.
   The same panel opens. Click **Assign** on the first suggested person. You
   should see their name is now on it, and the **Nobody yet** count goes down by one.
3. Scroll to **Reminders**. You should see: **Flock never sends messages. Copy
   these into your usual messages app.**
4. Set **Week starting** to the date of the first Practice service and click
   **Show messages**. You should see a ready-to-copy message for each person
   scheduled that week, including Pat Example.
5. Click **Copy** on one. On the laptop you should see **Copied. Paste it into
   your messages app.** Paste it somewhere to read it. (On a phone over the
   `http://192...` address the browser may refuse and say **Could not copy.**
   That is expected.)
6. **Nothing is sent.** There is no Send button anywhere, and no text, email or
   notification arrives on anyone's phone.

- [ ] Pass   [ ] Fail   Notes: ______________________________

---

## Part C: A volunteer on a phone

Use the **phone** for this part (see A3). The scheduler stays logged in on the
laptop.

### 9. A volunteer logs in and sees My schedule

1. On the laptop, open Flock using its network address from A3. On Pat's row,
   choose **Copy new invite**, then **Copy message**. Send it privately to the phone.
2. On the phone, tap the new link. **Welcome to Flock** should show the
   email Pat logs in with, `pat.example@example.com`. Choose a password and type it again. The boxes
   show dots, not letters. Tap **Choose password**; this also logs Pat in.
3. You should land on **My schedule**: a big **Next up** box with a sentence
   such as **You're serving this Sunday as Door at 9:00 am** (or **Next time
   you serve: Sun 22 Nov, Door**), then **Coming up** with a card for each of the
   three Practice services. Each card shows the date, the time, the position
   and team, and **Please answer**.
4. At the bottom there is a bar with **My schedule** and **Days off** only.
   There are no scheduler pages. Type `#/people` at the end of the address; you
   should be sent back to My schedule.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 10. Accept and decline

1. On the first card tap **Yes, I can** (try double-tapping). You should see
   **Thank you! You are confirmed.** and the card now says **Confirmed**.
2. On the second card tap **I can't**. You should see **Thanks for letting us
   know. Your scheduler will find someone else.** and that card disappears.
3. Back on the laptop, open **Gaps**. The count of **Said no** should have gone up
   by one, and the position Pat declined should be listed under **Said no**.
4. On the phone, on the Confirmed card tap **I can't make it after all**. You
   should see **Are you sure you can't serve on ...?**
5. Tap **No, keep me on**. The question goes away and the card stays Confirmed.
6. Tap **I can't make it after all** again and then **Yes, I can't make it**. The
   card should disappear.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 11. Add and remove a day off

1. On the phone, tap **Days off**. You should see **Days I can't serve**, a
   form with From, To and Reason, and **You have no days off saved**.
2. Tap **Add** with the dates empty. You should see **Please pick** a date.
3. Choose a To date that is before the From date. You should see a message that
   the end cannot be before the start.
4. Pick a date a few weeks away, type the reason `Family trip`, and tap **Add**
   (try double-tapping). You should see **Saved. You are off ...** and **Family
   trip** in the list **Days I have off**, once.
5. Now add a day off on the date of the **third Practice service**, the one Pat
   still has a waiting request for. You should see **You are already scheduled on
   ... Please tell your scheduler.**
6. Tap **Remove** beside each day off you added. You should see **Removed. You can
   be scheduled on those days again.**

- [ ] Pass   [ ] Fail   Notes: ______________________________

---

## Part D: Looking after people

Back on the laptop, logged in as the scheduler.

### 12. Change someone's access level

1. Go to **People**. Your own row (Demo Admin) says **That's you** and has no
   "Make volunteer" button. That is on purpose.
2. On Pat Example's row click **Make scheduler**. You should see **Make Pat
   Example a scheduler? ...** with two buttons.
3. Click **No, go back**. Nothing changes.
4. Click **Make scheduler** again, then **Yes, make a scheduler**. You should see
   **Pat Example is now a scheduler.** and the row says **Scheduler**.
5. On the phone, reload the page. Pat should now also see **Schedule, Gaps,
   People** and the other scheduler pages.
6. Back on the laptop click **Make volunteer** on Pat, then **Yes, make a
   volunteer**. You should see **Pat Example is now a volunteer.** Reload on the
   phone. The scheduler pages are gone again.
7. Try **Deactivate** on your own row, then **Yes, deactivate**. You should see
   **You can't deactivate your own account.**

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 13. Deactivate and reactivate a person

1. On Pat's row click **Deactivate**. You should see **Deactivate Pat Example? They
   will not be able to log in ... Nothing is deleted ...**
2. Click **No, go back**, then **Deactivate** again, then **Yes, deactivate**. You
   should see **Pat Example is deactivated. Their history is kept.** and a red
   **Deactivated** tag.
3. On the phone (still open) tap **Days off**. You should be sent to the Log in
   page with **Please log in again.**
4. On the phone try to log in as Pat. You should see **Wrong email or
   password**.
5. On the laptop click **Reactivate**, then **Yes, reactivate**. You should see
   **Pat Example is active again.**
6. On the phone log in as Pat with the password Pat chose. It should work.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 14. Reset a login

1. On the laptop, on Pat's row click **Edit name**: the email cannot be changed
   because Pat has joined. Cancel. Click **Reset login**. The confirmation
   should say that Pat's password and any linked sign-in stop working right
   away and Pat is logged out everywhere.
2. Click **Yes, reset login** (try double-clicking). You should see
   **Invite for Pat Example**. Choose **Copy message**, send it privately,
   and then choose **Done**.
3. On the phone tap anything. You should be sent to Log in with **Please log in
   again.**
4. Pat's old password should now say **Wrong email or password**.
5. Open the new invite link on the phone and choose a new password. Pat
   should be logged in directly; the old invite must no longer work.
6. For a **demo** volunteer who has not joined, use **Copy new invite** on
   People. Send Demo Alice her message and open its link to join as
   `demo.alice@example.com`. Alice already has a day off from the demo.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 15. Log out and session expiry

1. On the phone, tap **Log out**. You should be on the Log in page, with no
   menu. Press the browser's **Back** button and also try typing
   `#/blockouts` at the end of the address. You should stay on the Log in page.
2. **Two-tab check.** On the laptop open Flock in two browser tabs, both
   logged in. In the second tab click **Log out**. In the first tab click
   **Teams**. You should be sent to the Log in page with **Please log in
   again.**
3. A login lasts 14 days, which you cannot wait for. The computer tests check
   that case. If you want to see it yourself, change the laptop's date forward
   by 15 days, click anything in Flock, and expect **Please log in again.** Then
   put the date back.

- [ ] Pass   [ ] Fail   Notes: ______________________________

---

## Part E: Looks and comfort

### 16. Dark mode

1. Switch your laptop (or phone) to **dark mode** in its settings, then reload
   Flock. (Mac: System Settings, Appearance. Windows: Settings, Personalization,
   Colors. Phone: Settings, Display.)
2. Visit every page: Log in, My schedule, Days off, People, Teams, Services,
   Schedule, Gaps.
3. You should see a dark background with light text everywhere. All words should
   be easy to read: no grey text on grey, no white box in the middle of a dark
   page. Coloured tags (**Confirmed, Declined, Waiting for answer**) should still
   be readable and also carry a word, not only a colour.
4. Switch back to light mode and check again.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 17. Keyboard only

Put the mouse and trackpad aside. Use only **Tab**, **Shift+Tab**, **Enter**,
**Space**, the arrow keys and **Escape**.

1. On the Log in page press Tab. You should be able to reach Email, Password
   and Log in, in that order, with a clear outline around the one you are on.
   Type, then press Enter to log in.
2. Use Tab to reach the menu. Press Enter on **People**. The page should change
   and the page heading should get the outline.
3. Add a person using only the keyboard: reach **Add person**, press Enter, type a
   name, Tab to the Add button, press Enter.
4. Open a position in **Schedule** with Enter. The panel opens and the focus is
   inside it. Tab should stay inside the panel, never behind it. Press **Escape**.
   The panel closes and the focus goes back to the position you opened.
5. On **Teams**, press Tab until you reach **Delete team**. Press Enter. You get a
   question first. Press Tab to **No, go back** and Enter.
6. You should never lose track of where you are (no moment with no outline), and
   you should never get stuck.

- [ ] Pass   [ ] Fail   Notes: ______________________________

### 18. Screen reader basics

Turn on a screen reader (Mac: VoiceOver, Cmd+F5. Windows: Narrator, Ctrl+Windows+Enter.
Phone: VoiceOver or TalkBack). If you do not have one, a helper can do this
part. Skip it for now and tick **Skipped**.

1. On the Log in page, move through the page. It should say **Email, edit
   text** and **Password, secure edit text**, and the button **Log in**. Every box
   and button should say what it is for, never just "edit text" or "button".
2. When you log in with a wrong password, the message **Wrong email or
   password** should be read out without you moving.
3. On **People**, each button should say what it does, for example **Reset
   password**. When there is a name with it you should know whose it is, either
   from the row you are in or from the words around it. Note any that you cannot
   tell apart.
4. After changing page the reader should announce the new page heading.
5. Little pictures (icons) should be skipped. Pictures that only decorate should
   say nothing.
6. When a green or red message appears (for example **Team added.**), it should
   be read out.

- [ ] Pass   [ ] Fail   [ ] Skipped   Notes: ______________________________

### 19. What the page looks like at phone width

You can do this on the laptop: make the browser window narrow (about as narrow as
a phone), or use a real phone.

1. Look at every page. Nothing should run off the side or need sideways scrolling,
   except the Schedule grid on a wide screen (on a phone it turns into cards).
2. The menu should be a bar at the bottom of the screen (volunteers: **My
   schedule** and **Days off**; schedulers: **Schedule, Gaps, People, More**).
   **More** opens the other pages. Tap somewhere else, or press Escape, to close it.
3. Buttons should be big enough to tap with a thumb, with space between them,
   so you do not hit the wrong one. **Delete** buttons should never sit right on
   top of a normal button.
4. The slot panel should come up from the bottom like a sheet, and **Close** should
   always be reachable.
5. Text should be readable without zooming. Turn the phone sideways: it should
   still work.

- [ ] Pass   [ ] Fail   Notes: ______________________________

---

## Part F: Things to try to break it

Be mean. Nothing should crash, lose your work, show a blank page or show scary
words like "undefined" or "error 500". A plain message in everyday words is a
fine result.

### 20. Try to break it

For each, you should see a calm result: either it works once, or a plain message
says why it did not.

1. **Double clicks.** Double-click (fast) each of these: Log in, Add person, Add
   service, Assign, Yes I can, Add day off, Reset it, Delete. Only **one** thing
   should happen each time.
2. **Back button.** Click through People, Teams, Services, then press the
   browser's Back button several times. Each page should show correctly and old
   green or red messages should not pile up. After you log out, Back should
   never show you scheduler pages.
3. **Two tabs.** Open Flock in two tabs. In tab 1 delete a service. In tab 2,
   without reloading, click **Delete** on the same service and confirm. You should
   see a plain message, and the page should still work. In tab 2 also try
   changing someone Tab 1 just deactivated.
4. **Very long names.** Add a person with a name of 80 letters (it should work)
   and then 81 (it should say **The name must be 1 to 80 characters long.**).
   Look at the People page. Long names should wrap or be cut off neatly and not
   break the page. Try a very long team name, service title and day-off reason.
5. **Emoji and accents.** Add a person called `Zoë 🎺 Trumpet` and another
   called `🎺🎺🎺`. Both should work and show correctly everywhere (People,
   Schedule, Gaps, a reminder). `Zoë 🎺 Trumpet` gets the email `zoe@example.com`; `🎺🎺🎺` gets none.
6. **Strange text.** Add a team named `<b>Bold team</b>` and a person named
   `"><script>alert(1)</script>`. The page must show that text exactly as typed,
   as plain letters, and nothing must pop up or turn bold.
7. **Empty and spaces.** Try to save any form with nothing in it, or only spaces.
   You should see **Please type a name.** or a similar plain message.
8. **Rapid clicking around.** Click through all the menu items as fast as you can.
   You should end on the last page you clicked, with no error message.
9. **Reload in the middle.** Open a form, half fill it, and reload the page. Nothing
   is lost that was saved. Nothing odd is saved that was not.
10. **Stop Flock.** Press Ctrl+C in the terminal, then click a button in the browser.
    You should see **Can't reach the server. Check your internet and try again.**
    Start Flock again; the page should work after you reload.

- [ ] Pass   [ ] Fail   Notes: ______________________________

---

## Results

| # | Scenario | Pass | Fail |
| --- | --- | --- | --- |
| 1 | Join with an invite and change a password voluntarily | [ ] | [ ] |
| 2 | Wrong password and lockout | [ ] | [ ] |
| 3 | Add a person | [ ] | [ ] |
| 4 | Add a team and positions | [ ] | [ ] |
| 5 | Say who can do the new position | [ ] | [ ] |
| 6 | Create a service date | [ ] | [ ] |
| 7 | Assign volunteers | [ ] | [ ] |
| 8 | Gaps, suggestions and reminders | [ ] | [ ] |
| 9 | Volunteer logs in and sees My schedule (phone) | [ ] | [ ] |
| 10 | Accept and decline | [ ] | [ ] |
| 11 | Add and remove a day off | [ ] | [ ] |
| 12 | Change someone's access level | [ ] | [ ] |
| 13 | Deactivate and reactivate | [ ] | [ ] |
| 14 | Reset a password | [ ] | [ ] |
| 15 | Log out and session expiry | [ ] | [ ] |
| 16 | Dark mode | [ ] | [ ] |
| 17 | Keyboard only | [ ] | [ ] |
| 18 | Screen reader basics | [ ] | [ ] |
| 19 | Phone width | [ ] | [ ] |
| 20 | Things to try to break it | [ ] | [ ] |

---

## How to report a problem

When something fails, write down these things **right away**, while you can still
see the page. Send them to whoever looks after Flock.

1. **Which scenario and step** (for example "Scenario 10, step 2").
2. **What you did**, in your own words: what you clicked or typed.
3. **What you expected** (the "You should see" line).
4. **What actually happened.** Copy the exact words on the screen, including any
   red message. Take a screenshot if you can.
5. **Which device and browser** (for example "iPhone, Safari" or "Windows laptop,
   Chrome") and roughly how wide the window was.
6. **Who you were logged in as** (the email, for example `demo-admin@example.com`).
   **Never write down or send a password.**
7. **The time it happened**, to the minute.
8. **The last 10 lines in the terminal window where Flock is running.** Select,
   copy and paste them. They never contain passwords.
9. **Does it happen every time?** Try the same steps once more and say yes or no.

## Troubleshooting

- **"command not found: node"**: install Node.js (version 22.16 or newer) from
  https://nodejs.org and open a new terminal window.
- **The phone cannot open the page.** Check that: Flock is still running; the phone
  is on the same Wi-Fi (not guest Wi-Fi, and not mobile data); the address uses
  the laptop's current number and `:8080`; the laptop's firewall allowed "node".
  Try the laptop's own browser with the same `http://192...` address. If that works,
  the problem is the phone's Wi-Fi.
- **I forgot the demo password.** Stop Flock, delete `demo.db`, `demo.db-wal` and
  `demo.db-shm`, and run A1 again.
- **The demo says "This database already has people".** It only fills an empty
  database. Delete the files as above.
