// Port of web.groups_* + groups.html. Each account has its own groups (device_groups.owner_id,
// migration 0016; names unique per account), each with one of its own playlists as default:
// another account's group or playlist id answers exactly like a missing one.
import * as accounts from "../accounts.js";
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, fail, idParam, intField, redirect, str } from "../util.js";
import { requireRow } from "./devices.js";
import { csrfInput, emptyState, layout } from "./layout.js";

async function groupsPage(ctx) {
  const user = auth.requireUser(ctx);
  const canEdit = user.role !== "viewer";
  // The device count is the account's own projectors in the group (only those may join it).
  const groups = await db.all(ctx.env,
    `SELECT g.id, g.name,
            g.playlist_id, p.name AS playlist_name,
            (SELECT COUNT(*) FROM devices d WHERE d.group_id = g.id AND ${accounts.contentOwnerSql("d")} = ?1) AS device_count
       FROM device_groups g
       LEFT JOIN playlists p ON p.id = g.playlist_id AND p.owner_id = ?1
      WHERE g.owner_id = ?1
      ORDER BY g.name`, user.id);
  const playlists = await db.all(ctx.env, "SELECT id, name FROM playlists WHERE owner_id = ? ORDER BY name", user.id);
  const row = (g) => `<tr>
      <td class="name">${esc(g.name)}</td>
      <td>${g.device_count}</td>
      <td>
        <form method="post" action="/groups/${g.id}/assign" class="inline">
          ${csrfInput(ctx)}
          <select name="playlist_id" data-autosubmit aria-label="Default playlist for ${esc(g.name)}"${canEdit ? "" : " disabled"}>
            <option value="">Default</option>
            ${playlists.map((p) => `<option value="${p.id}"${p.id === g.playlist_id ? " selected" : ""}>${esc(p.name)}</option>`).join("\n            ")}
          </select>
        </form>
      </td>
      <td>
        ${canEdit ? `<form method="post" action="/groups/${g.id}/delete" class="inline" data-confirm="Delete ${esc(g.name)}? Devices in the group will lose this default playlist.">
          ${csrfInput(ctx)}
          <button type="submit" class="danger small">Delete</button>
        </form>` : ""}
      </td>
    </tr>`;
  const content = `<div class="page-head">
  <h1>Device groups</h1>
  ${canEdit ? `<form method="post" action="/groups" class="head-actions">
    ${csrfInput(ctx)}
    <label>new group
      <input type="text" name="name" placeholder="e.g., Lobby projectors" required>
    </label>
    <button type="submit" class="primary">Create</button>
  </form>` : ""}
</div>

${!groups.length ? emptyState("NO GROUPS", `No groups yet.${canEdit ? " Create one above." : ""}`) : `<div class="table-wrap">
<table class="data">
  <caption class="sr-only">Device groups</caption>
  <thead>
    <tr><th scope="col">Name</th><th scope="col">Devices</th><th scope="col">Default playlist</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
  </thead>
  <tbody>
    ${groups.map(row).join("\n    ")}
  </tbody>
</table>
</div>`}`;
  return layout(ctx, { title: "Groups", content });
}

// Names are unique within the account (idx_device_groups_owner_name): the 409 is only ever about
// one's own group.
async function groupsCreate(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const name = str(await ctx.form(), "name").trim();
  if (!name) fail(400, "Enter a name");
  let id;
  try {
    id = (await db.run(ctx.env, "INSERT INTO device_groups (owner_id, name, legacy_name) VALUES (?, ?, ?)", user.id, name, accounts.uniqueKey())).last_row_id;
  } catch (e) {
    if (db.isConstraintError(e)) fail(409, "A group with that name already exists");
    throw e;
  }
  await audit.log(ctx, "group_create", "group", id, { name });
  return redirect("/groups");
}

async function groupsAssign(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const groupId = idParam(ctx.params.group_id, "group_id");
  const pid = intField(str(await ctx.form(), "playlist_id"), "playlist_id");
  await requireRow(ctx.env, "device_groups", groupId, user.id, "Group");
  await requireRow(ctx.env, "playlists", pid, user.id, "Playlist");
  await db.run(ctx.env, "UPDATE device_groups SET playlist_id = ? WHERE id = ?", pid, groupId);
  await audit.log(ctx, "group_assign_playlist", "group", groupId, { playlist_id: pid });
  return redirect("/groups");
}

async function groupsDelete(ctx) {
  const user = auth.requireRole(ctx, "editor");
  const groupId = idParam(ctx.params.group_id, "group_id");
  const r = await db.run(ctx.env, "DELETE FROM device_groups WHERE id = ? AND owner_id = ?", groupId, user.id);
  if (!r.changes) fail(404, "Group not found");
  await audit.log(ctx, "group_delete", "group", groupId);
  return redirect("/groups");
}

export function register(router) {
  router.get("/groups", groupsPage);
  router.post("/groups", groupsCreate);
  router.post("/groups/:group_id/assign", groupsAssign);
  router.post("/groups/:group_id/delete", groupsDelete);
}
