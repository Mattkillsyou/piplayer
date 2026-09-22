// /signup: anyone can create an account from the login page; it starts as an editor (the
// owner's choice: no invite code, no approval step). Same card as /login and /setup; the form
// is re-rendered with the message on a mistake so nothing typed is lost. At most
// SIGNUPS_PER_IP attempts per address per SIGNUP_WINDOW_SECONDS (10 minutes, the window
// login_failures rows live), counted under auth.SIGNUP_KEY like the enroll throttle; every
// complete attempt counts, taken names and addresses are refused before the password is hashed.
// The email address is where /forgot sends the reset link (pages/forgot.js).
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, redirect, str } from "../util.js";
import { csrfInput } from "./layout.js";
import { authBrand, authPage } from "./login.js";

export const SIGNUP_ROLE = "editor";
export const SIGNUPS_PER_IP = 5;
export const SIGNUP_WINDOW_SECONDS = auth.LOGIN_USER_WINDOW_SECONDS;
export const EMAIL_TAKEN_MSG = "That email address already has an account";

function signupPage(ctx, error, username = "", email = "", status = 200, kind = "error") {
  const card = `<div class="auth-card">
    ${authBrand()}
    ${error ? `<div class="alert ${kind}" role="alert">${esc(error)}</div>` : ""}
    <form method="post" action="/signup">
      ${csrfInput(ctx)}
      <label>Username
        <input type="text" name="username" value="${esc(username)}" autocomplete="username" maxlength="${auth.MAX_USERNAME_CHARS}" autofocus required>
      </label>
      <label>Email
        <input type="email" name="email" value="${esc(email)}" autocomplete="email" maxlength="${auth.MAX_EMAIL_CHARS}" required>
      </label>
      <label>Password (at least ${auth.MIN_PASSWORD_CHARS} characters)
        <input type="password" name="password" autocomplete="new-password" required minlength="${auth.MIN_PASSWORD_CHARS}">
      </label>
      <label>Password (again)
        <input type="password" name="password2" autocomplete="new-password" required minlength="${auth.MIN_PASSWORD_CHARS}">
      </label>
      <button type="submit" class="primary">Create account</button>
    </form>
    <span class="auth-foot">p5k-console · new accounts can edit playlists, schedules and projectors · <a href="/login">back to sign in</a></span>
  </div>`;
  return authPage(ctx, { title: "Create an account", card, status });
}

async function signupSubmit(ctx) {
  if (ctx.user) return redirect("/dashboard");
  const form = await ctx.form();
  const username = str(form, "username").trim();
  const email = str(form, "email").trim();
  const password = str(form, "password");
  const wait = await auth.loginLockedFor(ctx.env, ctx.ip, auth.SIGNUP_KEY, SIGNUPS_PER_IP, SIGNUP_WINDOW_SECONDS);
  if (wait) {
    const minutes = Math.ceil(wait / 60);
    return signupPage(ctx, `Too many sign-ups from this address; try again in ${minutes} minute${minutes === 1 ? "" : "s"}`, username, email, 429);
  }
  if (!username) return signupPage(ctx, "Enter a username", username, email, 400);
  const nameProblem = auth.usernameProblem(username);
  if (nameProblem) return signupPage(ctx, nameProblem, username, email, 400);
  const emailProblem = auth.emailProblem(email);
  if (emailProblem) return signupPage(ctx, emailProblem, username, email, 400);
  const problem = auth.passwordProblem(password);
  if (problem) return signupPage(ctx, problem, username, email, 400);
  if (password !== str(form, "password2")) return signupPage(ctx, "The two passwords do not match", username, email, 400);
  await auth.recordLoginFailure(ctx.env, ctx.ip, auth.SIGNUP_KEY); // one tick of the per-address cap, taken or not
  if (await db.first(ctx.env, "SELECT 1 AS one FROM users WHERE username = ?", username)) {
    return signupPage(ctx, "That username is taken; pick another", username, email, 409);
  }
  if (await db.first(ctx.env, "SELECT 1 AS one FROM users WHERE lower(email) = lower(?)", email)) {
    return signupPage(ctx, EMAIL_TAKEN_MSG, username, email, 409);
  }
  const hash = await auth.hashPassword(password);
  let id;
  try {
    id = (await db.run(ctx.env, "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)", username, email, hash, SIGNUP_ROLE)).last_row_id;
  } catch (e) {
    if (db.isConstraintError(e)) { // lost the race
      const onEmail = /users_email_lower/.test(String(e.message));
      return signupPage(ctx, onEmail ? EMAIL_TAKEN_MSG : "That username is taken; pick another", username, email, 409);
    }
    throw e;
  }
  await auth.rotateSession(ctx, id);
  await audit.log(ctx, "user_signup", "user", id, { username, email, role: SIGNUP_ROLE }, { id, username });
  return auth.flashRedirect(ctx, "/dashboard", `Welcome, ${username}. Your account can edit playlists, schedules and projectors.`);
}

export function register(router) {
  router.get("/signup", (ctx) => (ctx.user ? redirect("/dashboard")
    : signupPage(ctx, ctx.url.searchParams.get("expired") ? "That form had expired; please fill it in again" : null, "", "", 200, "warn")));
  router.post("/signup", signupSubmit);
}
