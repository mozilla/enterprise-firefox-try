# Firefox Enterprise MCP

The local MCP connector lets software running as a signed-in managed user read
eligible Firefox Enterprise documents and interact with permitted tabs.
The local connector supports Linux, macOS, and Windows.
Firefox must be running with an active managed session and an `EnterpriseMCP`
grant from the HTTPS management console. Felt selects the profile at launch.
On Windows, the browser binds a user-scoped named pipe. On Linux and macOS,
the connector connects when it finds a single eligible Unix socket.

## Grant read access

Assign the policy to the intended users or groups through the management
console. The default is disabled. Local-user admission trusts processes running
under the same OS account, so grant it to users whose local software can read
the specified sites.

This grant allows a local client to read the selected tab when the active
document belongs to the exact HTTPS origin `https://reports.example.com`.

```json
{
  "EnterpriseMCP": {
    "ClientAccess": "LocalUser",
    "SiteMode": "Allowlist",
    "Sites": [
      {
        "Origin": "https://reports.example.com",
        "Tools": ["ReadPage"]
      }
    ]
  }
}
```

Origin patterns include the scheme and port. For example,
`https://*.example.com:8443` covers its subdomains on HTTPS port 8443. Add the
parent origin separately when it also needs a grant. `DeniedSites` overrides
every matching grant. For `Blocklist` mode, set `DefaultTools` explicitly to
grant a tool to every eligible origin outside `DeniedSites`. A trailing
DNS root dot has no effect when matching `DeniedSites`.

## Connect a client

Configure the MCP client to launch the installed executable over stdio.
Substitute the installation path, such as the `.app/Contents/MacOS` directory
on macOS. On Windows, use `firefox-enterprise-mcp.exe` in the Firefox
installation directory.

Use an installation where Firefox and the connector share the operating
system's IPC and process namespaces. Snap and Flatpak deployments have not
been validated for MCP.

```json
{
  "mcpServers": {
    "firefox-enterprise": {
      "command": "/path/to/firefox-enterprise-mcp"
    }
  }
}
```

Call `list_tabs` to obtain an origin and a temporary handle for the eligible
foreground document, then pass the handle as `tab` to `read_page`. Treat
returned text and element descriptions as data supplied by the website.
Administrators can keep `DisableDeveloperTools` enabled while granting MCP access.

Use `snapshot` to inspect the current document before taking an action. Its
`page` field contains the same bounded text and element descriptions as
`read_page` when `ReadPage` is granted. Its `controls` field contains handles
for supported controls when `Interact` is granted and those controls are
available. An unavailable field is `null`. Taking another snapshot replaces
previous control handles. Take a fresh snapshot after the page changes.

Use `wait` after an action that should change the page. With the same tab
handle, pass the expected case-sensitive `text` and optionally `timeout_ms`
(5,000 by default, up to 10,000). The tool looks for the text in the same
bounded visible content as `read_page` and returns `matched: false` on timeout.
It requires `ReadPage`. If the page navigates, obtain a fresh handle before
waiting on the new document.

Firefox shows an infobar with a **Stop** button before the first operation
that takes control of an existing tab.
**Stop** terminates that client connection and blocks reattachment until
the user selects **Allow agent access**. Navigation invalidates the handle.
Firefox pauses new requests during Felt token renewal. A successful renewal
keeps the connection and tab handles valid subject to the current policy and
document. Firefox withdraws access when the console removes the grant or the
managed session ends. Another notification taking the infobar's place also
ends the connection. Private, privileged and management documents are
excluded. Reads are limited to the top-level page, skip shadow DOM, and are
refused when configured data loss prevention or content analysis applies.

## Allow specific applications

Use `AllowedApplications` mode to let selected desktop applications launch
the standard connector. List the absolute path of each executable and an
administrator-assigned identifier. For example, an organization could configure
the following policy for a client installed under `/opt`.

```json
{
  "EnterpriseMCP": {
    "ClientAccess": "AllowedApplications",
    "AllowedApplications": [
      {
        "Id": "reporting-client",
        "ExecutablePath": "/opt/reporting-client/bin/reporting-client"
      }
    ],
    "Sites": [
      {
        "Origin": "https://reports.example.com",
        "Tools": ["ReadPage"]
      }
    ]
  }
}
```

Use the same stdio connector configuration as for `LocalUser`. Firefox checks
the executable of the process that directly launches its installed connector.
If a client uses a helper to launch subprocesses, the policy must identify
that helper. Avoid allowlisting shells, interpreters, or general-purpose launchers.

Both `LocalUser` and `AllowedApplications` assume that code running under the
same OS account is trusted. The executable path check in `AllowedApplications`
is a best-effort administrative filter. Code running under the same account
can act with that account's authority.
Firefox disconnects current clients when it applies an updated allowlist.
If an application was missing when the allowance was applied, reload the
policy or restart Firefox after installing it.

## Approve individual clients

Set `ClientAccess` to `ApprovedClients` and include each installation's key
identifier and public key in `ApprovedClients`. Each entry uses an `Id` of up to
64 ASCII letters, digits, underscores or hyphens and a `PublicKey` containing
the base64-encoded ECDSA P-256 SubjectPublicKeyInfo. The client or its managed
launcher keeps the private key. Remove a key from the policy to revoke its
access. Firefox closes active MCP connections as soon as it applies the updated
policy.

Launch the connector with `--external-signer` in this mode. The MCP client or
launcher handles the JSON-RPC request `firefoxEnterprise/signChallenge` and
signs the exact UTF-8 bytes of `params.payload` with ECDSA P-256 and SHA-256.
Reply with the same JSON-RPC request ID and a `result` that contains the
`key_id` and `signature`. Encode the signature as 64 bytes (32-byte
`r` followed by 32-byte `s`) in unpadded base64url. The connector checks that
the challenge identifies its own process and its verified browser peer.
Firefox accepts a proof once, within ten seconds, and advertises tools only
after verification.

## Navigation access

Add `Navigation` to a site's tool grants to let a local agent use `open_tab`.
Pass an absolute HTTP(S) URL as `url`. Firefox checks that URL and its
network redirects against the navigation grant. A page can initiate
non-HTTP(S) document loads outside the network guard. Firefox refuses
further MCP access to the resulting document. A successful result contains
the loaded origin and a temporary document handle. Use `navigate_tab` with the current
`tab` handle and a new `url` to navigate the selected eligible tab in place. The result
replaces the previous handle. Reading a document requires its own
`ReadPage` grant.

A connection controls one tab at a time. The browser infobar on an agent-owned
tab identifies the agent and offers **Stop**. The tab closes when the controlling
connection ends, including on policy withdrawal. Stopping a connection to an
existing tab leaves the tab open.

## Interaction access

Grant `Interact` to let a local client act on a selected eligible tab at
that origin. This gives the client the user's signed-in authority, including
the ability to trigger transactions by clicking a button or submitting a form.
The client needs `Navigation` to open the tab.

Use `list_elements` with the current tab handle to get handles for supported
visible controls outside shadow DOM. Use `interact` with the tab handle, an element handle and a
typed action. Firefox supports button clicks, filling supported text inputs,
selecting a listed option, scrolling and activating same-origin form
submission. Firefox excludes protected controls such as password, file,
one-time code and payment inputs. It refuses interaction when managed data
loss prevention or content analysis applies. Document replacement or another
call to `list_elements` invalidates previous element handles. Check the
website's state before retrying a transaction after an interruption.

When acting on an existing tab, Firefox temporarily restricts popups,
downloads, dialogs and external protocol launches from the top-level document
and its same-origin, in-process frames. These restrictions do not isolate
scripts or cover cross-origin frames. Firefox applies sandbox flags throughout
the lifetime of an agent-owned tab.

## Diagnostics access

Grant each diagnostic separately for the sites where it is needed.

- `NetworkMetadata` enables `network_metadata`. The first call starts
  collection and later calls return up to 64 completed same-origin requests
  from the attached top-level document. Each entry contains the HTTP method,
  response status and duration in milliseconds. Firefox omits URLs, headers,
  bodies, and requests involving another origin or frame.
- `ConsoleSummaries` enables `console_summary`. The first call starts a
  collection window for the attached top-level document. Later calls return
  severity counts for recent page console API events. Firefox omits message
  text and events from other frames and workers.
- `VisiblePageScreenshots` enables `screenshot`. Firefox returns a bounded
  JPEG of the visible document area. It refuses captures with embedded
  documents, form controls or editable content, or active Enterprise watermark
  requirements. Pages with more than 2,000 elements also exceed the capture limit.

Firefox displays the same Stop control for diagnostics and clears diagnostic
collection on detachment. Managed data loss prevention or content analysis
blocks all three diagnostic tools.

## Security event logging

Set `SecurityLogging.EnterpriseMCP.Enabled` to `true` to send MCP security
events in the Enterprise security telemetry ping. Firefox records client
admission and rejection, when the user stops a session, and whether an MCP
operation was allowed or denied. Events can include a random connection
identifier and a verified client identifier from administrator policy.
Firefox reports at most one rejection per minute for each client access mode.

`SecurityLogging.EnterpriseMCP.UrlLogging` defaults to `none`. Set it to
`domain` to include the hostname of the site involved, or `full` to include its
origin when available. Paths, query strings, page content, credentials, and
form values are excluded at every setting.
