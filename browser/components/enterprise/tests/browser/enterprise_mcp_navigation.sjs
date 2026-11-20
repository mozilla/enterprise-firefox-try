/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function handleRequest(request, response) {
  const query = new URLSearchParams(request.queryString);
  const key = query.get("id");
  response.setHeader("Cache-Control", "no-store", false);

  if (query.has("redirect")) {
    response.setStatusLine(request.httpVersion, 302, "Found");
    response.setHeader("Location", query.get("redirect"), false);
    return;
  }

  if (query.has("release")) {
    response.processAsync();
    getObjectState(key, pending => {
      if (pending) {
        pending.write("<!doctype html><h1>Late document</h1>");
        pending.finish();
      }
      response.finish();
    });
    return;
  }

  if (query.has("count")) {
    response.setHeader("Content-Type", "text/plain", false);
    response.write(getState(key) || "0");
    return;
  }

  setState(key, String(Number(getState(key)) + 1));
  response.setHeader("Content-Type", "text/html", false);
  if (query.has("hold")) {
    response.processAsync();
    setObjectState(key, response);
    return;
  }
  response.write("<!doctype html><h1>Agent tab</h1>");
  if (query.has("controls")) {
    response.write(`
      <button onclick="this.dataset.clicked = 'yes'">Apply</button>
      <button type="button"
              onclick="try {
                this.dataset.opened = Boolean(window.open('https://example.org/'));
              } catch {
                this.dataset.opened = 'blocked';
              }">Popup</button>
      <label>Title <input id="title" maxlength="20"></label>
      <input id="subject" aria-label="Subject" maxlength="20"
             oninput="this.dataset.edited = 'yes'">
      <select id="priority" aria-label="Priority" onchange="this.dataset.edited = 'yes'">
        <option>Low</option><option>High</option><option disabled>Unavailable</option>
      </select>
      <input type="password" aria-label="Password">
      <input type="file" aria-label="File">
      <input autocomplete="one-time-code" aria-label="Code">
      <input style="display:none" aria-label="Hidden">
      <form onsubmit="event.preventDefault(); this.dataset.submitted = 'yes'">
        <button type="submit">Save</button>
      </form>
      <form><input autocomplete="cc-number"><button>Pay</button></form>
      <div tabindex="0" aria-label="Log" style="height: 48px; overflow:auto">
        <div style="height: 200px">Log entries</div>
      </div>
    `);
  }
  if (query.has("image")) {
    const src = query
      .get("image")
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;");
    response.write(`<img src="${src}">`);
  }
}
